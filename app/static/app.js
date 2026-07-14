/* GMaps Historie – frontendová logika (ES modul, sdílené helpery v common.js) */
import { $, toDateStr, dateToTs, currentRange,
         buildUrl, apiFetch, escapeHtml, toast,
         isDarkTheme, initThemeToggle, appConfirm, appPrompt } from "./common.js";
import { icon, mountIcons } from "./icons.js";
import { typeLabel, tile, trend, sparkline, renderRecords,
         renderMonthlyChart, renderAnalysis,
         renderPunchcard, renderInsightFacts } from "./charts.js";
import { initEventStream } from "./sync-events.js";
import { transportParam, renderNewPlaces } from "./map-filters.js";
import { DayScrubber, initSpeedButtons, formatPlayClock, daySummaryText } from "./day-playback.js";
import { initMapTools } from "./map-tools.js";
import { initPlacesUI } from "./places-ui.js";
import { initImportUi, startImport } from "./import-ui.js";
import { initTimelapse } from "./timelapse.js";
import { initYearCard } from "./year-card.js";

initThemeToggle($("themeBtn"));
mountIcons();

// ------------------------------------------------------------- záložky

document.querySelectorAll("#tabs .tab-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    placesUI.cancelModes();   // přepnutím se nesmí zaseknout kreslení/úprava oblasti
    if (mapTools.measureBusy()) measureCleanup();
    document.querySelectorAll("#tabs .tab-btn").forEach((b) =>
      b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-page").forEach((p) =>
      p.classList.toggle("active", p.dataset.page === btn.dataset.tab));
    if (btn.dataset.tab === "mista") loadPlacesTab();
    if (btn.dataset.tab === "analyza") renderInsightsPanel();
  }));

$("panelCollapse").addEventListener("click", () => {
  placesUI.cancelModes();
  const collapsed = $("panel").classList.toggle("collapsed");
  $("panelCollapse").textContent = collapsed ? "▸" : "▾";
});

// Panel lze odsunout tažením za hlavičku – uvolní se tak mapa pod ním.
// Poslední pozice se pamatuje (localStorage) a obnoví při dalším otevření;
// dvojklik na hlavičku vrátí panel na výchozí místo.
// (Na mobilu je panel spodní list, tam se přesun nepoužívá.)
(function makePanelDraggable() {
  const panel = $("panel"), head = $("panelHead");
  const isMobile = () => window.matchMedia("(max-width: 800px)").matches;

  const clampPos = (x, y) => [
    Math.max(4, Math.min(window.innerWidth - Math.min(panel.offsetWidth, 240) - 4, x)),
    Math.max(4, Math.min(window.innerHeight - 48, y)),
  ];
  const applyPos = (x, y) => {
    [x, y] = clampPos(x, y);
    panel.style.right = "auto";
    panel.style.left = x + "px";
    panel.style.top = y + "px";
  };
  const savePos = () => {
    const r = panel.getBoundingClientRect();
    localStorage.setItem("panel.pos",
      JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
  };

  // obnova naposledy uložené pozice (jen desktop; pozice se ořízne do okna)
  if (!isMobile()) {
    try {
      const p = JSON.parse(localStorage.getItem("panel.pos") || "null");
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) applyPos(p.x, p.y);
    } catch (e) { /* poškozené uložení – nechat výchozí */ }
  }

  let sx, sy, ox, oy, dragging = false;
  head.addEventListener("pointerdown", (e) => {
    if (isMobile() || e.target.closest("button, a, input, select")) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    panel.style.right = "auto";
    head.classList.add("dragging");
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const nx = Math.max(4, Math.min(window.innerWidth - w - 4, ox + e.clientX - sx));
    const ny = Math.max(4, Math.min(window.innerHeight - h - 4, oy + e.clientY - sy));
    panel.style.left = nx + "px";
    panel.style.top = ny + "px";
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    head.classList.remove("dragging");
    savePos();
    try { head.releasePointerCapture(e.pointerId); } catch (_) { /* — */ }
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
  // dvojklik na hlavičku = návrat na výchozí pozici i velikost
  head.addEventListener("dblclick", (e) => {
    if (e.target.closest("button, a, input, select")) return;
    panel.style.left = panel.style.top = panel.style.right = "";
    panel.style.width = panel.style.height = "";
    localStorage.removeItem("panel.pos");
    localStorage.removeItem("panel.width");
    localStorage.removeItem("panel.height");
    toast("Panel vrácen na výchozí pozici a velikost.");
  });
  // při přechodu na mobil (spodní list) zrušit ruční pozici, ať platí layout;
  // na desktopu po zmenšení okna panel jen přitáhnout dovnitř
  window.addEventListener("resize", () => {
    if (isMobile()) {
      panel.style.left = panel.style.top = panel.style.right = "";
    } else if (panel.style.left) {
      applyPos(parseFloat(panel.style.left), parseFloat(panel.style.top));
    }
  });
})();

// -------------------------------------------------------- přehrávání dne

const play = {
  points: [], day: null, dayStart: 0, dateVal: "",
  timer: null, t: 0, marker: null, trail: null, idx: 1,
};
const dayScrubber = new DayScrubber($("dayScrubber"));
// rychlost přehrávání se pamatuje (obnovit před inicializací tlačítek,
// ať je aktivní správné; ukládat při každé změně)
const savedSpeed = localStorage.getItem("map.playSpeed");
if (savedSpeed) $("playSpeed").value = savedSpeed;
initSpeedButtons($("playSpeedBtns"), $("playSpeed"),
  (v) => localStorage.setItem("map.playSpeed", String(v)));

dayScrubber.onSeek((t) => {
  if (!play.points.length) return;
  const t0 = play.points[0][0], t1 = play.points[play.points.length - 1][0];
  play.t = Math.max(t0, Math.min(t1, t));
  renderPlayhead(play.t);
});
dayScrubber.onPauseDuringSeek(
  () => !!play.timer,
  () => pausePlayback(),
  () => resumePlayback(),
);

$("timelineToggle").addEventListener("click", () => {
  const pop = $("timelinePop");
  pop.hidden = !pop.hidden;
  $("timelineToggle").classList.toggle("active", !pop.hidden);
});

async function loadDayData(dateVal) {
  const from_ts = dateToTs(dateVal, false);
  const day = await api("/api/day", { from_ts, to_ts: from_ts + 86400 });
  play.day = day;
  play.dayStart = from_ts;
  play.dateVal = dateVal;
  play.points = day.points || [];
  dayScrubber.setDay(day, from_ts);
  $("playInfo").textContent = day.points.length < 2
    ? "Pro tento den nejsou žádné body."
    : daySummaryText(day) + " · barva stopy = rychlost";
  renderDayTimeline(day);
  return day;
}

/* Přichycení přehrávaného dne k silniční síti (OSRM) – jen se souhlasem
   v Soukromí. Vykreslí podkladovou "silniční" linku pod barevnou stopou. */
let matchedWarned = false;

async function drawMatchedRoad() {
  if (!$("roadSnap")?.checked || !play.dayStart) return;
  const wantDate = play.dateVal;
  try {
    const res = await api("/api/match_day",
      { from_ts: play.dayStart, to_ts: play.dayStart + 86400 });
    if (play.dateVal !== wantDate || !res.points.length) return;   // den se mezitím změnil
    L.polyline(res.points, {
      color: "#fff", weight: 7, opacity: 0.9, interactive: false,
      lineJoin: "round", lineCap: "round",
    }).addTo(playLayer);
    L.polyline(res.points, {
      color: css("--series-1"), weight: 4, opacity: 0.9,
      lineJoin: "round", lineCap: "round", interactive: false,
    }).bindTooltip("Trasa přichycená k silnici (OSRM)").addTo(playLayer);
  } catch (e) {
    if (!matchedWarned) {
      matchedWarned = true;   // hlásit jen jednou, ať to neotravuje
      toast("Přichycení k silnicím teď není dostupné: " + e.message, "error");
    }
  }
}

// Lišta přehrávání jde schovat (křížek) – místo ní zůstane malé kulaté
// tlačítko dole uprostřed. Stav se pamatuje; spuštění přehrávání lištu
// samo zase ukáže, aby ovládání nebylo neviditelné.
function setPlaybarHidden(hidden) {
  $("playbackBar").hidden = hidden;
  $("playbarShow").hidden = !hidden;
  localStorage.setItem("playbar.hidden", hidden ? "1" : "");
}
$("playbarHide").addEventListener("click", () => setPlaybarHidden(true));
$("playbarShow").addEventListener("click", () => setPlaybarHidden(false));
if (localStorage.getItem("playbar.hidden") === "1") setPlaybarHidden(true);

async function playDay(autoplay = true) {
  const dateVal = $("playDate").value;
  if (!dateVal) { toast("Vyberte den k přehrání.", "error"); return; }
  if ($("playbackBar").hidden) setPlaybarHidden(false);
  if (play.dateVal === dateVal && play.points.length >= 2) {
    if (play.timer) pausePlayback();
    else if (autoplay) resumePlayback();
    return;
  }
  stopPlayback();
  const day = await loadDayData(dateVal);
  if (day.points.length < 2) {
    playLayer.clearLayers();
    return;
  }
  setupPlaybackMap(day);
  if (autoplay) resumePlayback();
  else setPlayUi(false);
}

$("playBtn").addEventListener("click", () => playDay(true));

function shiftDay(delta) {
  const val = $("playDate").value;
  if (!val) return;
  const wasPlaying = !!play.timer;
  const d = new Date(dateToTs(val, false) * 1000);
  d.setDate(d.getDate() + delta);
  $("playDate").value = toDateStr(d);
  stopPlayback();
  play.dateVal = "";
  playDay(wasPlaying);
}
$("dayPrev").addEventListener("click", () => shiftDay(-1));
$("dayNext").addEventListener("click", () => shiftDay(1));
$("playDate").addEventListener("change", () => {
  stopPlayback();
  play.dateVal = "";
  playDay(false);
});

(function touchDaySwipe() {
  const bar = $("playbackBar");
  let sx = 0;
  bar.addEventListener("touchstart", (e) => {
    if (e.target.closest("#dayScrubber, button, input")) return;
    sx = e.changedTouches[0].clientX;
  }, { passive: true });
  bar.addEventListener("touchend", (e) => {
    if (!sx) return;
    const dx = e.changedTouches[0].clientX - sx;
    sx = 0;
    if (Math.abs(dx) > 60) shiftDay(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

const tooltip = $("tooltip");

// preferCanvas: všechny vektory (trasy, body, značky) se kreslí do canvasu –
// řádově rychlejší než tisíce SVG/DOM elementů
const map = L.map("map", { zoomControl: true, preferCanvas: true })
  .setView([49.8, 15.5], 7); // ČR
window.map = map;   // pro ladění v konzoli

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_ATTR = OSM_ATTR + ' &copy; <a href="https://carto.com/attributions">CARTO</a>';
// crossOrigin: dlaždice se načtou s CORS (OSM/Carto/Esri posílají ACAO), takže
// jimi neztratíme přístup k canvasu při exportu mapy do PNG.
const baseLayers = {
  "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: OSM_ATTR, crossOrigin: true }),
  "Světlá (Carto)": L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 20, attribution: CARTO_ATTR, crossOrigin: true }),
  "Tmavá (Carto)": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 20, attribution: CARTO_ATTR, crossOrigin: true }),
  "Satelit (Esri)": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles &copy; Esri", crossOrigin: true }),
};
// zvolený podklad se pamatuje; jinak výchozí podle světlého/tmavého vzhledu
const savedBase = localStorage.getItem("map.baseLayer");
const defaultBase = isDarkTheme() ? "Tmavá (Carto)" : "OpenStreetMap";
baseLayers[(savedBase && baseLayers[savedBase]) ? savedBase : defaultBase].addTo(map);
const layersControl = L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
map.on("baselayerchange", (e) => localStorage.setItem("map.baseLayer", e.name));

/* Zapamatování nastavení mapy (vrstvy, filtry, rychlost přehrávání…).
   Uloží se při každé změně a obnoví při dalším otevření – uživatel si tak
   nemusí vrstvy a filtry pokaždé přenastavovat. */
const MAP_SETTINGS = [
  "layerTracks", "layerPoints", "layerHeat", "layerVisits", "layerMyPlaces",
  "layerViewport", "transportFilter", "locRadius", "locMinStay", "placeSort",
  "geoOnline", "trackColorMode", "roadSnap", "statRadius", "statRoutes",
  "heatMode", "heatHours", "visitMinStay", "visitNames",
];

function loadMapSettings() {
  for (const id of MAP_SETTINGS) {
    const saved = localStorage.getItem("map." + id);
    if (saved === null) continue;
    const el = $(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = saved === "true";
    else el.value = saved;
  }
}

function saveMapSettings() {
  for (const id of MAP_SETTINGS) {
    const el = $(id);
    if (el) localStorage.setItem("map." + id, el.type === "checkbox" ? el.checked : el.value);
  }
}

MAP_SETTINGS.forEach((id) => $(id)?.addEventListener("change", saveMapSettings));
loadMapSettings();   // obnovit dřív, než se poprvé vykreslí data
// zapnutí online adres → překreslit místa, ať se adresy začnou dotahovat
$("geoOnline")?.addEventListener("change", () => renderMyPlaces());
$("trackColorMode")?.addEventListener("change", () => renderTracks());

// --------------------------------------- časosběr měsíců (timelapse.js)

initTimelapse({
  map,
  css: (n) => css(n),   // closure – css je definováno níže (TDZ)
  onEnter: () => {          // běžné trasy by se s časosběrem tloukly
    stopPlayback();
    map.removeLayer(trackLayer);
  },
  onExit: () => {
    if ($("layerTracks").checked) map.addLayer(trackLayer);
  },
});

// ------------------------------------------- statistiky na mapě (insights)

const insightLayer = L.layerGroup().addTo(map);
let insightsCache = null;     // {key, data|promise}

async function getInsights() {
  const key = $("dateFrom").value + "|" + $("dateTo").value;
  if (insightsCache?.key === key) return insightsCache.data;
  const promise = api("/api/insights", currentRange());
  insightsCache = { key, data: promise };
  try {
    const data = await promise;
    insightsCache = { key, data };
    return data;
  } catch (e) {
    insightsCache = null;
    throw e;
  }
}

async function drawMapStats() {
  insightLayer.clearLayers();
  if (!$("statRadius").checked && !$("statRoutes").checked) return;
  let ins;
  try { ins = await getInsights(); } catch (e) {
    toast("Statistiky se nepodařilo spočítat: " + e.message, "error");
    return;
  }
  if ($("statRadius").checked && ins.radius && ins.home) {
    const color = css("--series-3");
    for (const [key, label, dash] of [["p50_m", "50 %", null],
                                      ["p90_m", "90 %", "7 7"],
                                      ["p99_m", "99 %", "2 7"]]) {
      L.circle([ins.home.lat, ins.home.lon], {
        radius: ins.radius[key], fill: false, color, weight: 2,
        dashArray: dash, interactive: false,
      }).addTo(insightLayer);
      const latOff = ins.radius[key] / 111320;   // popisek na severním okraji
      L.marker([ins.home.lat + latOff, ins.home.lon], {
        interactive: false,
        icon: L.divIcon({ className: "radiusLbl",
                          html: `${label} záznamů`, iconSize: [0, 0] }),
      }).addTo(insightLayer);
    }
  }
  if ($("statRoutes").checked && ins.routes_geo?.length) {
    const maxN = ins.routes_geo[0].count;
    for (const r of ins.routes_geo) {
      L.polyline([[r.from_lat, r.from_lon], [r.to_lat, r.to_lon]], {
        color: css("--cat-4"), weight: 2 + 8 * (r.count / maxN),
        opacity: 0.75, lineCap: "round",
      }).bindTooltip(`${escapeHtml(r.from)} ⇄ ${escapeHtml(r.to)}<br>` +
        `${r.count}×${r.km_avg != null ? ` · Ø ${r.km_avg.toLocaleString("cs")} km` : ""}`,
        { sticky: true }).addTo(insightLayer);
    }
  }
}

["statRadius", "statRoutes"].forEach((id) =>
  $(id).addEventListener("change", drawMapStats));

/* Analýza: zajímavosti a rytmus týdne se dopočítají při otevření záložky. */
async function renderInsightsPanel() {
  try {
    const ins = await getInsights();
    renderInsightFacts($("insightFacts"), ins);
    renderPunchcard($("punchcard"), ins.punchcard);
  } catch (e) {
    $("insightFacts").textContent = "Zajímavosti se nepodařilo načíst: " + e.message;
  }
}

// ------------------------------------------------ ovládací sloupec mapy

$("ctlFit").addEventListener("click", () => {
  if (!state.points.length) { toast("Žádná data k přiblížení – zvolte jiné období.", "error"); return; }
  state.fitted = false;
  fitToData();
});

$("ctlLocate").addEventListener("click", () => {
  if (!navigator.geolocation) { toast("Prohlížeč neumí zjistit polohu.", "error"); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    map.flyTo([lat, lon], 15, { duration: 0.8 });
    const m = L.circleMarker([lat, lon], {
      radius: 8, color: "#fff", weight: 2.5,
      fillColor: css("--accent-red"), fillOpacity: 0.95,
    }).addTo(map).bindTooltip("Jste tady");
    setTimeout(() => map.removeLayer(m), 12000);
  }, () => toast("Polohu se nepodařilo zjistit (zamítnuto nebo nedostupné).", "error"),
  { timeout: 8000 });
});

$("ctlFull").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) { toast("Celá obrazovka není v tomto prohlížeči dostupná.", "error"); }
});

