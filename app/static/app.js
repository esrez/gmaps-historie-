/* GMaps Historie – frontendová logika (ES modul, sdílené helpery v common.js) */
import { $, toDateStr, toTimeStr, partsToTs, dateToTs, currentRange,
         buildUrl, apiFetch, escapeHtml, toast,
         isDarkTheme, initThemeToggle } from "./common.js";
import { icon, mountIcons } from "./icons.js";

initThemeToggle($("themeBtn"));
mountIcons();

// ------------------------------------------------------------- záložky

document.querySelectorAll("#tabs .tab-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("#tabs .tab-btn").forEach((b) =>
      b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-page").forEach((p) =>
      p.classList.toggle("active", p.dataset.page === btn.dataset.tab));
  }));

$("panelCollapse").addEventListener("click", () => {
  const collapsed = $("panel").classList.toggle("collapsed");
  $("panelCollapse").textContent = collapsed ? "▸" : "▾";
});

$("timelineToggle").addEventListener("click", () => {
  $("timelinePop").hidden = !$("timelinePop").hidden;
});

const tooltip = $("tooltip");

// preferCanvas: všechny vektory (trasy, body, značky) se kreslí do canvasu –
// řádově rychlejší než tisíce SVG/DOM elementů
const map = L.map("map", { zoomControl: true, preferCanvas: true })
  .setView([49.8, 15.5], 7); // ČR
window.map = map;   // pro ladění v konzoli

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_ATTR = OSM_ATTR + ' &copy; <a href="https://carto.com/attributions">CARTO</a>';
const baseLayers = {
  "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: OSM_ATTR }),
  "Světlá (Carto)": L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 20, attribution: CARTO_ATTR }),
  "Tmavá (Carto)": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom: 20, attribution: CARTO_ATTR }),
  "Satelit (Esri)": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles &copy; Esri" }),
};
baseLayers[isDarkTheme() ? "Tmavá (Carto)" : "OpenStreetMap"].addTo(map);
const layersControl = L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

/* Offline mapa (PMTiles): pokud na serveru leží data/map.pmtiles, přidá se
   plně lokální podklad a rovnou se použije – žádná dlaždice neopustí síť. */
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
    Object.values(baseLayers).forEach((l) => { if (map.hasLayer(l) && l !== offline) map.removeLayer(l); });
    offline.addTo(map);
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
const locLayer = L.layerGroup().addTo(map);
const canvasRenderer = L.canvas({ padding: 0.3 });
let heatLayer = null;

const state = { points: [], heatCells: [], visits: [], fitted: false, loadedOnce: false };

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
  if (!$("layerViewport").checked || !state.loadedOnce) return {};
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
  const r = { ...currentRange(), ...viewportParams() };
  $("mapLoading").hidden = false;
  try {
    const [pts, heat] = await Promise.all([
      apiFetch("/api/points", { params: r, signal: ctrl.signal }),
      apiFetch("/api/heatmap", { params: r, signal: ctrl.signal }),
    ]);
    state.points = pts.points;
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
    state.loadedOnce = true;
    if (!state.fitted) fitToData();
    writeHash();
  } catch (e) {
    toast("Načtení dat selhalo: " + e.message, "error");
  } finally {
    $("loadBtn").disabled = false;
  }
}

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
  parts.push(`ll=${c.lat.toFixed(5)},${c.lng.toFixed(5)}`, `z=${map.getZoom()}`);
  history.replaceState(null, "", "#" + parts.join("&"));
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("od")) $("dateFrom").value = h.get("od");
  if (h.get("do")) $("dateTo").value = h.get("do");
  const ll = (h.get("ll") || "").split(",").map(Number);
  if (ll.length === 2 && !ll.some(isNaN)) {
    map.setView(ll, Number(h.get("z")) || 12);
    state.fitted = true;   // pohled je dán adresou, neskákat na data
  }
}

function fitToData() {
  const pts = state.points;
  if (!pts.length) return;
  const lats = pts.map((p) => p[1]), lons = pts.map((p) => p[2]);
  map.fitBounds([
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ], { padding: [30, 30] });
  state.fitted = true;
}

// --------------------------------------------------------------- vrstvy

