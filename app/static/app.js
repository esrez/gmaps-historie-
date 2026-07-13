/* GMaps Historie – frontendová logika (ES modul, sdílené helpery v common.js) */
import { $, toDateStr, toTimeStr, partsToTs, dateToTs, currentRange,
         buildUrl, apiFetch, escapeHtml, toast,
         isDarkTheme, initThemeToggle, appConfirm, appPrompt } from "./common.js";
import { icon, mountIcons } from "./icons.js";
import { typeLabel, tile, trend, sparkline, renderRecords,
         renderMonthlyChart, renderAnalysis } from "./charts.js";
import { initEventStream } from "./sync-events.js";
import { transportParam, renderNewPlaces } from "./map-filters.js";
import { DayScrubber, initSpeedButtons, formatPlayClock, daySummaryText } from "./day-playback.js";
import { initMapTools } from "./map-tools.js";
import { initImportUi, startImport } from "./import-ui.js";

initThemeToggle($("themeBtn"));
mountIcons();

// ------------------------------------------------------------- záložky

document.querySelectorAll("#tabs .tab-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (drawState.active) drawCleanup();   // přepnutím se nesmí zaseknout kreslení oblasti
    if (mapTools.measureBusy()) measureCleanup();
    document.querySelectorAll("#tabs .tab-btn").forEach((b) =>
      b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-page").forEach((p) =>
      p.classList.toggle("active", p.dataset.page === btn.dataset.tab));
    if (btn.dataset.tab === "mista") loadPlacesTab();
  }));

$("panelCollapse").addEventListener("click", () => {
  if (drawState.active) drawCleanup();
  const collapsed = $("panel").classList.toggle("collapsed");
  $("panelCollapse").textContent = collapsed ? "▸" : "▾";
});