/* Offline mapa (PMTiles): pokud na serveru leží data/map.pmtiles, přidá se
   plně lokální podklad. Použije se automaticky jen když si uživatel podklad
   sám nezvolil (nebo si zvolil právě offline). */
(async function initOfflineBasemap() {
  try {
    const st = await apiFetch("/api/pmtiles/status");
    if (!st.available || typeof protomapsL === "undefined") return;
    const offline = protomapsL.leafletLayer({
      url: new URL("/api/pmtiles", location.origin).toString(),
      theme: isDarkTheme() ? "dark" : "light",
      attribution: '<a href="https://protomaps.com">Protomaps</a> © OpenStreetMap',
    });
    baseLayers["Offline (PMTiles)"] = offline;
    layersControl.addBaseLayer(offline, "Offline (PMTiles)");
    if (!savedBase || savedBase === "Offline (PMTiles)") {
      Object.values(baseLayers).forEach((l) => { if (map.hasLayer(l) && l !== offline) map.removeLayer(l); });
      offline.addTo(map);
    }
  } catch (e) { /* offline mapa není k dispozici */ }
})();

const trackLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const myPlacesLayer = L.layerGroup().addTo(map);
const visitLayer = L.markerClusterGroup({
  disableClusteringAtZoom: 15,
  maxClusterRadius: 40,
  showCoverageOnHover: false,
}).addTo(map);
const playLayer = L.layerGroup().addTo(map);
const compareLayer = L.layerGroup().addTo(map);
const locLayer = L.layerGroup().addTo(map);
const canvasRenderer = L.canvas({ padding: 0.3 });
let heatLayer = null;

const state = { points: [], breaks: [], heatCells: [], visits: [],
                fitted: false, loadedOnce: false };

const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function distKm(a, b) {
  const dLat = (b[1] - a[1]) * 111;
  const dLon = (b[2] - a[2]) * 111 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// ---------------------------------------------------------------- období

function setPreset(preset) {
  const today = new Date();
  if (preset === "all") {
    $("dateFrom").value = "";
    $("dateTo").value = "";
  } else if (preset === "thisYear") {
    $("dateFrom").value = `${today.getFullYear()}-01-01`;
    $("dateTo").value = toDateStr(today);
  } else if (preset === "lastYear") {
    $("dateFrom").value = `${today.getFullYear() - 1}-01-01`;
    $("dateTo").value = `${today.getFullYear() - 1}-12-31`;
  } else {
    const from = new Date(today.getTime() - Number(preset) * 86400 * 1000);
    $("dateFrom").value = toDateStr(from);
    $("dateTo").value = toDateStr(today);
  }
  loadAll();
}

document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => setPreset(b.dataset.days)));
$("loadBtn").addEventListener("click", loadAll);

// ------------------------------------- velikost panelu (tažením za roh)

/* Pravý dolní roh panelu jde táhnout – mění šířku i výšku (širší panel =
   komplexnější přehled statistik, nižší panel = víc mapy). Velikost se
   pamatuje; dvojklik na hlavičku vše vrátí na výchozí. */
(function panelResizable() {
  const panel = $("panel");
  const maxW = () => Math.min(920, window.innerWidth - 24);
  const maxH = () => window.innerHeight - 24;
  const savedW = Number(localStorage.getItem("panel.width"));
  if (savedW >= 320) panel.style.width = Math.min(savedW, maxW()) + "px";
  const savedH = Number(localStorage.getItem("panel.height"));
  if (savedH >= 240) panel.style.height = Math.min(savedH, maxH()) + "px";
  const h = document.createElement("div");
  h.id = "panelResize";
  h.title = "Tažením změníte šířku i výšku panelu";
  panel.appendChild(h);
  h.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const r = panel.getBoundingClientRect();
    const startW = r.width, startH = r.height;
    h.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = Math.max(320, Math.min(maxW(), startW + ev.clientX - startX));
      panel.style.width = w + "px";
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 8) {   // výšku měnit až při svislém tahu (ne omylem)
        const hh = Math.max(240, Math.min(maxH(), startH + dy));
        panel.style.height = hh + "px";
      }
    };
    const up = () => {
      h.removeEventListener("pointermove", move);
      h.removeEventListener("pointerup", up);
      const rr = panel.getBoundingClientRect();
      localStorage.setItem("panel.width", String(Math.round(rr.width)));
      if (panel.style.height) {
        localStorage.setItem("panel.height", String(Math.round(rr.height)));
      }
    };
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up);
  });
})();

// ------------------------------------------------------------------ API

const api = (path, params) => apiFetch(path, { params });

/* Parametry výřezu mapy: při přiblížení se dotahuje plný detail jen pro
   viditelnou oblast a heatmapa dostane jemnější mřížku. */
function viewportParams() {
  // Výřez omezuje dotaz jen když už je mapa usazená na datech. Při prvním
  // (i poimportním) načtení fitted=false → dotáhne se vše a mapa se přiblíží
  // na data. Bez toho by filtr výřezu schoval čerstvě naimportovaná data,
  // pokud mapa zrovna kouká jinam („ve zvoleném období nejsou žádná data").
  if (!$("layerViewport").checked || !state.loadedOnce || !state.fitted) return {};
  const b = map.getBounds().pad(0.3);
  const z = map.getZoom();
  return {
    min_lat: b.getSouth().toFixed(5), max_lat: b.getNorth().toFixed(5),
    min_lon: b.getWest().toFixed(5), max_lon: b.getEast().toFixed(5),
    precision: z >= 14 ? 5 : z >= 11 ? 4 : z >= 8 ? 3 : 2,
  };
}

/* Režim heatmapy: pohyb (body, volitelně jen část dne) × strávený čas. */
function heatParams() {
  const out = { mode: $("heatMode")?.value || "points" };
  const hrs = $("heatHours")?.value;
  if (out.mode === "points" && hrs) {
    const [f, t] = hrs.split("-").map(Number);
    out.hour_from = f;
    out.hour_to = t;
  }
  return out;
}
["heatMode", "heatHours"].forEach((id) =>
  $(id)?.addEventListener("change", () => loadMapData()));

let mapAbort = null;