function splitSegments(points) {
  // rozdělí body na souvislé úseky: mezera > 30 min nebo skok > 50 km
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

function renderTracks() {
  trackLayer.clearLayers();
  if (!$("layerTracks").checked) return;
  // „casing": světlý/tmavý podklad pod čarou – trasa je čitelná na každém
  // podkladu (satelit, tmavá mapa) a čáry působí prokresleně
  const casing = isDarkTheme() ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.9)";
  const segments = splitSegments(state.points);
  for (const seg of segments) {
    L.polyline(seg.map((p) => [p[1], p[2]]), {
      color: casing, weight: 6, opacity: 1, interactive: false,
    }).addTo(trackLayer);
  }
  // dvě střídající se modré – sousední samostatné cesty jdou rozlišit
  const shades = [css("--series-1"), isDarkTheme() ? "#6da7ec" : "#5598e7"];
  let arrows = 0;
  segments.forEach((seg, si) => {
    const from = new Date(seg[0][0] * 1000);
    const to = new Date(seg[seg.length - 1][0] * 1000);
    const shade = shades[si % 2];
    const line = L.polyline(seg.map((p) => [p[1], p[2]]), {
      color: shade,
      weight: 2.5,
      opacity: 0.9,
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
    shape.bindTooltip(`<b>${escapeHtml(p.name)}</b><br>${info}<br><i>kliknutím zobrazíte pobyty</i>`,
      { sticky: true });
    shape.on("click", (ev) => {
      L.DomEvent.stop(ev);
      whenIWasHere(p.lat, p.lon, p.name);
    });
    shape.addTo(myPlacesLayer);
  }
}

$("layerMyPlaces").addEventListener("change", renderMyPlaces);

// ------------------------------------------- kreslení oblasti (polygon)

const drawState = { active: false, pts: [], preview: null };

function drawCleanup() {
  drawState.active = false;
  drawState.pts = [];
  if (drawState.preview) { map.removeLayer(drawState.preview); drawState.preview = null; }
  locLayer.clearLayers();
  map.getContainer().style.cursor = "";
  map.doubleClickZoom.enable();
  $("drawPolyBtn").innerHTML = `${icon("polygon")} Pojmenovat oblast (polygon)`;
}

$("drawPolyBtn").addEventListener("click", () => {
  if (drawState.active) { finishPolygonDraw(); return; }
  drawState.active = true;
  map.doubleClickZoom.disable();
  map.getContainer().style.cursor = "crosshair";
  $("drawPolyBtn").innerHTML = `${icon("check")} Dokončit oblast`;
  toast("Klikáním do mapy obkreslete oblast (min. 3 body), pak Dokončit. Esc zruší.");
});

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
  const name = prompt("Název oblasti (zákazník, sklad, areál…):");
  if (name === null || !name.trim()) { drawCleanup(); return; }
  try {
    await apiFetch("/api/places", {
      method: "POST",
      body: { name: name.trim(), polygon: drawState.pts },
    });
    toast(`Oblast pojmenována: ${name.trim()}`, "success");
  } catch (e) {
    toast("Uložení oblasti selhalo: " + e.message, "error");
  }
  drawCleanup();
  renderMyPlaces();
  loadAll();
}

map.on("dblclick", () => { if (drawState.active) finishPolygonDraw(); });

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
      radius: 3.5,
      color: css("--series-1"),
      weight: 1,
      fillColor: css("--series-1"),
      fillOpacity: 0.55,
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
    color: css("--series-2"),
    fillColor: css("--series-2"),
    fillOpacity: 0.55,
    weight: 1,
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

const TYPE_LABELS = {
  IN_PASSENGER_VEHICLE: "Autem", DRIVING: "Autem", WALKING: "Pěšky",
  RUNNING: "Běh", CYCLING: "Na kole", IN_BUS: "Autobusem", IN_TRAIN: "Vlakem",
  IN_TRAM: "Tramvají", IN_SUBWAY: "Metrem", FLYING: "Letadlem",
  MOTORCYCLING: "Na motorce", IN_FERRY: "Trajektem", SAILING: "Lodí",
  SKIING: "Lyže", UNKNOWN: "Neznámé", UNKNOWN_ACTIVITY_TYPE: "Neznámé",
};
const typeLabel = (t) => TYPE_LABELS[t.replaceAll(" ", "_")]
  || t.replaceAll("_", " ").toLowerCase();

function tile(value, label, extra = "") {
  return `<div class="tile"><div class="value">${value}${extra}</div><div class="label">${label}</div></div>`;
}

/* Šipka ↑/↓ s procenty oproti předchozímu stejně dlouhému období. */
function trend(cur, prev) {
  if (prev == null || !(prev > 0)) return "";
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (!Number.isFinite(pct) || pct === 0) return "";
  const up = pct > 0;
  return `<span class="trend ${up ? "up" : "down"}" ` +
    `title="oproti předchozímu stejně dlouhému období">${up ? "↑" : "↓"}${Math.abs(pct)} %</span>`;
}

/* Miniaturní křivka km po měsících v rohu dlaždice. */
function sparkline(monthly) {
  const vals = (monthly || []).map((m) => m.km);
  if (vals.length < 3) return "";
  const max = Math.max(...vals);
  if (!(max > 0)) return "";
  const W = 58, H = 16;
  const step = W / (vals.length - 1);
  const pts = vals
    .map((v, i) => `${(i * step).toFixed(1)},${(H - 1.5 - (H - 3) * (v / max)).toFixed(1)}`)
    .join(" ");
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">` +
    `<polyline points="${pts}" fill="none" stroke="var(--series-1)" stroke-width="1.5" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

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

/* Kartička nad mapou, když zvolené období nemá žádná data. */
function renderEmptyState(pts) {
  if (!pts) return;   // dotaz zrušen novějším – stav neměnit
  let el = document.getElementById("emptyState");
  if (!el) {
    el = document.createElement("div");
    el.id = "emptyState";
    el.className = "floating";
    el.innerHTML =
      `${icon("pin", 30)}<h3>Ve zvoleném období nejsou žádná data</h3>` +
      '<p class="muted">Zkuste jiné datum, nebo naimportujte export v záložce Nástroje.</p>' +
      '<button class="primary" id="emptyAllBtn">Zobrazit vše</button>';
    document.getElementById("app").appendChild(el);
    el.querySelector("#emptyAllBtn").addEventListener("click", () => {
      $("dateFrom").value = "";
      $("dateTo").value = "";
      loadAll();
    });
  }
  el.hidden = pts.total !== 0;
}

/* Pojmenování místa – název (zákazník, adresa…) se použije všude
   místo souřadnic a lze ho kdykoli změnit stejnou cestou. */
async function renamePlace(lat, lon, currentLabel) {
  const suggestion = /\d+\.\d+/.test(currentLabel || "") ? "" : (currentLabel || "");
  const name = prompt(
    "Název místa (např. Zákazník Novák nebo adresa).\nPrázdný název = zrušit vlastní pojmenování.",
    suggestion);
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

// Obecný sloupcový graf – SVG, jedna řada (modrá), tooltip na hover.
// items: [{label, value, tip?}]; opts: {unit, tickEvery, aria, decimals}
function renderBarChart(el, items, opts = {}) {
  if (!items || items.length < 2 || !items.some((it) => it.value > 0)) {
    el.innerHTML = "";
    return false;
  }
  const unit = opts.unit || "";
  const dec = opts.decimals ?? 0;
  const fmt = (v) => v.toLocaleString("cs", { maximumFractionDigits: dec });

  const W = 308, H = 126, padL = 34, padB = 16, padT = 14;
  const plotW = W - padL - 4, plotH = H - padT - padB;
  const maxV = Math.max(...items.map((it) => it.value), 1e-9);
  const n = items.length;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(18, slot - 2));
  const y = (v) => padT + plotH * (1 - v / maxV);
  const peakIdx = items.findIndex((it) => it.value === maxV);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.aria || ""}">`;
  for (const f of [0.5, 1]) {
    const gy = y(maxV * f);
    svg += `<line class="gridline" x1="${padL}" y1="${gy}" x2="${W - 4}" y2="${gy}"/>`;
    svg += `<text x="${padL - 4}" y="${gy + 3}" text-anchor="end">${fmt(maxV * f)}</text>`;
  }
  items.forEach((it, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const by = y(it.value);
    const h = Math.max(0, padT + plotH - by);
    const r = Math.min(4, barW / 2, h); // zaoblený jen horní konec, ukotveno k základně
    svg += `<path class="bar" data-i="${i}" d="M${x},${padT + plotH} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>`;
    if (i === peakIdx && h > 10)
      svg += `<text class="peak" x="${x + barW / 2}" y="${by - 3}" text-anchor="middle">${fmt(it.value)}</text>`;
  });
  svg += `<line class="baseline" x1="${padL}" y1="${padT + plotH}" x2="${W - 4}" y2="${padT + plotH}"/>`;
  const every = opts.tickEvery || Math.ceil(n / 6);
  items.forEach((it, i) => {
    if (i % every !== 0) return;
    const x = padL + i * slot + slot / 2;
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle">${it.label}</text>`;
  });
  svg += "</svg>";
  el.innerHTML = svg;

  el.querySelectorAll(".bar").forEach((bar) => {
    bar.addEventListener("mousemove", (ev) => {
      const it = items[Number(bar.dataset.i)];
      tooltip.innerHTML =
        `<span class="t-label">${it.tip || it.label}</span> ` +
        `<b>${it.value.toLocaleString("cs", { maximumFractionDigits: 1 })}${unit ? " " + unit : ""}</b>`;
      tooltip.hidden = false;
      tooltip.style.left = ev.clientX + 12 + "px";
      tooltip.style.top = ev.clientY - 10 + "px";
    });
    bar.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  });
  return true;
}

function renderMonthlyChart(monthly) {
  const items = (monthly || []).map((m) => {
    const [yy, mm] = m.month.split("-");
    return { label: `${Number(mm)}/${yy.slice(2)}`, tip: m.month, value: m.km };
  });
  const shown = renderBarChart($("monthlyChart"), items,
    { unit: "km", aria: "Kilometry po měsících" });
  $("monthlyTitle").hidden = !shown;
}

function renderAnalysis(a) {
  renderBarChart($("weekdayChart"),
    a.weekday_km.map((d) => ({ label: d.day, value: d.km })),
    { unit: "km", tickEvery: 1, aria: "Kilometry podle dne v týdnu" });
  renderBarChart($("hourlyChart"),
    a.hourly_points.map((h) => ({ label: String(h.hour), tip: `${h.hour}:00–${h.hour}:59`, value: h.count })),
    { unit: "záznamů", tickEvery: 4, aria: "Počet GPS záznamů podle hodiny dne" });
  $("yearlyList").innerHTML = a.yearly_km.length
    ? a.yearly_km.map((y) =>
        `<div class="typeRow"><span>${y.year} (${y.trips.toLocaleString("cs")} cest)</span>` +
        `<b>${y.km.toLocaleString("cs")} km</b></div>`).join("")
    : '<p class="muted">Žádné rozpoznané cesty v období.</p>';
}

// -------------------------------------------------------- kalendář roku

// sekvenční modrá pro km/den; šedá = data bez rozpoznané jízdy
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
  const gridBg = css("--grid");

  let svg = "";
  const months = [];
  for (let d = new Date(first); d.getFullYear() === calYear; d.setDate(d.getDate() + 1)) {
    const dayIdx = Math.floor((d - first) / 86400000);
    const col = Math.floor((dayIdx + startCol) / 7);
    const row = (dayIdx + startCol) % 7;
    const iso = toDateStr(d);
    const info = byDate.get(iso);
    let fill = "transparent", stroke = gridBg;
    if (info) {
      if (info.km > 0) {
        const idx = Math.min(4, Math.floor((info.km / maxKm) * 5));
        fill = CAL_STEPS[idx];
        stroke = "none";
      } else {
        fill = css("--baseline");   // záznam polohy, ale žádná jízda
        stroke = "none";
      }
    }
    if (d.getDate() === 1) months.push([col, d.toLocaleDateString("cs", { month: "short" })]);
    svg += `<rect x="${col * (cell + gap)}" y="${14 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="0.75" data-d="${iso}"><title>${d.toLocaleDateString("cs")}${info ? ` – ${info.km} km` : ""}</title></rect>`;
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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawState.active) {
    drawCleanup();
    toast("Kreslení oblasti zrušeno.");
    return;
  }
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey) return;
  if (e.key === "ArrowLeft") { shiftDay(-1); }
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

// -------------------------------------------------------- přehrávání dne

const play = { points: [], timer: null, t: 0, marker: null, trail: null, idx: 1 };
window.play = play;   // pro ladění v konzoli

async function playDay() {
  stopPlayback();
  const dateVal = $("playDate").value;
  if (!dateVal) { toast("Vyberte den k přehrání.", "error"); return; }
  const from_ts = dateToTs(dateVal, false);
  const day = await api("/api/day", { from_ts, to_ts: from_ts + 86400 });
  if (day.points.length < 2) {
    playLayer.clearLayers();
    $("playInfo").textContent = "Pro tento den nejsou žádné body.";
    return;
  }
  startPlayback(day);
}

$("playBtn").addEventListener("click", () => {
  if (play.timer) { stopPlayback(); return; }
  playDay();
});

function shiftDay(delta) {
  const val = $("playDate").value;
  if (!val) return;
  const d = new Date(dateToTs(val, false) * 1000);
  d.setDate(d.getDate() + delta);
  $("playDate").value = toDateStr(d);
  playDay();
}
$("dayPrev").addEventListener("click", () => shiftDay(-1));
$("dayNext").addEventListener("click", () => shiftDay(1));

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

function startPlayback(day) {
  playLayer.clearLayers();
  play.points = day.points;
  const pts = play.points;
  play.t = pts[0][0];
  play.idx = 1;
  play.trail = L.layerGroup().addTo(playLayer);
  play.marker = L.circleMarker([pts[0][1], pts[0][2]], {
    radius: 8, color: "#fff", weight: 2,
    fillColor: css("--accent-red"), fillOpacity: 1,
  }).addTo(playLayer);
  map.fitBounds(pts.map((p) => [p[1], p[2]]), { padding: [40, 40] });

  for (const v of day.visits) {
    visitMarker(v).bindTooltip(v.name || v.semantic || "Místo").addTo(playLayer);
  }
  const km = day.activities.reduce((a, x) => a + (x.distance_m || 0), 0) / 1000;
  $("playInfo").textContent =
    `${day.points.length} bodů, ${day.visits.length} návštěv` +
    (km ? `, ${km.toFixed(1)} km dle aktivit` : "") +
    " · barva stopy = rychlost (světlá pomalu, tmavá rychle)";
  renderDayTimeline(day);

  $("playBtn").innerHTML = icon("pause");
  $("playBtn").dataset.state = "playing";
  let last = performance.now();
  play.timer = requestAnimationFrame(function frame(now) {
    const speed = Number($("playSpeed").value);
    play.t += ((now - last) / 1000) * speed;
    last = now;
    if (play.t >= pts[pts.length - 1][0]) { renderPlayhead(pts[pts.length - 1][0]); stopPlayback(); return; }
    renderPlayhead(play.t);
    play.timer = requestAnimationFrame(frame);
  });
}

// Chronologický přehled dne: návštěvy a přesuny pod přehrávačem.
function renderDayTimeline(day) {
  const hm = (ts) => new Date(ts * 1000)
    .toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" });
  const events = [
    ...day.visits.map((v) => ({ ...v, kind: "visit" })),
    ...day.activities.map((a) => ({ ...a, kind: "act" })),
  ].sort((a, b) => a.start_ts - b.start_ts);
  $("dayTimeline").innerHTML = events.map((ev, i) => {
    if (ev.kind === "visit") {
      const hrs = ((ev.end_ts - ev.start_ts) / 3600).toFixed(1);
      return `<li>${icon("pin", 12)} ${hm(ev.start_ts)}–${hm(ev.end_ts)} ` +
        `<a data-i="${i}">${escapeHtml(ev.name || ev.semantic || "Místo")}</a> ` +
        `<span class="muted">(${hrs} h)</span></li>`;
    }
    const km = ((ev.distance_m || 0) / 1000).toFixed(1);
    return `<li>${icon("chevR", 12)} ${hm(ev.start_ts)}–${hm(ev.end_ts)} ${escapeHtml(typeLabel(ev.type))}` +
      (km > 0 ? ` <b>${km} km</b>` : "") + "</li>";
  }).join("");
  $("dayTimeline").querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      const ev = events[Number(a.dataset.i)];
      if (ev.lat) map.flyTo([ev.lat, ev.lon], 16, { duration: 0.8 });
    }));
}