// Panel lze odsunout tažením za hlavičku – uvolní se tak mapa pod ním.
// (Na mobilu je panel spodní list, tam se přesun nepoužívá.)
(function makePanelDraggable() {
  const panel = $("panel"), head = $("panelHead");
  const isMobile = () => window.matchMedia("(max-width: 800px)").matches;
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
    try { head.releasePointerCapture(e.pointerId); } catch (_) { /* — */ }
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
  // při přechodu na mobil (spodní list) zrušit ruční pozici, ať platí layout
  window.addEventListener("resize", () => {
    if (isMobile()) { panel.style.left = panel.style.top = panel.style.right = ""; }
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

async function playDay(autoplay = true) {
  const dateVal = $("playDate").value;
  if (!dateVal) { toast("Vyberte den k přehrání.", "error"); return; }
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
  "geoOnline", "trackColorMode", "roadSnap",
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
      apiFetch("/api/heatmap", { params: r, signal: ctrl.signal }),
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
  if ($("playDate").value) parts.push("play=" + $("playDate").value);
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
  if (segments.length > 400) {
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

// -------------------------------------------------- moje místa (názvy)

async function renderMyPlaces() {
  myPlacesLayer.clearLayers();
  if (!$("layerMyPlaces").checked) return;
  let all, stats = {};
  try {
    const r = currentRange();
    const [pl, st] = await Promise.all([
      api("/api/places"),
      api("/api/places/stats", r),
    ]);
    all = pl.places;
    for (const s of st.stats) stats[s.id] = s;
  } catch (e) { return; }
  const color = isDarkTheme() ? "#9085e9" : "#4a3aa7";
  for (const p of all) {
    const style = { color, weight: 2, fillColor: color, fillOpacity: 0.07,
                    dashArray: "5 5" };
    const shape = p.polygon
      ? L.polygon(p.polygon, style)
      : L.circle([p.lat, p.lon], { radius: p.radius_m, ...style });
    // bublina rovnou říká, jak dlouho jsem tu ve zvoleném období byl
    const s = stats[p.id];
    const info = s && s.count
      ? `${s.count}×, ${(s.secs / 3600).toLocaleString("cs", { maximumFractionDigits: 1 })} h ve zvoleném období`
      : "ve zvoleném období bez pobytu";
    const base = `<b>${escapeHtml(p.name)}</b><br>${info}`;
    const tail = "<br><i>kliknutím zobrazíte pobyty</i>";
    shape.bindTooltip(base + tail, { sticky: true });
    // adresa (reverzní geokódování) se doplní do bubliny až při najetí
    shape.on("tooltipopen", async () => {
      const addr = await reverseGeocode(p.lat, p.lon);
      if (addr) shape.setTooltipContent(
        `${base}<br><span class="tipAddr">${escapeHtml(addr)}</span>${tail}`);
    });
    shape.on("click", (ev) => {
      L.DomEvent.stop(ev);
      whenIWasHere(p.lat, p.lon, p.name);
    });
    shape.addTo(myPlacesLayer);
  }
}

$("layerMyPlaces").addEventListener("change", renderMyPlaces);

// ------------------------------------------------ přehled „Moje místa"

let placesData = [];   // [{...place, count, secs}] pro zvolené období

function fmtDur(secs) {
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

// ---------- reverzní geokódování (souřadnice → adresa) s mezipamětí ----------
// Šetrné k Nominatim: výsledky se drží v localStorage a stahují jen na vyžádání.
let geoStore = {};
try { geoStore = JSON.parse(localStorage.getItem("revgeo") || "{}"); } catch (e) { geoStore = {}; }
const geoInflight = new Map();

async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (key in geoStore) return geoStore[key];
  // soukromí: bez souhlasu se souřadnice nikam neposílají (jen dřív zjištěné)
  if (!$("geoOnline")?.checked) return null;
  if (geoInflight.has(key)) return geoInflight.get(key);
  const pr = (async () => {
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2" +
        `&lat=${lat}&lon=${lon}&accept-language=cs&zoom=18`);
      const d = await r.json();
      const addr = d.display_name || null;
      geoStore[key] = addr;
      try { localStorage.setItem("revgeo", JSON.stringify(geoStore)); } catch (e) { /* plno */ }
      return addr;
    } catch (e) { return null; }
  })();
  geoInflight.set(key, pr);
  return pr;
}

// ---------- našeptávač názvů míst (datalist sdílený všemi poli) ----------
const suggestSet = new Set();

function addSuggestion(value) {
  const v = (value || "").trim();
  if (!v || suggestSet.has(v)) return;
  suggestSet.add(v);
  const opt = document.createElement("option");
  opt.value = v;
  $("dlPlaceNames").appendChild(opt);
}

async function loadPlaceSuggest() {
  try {
    const s = await api("/api/trips/suggest");
    for (const v of s.places) addSuggestion(v);
  } catch (e) { /* nedostupné */ }
}

async function loadPlacesTab() {
  try {
    const r = currentRange();
    const [pl, st] = await Promise.all([
      api("/api/places"),
      api("/api/places/stats", r),
    ]);
    const stats = {};
    for (const s of st.stats) stats[s.id] = s;
    placesData = pl.places.map((p) => ({
      ...p, count: stats[p.id]?.count || 0, secs: stats[p.id]?.secs || 0,
    }));
  } catch (e) { placesData = []; }
  drawPlacesList();
}

function drawPlacesList() {
  const list = $("placesList");
  if (!placesData.length) {
    list.innerHTML =
      `<div id="placesEmpty">${icon("pin", 28)}` +
      "<p><b>Zatím žádná pojmenovaná místa</b></p>" +
      '<p class="muted">Pojmenujte místo v mapě (klik → „Pojmenovat místo"), ' +
      "nebo obkreslete oblast polygonem v záložce Mapa.</p></div>";
    return;
  }
  const q = $("placeSearch").value.trim().toLowerCase();
  const sort = $("placeSort").value;
  const items = placesData
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "cs")
      : sort === "count" ? b.count - a.count : b.secs - a.secs);
  if (!items.length) {
    list.innerHTML = '<p class="muted" style="padding:10px 4px">Nic nevyhovuje filtru.</p>';
    return;
  }
  list.innerHTML = items.map((p) => {
    const sub = p.count
      ? `${p.count}× · ${fmtDur(p.secs)} ve zvoleném období`
      : "ve zvoleném období bez pobytu";
    return `<div class="placeCard" data-id="${p.id}">
      <div class="placeHead">
        <span class="ic pinIc">${icon(p.polygon ? "polygon" : "pin", 16)}</span>
        <div class="pmeta">
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="psub">${sub}</div>
        </div>
        <span class="ptag">${p.polygon ? "oblast" : "kruh"}</span>
        <button class="pact edit" title="Přejmenovat">${icon("pencil", 14)}</button>
        <button class="pact del" title="Smazat místo">${icon("trash", 14)}</button>
      </div>
    </div>`;
  }).join("");
}

// jedno delegované klikání pro celý seznam (přežije překreslení)
$("placesList").addEventListener("click", async (ev) => {
  const card = ev.target.closest(".placeCard");
  if (!card) return;
  const id = Number(card.dataset.id);
  const p = placesData.find((x) => x.id === id);
  if (!p) return;

  if (ev.target.closest(".edit")) { startPlaceEdit(card, p); return; }
  if (ev.target.closest(".del")) {
    if (!await appConfirm(`Smazat pojmenování místa „${p.name}"?`,
        { okLabel: "Smazat", danger: true })) return;
    await apiFetch(`/api/places/${id}`, { method: "DELETE" });
    toast("Místo smazáno.", "success");
    renderMyPlaces();
    loadPlacesTab();
    return;
  }
  if (ev.target.closest(".placeEditPanel")) return;   // klik uvnitř editace

  // klik na kartu: přepnout detail s pobyty + doletět na mapě
  if (p.polygon) map.flyToBounds(p.polygon, { maxZoom: 16, duration: 0.7 });
  else map.flyTo([p.lat, p.lon], 15, { duration: 0.7 });
  const open = card.querySelector(".placeBody");
  if (open) { open.remove(); card.querySelector(".placeAddr")?.remove(); return; }
  await expandPlace(card, id);
});

async function expandPlace(card, id) {
  const p = placesData.find((x) => x.id === id);
  const body = document.createElement("div");
  body.className = "placeBody";
  body.innerHTML = '<p class="muted">Načítám pobyty…</p>';
  card.appendChild(body);
  // adresa místa (reverzní geokódování) v záhlaví detailu
  if (p) {
    const addrEl = document.createElement("div");
    addrEl.className = "placeAddr muted";
    addrEl.innerHTML = `${icon("pin", 12)} zjišťuji adresu…`;
    reverseGeocode(p.lat, p.lon).then((addr) => {
      addrEl.innerHTML = `${icon("pin", 12)} ${addr ? escapeHtml(addr)
        : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`}`;
      addSuggestion(addr);
    });
    card.insertBefore(addrEl, body);
  }
  try {
    const d = await api(`/api/places/${id}/stays`, currentRange());
    if (!d.stays.length) {
      body.innerHTML = '<p class="muted">Ve zvoleném období tu nemáte žádný pobyt.</p>';
      return;
    }
    body.innerHTML = "<ol>" + d.stays.map((s) => {
      const a = new Date(s.start_ts * 1000), b = new Date(s.end_ts * 1000);
      const day = a.toLocaleDateString("cs", { weekday: "short", day: "numeric", month: "numeric" });
      return `<li><span>${day} ${toTimeStr(a)}–${toTimeStr(b)}</span><b>${fmtDur(s.secs)}</b></li>`;
    }).join("") + "</ol>";
  } catch (e) {
    body.innerHTML = `<p class="muted">Načtení selhalo: ${escapeHtml(e.message)}</p>`;
  }
}

let radiusPreview = null;

function clearRadiusPreview() {
  if (radiusPreview) { map.removeLayer(radiusPreview); radiusPreview = null; }
}

function startPlaceEdit(card, p) {
  if (card.querySelector(".placeEditPanel")) return;
  card.querySelector(".placeBody")?.remove();   // zavřít případný detail pobytů
  const circle = !p.polygon;
  const panel = document.createElement("div");
  panel.className = "placeEditPanel";
  panel.innerHTML =
    `<label class="peRow">Název<input class="peName" type="text" list="dlPlaceNames" value="${escapeHtml(p.name)}"></label>` +
    (circle
      ? `<label class="peRow">Okruh (m)<input class="peRadius" type="number" min="20" step="10" value="${Math.round(p.radius_m)}"></label>`
      : "") +
    `<div class="peActions">` +
      `<button type="button" class="peShape">${icon("pencil", 13)} ${p.polygon ? "Upravit body na mapě" : "Upravit na mapě (posun/velikost)"}</button>` +
      `<button type="button" class="peArea">${icon("polygon", 13)} ${p.polygon ? "Překreslit celou oblast" : "Vymezit oblast (polygon)"}</button>` +
      (p.polygon ? `<button type="button" class="peToCircle">${icon("refresh", 13)} Zpět na kruh</button>` : "") +
    `</div>` +
    `<div class="peSave"><button type="button" class="primary peOk">${icon("check", 13)} Uložit</button>` +
    `<button type="button" class="peCancel">Zrušit</button></div>`;
  card.appendChild(panel);
  const nameI = panel.querySelector(".peName");
  const radiusI = panel.querySelector(".peRadius");
  nameI.focus();
  nameI.select();

  // adresu místa nabídnout jako možný název (našeptávač)
  reverseGeocode(p.lat, p.lon).then((addr) => { if (addr) addSuggestion(addr); });

  // živý náhled okruhu při psaní
  if (radiusI) {
    const preview = () => {
      clearRadiusPreview();
      const rv = Number(radiusI.value);
      if (rv >= 20) {
        radiusPreview = L.circle([p.lat, p.lon], { radius: rv, color: css("--series-2"),
          weight: 1.5, dashArray: "4 4", fillOpacity: 0.06 }).addTo(map);
      }
    };
    radiusI.addEventListener("input", preview);
  }

  const close = () => { clearRadiusPreview(); panel.remove(); };
  const save = async () => {
    const name = nameI.value.trim();
    if (!name) { toast("Název nesmí být prázdný.", "error"); return; }
    const body = {};
    if (name !== p.name) body.name = name;
    if (radiusI) {
      const rv = Number(radiusI.value);
      if (!(rv >= 20)) { toast("Okruh musí být alespoň 20 m.", "error"); return; }
      if (Math.round(rv) !== Math.round(p.radius_m)) body.radius_m = rv;
    }
    if (!Object.keys(body).length) { close(); return; }
    try {
      await apiFetch(`/api/places/${p.id}`, { method: "PATCH", body });
      toast("Místo upraveno.", "success");
      close();
      renderMyPlaces();
      loadPlacesTab();
    } catch (e) { toast("Úprava selhala: " + e.message, "error"); }
  };

  panel.querySelector(".peOk").addEventListener("click", save);
  panel.querySelector(".peCancel").addEventListener("click", close);
  panel.querySelector(".peShape").addEventListener("click", () => { close(); startGeometryEdit(p); });
  panel.querySelector(".peArea").addEventListener("click", () => { close(); startAreaRedraw(p); });
  panel.querySelector(".peToCircle")?.addEventListener("click", async () => {
    if (!await appConfirm("Zrušit vymezenou oblast? Místo se vrátí na kruhový okruh.",
        { okLabel: "Zrušit oblast", danger: true })) return;
    try {
      await apiFetch(`/api/places/${p.id}`, { method: "PATCH", body: { polygon: [] } });
      toast("Oblast zrušena, místo je nyní kruhové.", "success");
      close();
      renderMyPlaces();
      loadPlacesTab();
    } catch (e) { toast("Úprava selhala: " + e.message, "error"); }
  });
  nameI.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    else if (e.key === "Escape") close();
  });
}

$("placeSearch").addEventListener("input", drawPlacesList);
$("placeSort").addEventListener("change", drawPlacesList);

// --------------------------- měření a export PNG (modul map-tools.js)

const mapTools = initMapTools({
  map, canvasRenderer, css,
  beforeMeasure: () => {   // zavřít konkurenční režimy kreslení
    if (drawState.active) drawCleanup();
    if (geomState.active) geomCleanup();
  },
});
const measureCleanup = mapTools.measureCleanup;


// ------------------------------------------- kreslení oblasti (polygon)

const drawState = { active: false, pts: [], preview: null, editPlaceId: null, editName: "" };

function drawCleanup() {
  drawState.active = false;
  drawState.pts = [];
  drawState.editPlaceId = null;
  drawState.editName = "";
  if (drawState.preview) { map.removeLayer(drawState.preview); drawState.preview = null; }
  locLayer.clearLayers();
  map.getContainer().style.cursor = "";
  map.doubleClickZoom.enable();
  $("drawPolyBtn").innerHTML = `${icon("polygon")} Pojmenovat oblast (polygon)`;
}

function beginDraw() {
  measureCleanup();   // ať se nástroje nepletou
  drawState.active = true;
  drawState.pts = [];
  map.doubleClickZoom.disable();
  map.getContainer().style.cursor = "crosshair";
  $("drawPolyBtn").innerHTML = `${icon("check")} Dokončit oblast`;
  toast(drawState.editPlaceId
    ? `Obkreslete novou oblast pro „${drawState.editName}", pak Dokončit (dvojklik). Esc zruší.`
    : "Klikáním do mapy obkreslete oblast (min. 3 body), pak Dokončit. Esc zruší.");
}

$("drawPolyBtn").addEventListener("click", () => {
  if (drawState.active) { finishPolygonDraw(); return; }
  drawState.editPlaceId = null;   // nová oblast
  beginDraw();
});

// Spustí překreslení oblasti existujícího místa (z editace v záložce Místa).
function startAreaRedraw(p) {
  document.querySelector('#tabs [data-tab="mapa"]').click();   // cleanup proběhne dřív, než začneme
  if (p.polygon) map.flyToBounds(p.polygon, { maxZoom: 16, duration: 0.6 });
  else map.flyTo([p.lat, p.lon], 16, { duration: 0.6 });
  if (p.polygon) {   // ukázat stávající oblast jako vodítko
    L.polygon(p.polygon, { color: css("--series-2"), weight: 1.5, dashArray: "2 4",
                           fill: false, interactive: false }).addTo(locLayer);
  }
  drawState.editPlaceId = p.id;
  drawState.editName = p.name;
  beginDraw();
}

function addDrawVertex(lat, lng) {
  drawState.pts.push([lat, lng]);
  L.circleMarker([lat, lng], { radius: 4, color: css("--accent-red"),
                               fillOpacity: 1 }).addTo(locLayer);
  if (drawState.preview) map.removeLayer(drawState.preview);
  drawState.preview = L.polygon(drawState.pts, {
    color: css("--accent-red"), weight: 2, dashArray: "4 4", fillOpacity: 0.08,
  }).addTo(map);
}

async function finishPolygonDraw() {
  if (drawState.pts.length < 3) {
    toast("Oblast potřebuje alespoň 3 body.", "error");
    return;
  }
  try {
    if (drawState.editPlaceId) {
      await apiFetch(`/api/places/${drawState.editPlaceId}`, {
        method: "PATCH", body: { polygon: drawState.pts },
      });
      toast(`Oblast upravena: ${drawState.editName}`, "success");
    } else {
      const name = await appPrompt("Název oblasti (zákazník, sklad, areál…):",
        { title: "Pojmenovat oblast", placeholder: "Zákazník Novák" });
      if (name === null || !name.trim()) { drawCleanup(); return; }
      await apiFetch("/api/places", {
        method: "POST", body: { name: name.trim(), polygon: drawState.pts },
      });
      toast(`Oblast pojmenována: ${name.trim()}`, "success");
    }
  } catch (e) {
    toast("Uložení oblasti selhalo: " + e.message, "error");
  }
  drawCleanup();
  renderMyPlaces();
  loadAll();
}

map.on("dblclick", () => { if (drawState.active) finishPolygonDraw(); });

// ------------------------- interaktivní úprava tvaru uloženého místa
// polygon: táhnutelné body + „+" pro přidání + pravý klik pro smazání;
// kruh: prostřední značka posune střed, krajní mění velikost (poloměr).

const geomState = { active: false, place: null, verts: [], center: null, radius: 0, shape: null };

function geomHandleIcon(kind) {
  if (kind === "mid") {
    return L.divIcon({ className: "geomHandle mid", html: "+", iconSize: [16, 16], iconAnchor: [8, 8] });
  }
  return L.divIcon({ className: "geomHandle " + kind, iconSize: [15, 15], iconAnchor: [8, 8] });
}

function geomCleanup() {
  geomState.active = false;
  geomState.place = null;
  geomState.verts = [];
  geomState.center = null;
  if (geomState.shape) { map.removeLayer(geomState.shape); geomState.shape = null; }
  locLayer.clearLayers();
  document.getElementById("geomBar")?.remove();
  map.doubleClickZoom.enable();
}

function startGeometryEdit(p) {
  drawCleanup();
  geomCleanup();
  measureCleanup();
  document.querySelector('#tabs [data-tab="mapa"]').click();
  geomState.active = true;
  geomState.place = p;
  if (p.polygon) {
    geomState.verts = p.polygon.map(([a, b]) => [a, b]);
    map.flyToBounds(p.polygon, { maxZoom: 17, duration: 0.5 });
    redrawPolyEditor();
    toast("Táhněte body oblasti. Značka plus mezi body přidá bod, pravý klik bod smaže.");
  } else {
    geomState.center = [p.lat, p.lon];
    geomState.radius = p.radius_m;
    map.flyTo(geomState.center, 16, { duration: 0.5 });
    redrawCircleEditor();
    toast("Táhněte prostřední značku pro posun místa, krajní pro změnu velikosti.");
  }
  showGeomBar(p.name);
}

function redrawPolyEditor() {
  locLayer.clearLayers();
  if (geomState.shape) map.removeLayer(geomState.shape);
  const verts = geomState.verts;
  geomState.shape = L.polygon(verts, { color: css("--series-2"), weight: 2,
    fillColor: css("--series-2"), fillOpacity: 0.1 }).addTo(map);
  verts.forEach((v, i) => {
    const h = L.marker(v, { draggable: true, icon: geomHandleIcon("vertex"), zIndexOffset: 1000 });
    h.on("drag", (e) => { verts[i] = [e.latlng.lat, e.latlng.lng]; geomState.shape.setLatLngs(verts); });
    h.on("dragend", redrawPolyEditor);
    h.on("contextmenu", (e) => { L.DomEvent.stop(e); removeVertex(i); });
    h.addTo(locLayer);
  });
  verts.forEach((v, i) => {
    const n = verts[(i + 1) % verts.length];
    const mid = [(v[0] + n[0]) / 2, (v[1] + n[1]) / 2];
    const m = L.marker(mid, { icon: geomHandleIcon("mid") });
    m.on("click", (e) => { L.DomEvent.stop(e); verts.splice(i + 1, 0, mid); redrawPolyEditor(); });
    m.addTo(locLayer);
  });
  updateGeomInfo();
}

function removeVertex(i) {
  if (geomState.verts.length <= 3) { toast("Oblast musí mít alespoň 3 body.", "error"); return; }
  geomState.verts.splice(i, 1);
  redrawPolyEditor();
}

function edgeLatLng() {
  const [lat, lon] = geomState.center;
  const dLon = geomState.radius / (111320 * Math.cos((lat * Math.PI) / 180));
  return L.latLng(lat, lon + dLon);
}

function redrawCircleEditor() {
  locLayer.clearLayers();
  if (geomState.shape) map.removeLayer(geomState.shape);
  geomState.shape = L.circle(geomState.center, { radius: geomState.radius,
    color: css("--series-2"), weight: 2, fillColor: css("--series-2"), fillOpacity: 0.08 }).addTo(map);
  const c = L.marker(geomState.center, { draggable: true, icon: geomHandleIcon("center"), zIndexOffset: 1000 });
  c.on("drag", (e) => { geomState.center = [e.latlng.lat, e.latlng.lng]; geomState.shape.setLatLng(geomState.center); });
  c.on("dragend", redrawCircleEditor);
  c.addTo(locLayer);
  const edge = L.marker(edgeLatLng(), { draggable: true, icon: geomHandleIcon("edge"), zIndexOffset: 1000 });
  edge.on("drag", (e) => {
    geomState.radius = Math.max(20, map.distance(geomState.center, e.latlng));
    geomState.shape.setRadius(geomState.radius);
    updateGeomInfo();
  });
  edge.on("dragend", redrawCircleEditor);
  edge.addTo(locLayer);
  updateGeomInfo();
}

function showGeomBar(name) {
  document.getElementById("geomBar")?.remove();
  const bar = document.createElement("div");
  bar.id = "geomBar";
  bar.className = "floating";
  bar.innerHTML =
    `<span class="gbName">${icon("pencil", 13)} <b>${escapeHtml(name)}</b></span>` +
    '<span id="geomInfo" class="muted"></span>' +
    `<button type="button" class="primary" id="geomSave">${icon("check", 13)} Uložit tvar</button>` +
    '<button type="button" id="geomCancel">Zrušit</button>';
  document.getElementById("app").appendChild(bar);
  bar.querySelector("#geomSave").addEventListener("click", saveGeom);
  bar.querySelector("#geomCancel").addEventListener("click", geomCleanup);
}

function updateGeomInfo() {
  const el = document.getElementById("geomInfo");
  if (!el || !geomState.place) return;
  el.textContent = geomState.place.polygon
    ? `${geomState.verts.length} bodů`
    : `okruh ${Math.round(geomState.radius)} m`;
}

async function saveGeom() {
  const p = geomState.place;
  if (!p) return;
  let body;
  if (p.polygon) {
    if (geomState.verts.length < 3) { toast("Oblast musí mít alespoň 3 body.", "error"); return; }
    body = { polygon: geomState.verts };
  } else {
    body = { radius_m: Math.round(geomState.radius),
             lat: geomState.center[0], lon: geomState.center[1] };
  }
  try {
    await apiFetch(`/api/places/${p.id}`, { method: "PATCH", body });
    toast("Tvar místa uložen.", "success");
    geomCleanup();
    renderMyPlaces();
    loadAll();
  } catch (e) { toast("Uložení selhalo: " + e.message, "error"); }
}

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

function renderVisits() {
  visitLayer.clearLayers();
  if (!$("layerVisits").checked) return;
  for (const v of state.visits) {
    const from = new Date(v.start_ts * 1000), to = new Date(v.end_ts * 1000);
    const hours = ((v.end_ts - v.start_ts) / 3600).toFixed(1);
    const label = v.label || v.name || v.semantic || "Místo";
    const m = visitMarker(v).bindTooltip(
      `${escapeHtml(label)} · ${hours} h`, { direction: "top" }
    ).bindPopup(
      `<b>${escapeHtml(label)}</b><br>` +
      (v.address ? escapeHtml(v.address) + "<br>" : "") +
      `${from.toLocaleString("cs")} – ${to.toLocaleTimeString("cs")}<br>${hours} h<br>` +
      `<a href="#" class="renameLink">${icon("pencil", 11)} Pojmenovat místo</a>`
    ).addTo(visitLayer);
    m.on("popupopen", (ev) => {
      ev.popup.getElement().querySelector(".renameLink")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          map.closePopup();
          renamePlace(v.lat, v.lon, label);
        });
    });
  }
}

["layerTracks", "layerPoints", "layerHeat", "layerVisits"].forEach((id) =>
  $(id).addEventListener("change", () => {
    renderTracks();
    renderPoints();
    renderHeat();
    renderVisits();
  }));

$("layerViewport").addEventListener("change", () => {
  if (state.loadedOnce) loadMapData();   // přepnutí režimu → překreslit hned
});

// ------------------------------------------------------------ statistiky

function renderStats(s, prev) {
  const p = prev || {};
  $("statTiles").innerHTML =
    tile(s.total_km.toLocaleString("cs"), "km celkem",
      trend(s.total_km, p.total_km) + sparkline(s.monthly_km)) +
    tile(s.days_with_data.toLocaleString("cs"), "dní se záznamem",
      trend(s.days_with_data, p.days_with_data)) +
    tile(s.visits.toLocaleString("cs"), "návštěv míst",
      trend(s.visits, p.visits)) +
    tile(s.visit_hours.toLocaleString("cs"), "hodin na místech",
      trend(s.visit_hours, p.visit_hours));

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
    .map((p, i) =>
      `<li><a data-i="${i}">${escapeHtml(p.label)}</a> — ${p.count}×, ${p.hours.toLocaleString("cs")} h ` +
      `<button class="renameBtn" data-i="${i}" title="Pojmenovat místo (zákazník, adresa…)">${icon("pencil", 12)}</button></li>`)
    .join("");
  $("topPlaces").querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      const p = s.top_places[Number(a.dataset.i)];
      map.flyTo([p.lat, p.lon], 15, { duration: 0.8 });
    }));
  $("topPlaces").querySelectorAll(".renameBtn").forEach((b) =>
    b.addEventListener("click", () => {
      const p = s.top_places[Number(b.dataset.i)];
      renamePlace(p.lat, p.lon, p.label);
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
    svg += `<rect x="${col * (cell + gap)}" y="${14 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="0.75" data-d="${iso}"${recAttr}><title>${d.toLocaleDateString("cs")} – ${tip}</title></rect>`;
  }
  const weeks = Math.ceil((365 + startCol) / 7) + 1;
  const width = weeks * (cell + gap);
  const monthLabels = months.map(([c, name]) =>
    `<text x="${c * (cell + gap)}" y="9">${name}</text>`).join("");
  el.innerHTML =
    `<svg viewBox="0 0 ${width} ${14 + 7 * (cell + gap)}" role="img" ` +
    `aria-label="Kalendář najetých km v roce ${calYear}">${monthLabels}${svg}</svg>`;
  el.querySelectorAll("rect[data-d]").forEach((r) =>
    r.addEventListener("click", () => {
      $("playDate").value = r.dataset.d;
      playDay();
    }));
}

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
  if (e.key === "Escape" && drawState.active) {
    drawCleanup();
    toast("Kreslení oblasti zrušeno.");
    return;
  }
  if (e.key === "Escape" && geomState.active) {
    geomCleanup();
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
  if (drawState.active) {
    addDrawVertex(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (geomState.active || mapTools.measureActive()) return;   // při úpravě/měření klik nic neotvírá
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

function startPlayback(day) {
  setupPlaybackMap(day);
  resumePlayback();
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

function pausePlayback() {
  if (play.timer) cancelAnimationFrame(play.timer);
  play.timer = null;
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

(async function init() {
  readHash();
  initEventStream();
  $("playDate").value = toDateStr(new Date());
  try {
    const r = await api("/api/range");
    if (r.max_ts) {
      $("playDate").value = toDateStr(new Date(r.max_ts * 1000));
      calYear = new Date(r.max_ts * 1000).getFullYear();
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
  if (new URLSearchParams(location.hash.slice(1)).get("play")) playDay();
})();

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