async function loadMapData() {
  mapAbort?.abort();   // rozpracovaný starší dotaz rovnou zrušit (šetří server)
  const ctrl = new AbortController();
  mapAbort = ctrl;
  const r = { ...currentRange(), ...viewportParams(), ...transportParam() };
  $("mapLoading").hidden = false;
  $("mapBar").hidden = false;
  try {
    const [pts, heat] = await Promise.all([
      apiFetch("/api/points", { params: r, signal: ctrl.signal }),
      apiFetch("/api/heatmap", { params: { ...r, ...heatParams() }, signal: ctrl.signal }),
    ]);
    state.points = pts.points;
    state.breaks = pts.breaks || [];
    state.heatCells = heat.cells;
    renderTracks();
    renderPoints();
    renderHeat();
    $("dbInfo").textContent =
      `Zobrazeno ${pts.sampled.toLocaleString("cs")} z ${pts.total.toLocaleString("cs")} bodů` +
      (pts.step > 1 ? ` (vzorkování 1:${pts.step})` : "");
    return pts;
  } catch (e) {
    if (e.name === "AbortError") return null;   // nahradil ho novější dotaz
    throw e;
  } finally {
    if (mapAbort === ctrl) {
      mapAbort = null;
      $("mapLoading").hidden = true;
      $("mapBar").hidden = true;
    }
  }
}

async function loadAll() {
  const r = currentRange();
  $("loadBtn").disabled = true;
  try {
    if (!$("statTiles").childElementCount) {
      $("statTiles").innerHTML = '<div class="tile skeleton"></div>'.repeat(4);
    }
    const prevRange = (r.from_ts !== null && r.to_ts !== null)
      ? { from_ts: 2 * r.from_ts - r.to_ts, to_ts: r.from_ts - 1 }
      : null;
    const [pts, visits, stats, analysis, prevStats] = await Promise.all([
      loadMapData(),
      api("/api/visits", r),
      api("/api/stats", r),
      api("/api/analysis", r),
      prevRange ? api("/api/stats", prevRange).catch(() => null) : null,
    ]);
    state.visits = visits.visits;
    renderVisits();
    renderMyPlaces();
    renderStats(stats, prevStats);
    renderEmptyState(pts);
    renderAnalysis(analysis);
    if (document.querySelector('.tab-page[data-page="mista"]').classList.contains("active"))
      loadPlacesTab();   // přehled míst drží krok se zvoleným obdobím
    state.loadedOnce = true;
    insightsCache = null;   // změna období → statistiky přepočítat
    if ($("statRadius").checked || $("statRoutes").checked) drawMapStats();
    if (document.querySelector('.tab-page[data-page="analyza"]').classList.contains("active"))
      renderInsightsPanel();
    if (!state.fitted) fitToData();
    writeHash();
  } catch (e) {
    toast("Načtení dat selhalo: " + e.message, "error");
  } finally {
    $("loadBtn").disabled = false;
  }
}
window.loadAll = loadAll;

map.on("moveend", debounce(() => {
  writeHash();
  if ($("layerViewport").checked && state.loadedOnce) loadMapData();
}, 400));

// ---------------------------------------------- stav pohledu v adrese (URL)

function writeHash() {
  const c = map.getCenter();
  const parts = [];
  if ($("dateFrom").value) parts.push("od=" + $("dateFrom").value);
  if ($("dateTo").value) parts.push("do=" + $("dateTo").value);
  // play v adrese jen když je den opravdu načtený k přehrávání – jinak by
  // každé obnovení stránky samo spouštělo přehrávání (a odkrývalo lištu)
  if (play.dateVal) parts.push("play=" + play.dateVal);
  parts.push(`ll=${c.lat.toFixed(5)},${c.lng.toFixed(5)}`, `z=${map.getZoom()}`);
  history.replaceState(null, "", "#" + parts.join("&"));
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("od")) $("dateFrom").value = h.get("od");
  if (h.get("do")) $("dateTo").value = h.get("do");
  if (h.get("play")) $("playDate").value = h.get("play");
  const ll = (h.get("ll") || "").split(",").map(Number);
  if (ll.length === 2 && !ll.some(isNaN)) {
    map.setView(ll, Number(h.get("z")) || 12);
    state.fitted = true;   // pohled je dán adresou, neskákat na data
  }
}

function fitToData() {
  const pts = state.points;
  if (!pts.length) return;
  // smyčka místo Math.min(...pole): spread s 60k+ prvky přeteče zásobník volání
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p[1] < minLat) minLat = p[1];
    if (p[1] > maxLat) maxLat = p[1];
    if (p[2] < minLon) minLon = p[2];
    if (p[2] > maxLon) maxLon = p[2];
  }
  map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [30, 30] });
  state.fitted = true;
}

// --------------------------------------------------------------- vrstvy

function splitSegments(points, breaks) {
  // Hranice úseků poslal server (breaks = indexy začátků úseků) – po
  // zjednodušení tras už časová heuristika neplatí (mezi ponechanými body
  // vznikají dlouhé rozestupy) a rozbila by dlouhé rovné jízdy.
  if (breaks && breaks.length) {
    const out = [];
    for (let b = 0; b < breaks.length; b++) {
      const seg = points.slice(breaks[b], breaks[b + 1] ?? points.length);
      if (seg.length > 1) out.push(seg);
    }
    return out;
  }
  // fallback: rozdělit podle mezery > 30 min nebo skoku > 50 km (surová data)
  const segs = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const dt = p[0] - prev[0];
      const dLat = (p[1] - prev[1]) * 111;
      const dLon = (p[2] - prev[2]) * 111 * Math.cos((p[1] * Math.PI) / 180);
      const km = Math.sqrt(dLat * dLat + dLon * dLon);
      if (dt > 1800 || km > 50) {
        if (cur.length > 1) segs.push(cur);
        cur = [];
      }
    }
    cur.push(p);
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

/* Pevné barvy roků: rok má vždy stejnou barvu bez ohledu na zvolené období
   (barva sleduje entitu). Identitu vždy doplňuje legenda + tooltipy. */
const YEAR_COLORS = ["#2a78d6", "#1baf7a", "#e0810f", "#8a5cd6", "#d64583", "#0f9bb0"];
const yearColor = (y) => YEAR_COLORS[((y % YEAR_COLORS.length) + YEAR_COLORS.length) % YEAR_COLORS.length];
const segYear = (seg) => new Date(seg[0][0] * 1000).getFullYear();

function renderYearLegend(years) {
  let box = document.getElementById("trackYearLegend");
  if (!years || !years.length) { box?.remove(); return; }
  if (!box) {
    box = document.createElement("div");
    box.id = "trackYearLegend";
    $("mapLegend").prepend(box);
  }
  box.innerHTML = years.map((y) =>
    `<span class="lg-year"><span class="lg-line" style="background:${yearColor(y)}"></span>${y}</span>`).join(" ");
}

// nad tolik úseků v pohledu se místo interaktivních vrstev kreslí
// rychlé multi-čáry (roky dat najednou by jinak mapu zadusily)
const FAST_TRACKS_ABOVE = 400;