function renderPlayhead(t) {
  const pts = play.points;
  const last = pts.length - 1;
  // posun zpět (slider) → kurzor a stopu postavit znovu od začátku
  if (t < pts[play.idx - 1][0]) {
    play.idx = 1;
    play.trail.clearLayers();
  }
  // kurzor jde jen dopředu; stopa roste přidáváním úseků, ne přestavbou
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
  play.marker.setLatLng([lat, lon]);
  $("playClock").textContent = new Date(t * 1000).toLocaleTimeString("cs");
  $("playSpeedNow").textContent = kmh >= 1 ? `${Math.round(kmh)} km/h` : "";
  const t0 = pts[0][0], t1 = pts[last][0];
  $("playSlider").value = t1 > t0 ? Math.round(((t - t0) / (t1 - t0)) * 1000) : 1000;
}

$("playSlider").addEventListener("input", () => {
  if (!play.points.length) return;
  const t0 = play.points[0][0], t1 = play.points[play.points.length - 1][0];
  play.t = t0 + ((t1 - t0) * Number($("playSlider").value)) / 1000;
  renderPlayhead(play.t);
});

function stopPlayback() {
  if (play.timer) cancelAnimationFrame(play.timer);
  play.timer = null;
  $("playBtn").innerHTML = icon("play");
  $("playBtn").dataset.state = "stopped";
  $("playSpeedNow").textContent = "";
}

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
  if (!confirm(`Smazat ${dry.low_accuracy.toLocaleString("cs")} nepřesných bodů, `
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

// ----------------------------------------------------------------- import

$("importBtn").addEventListener("click", async () => {
  const f = $("importFile").files[0];
  if (!f) { toast("Nejdřív vyberte soubor k importu.", "error"); return; }
  const fd = new FormData();
  fd.append("file", f);
  $("importBtn").disabled = true;
  $("importStatus").textContent = `Nahrávám ${f.name} …`;
  try {
    const res = await fetch("/api/import", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || res.status);
    await watchImport(body.job_id);   // import běží na pozadí, sledujeme průběh
  } catch (e) {
    $("importStatus").textContent = "Import selhal: " + e.message;
    toast("Import selhal", "error");
    $("importBtn").disabled = false;
  }
});

async function watchImport(jobId) {
  const fmt = (v) => v.toLocaleString("cs");
  while (true) {
    let s;
    try {
      s = await api(`/api/import/status/${jobId}`);
    } catch (e) {
      $("importStatus").textContent = "Nelze zjistit stav importu: " + e.message;
      break;
    }
    if (s.status === "running") {
      $("importStatus").textContent =
        `Zpracovávám… +${fmt(s.points)} bodů, +${fmt(s.visits)} návštěv, +${fmt(s.activities)} aktivit`;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (s.status === "done") {
      $("importStatus").textContent =
        `Hotovo: +${fmt(s.points)} bodů, +${fmt(s.visits)} návštěv, ` +
        `+${fmt(s.activities)} aktivit (${s.files} souborů).`;
      toast("Import dokončen.", "success");
      state.fitted = false;
      loadAll();
    } else {
      $("importStatus").textContent = "Import selhal: " + s.error;
      toast("Import selhal", "error");
    }
    break;
  }
  $("importBtn").disabled = false;
}

$("backupBtn").addEventListener("click", () => { location.href = "/api/backup"; });

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
  readHash();   // obnovit pohled a období z adresy (záložky, sdílení, reload)
  $("playDate").value = toDateStr(new Date());
  try {
    const r = await api("/api/range");
    if (r.max_ts) {
      $("playDate").value = toDateStr(new Date(r.max_ts * 1000));
      calYear = new Date(r.max_ts * 1000).getFullYear();
    }
    if (!r.points && !r.visits) {
      // prázdná databáze → navést uživatele rovnou k importu
      document.querySelector('#tabs [data-tab="nastroje"]').click();
      $("importStatus").textContent =
        "Začněte zde: nahrajte Timeline.json z telefonu nebo ZIP z Takeoutu.";
      toast("Zatím nejsou žádná data – začněte importem exportu z Google Maps.");
    }
  } catch (e) { /* server nedostupný – ukáže se při Načíst */ }
  showAutoImportLog();
  renderCalendar();
  loadAll();
})();