function renderTracks() {
  trackLayer.clearLayers();
  if (!$("layerTracks").checked) { renderYearLegend(null); return; }
  // „casing": světlý/tmavý podklad pod čarou – trasa je čitelná na každém
  // podkladu (satelit, tmavá mapa) a čáry působí prokresleně
  const casing = isDarkTheme() ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.9)";
  const segments = splitSegments(state.points, state.breaks);
  const byYear = $("trackColorMode")?.value === "year";
  // dvě střídající se modré – sousední samostatné cesty jdou rozlišit
  const shadePair = [css("--series-1"), isDarkTheme() ? "#6da7ec" : "#5598e7"];
  const segColor = (seg, i) => (byYear ? yearColor(segYear(seg)) : shadePair[i % 2]);
  renderYearLegend(byYear
    ? [...new Set(segments.map(segYear))].sort() : null);

  // Rychlá cesta pro roky dat najednou (tisíce cest v pohledu zdaleka):
  // místo tisíců interaktivních vrstev pár multi-čar bez událostí.
  // Po přiblížení („Detail podle výřezu") segmentů v záběru ubude a
  // automaticky se zapne plné interaktivní kreslení s tooltipy a šipkami.
  if (segments.length > FAST_TRACKS_ABOVE) {
    const lls = segments.map((seg) => seg.map((p) => [p[1], p[2]]));
    L.polyline(lls, { color: casing, weight: 5, opacity: 1, lineJoin: "round",
                      lineCap: "round", interactive: false }).addTo(trackLayer);
    // seskupit úseky podle výsledné barvy → jedna multi-čára na barvu
    const groups = new Map();
    segments.forEach((seg, i) => {
      const c = segColor(seg, i);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(lls[i]);
    });
    for (const [color, group] of groups) {
      L.polyline(group, { color, weight: 2.2, opacity: 0.9, lineJoin: "round",
                          lineCap: "round", interactive: false }).addTo(trackLayer);
    }
    return;
  }

  for (const seg of segments) {
    L.polyline(seg.map((p) => [p[1], p[2]]), {
      color: casing, weight: 6, opacity: 1, interactive: false,
      lineJoin: "round", lineCap: "round",
    }).addTo(trackLayer);
  }
  let arrows = 0;
  segments.forEach((seg, si) => {
    const from = new Date(seg[0][0] * 1000);
    const to = new Date(seg[seg.length - 1][0] * 1000);
    const shade = segColor(seg, si);
    const line = L.polyline(seg.map((p) => [p[1], p[2]]), {
      color: shade,
      weight: 2.5,
      opacity: 0.9,
      lineJoin: "round",
      lineCap: "round",
    }).bindTooltip(
      `${from.toLocaleString("cs")} – ${to.toLocaleTimeString("cs")}<br>` +
      "<i>kliknutím přehrajete den</i>", { sticky: true });
    line.on("click", (ev) => {
      L.DomEvent.stop(ev); // nespouštět mapový popup „Kdy jsem tu byl?"
      $("playDate").value = toDateStr(from);
      playDay();
    });
    line.on("mouseover", () => line.setStyle({ weight: 4.5 }));
    line.on("mouseout", () => line.setStyle({ weight: 2.5 }));
    line.addTo(trackLayer);

    // směrová šipka uprostřed cesty – je vidět, kterým směrem jsem jel
    if (arrows < 150 && seg.length >= 6) {
      const mi = Math.floor(seg.length / 2);
      const a = seg[mi - 1], b = seg[mi + 1] || seg[mi];
      const bearing = Math.atan2(
        (b[2] - a[2]) * Math.cos((a[1] * Math.PI) / 180),
        b[1] - a[1]) * 180 / Math.PI;
      L.marker([seg[mi][1], seg[mi][2]], {
        interactive: false,
        icon: L.divIcon({
          className: "trackArrow",
          html: `<span style="transform:rotate(${Math.round(bearing - 90)}deg);color:${shade}">➤</span>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      }).addTo(trackLayer);
      arrows++;
    }
  });
}

// ------------------------------------------------- porovnání dvou období

let compareAbort = null;

function compareRange() {
  const f = $("cmpFrom").value, t = $("cmpTo").value;
  return {
    from_ts: f ? dateToTs(f, false) : null,
    to_ts: t ? dateToTs(t, true) : null,
  };
}

async function loadCompare() {
  compareLayer.clearLayers();
  if (!$("layerCompare").checked) return;
  const r = compareRange();
  if (r.from_ts === null || r.to_ts === null) return;
  compareAbort?.abort();
  const ctrl = new AbortController();
  compareAbort = ctrl;
  try {
    const pts = await api("/api/points",
      { params: { ...r, limit: 60000 }, signal: ctrl.signal });
    const color = css("--series-3");
    // jedna multi-čára pro všechny úseky – u dlouhých období řádově rychlejší
    const lls = splitSegments(pts.points, pts.breaks).map((seg) => seg.map((p) => [p[1], p[2]]));
    if (lls.length) {
      L.polyline(lls, { color, weight: 2.5, opacity: 0.85,
                        dashArray: "5 4", interactive: false }).addTo(compareLayer);
    }
  } catch (e) {
    if (e.name !== "AbortError") toast("Porovnání se nenačetlo: " + e.message, "error");
  } finally {
    if (compareAbort === ctrl) compareAbort = null;
  }
}

$("layerCompare").addEventListener("change", () => {
  const on = $("layerCompare").checked;
  $("comparePanel").hidden = !on;
  if (on && !$("cmpFrom").value) setComparePreset("prevYear");
  else loadCompare();
});
["cmpFrom", "cmpTo"].forEach((id) =>
  $(id).addEventListener("change", loadCompare));

function setComparePreset(which) {
  if (which === "prevYear") {
    const r = currentRange();
    const shift = (ts) => {
      const d = new Date(ts * 1000);
      d.setFullYear(d.getFullYear() - 1);
      return d;
    };
    if (r.from_ts !== null) $("cmpFrom").value = toDateStr(shift(r.from_ts));
    if (r.to_ts !== null) $("cmpTo").value = toDateStr(shift(r.to_ts));
  }
  loadCompare();
}
document.querySelectorAll("#comparePanel [data-cmp]").forEach((b) =>
  b.addEventListener("click", () => setComparePreset(b.dataset.cmp)));

// --------------------------- měření a export PNG (modul map-tools.js)

const mapTools = initMapTools({
  map, canvasRenderer, css,
  beforeMeasure: () => placesUI.cancelModes(),   // zavřít konkurenční režimy kreslení
});
const measureCleanup = mapTools.measureCleanup;

// ------------------------------ moje místa a kreslení (modul places-ui.js)

const placesUI = initPlacesUI({
  map, locLayer, myPlacesLayer, css,
  whenIWasHere: (lat, lon, label) => whenIWasHere(lat, lon, label),
  loadAll: () => loadAll(),
  measureCleanup: () => measureCleanup(),
});
const { renderMyPlaces, loadPlacesTab, loadPlaceSuggest } = placesUI;

let glifyLayer = null;

function clearGlify() {
  if (glifyLayer) {
    glifyLayer.remove();
    glifyLayer = null;
  }
}

function renderPoints() {
  pointLayer.clearLayers();
  clearGlify();
  if (!$("layerPoints").checked) return;
  const pts = state.points;

  // nad ~20k bodů převezme kreslení WebGL (L.glify) – zvládne statisíce bodů
  if (pts.length > 20000 && window.L?.glify) {
    const hex = css("--series-1");
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    glifyLayer = L.glify.points({
      map,
      data: pts.map((p) => [p[1], p[2]]),
      size: 6,
      color: { r, g, b, a: 0.6 },
      click: (e, point) => whenIWasHere(point[0], point[1]),
    });
    return;
  }

  const step = Math.max(1, Math.ceil(pts.length / 20000)); // strop kvůli plynulosti
  const shown = Math.ceil(pts.length / step);
  const withTooltips = shown <= 3000; // tooltip na každém bodu je drahý – jen při detailu
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    const m = L.circleMarker([p[1], p[2]], {
      renderer: canvasRenderer,
      radius: 4,
      color: "#fff",           // bílý prstenec – bod je čitelný na každém podkladu
      weight: 1.3,
      fillColor: css("--series-1"),
      fillOpacity: 0.85,
    }).on("click", () => whenIWasHere(p[1], p[2]));
    if (withTooltips) m.bindTooltip(new Date(p[0] * 1000).toLocaleString("cs"));
    m.addTo(pointLayer);
  }
}

function renderHeat() {
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  if (!$("layerHeat").checked || !state.heatCells.length) return;
  const maxC = Math.max(...state.heatCells.map((c) => c[2]));
  const data = state.heatCells.map((c) => [c[0], c[1], Math.log(1 + c[2]) / Math.log(1 + maxC)]);
  heatLayer = L.heatLayer(data, { radius: 12, blur: 18, maxZoom: 17, max: 1.0 }).addTo(map);
}

function visitMarker(v) {
  // velikost značky roste s časem stráveným na místě (odmocninou, ať neuletí)
  const hours = Math.max((v.end_ts - v.start_ts) / 3600, 0);
  return L.circleMarker([v.lat, v.lon], {
    radius: Math.min(12, 4 + Math.sqrt(hours) * 1.6),
    color: "#fff",             // bílý prstenec odděluje značku od podkladu
    fillColor: css("--series-2"),
    fillOpacity: 0.8,
    weight: 1.5,
  });
}

// popisků přímo v mapě zobrazit jen tolik, aby se navzájem nepřekrývaly
const VISIT_LABELS_MAX = 30;

function renderVisits() {
  visitLayer.clearLayers();
  if (!$("layerVisits").checked) return;
  const minStay = Number($("visitMinStay")?.value || 0) * 60;
  const shown = state.visits.filter((v) => v.end_ts - v.start_ts >= minStay);
  // popisky: nejdelší pobyty s "lidským" jménem (ne souřadnicový fallback)
  const labelled = new Set();
  if ($("visitNames")?.checked) {
    shown.filter((v) => v.label || v.name)
      .sort((a, b) => (b.end_ts - b.start_ts) - (a.end_ts - a.start_ts))
      .slice(0, VISIT_LABELS_MAX)
      .forEach((v) => labelled.add(v));
  }
  for (const v of shown) {
    const from = new Date(v.start_ts * 1000), to = new Date(v.end_ts * 1000);
    const hours = ((v.end_ts - v.start_ts) / 3600).toFixed(1);
    const label = v.label || v.name || v.semantic || "Místo";
    const m = visitMarker(v).bindPopup(
      `<b>${escapeHtml(label)}</b><br>` +
      (v.address ? escapeHtml(v.address) + "<br>" : "") +
      `${from.toLocaleString("cs")} – ${to.toLocaleTimeString("cs")}<br>${hours} h` +
      '<div class="visitActions">' +
      `<a href="#" data-act="play">${icon("play", 11)} Přehrát den</a>` +
      `<a href="#" data-act="stays">${icon("search", 11)} Kdy jsem tu byl?</a>` +
      `<a href="#" data-act="rename">${icon("pencil", 11)} Pojmenovat</a>` +
      `<a href="#" data-act="del" class="danger">${icon("trash", 11)} Smazat návštěvu</a>` +
      "</div>"
    ).addTo(visitLayer);
    if (labelled.has(v)) {
      m.bindTooltip(escapeHtml(label),
        { permanent: true, direction: "top", className: "visitName", offset: [0, -6] });
    } else {
      m.bindTooltip(`${escapeHtml(label)} · ${hours} h`, { direction: "top" });
    }
    m.on("popupopen", (ev) => visitPopupActions(ev, v, label));
  }
}

// Akce v bublině návštěvy – úprava a mazání přímo z mapy.
function visitPopupActions(ev, v, label) {
  ev.popup.getElement().querySelectorAll("[data-act]").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const act = a.dataset.act;
      if (act !== "del") map.closePopup();
      if (act === "play") {
        $("playDate").value = toDateStr(new Date(v.start_ts * 1000));
        playDay();
      } else if (act === "stays") {
        whenIWasHere(v.lat, v.lon, label);
      } else if (act === "rename") {
        renamePlace(v.lat, v.lon, label);
      } else if (act === "del") {
        if (!await appConfirm(
          `Smazat tuto návštěvu (${label})? GPS body zůstanou, smaže se jen záznam pobytu.`,
          { okLabel: "Smazat", danger: true })) return;
        map.closePopup();
        try {
          await apiFetch(`/api/visits/${v.id}`, { method: "DELETE" });
          state.visits = state.visits.filter((x) => x !== v);
          renderVisits();
          toast("Návštěva smazána.", "success");
        } catch (err) { toast("Smazání selhalo: " + err.message, "error"); }
      }
    }));
}

["layerTracks", "layerPoints", "layerHeat", "layerVisits"].forEach((id) =>
  $(id).addEventListener("change", () => {
    renderTracks();
    renderPoints();
    renderHeat();
    renderVisits();
  }));
$("visitMinStay")?.addEventListener("change", renderVisits);
$("visitNames")?.addEventListener("change", renderVisits);

$("layerViewport").addEventListener("change", () => {
  if (state.loadedOnce) loadMapData();   // přepnutí režimu → překreslit hned
});

// ------------------------------------------------------------ statistiky

// Dlaždice statistik jsou definované datově – uživatel si ozubeným kolečkem
// vybere, které chce vidět (výběr se pamatuje v localStorage).
const num = (v, digits = 1) =>
  (v || 0).toLocaleString("cs", { maximumFractionDigits: digits });
const ratio = (a, b) => (b > 0 ? a / b : 0);

const STAT_TILES = [
  { id: "km", label: "km celkem",
    value: (s) => num(s.total_km),
    extra: (s, p) => trend(s.total_km, p.total_km) + sparkline(s.monthly_km) },
  { id: "days", label: "dní se záznamem",
    value: (s) => num(s.days_with_data, 0),
    extra: (s, p) => trend(s.days_with_data, p.days_with_data) },
  { id: "visits", label: "návštěv míst",
    value: (s) => num(s.visits, 0),
    extra: (s, p) => trend(s.visits, p.visits) },
  { id: "visitHours", label: "hodin na místech",
    value: (s) => num(s.visit_hours),
    extra: (s, p) => trend(s.visit_hours, p.visit_hours) },
  { id: "kmPerDay", label: "Ø km na den se záznamem",
    value: (s) => num(ratio(s.total_km, s.days_with_data)) },
  { id: "trips", label: "cest celkem",
    value: (s) => num(s.trips_count, 0),
    extra: (s, p) => trend(s.trips_count, p.trips_count) },
  { id: "travelHours", label: "hodin na cestách",
    value: (s) => num(s.travel_hours),
    extra: (s, p) => trend(s.travel_hours, p.travel_hours) },
  { id: "places", label: "různých míst",
    value: (s) => num(s.unique_places, 0),
    extra: (s, p) => trend(s.unique_places, p.unique_places) },
  { id: "kmPerTrip", label: "Ø km na cestu",
    value: (s) => num(ratio(s.total_km, s.trips_count)),
    extra: (s, p) => trend(ratio(s.total_km, s.trips_count),
                           ratio(p.total_km, p.trips_count) || null) },
  { id: "speed", label: "Ø km/h na cestách",
    value: (s) => num(ratio(s.total_km, s.travel_hours)),
    extra: (s, p) => trend(ratio(s.total_km, s.travel_hours),
                           ratio(p.total_km, p.travel_hours) || null) },
  { id: "visitsPerDay", label: "Ø návštěv na den",
    value: (s) => num(ratio(s.visits, s.days_with_data)) },
];

function hiddenTiles() {
  try {
    return new Set(JSON.parse(localStorage.getItem("stats.hiddenTiles") || "[]"));
  } catch (e) { return new Set(); }
}

let lastStatsArgs = null;   // pro překreslení po změně výběru dlaždic

// Ozubené kolečko u nadpisu: zaškrtávací výběr zobrazených dlaždic.
$("statCustomize").addEventListener("click", () => {
  const box = $("statPicker");
  if (!box.hidden) { box.hidden = true; return; }
  const hidden = hiddenTiles();
  box.innerHTML = STAT_TILES.map((t) =>
    `<label class="check"><input type="checkbox" data-tile="${t.id}"` +
    `${hidden.has(t.id) ? "" : " checked"}> ${t.label}</label>`).join("");
  box.hidden = false;
  box.querySelectorAll("input").forEach((i) => i.addEventListener("change", () => {
    const off = [...box.querySelectorAll("input:not(:checked)")]
      .map((x) => x.dataset.tile);
    localStorage.setItem("stats.hiddenTiles", JSON.stringify(off));
    if (lastStatsArgs) renderStats(...lastStatsArgs);
  }));
});

function renderStats(s, prev) {
  const p = prev || {};
  lastStatsArgs = [s, prev];
  const hidden = hiddenTiles();
  $("statTiles").innerHTML = STAT_TILES
    .filter((t) => !hidden.has(t.id))
    .map((t) => tile(t.value(s), t.label, t.extra ? t.extra(s, p) : ""))
    .join("");

  renderMonthlyChart(s.monthly_km);
  $("monthlyNote").textContent =
    s.monthly_source === "points"
      ? "Spočteno ze surových GPS bodů" + (s.monthly_approx ? " (vzorkováno, přibližné)" : "")
      : "";

  $("byType").innerHTML = s.by_type
    .filter((t) => t.km > 0)
    .map((t) => `<div class="typeRow"><span>${escapeHtml(typeLabel(t.type))} (${t.count}×)</span><b>${t.km.toLocaleString("cs")} km</b></div>`)
    .join("");

  renderRecords(s.records);
  renderNewPlaces(s.new_places);

  $("topPlaces").innerHTML = s.top_places
    .map((pl, i) =>
      `<li><a data-i="${i}">${escapeHtml(pl.label)}</a> — ${pl.count}×, ${pl.hours.toLocaleString("cs")} h ` +
      `<button class="renameBtn" data-i="${i}" title="Pojmenovat místo (zákazník, adresa…)">${icon("pencil", 12)}</button></li>`)
    .join("");
  $("topPlaces").querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      const pl = s.top_places[Number(a.dataset.i)];
      map.flyTo([pl.lat, pl.lon], 15, { duration: 0.8 });
    }));
  $("topPlaces").querySelectorAll(".renameBtn").forEach((b) =>
    b.addEventListener("click", () => {
      const pl = s.top_places[Number(b.dataset.i)];
      renamePlace(pl.lat, pl.lon, pl.label);
    }));
}

/* Kartička nad mapou, když zvolený výběr nemá žádná data. Ptá se serveru,
   jaká data jsou vůbec v databázi, a podle toho poradí – aby uživatel po
   importu nezůstal u prázdné mapy, když data má, jen mimo zvolené období. */
function ensureEmptyState() {
  let el = document.getElementById("emptyState");
  if (el) return el;
  el = document.createElement("div");
  el.id = "emptyState";
  el.className = "floating";
  el.hidden = true;
  document.getElementById("app").appendChild(el);
  return el;
}

let emptyStateSeq = 0;   // proti závodu: novější načtení přebije dokreslení staršího

async function renderEmptyState(pts) {
  if (!pts) return;   // dotaz zrušen novějším – stav neměnit
  const seq = ++emptyStateSeq;
  const el = ensureEmptyState();
  if (pts.total !== 0) { el.hidden = true; return; }

  // je vybrané období, nebo koukáme na prázdný výřez? zeptáme se, co v DB je
  let range = null;
  try { range = await api("/api/range"); } catch (e) { /* offline */ }
  if (seq !== emptyStateSeq) return;   // mezitím doběhlo novější načtení – nesahat na kartičku
  const hasData = range && (range.points || range.visits);
  const rangeShown = !!($("dateFrom").value || $("dateTo").value);

  if (hasData) {
    const fmtD = (ts) => new Date(ts * 1000).toLocaleDateString("cs");
    const span = (range.min_ts && range.max_ts)
      ? ` (${fmtD(range.min_ts)} – ${fmtD(range.max_ts)})` : "";
    el.innerHTML =
      `${icon("database", 30)}<h3>Tady zrovna nic není, ale data máte</h3>` +
      `<p class="muted">V databázi je <b>${range.points.toLocaleString("cs")}</b> bodů ` +
      `a <b>${range.visits.toLocaleString("cs")}</b> návštěv${span}.<br>` +
      (rangeShown
        ? "Zvolené období je mimo ně – zkuste je rozšířit nebo zobrazit vše."
        : "Mapa jen kouká jinam – zobrazte vše a skočíme na vaše data.") +
      "</p><button class=\"primary\" id=\"emptyAllBtn\">Zobrazit všechna data</button>";
  } else {
    el.innerHTML =
      `${icon("pin", 30)}<h3>Zatím žádná data</h3>` +
      '<p class="muted">Naimportujte export z Google historie polohy ' +
      '(Timeline.json nebo ZIP z Takeoutu) v záložce Nástroje.</p>' +
      '<button class="primary" id="emptyToolsBtn">Přejít na import</button>';
  }

  const allBtn = el.querySelector("#emptyAllBtn");
  if (allBtn) allBtn.addEventListener("click", () => showAllData());
  const toolsBtn = el.querySelector("#emptyToolsBtn");
  if (toolsBtn) toolsBtn.addEventListener("click", () =>
    document.querySelector('#tabs [data-tab="nastroje"]').click());
  el.hidden = false;
}

/* Zobrazit úplně vše: zrušit období i výřezový filtr dotazu a skočit na data. */
function showAllData() {
  $("dateFrom").value = "";
  $("dateTo").value = "";
  state.fitted = false;   // vynutí globální dotaz (bez výřezu) a přiblížení na data
  loadAll();
}

/* Pojmenování místa – název (zákazník, adresa…) se použije všude
   místo souřadnic a lze ho kdykoli změnit stejnou cestou. */
async function renamePlace(lat, lon, currentLabel) {
  const suggestion = /\d+\.\d+/.test(currentLabel || "") ? "" : (currentLabel || "");
  const name = await appPrompt(
    "Název místa (např. Zákazník Novák nebo adresa).\nPrázdný název = zrušit vlastní pojmenování.",
    { title: "Pojmenovat místo", value: suggestion });
  if (name === null) return;
  if (name.trim() === "") {
    // smazat případný vlastní název v okolí
    const { places: all } = await api("/api/places");
    const near = all.find((p) => distKm([0, lat, lon], [0, p.lat, p.lon]) < 0.15);
    if (near) {
      await apiFetch(`/api/places/${near.id}`, { method: "DELETE" });
      toast("Vlastní název odstraněn.", "success");
      loadAll();
    }
    return;
  }
  await apiFetch("/api/places", { method: "POST", body: { lat, lon, name: name.trim() } });
  toast(`Místo pojmenováno: ${name.trim()}`, "success");
  renderMyPlaces();
  loadAll();
}

// -------------------------------------------------------- kalendář roku

// Sekvenční modrá ramp pro km/den (světlá → tmavá). „Jen poloha" (záznam bez
// jízdy) dostane ještě světlejší modrou, takže JAKÁKOLI modrá = je tam záznam;
// šedá = den bez záznamu. Rozlišení modrá/šedá je čitelné i barvoslepým.
const CAL_REC = "#cfe3fb";   // záznam polohy bez rozpoznané jízdy
const CAL_STEPS = ["#9ec5f4", "#6da7ec", "#3987e5", "#1c5cab", "#0d366b"];
let calYear = new Date().getFullYear();

/* Duchový náhled dne: po najetí na den v kalendáři se na mapě ukáže
   jeho stopa (čárkovaně červeně) – bez klikání hned vidíte, kudy den vedl. */
const dayPreviewLayer = L.layerGroup().addTo(map);
const dayPreviewCache = new Map();
let dayPreviewTimer = null;
let dayPreviewGen = 0;

function clearDayPreview() {
  clearTimeout(dayPreviewTimer);
  dayPreviewGen++;
  dayPreviewLayer.clearLayers();
}

function showDayPreview(iso) {
  clearTimeout(dayPreviewTimer);
  const myGen = ++dayPreviewGen;
  dayPreviewTimer = setTimeout(async () => {
    let day = dayPreviewCache.get(iso);
    if (!day) {
      const from_ts = dateToTs(iso, false);
      try {
        day = await api("/api/day", { from_ts, to_ts: from_ts + 86400 });
      } catch (e) { return; }
      if (dayPreviewCache.size > 90) dayPreviewCache.clear();
      dayPreviewCache.set(iso, day);
    }
    if (myGen !== dayPreviewGen) return;   // kurzor už je jinde
    dayPreviewLayer.clearLayers();
    for (const seg of splitSegments(day.points)) {
      L.polyline(seg.map((p) => [p[1], p[2]]), {
        color: css("--accent-red"), weight: 3, opacity: 0.75,
        dashArray: "6 5", interactive: false,
        lineJoin: "round", lineCap: "round",
      }).addTo(dayPreviewLayer);
    }
  }, 200);   // krátká prodleva – přejezd přes kalendář nestřílí dotazy
}

async function renderCalendar() {
  $("calYear").textContent = calYear;
  const el = $("calendar");
  let data;
  try {
    data = await api("/api/calendar", { year: calYear });
  } catch (e) {
    el.innerHTML = "";
    return;
  }
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  const maxKm = Math.max(...data.days.map((d) => d.km), 1);
  const cell = 11, gap = 2;
  const first = new Date(calYear, 0, 1);
  const startCol = (first.getDay() + 6) % 7;   // pondělí = 0
  const emptyFill = css("--grid");        // prázdný den = zřetelné šedé políčko
  const emptyStroke = css("--baseline");  // s jemným rámečkem, ať je grid vidět

  let svg = "";
  const months = [];
  for (let d = new Date(first); d.getFullYear() === calYear; d.setDate(d.getDate() + 1)) {
    const dayIdx = Math.floor((d - first) / 86400000);
    const col = Math.floor((dayIdx + startCol) / 7);
    const row = (dayIdx + startCol) % 7;
    const iso = toDateStr(d);
    const info = byDate.get(iso);
    const hasRecord = info && ((info.points || 0) > 0 || info.km > 0);
    // výchozí = den bez záznamu: zřetelně prázdné šedé políčko s rámečkem
    let fill = emptyFill, stroke = emptyStroke;
    let tip = "bez záznamu";
    if (hasRecord) {
      stroke = "none";
      if (info.km > 0) {
        const idx = Math.min(4, Math.floor((info.km / maxKm) * 5));
        fill = CAL_STEPS[idx];
        tip = `${info.km} km` + (info.points ? `, ${info.points.toLocaleString("cs")} bodů` : "");
      } else {
        fill = CAL_REC;   // je tam záznam polohy, jen bez rozpoznané jízdy
        tip = `jen poloha${info.points ? ` (${info.points.toLocaleString("cs")} bodů)` : ""}`;
      }
    }
    if (d.getDate() === 1) months.push([col, d.toLocaleDateString("cs", { month: "short" })]);
    const recAttr = hasRecord ? ` data-rec="${info.km > 0 ? "km" : "pos"}"` : "";
    svg += `<rect x="${col * (cell + gap)}" y="${14 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="0.75" data-d="${iso}"${recAttr} data-tip="${d.toLocaleDateString("cs")} – ${tip}"></rect>`;
  }
  const weeks = Math.ceil((365 + startCol) / 7) + 1;
  const width = weeks * (cell + gap);
  const monthLabels = months.map(([c, name]) =>
    `<text x="${c * (cell + gap)}" y="9">${name}</text>`).join("");
  el.innerHTML =
    `<svg viewBox="0 0 ${width} ${14 + 7 * (cell + gap)}" role="img" ` +
    `aria-label="Kalendář najetých km v roce ${calYear}">${monthLabels}${svg}</svg>`;
  dayPreviewCache.clear();   // po překreslení (novém roce/importu) čerstvá data
  el.querySelectorAll("rect[data-d]").forEach((r) => {
    r.addEventListener("click", () => {
      $("playDate").value = r.dataset.d;
      playDay();
    });
    // najetí: tooltip s detaily dne + duchový náhled stopy na mapě
    r.addEventListener("mousemove", (ev) => {
      tooltip.innerHTML = `<span class="t-label">${r.dataset.tip}</span>` +
        (r.dataset.rec ? " <b>· kliknutím přehrajete</b>" : "");
      tooltip.hidden = false;
      tooltip.style.left = ev.clientX + 12 + "px";
      tooltip.style.top = ev.clientY - 10 + "px";
      if (r.dataset.rec) showDayPreview(r.dataset.d);
    });
    r.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
      clearDayPreview();
    });
  });
}

initYearCard(() => calYear);   // karta souhrnu roku zobrazeného v kalendáři
$("calPrev").addEventListener("click", () => { calYear--; renderCalendar(); });
$("calNext").addEventListener("click", () => { calYear++; renderCalendar(); });

// ------------------------------------------------------ klávesové zkratky

const SHORTCUTS = [
  ["← →", "předchozí / další den přehrávání"],
  ["mezerník", "spustit / pozastavit přehrávání dne"],
  ["M", "měření vzdálenosti (na mapě)"],
  ["Esc", "zrušit kreslení, měření či zavřít okno"],
  ["?", "tato nápověda"],
];

function toggleShortcutHelp(force) {
  let el = document.getElementById("shortcutHelp");
  if (!el) {
    el = document.createElement("div");
    el.id = "shortcutHelp";
    el.hidden = true;
    el.innerHTML =
      `<div class="dlgCard"><h3 class="dlgTitle">Klávesové zkratky</h3>` +
      `<table class="shortcutTable">${SHORTCUTS.map(([k, d]) =>
        `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join("")}</table>` +
      `<div class="dlgBtns"><button class="primary" type="button">Zavřít</button></div></div>`;
    document.body.appendChild(el);
    el.querySelector("button").addEventListener("click", () => { el.hidden = true; });
    el.addEventListener("mousedown", (ev) => { if (ev.target === el) el.hidden = true; });
  }
  el.hidden = force !== undefined ? !force : !el.hidden;
}

document.addEventListener("keydown", (e) => {
  const help = document.getElementById("shortcutHelp");
  if (e.key === "Escape" && help && !help.hidden) {
    help.hidden = true;
    return;
  }
  if (e.key === "Escape" && placesUI.drawActive()) {
    placesUI.drawCleanup();
    toast("Kreslení oblasti zrušeno.");
    return;
  }
  if (e.key === "Escape" && placesUI.geomActive()) {
    placesUI.geomCleanup();
    toast("Úprava tvaru zrušena.");
    return;
  }
  if (e.key === "Escape" && mapTools.measureBusy()) {
    measureCleanup();
    return;
  }
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey) return;
  if (e.key === "?") { e.preventDefault(); toggleShortcutHelp(); }
  else if (e.key === "m" || e.key === "M") { $("measureBtn").click(); }
  else if (e.key === "ArrowLeft") { shiftDay(-1); }
  else if (e.key === "ArrowRight") { shiftDay(1); }
  else if (e.code === "Space") { e.preventDefault(); $("playBtn").click(); }
});

// ------------------------------------------------- hledání a historie místa

const loc = { lat: null, lon: null, label: "" };

$("searchBtn").addEventListener("click", doSearch);
$("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

async function doSearch() {
  const q = $("searchInput").value.trim();
  if (q.length < 2) return;
  $("searchResults").innerHTML = '<p class="muted">Hledám…</p>';
  const [mine, world] = await Promise.all([
    api("/api/search_visits", { q }).catch(() => ({ results: [] })),
    fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=cs&q=${encodeURIComponent(q)}`)
      .then((r) => r.json()).catch(() => []),
  ]);
  let html = "";
  if (mine.results.length) {
    html += "<h3>Moje místa</h3><ul class=\"resultList\">" + mine.results.map((r, i) =>
      `<li><a data-kind="mine" data-i="${i}">${escapeHtml(r.label)}</a>` +
      `<span class="muted"> — ${r.custom ? "vlastní název"
        : `${r.count}×, ${r.hours.toLocaleString("cs")} h`}</span></li>`).join("") + "</ul>";
  }
  if (world.length) {
    html += "<h3>Mapa (OpenStreetMap)</h3><ul class=\"resultList\">" + world.map((r, i) =>
      `<li><a data-kind="world" data-i="${i}">${escapeHtml(r.display_name)}</a></li>`).join("") + "</ul>";
  }
  $("searchResults").innerHTML = html || '<p class="muted">Nic nenalezeno.</p>';
  $("searchResults").querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      const r = a.dataset.kind === "mine"
        ? mine.results[Number(a.dataset.i)]
        : world[Number(a.dataset.i)];
      const lat = Number(r.lat), lon = Number(r.lon);
      map.flyTo([lat, lon], 15, { duration: 0.8 });
      whenIWasHere(lat, lon, a.dataset.kind === "mine" ? r.label : r.display_name);
    }));
}

map.on("click", (e) => {
  if (placesUI.drawActive()) {
    placesUI.addDrawVertex(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (placesUI.geomActive() || mapTools.measureActive()) return;   // při úpravě/měření klik nic neotvírá
  const { lat, lng } = e.latlng;
  const div = document.createElement("div");
  const btn = document.createElement("button");
  btn.textContent = "Kdy jsem tu byl?";
  btn.className = "primary";
  btn.addEventListener("click", () => { map.closePopup(); whenIWasHere(lat, lng); });
  div.appendChild(btn);
  L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
});

async function whenIWasHere(lat, lon, label) {
  loc.lat = lat; loc.lon = lon;
  loc.label = label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const radius = Number($("locRadius").value);
  const r = currentRange();
  $("locPanel").hidden = false;
  $("locTitle").textContent = loc.label;
  $("locSummary").textContent = "Hledám pobyty…";
  $("locStays").innerHTML = "";

  locLayer.clearLayers();
  L.circle([lat, lon], {
    radius, color: css("--accent-red"), weight: 2, fillOpacity: 0.08,
  }).addTo(locLayer);

  try {
    const res = await api("/api/at_location", {
      lat, lon, radius_m: radius,
      min_stay_min: Number($("locMinStay").value), ...r,
    });
    if (!label && res.place_name) {
      loc.label = res.place_name;
      $("locTitle").textContent = res.place_name;
    }
    const hrs = (res.total_s / 3600).toLocaleString("cs", { maximumFractionDigits: 1 });
    const minStay = Number($("locMinStay").value);
    $("locSummary").textContent = res.count
      ? `${res.count}× ve zvoleném období, celkem ${hrs} h` +
        (minStay ? ` (průjezdy pod ${minStay} min se nepočítají)` : "")
      : "Ve zvoleném období tu žádný pobyt není. Zkuste větší okruh, kratší min. pobyt nebo období Vše.";
    $("locStays").innerHTML = res.stays.slice().reverse().map((s) => {
      const d = new Date(s.start_ts * 1000);
      const from = d.toLocaleDateString("cs", { weekday: "short", day: "numeric", month: "numeric", year: "numeric" });
      const t1 = d.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" });
      const t2 = new Date(s.end_ts * 1000).toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" });
      const dur = s.duration_s >= 5400
        ? (s.duration_s / 3600).toFixed(1) + " h"
        : Math.round(s.duration_s / 60) + " min";
      return `<li><a data-ts="${s.start_ts}">${from}</a> ${t1}–${t2} ` +
        `<b>${dur}</b>${s.name ? ' <span class="muted">' + escapeHtml(s.name) + "</span>" : ""}</li>`;
    }).join("");
    $("locStays").querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        const d = new Date(Number(a.dataset.ts) * 1000);
        $("playDate").value = toDateStr(d);
        playDay();
      }));
  } catch (e) {
    $("locSummary").textContent = "Dotaz selhal: " + e.message;
  }
}

["locRadius", "locMinStay"].forEach((id) =>
  $(id).addEventListener("change", () => {
    if (loc.lat !== null) whenIWasHere(loc.lat, loc.lon, loc.label);
  }));
$("locCloseBtn").addEventListener("click", () => {
  $("locPanel").hidden = true;
  locLayer.clearLayers();
});
$("locRenameBtn").addEventListener("click", async () => {
  if (loc.lat === null) return;
  await renamePlace(loc.lat, loc.lon, loc.label);
  whenIWasHere(loc.lat, loc.lon);
});
$("locExportBtn").addEventListener("click", () => {
  if (loc.lat === null) return;
  const r = currentRange();
  location.href = buildUrl("/api/export_location.xlsx", {
    lat: loc.lat, lon: loc.lon, radius_m: Number($("locRadius").value),
    min_stay_min: Number($("locMinStay").value),
    ...r, label: loc.label,
  });
});

// ---------------------------------------------------------------- exporty

$("exportXlsx").addEventListener("click", () => {
  location.href = buildUrl("/api/export.xlsx", currentRange());
});
$("exportGpx").addEventListener("click", () => {
  location.href = buildUrl("/api/export.gpx", currentRange());
});
$("exportGeojson")?.addEventListener("click", () => {
  const anon = $("exportAnonymize")?.checked;
  location.href = buildUrl("/api/export.geojson", { ...currentRange(), anonymize: anon ? 1 : 0 });
});

$("transportFilter")?.addEventListener("change", () => {
  if (state.loadedOnce) loadMapData();
});

// stopa dne je obarvená rychlostí – sekvenční modrá řada (světlá = pomalu)
const SPEED_STEPS = [
  [6, "#9ec5f4"], [25, "#6da7ec"], [60, "#3987e5"],
  [100, "#256abf"], [Infinity, "#0d366b"],
];

function segmentSpeedKmh(a, b) {
  const dt = b[0] - a[0];
  if (dt <= 0 || dt > 900) return 0;
  return (distKm(a, b) / dt) * 3600;
}

function speedColor(kmh) {
  for (const [limit, color] of SPEED_STEPS)
    if (kmh < limit) return color;
  return SPEED_STEPS[SPEED_STEPS.length - 1][1];
}

function addTrailSegment(a, b) {
  L.polyline([[a[1], a[2]], [b[1], b[2]]], {
    renderer: canvasRenderer,
    color: speedColor(segmentSpeedKmh(a, b)),
    weight: 4,
    opacity: 0.9,
  }).addTo(play.trail);
}

function setupPlaybackMap(day) {
  playLayer.clearLayers();
  play.points = day.points;
  const pts = play.points;
  if (!play.t || play.t < pts[0][0] || play.t > pts[pts.length - 1][0]) {
    play.t = pts[0][0];
  }
  play.idx = 1;
  play.trail = L.layerGroup().addTo(playLayer);
  play.marker = L.circleMarker([pts[0][1], pts[0][2]], {
    radius: 8, color: "#fff", weight: 2,
    fillColor: css("--accent-red"), fillOpacity: 1,
  }).addTo(playLayer);
  map.fitBounds(pts.map((p) => [p[1], p[2]]), { padding: [40, 40] });
  drawMatchedRoad();   // volitelné přichycení stopy dne k silnicím (opt-in)

  for (const v of day.visits) {
    visitMarker(v).bindTooltip(v.name || v.semantic || "Místo").addTo(playLayer);
  }
  dayScrubber.setDay(day, play.dayStart);
  renderPlayhead(play.t);
}

function renderDayTimeline(day) {
  const hm = (ts) => new Date(ts * 1000)
    .toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" });
  const events = [
    ...day.visits.map((v) => ({ ...v, kind: "visit" })),
    ...day.activities.map((a) => ({ ...a, kind: "act" })),
  ].sort((a, b) => a.start_ts - b.start_ts);
  $("dayTimeline").innerHTML = events.map((ev, i) => {
    const cls = ev.kind === "visit" ? "pb-ev-visit" : "pb-ev-move";
    if (ev.kind === "visit") {
      const hrs = ((ev.end_ts - ev.start_ts) / 3600).toFixed(1);
      return `<li class="${cls}"><span class="ev-time">${hm(ev.start_ts)}–${hm(ev.end_ts)}</span> ` +
        `${icon("pin", 12)} <a data-i="${i}" data-ts="${ev.start_ts}">` +
        `${escapeHtml(ev.name || ev.semantic || "Místo")}</a> ` +
        `<span class="muted">(${hrs} h)</span></li>`;
    }
    const km = ((ev.distance_m || 0) / 1000).toFixed(1);
    return `<li class="${cls}"><span class="ev-time">${hm(ev.start_ts)}–${hm(ev.end_ts)}</span> ` +
      `${icon("chevR", 12)} ${escapeHtml(typeLabel(ev.type))}` +
      (km > 0 ? ` <b>${km} km</b>` : "") +
      ` <a href="#" data-ts="${ev.start_ts}" class="muted">přejít</a></li>`;
  }).join("");
  $("dayTimeline").querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const ts = Number(a.dataset.ts);
      if (a.dataset.i != null) {
        const ev = events[Number(a.dataset.i)];
        if (ev.lat) map.flyTo([ev.lat, ev.lon], 16, { duration: 0.8 });
      }
      if (ts && play.points.length) {
        pausePlayback();
        play.t = ts;
        renderPlayhead(ts);
      }
    }));
}

function renderPlayhead(t) {
  const pts = play.points;
  if (!pts.length) return;
  const last = pts.length - 1;
  if (t < pts[play.idx - 1][0]) {
    play.idx = 1;
    play.trail.clearLayers();
  }
  while (play.idx <= last && pts[play.idx][0] <= t) {
    addTrailSegment(pts[play.idx - 1], pts[play.idx]);
    play.idx++;
  }
  let lat, lon, kmh = 0;
  if (play.idx > last) {
    lat = pts[last][1]; lon = pts[last][2];
  } else {
    const a = pts[play.idx - 1], b = pts[play.idx];
    const gap = b[0] - a[0];
    const f = gap > 0 && gap < 900 ? Math.min(1, (t - a[0]) / gap) : 0;
    lat = a[1] + (b[1] - a[1]) * f;
    lon = a[2] + (b[2] - a[2]) * f;
    kmh = segmentSpeedKmh(a, b);
  }
  play.marker?.setLatLng([lat, lon]);
  $("playClock").textContent = formatPlayClock(t);
  $("playSpeedNow").textContent = kmh >= 1 ? `${Math.round(kmh)} km/h` : "";
  dayScrubber.setTime(t);
  const scrub = $("dayScrubber");
  const dayOff = t - play.dayStart;
  scrub.setAttribute("aria-valuenow", String(Math.round(dayOff)));
  scrub.setAttribute("aria-valuetext", formatPlayClock(t));
}

function setPlayUi(playing) {
  $("playBtn").innerHTML = icon(playing ? "pause" : "play");
  $("playBtn").dataset.state = playing ? "playing" : "paused";
}

let wakeLock = null;   // displej nezhasíná během přehrávání (mobil)

async function acquireWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); }
  catch (e) { /* nepodporováno / zamítnuto – nevadí */ }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function pausePlayback() {
  if (play.timer) cancelAnimationFrame(play.timer);
  play.timer = null;
  releaseWakeLock();
  setPlayUi(false);
}

function resumePlayback() {
  if (!play.points.length || play.timer) return;
  const pts = play.points;
  if (play.t >= pts[pts.length - 1][0]) {
    play.t = pts[0][0];
    play.idx = 1;
    play.trail?.clearLayers();
  }
  setPlayUi(true);
  acquireWakeLock();
  let last = performance.now();
  play.timer = requestAnimationFrame(function frame(now) {
    const speed = Number($("playSpeed").value);
    play.t += ((now - last) / 1000) * speed;
    last = now;
    if (play.t >= pts[pts.length - 1][0]) {
      renderPlayhead(pts[pts.length - 1][0]);
      pausePlayback();
      return;
    }
    renderPlayhead(play.t);
    play.timer = requestAnimationFrame(frame);
  });
}

function stopPlayback() {
  pausePlayback();
  $("playSpeedNow").textContent = "";
}

window.play = play;

// ------------------------------------------------- smazání období (soukromí)

$("purgeBtn").addEventListener("click", async () => {
  const f = $("purgeFrom").value, t = $("purgeTo").value;
  if (!f || !t) { toast("Zadejte rozmezí od–do.", "error"); return; }
  const range = { from_ts: dateToTs(f, false), to_ts: dateToTs(t, true) };
  try {
    const dry = await apiFetch("/api/purge_range",
      { method: "POST", params: { ...range, dry_run: true } });
    const total = dry.points + dry.visits + dry.activities;
    if (!total) { toast("Ve zvoleném rozmezí nejsou žádná data.", "error"); return; }
    const ok = await appConfirm(
      `Smazat ${dry.points.toLocaleString("cs")} bodů, ${dry.visits.toLocaleString("cs")} návštěv `
      + `a ${dry.activities.toLocaleString("cs")} cest z období ${f} až ${t}?\n`
      + "Před smazáním se automaticky vytvoří záloha.",
      { title: "Smazat období", okLabel: "Smazat", danger: true });
    if (!ok) return;
    const res = await apiFetch("/api/purge_range",
      { method: "POST", params: { ...range, dry_run: false } });
    toast(`Smazáno. Záloha uložena jako ${res.backup}.`, "success");
    loadBackups();
    showHealth();
    renderCalendar();
    showAllData();
  } catch (e) {
    toast("Smazání selhalo: " + e.message, "error");
  }
});

// ------------------------------------------------------------ údržba dat

function qualityParams() {
  return { ...currentRange(), accuracy_limit: Number($("accLimit").value) };
}

$("qualityBtn").addEventListener("click", async () => {
  $("qualityBtn").disabled = true;
  $("qualityReport").innerHTML = '<p class="muted">Kontroluji…</p>';
  try {
    const q = await api("/api/quality", qualityParams());
    const fmt = (v) => v.toLocaleString("cs");
    const issues = [];
    if (q.low_accuracy) issues.push(`${icon("alert", 13)} ${fmt(q.low_accuracy)} bodů s přesností horší než ${q.accuracy_limit} m`);
    if (q.outliers) issues.push(`${icon("alert", 13)} ${fmt(q.outliers)} GPS „teleportů" (osamocené skoky)`);
    if (q.outliers === null) issues.push("ℹ️ Příliš mnoho bodů – teleporty se vyhodnotí až při opravě");
    if (q.bad_visits) issues.push(`${icon("alert", 13)} ${fmt(q.bad_visits)} vadných návštěv (konec před začátkem)`);
    if (q.duplicate_activities) issues.push(
      `${icon("alert", 13)} ${fmt(q.duplicate_activities)} duplicitních cest (překryv více exportů)`);
    if (q.gap_days) issues.push(
      `ℹ️ ${fmt(q.gap_days)} dní bez jakýchkoli dat` +
      (q.gap_samples.length ? ` (např. ${q.gap_samples.slice(0, 5).join(", ")}…)` : ""));
    $("qualityReport").innerHTML = issues.length
      ? `<ul class="issueList">${issues.map((i) => `<li>${i}</li>`).join("")}</ul>`
      : `<p class="muted">${icon("check", 13)} Žádné problémy nenalezeny.</p>`;
    const fixable = q.low_accuracy + (q.outliers ?? 1) + q.bad_visits + q.duplicate_activities;
    $("cleanupBtn").hidden = fixable === 0;
  } catch (e) {
    $("qualityReport").innerHTML = `<p class="muted">Kontrola selhala: ${e.message}</p>`;
  } finally {
    $("qualityBtn").disabled = false;
  }
});

$("cleanupBtn").addEventListener("click", async () => {
  const dry = await apiFetch("/api/cleanup", { method: "POST", params: { ...qualityParams(), dry_run: true } });
  const total = dry.low_accuracy + dry.outliers + dry.bad_visits + dry.duplicate_activities;
  if (!total) { $("qualityReport").innerHTML = '<p class="muted">Není co opravovat.</p>'; return; }
  if (!await appConfirm(`Smazat ${dry.low_accuracy.toLocaleString("cs")} nepřesných bodů, `
    + `${dry.outliers.toLocaleString("cs")} teleportů, ${dry.bad_visits.toLocaleString("cs")} vadných návštěv `
    + `a ${dry.duplicate_activities.toLocaleString("cs")} duplicitních cest?\n`
    + "Doporučení: originální exporty od Googlu si nechte – kdykoli je lze naimportovat znovu.")) return;
  $("cleanupBtn").disabled = true;
  try {
    const res = await apiFetch("/api/cleanup", { method: "POST", params: { ...qualityParams(), dry_run: false } });
    $("qualityReport").innerHTML =
      `<p class="muted">${icon("wand", 13)} Smazáno: ${res.low_accuracy.toLocaleString("cs")} nepřesných bodů, `
      + `${res.outliers.toLocaleString("cs")} teleportů, ${res.bad_visits.toLocaleString("cs")} návštěv, `
      + `${res.duplicate_activities.toLocaleString("cs")} duplicitních cest.</p>`;
    $("cleanupBtn").hidden = true;
    loadAll();
  } finally {
    $("cleanupBtn").disabled = false;
  }
});

// --------------------------------------- import dat (modul import-ui.js)

initImportUi({
  onImported: () => { loadPlaceSuggest(); showAllData(); },
  wizardOpen: () => !$("wizard").hidden,
  closeWizardSoon: () => setTimeout(closeWizard, 1800),
});


// ----------------------------------------------------- průvodce / nápověda

const WIZ_STEPS = 3;
let wizStep = 1;

function renderWizStep() {
  document.querySelectorAll("#wizCard .wizStep").forEach((el) =>
    el.hidden = Number(el.dataset.step) !== wizStep);
  $("wizPrev").hidden = wizStep === 1;
  $("wizNext").hidden = wizStep === WIZ_STEPS;
  $("wizDone").hidden = wizStep !== WIZ_STEPS;
  const dots = document.querySelector("#wizFoot .wizDots");
  dots.innerHTML = Array.from({ length: WIZ_STEPS },
    (_, i) => `<span class="${i + 1 === wizStep ? "on" : ""}"></span>`).join("");
}

function openWizard(step = 1) {
  wizStep = step;
  $("wizNoAuto").checked = localStorage.getItem("wizardSeen") === "1";
  renderWizStep();
  $("wizard").hidden = false;
}

function closeWizard() {
  $("wizard").hidden = true;
}

$("helpBtn").addEventListener("click", () => openWizard(2));   // rovnou k odkazům na data
$("howtoBtn").addEventListener("click", () => openWizard(2));
$("wizClose").addEventListener("click", closeWizard);
$("wizDone").addEventListener("click", closeWizard);
$("wizPrev").addEventListener("click", () => { wizStep = Math.max(1, wizStep - 1); renderWizStep(); });
$("wizNext").addEventListener("click", () => { wizStep = Math.min(WIZ_STEPS, wizStep + 1); renderWizStep(); });
$("wizNoAuto").addEventListener("change", () => {
  localStorage.setItem("wizardSeen", $("wizNoAuto").checked ? "1" : "0");
});
$("wizard").addEventListener("click", (e) => { if (e.target.id === "wizard") closeWizard(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("wizard").hidden) closeWizard();
});

// tlačítko v průvodci: ukázková data pro vyzkoušení bez vlastního exportu
$("wizDemoBtn")?.addEventListener("click", async () => {
  $("wizDemoBtn").disabled = true;
  const orig = $("wizDemoBtn").innerHTML;
  $("wizDemoBtn").innerHTML = `${icon("wand")} Generuji ukázku…`;
  try {
    const res = await apiFetch("/api/demo", { method: "POST" });
    toast(`Ukázka nahrána: ${res.points.toLocaleString("cs")} bodů, ` +
      `${res.visits} návštěv. Rozhlédněte se!`, "success");
    closeWizard();
    loadPlaceSuggest();
    renderCalendar();
    showAllData();
  } catch (e) {
    toast("Ukázku nejde nahrát: " + e.message, "error");
  } finally {
    $("wizDemoBtn").disabled = false;
    $("wizDemoBtn").innerHTML = orig;
  }
});

// tlačítko v průvodci: vybrat soubor a rovnou importovat
$("wizImportBtn").addEventListener("click", () => {
  const onPick = () => {
    $("importFile").removeEventListener("change", onPick);
    if ($("importFile").files[0]) startImport($("importFile").files[0]);
  };
  $("importFile").addEventListener("change", onPick);
  $("importFile").click();
});

$("backupBtn").addEventListener("click", () => { location.href = "/api/backup"; });

async function loadBackups() {
  try {
    const { backups } = await api("/api/backups");
    const sel = $("restoreSelect");
    sel.innerHTML = '<option value="">— vyberte zálohu —</option>' +
      backups.map((b) =>
        `<option value="${escapeHtml(b.name)}">${b.when} · ${(b.size / 1e6).toFixed(1)} MB</option>`
      ).join("");
  } catch (e) { /* nedostupné */ }
}

$("restoreBtn").addEventListener("click", async () => {
  const name = $("restoreSelect").value;
  if (!name) { toast("Nejdřív vyberte zálohu.", "error"); return; }
  if (!await appConfirm("Obnovit databázi z této zálohy? Současná data se přepíšou " +
               "(předtím se ale sama zazálohují, obnovu lze vzít zpět).")) return;
  try {
    // apiFetch, ne api(): wrapper api() bere 2. argument jen jako query
    // parametry a metodu by zahodil (obnova by se volala jako GET → 405)
    const res = await apiFetch("/api/restore", { method: "POST", params: { name } });
    toast(`Databáze obnovena ze zálohy. Předchozí stav uložen jako ${res.safety_backup}.`,
      "success");
    loadBackups();
    location.reload();
  } catch (e) {
    toast("Obnova selhala: " + e.message, "error");
  }
});

async function showAutoImportLog() {
  try {
    const { log } = await api("/api/autoimport");
    $("autoImportLog").innerHTML = log.length
      ? "Auto-import: " + log.map((l) =>
          `${escapeHtml(l.file)} (${l.when}) ${l.status === "ok" ? icon("check", 11) : icon("x", 11) + " " + escapeHtml(l.error || "")}`
        ).join("<br>")
      : "";
  } catch (e) { /* nedostupné */ }
}

// ------------------------------------------------------------------ start

/* Nenápadná připomínka, když poslední data v databázi jsou starší 30 dní –
   uživatel na nový export z Googlu snadno zapomene. Odkliknutí se pamatuje
   měsíc (klíč obsahuje rok-měsíc), takže banner neotravuje. */
function maybeShowStaleNotice(maxTs) {
  const days = Math.floor((Date.now() / 1000 - maxTs) / 86400);
  if (days < 30) return;
  const key = "staleDismissed." + new Date().toISOString().slice(0, 7);
  if (localStorage.getItem(key)) return;
  const el = document.createElement("div");
  el.id = "staleNotice";
  el.className = "floating";
  el.innerHTML =
    `${icon("calendar", 15)} Poslední data jsou <b>${days} dní</b> stará. ` +
    "Nahrajte nový export z Googlu, ať mapa nezaostává. " +
    `<button id="staleImportBtn" class="primary">Import</button>` +
    `<button id="staleCloseBtn" title="Skrýt do příštího měsíce">${icon("x", 13)}</button>`;
  document.getElementById("app").appendChild(el);
  $("staleImportBtn").addEventListener("click", () => {
    document.querySelector('#tabs [data-tab="nastroje"]').click();
    el.remove();
  });
  $("staleCloseBtn").addEventListener("click", () => {
    localStorage.setItem(key, "1");
    el.remove();
  });
}

(async function init() {
  readHash();
  initEventStream();
  $("playDate").value = toDateStr(new Date());
  try {
    const r = await api("/api/range");
    if (r.max_ts) {
      $("playDate").value = toDateStr(new Date(r.max_ts * 1000));
      calYear = new Date(r.max_ts * 1000).getFullYear();
      maybeShowStaleNotice(r.max_ts);
    }
    if (!r.points && !r.visits) {
      // prázdná databáze → laika provede průvodce (pokud si ho nevypnul)
      $("importStatus").textContent =
        "Začněte zde: nahrajte Timeline.json z telefonu nebo ZIP z Takeoutu.";
      if (localStorage.getItem("wizardSeen") === "1") {
        document.querySelector('#tabs [data-tab="nastroje"]').click();
      } else {
        openWizard(1);
      }
    }
  } catch (e) { /* server nedostupný – ukáže se při Načíst */ }
  showVersion();
  showHealth();
  loadProfiles();
  loadBackups();
  loadPlaceSuggest();
  showAutoImportLog();
  renderCalendar();
  loadAll();
  maybeCheckUpdate();
  // obnovení stránky den jen připraví (posuvník, stopa) – přehrávání se
  // samo nespouští, to je vždy až na kliknutí uživatele
  if (new URLSearchParams(location.hash.slice(1)).get("play")) playDay(false);
})();

// Nenápadné upozornění na novou verzi – nejvýš 1× denně, každou verzi
// oznámí jen jednou. Detail (odkaz ke stažení) je v Nástroje → O aplikaci.
async function maybeCheckUpdate() {
  const last = Number(localStorage.getItem("updateCheck.ts") || 0);
  if (Date.now() - last < 86400e3) return;
  localStorage.setItem("updateCheck.ts", String(Date.now()));
  try {
    const u = await api("/api/update_check");
    if (u.available && localStorage.getItem("updateSeen") !== u.latest) {
      localStorage.setItem("updateSeen", u.latest);
      toast(`Je k dispozici nová verze ${u.latest} (máte ${u.current}). ` +
            "Odkaz najdete v Nástroje → O aplikaci.", "info");
    }
  } catch (e) { /* offline / kontrola vypnutá */ }
}

async function loadProfiles() {
  try {
    const r = await api("/api/profiles");
    const sel = $("profileSelect");
    if (!sel) return;
    sel.innerHTML = '<option value="">— profil —</option>' +
      (r.profiles || []).map((p) => `<option value="${p.name}">${p.name}</option>`).join("");
    if (r.active) sel.value = r.active;
  } catch (_) { /* nepodporováno */ }
}

$("profileCreateBtn")?.addEventListener("click", async () => {
  const name = await appPrompt("Název nového profilu:", { title: "Nový profil" });
  if (!name || !name.trim()) return;
  try {
    await apiFetch("/api/profiles", { method: "POST", body: { name: name.trim() } });
    await loadProfiles();
    toast("Profil vytvořen.", "success");
  } catch (e) {
    toast("Vytvoření profilu selhalo: " + e.message, "error");
  }
});

$("profileSwitchBtn")?.addEventListener("click", async () => {
  const sel = $("profileSelect");
  if (!sel || !sel.value) { toast("Vyberte profil.", "error"); return; }
  try {
    await apiFetch("/api/profiles/switch", { method: "POST", body: { name: sel.value } });
    toast(`Přepnuto na profil ${sel.value}.`, "success");
    location.reload();
  } catch (e) {
    toast("Přepnutí profilu selhalo: " + e.message, "error");
  }
});

async function showHealth() {
  try {
    const h = await api("/api/health");
    const mb = (h.db_size / 1e6).toLocaleString("cs", { maximumFractionDigits: 1 });
    $("appHealth").innerHTML =
      `Databáze (profil ${escapeHtml(h.profile)}): <b>${mb} MB</b> · ` +
      `${h.points.toLocaleString("cs")} bodů, ${h.visits.toLocaleString("cs")} návštěv, ` +
      `${h.trips.toLocaleString("cs")} jízd v knize<br>` +
      `Poslední záloha: <b>${h.last_backup || "zatím žádná"}</b> ` +
      '<span class="muted">(zálohuje se automaticky 1× denně)</span>';
  } catch (e) { $("appHealth").textContent = ""; }
  try {
    const [u, v] = await Promise.all([api("/api/update_check"), api("/api/version")]);
    if (u.available) {
      $("appHealth").innerHTML +=
        `<br>${icon("refresh", 12)} K dispozici je novější verze <b>${escapeHtml(u.latest)}</b>` +
        (u.url ? ` – <a href="${escapeHtml(u.url)}" target="_blank" rel="noopener">stáhnout</a>` : "") +
        (v.desktop
          ? ` <button id="updateNowBtn" class="primary">${icon("download", 12)} Stáhnout a aktualizovat</button>`
          : "");
      $("updateNowBtn")?.addEventListener("click", () => runSelfUpdate(u.latest));
    }
  } catch (e) { /* kontrola není dostupná */ }
}

// Jedno-kliková aktualizace desktopové aplikace: stáhne nový exe z GitHubu,
// server ho ověří, a po potvrzení se aplikace restartuje s novou verzí.
async function runSelfUpdate(latest) {
  const btn = $("updateNowBtn");
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Stahuji novou verzi… (může trvat pár minut)";
  try {
    await apiFetch("/api/update/download", { method: "POST" });
  } catch (e) {
    toast("Stažení aktualizace selhalo: " + e.message, "error");
    btn.disabled = false;
    btn.innerHTML = orig;
    return;
  }
  const ok = await appConfirm(
    `Aktualizace ${latest} je stažená a ověřená. Aplikace se nyní ukončí, ` +
    "vymění za novou verzi a sama znovu spustí. Pokračovat?",
    { title: "Aktualizovat aplikaci", okLabel: "Restartovat" });
  if (!ok) {
    btn.disabled = false;
    btn.innerHTML = orig;
    toast("Aktualizace je připravená – dokončí se při příštím potvrzení.");
    return;
  }
  try {
    await apiFetch("/api/update/apply", { method: "POST" });
  } catch (e) {
    toast("Spuštění aktualizace selhalo: " + e.message, "error");
    btn.disabled = false;
    btn.innerHTML = orig;
    return;
  }
  btn.textContent = "Restartuji…";
  toast("Aplikace se restartuje – stránka se sama obnoví.", "info");
  // počkat, až naběhne nová verze, a stránku obnovit (nová PWA cache atd.)
  const t0 = Date.now();
  const timer = setInterval(async () => {
    try {
      const r = await fetch("/api/version", { cache: "no-store" });
      if (r.ok && (await r.json()).release === latest) {
        clearInterval(timer);
        location.reload();
      }
    } catch (e) { /* server se ještě vyměňuje */ }
    if (Date.now() - t0 > 180000) clearInterval(timer);   // 3 min strop
  }, 2000);
}

$("dbCheckBtn")?.addEventListener("click", async () => {
  $("dbCheckResult").textContent = "Kontroluji…";
  try {
    const r = await apiFetch("/api/health/check", { method: "POST" });
    $("dbCheckResult").innerHTML = r.ok
      ? `${icon("check", 13)} Databáze je v pořádku.`
      : `${icon("alert", 13)} Nalezeny potíže: ${escapeHtml(r.detail.join("; "))} – ` +
        "obnovte poslední zálohu.";
  } catch (e) {
    $("dbCheckResult").textContent = "Kontrola selhala: " + e.message;
  }
});

// „Přidat na plochu": prohlížeč nabídku ohlásí událostí – pak ukážeme tlačítko
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = $("installBtn");
  if (btn) btn.hidden = false;
});

$("installBtn")?.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("installBtn").hidden = true;
});

async function showVersion() {
  try {
    const { version, release, desktop } = await api("/api/version");
    $("appVersion").textContent = `Verze UI: ${version} · vydání ${release || "?"}`;
    // tlačítko „Ukončit aplikaci" jen u desktopové aplikace (.exe / run.py)
    if (desktop) {
      $("quitBtn").hidden = false;
      $("quitHint").hidden = false;
    }
  } catch (e) { /* nedostupné */ }
}

$("quitBtn").addEventListener("click", async () => {
  if (!await appConfirm("Opravdu ukončit aplikaci GMaps Historie?",
        { okLabel: "Ukončit", danger: true })) return;
  $("quitBtn").disabled = true;
  try {
    await apiFetch("/api/shutdown", { method: "POST" });
  } catch (e) { /* server se ukončuje, chyba spojení je v pořádku */ }
  document.body.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;' +
    'height:100vh;font:16px system-ui;text-align:center;padding:20px;color:#555">' +
    "Aplikace byla ukončena.<br>Okno prohlížeče teď můžete zavřít.</div>";
});
