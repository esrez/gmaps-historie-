/* GMaps Historie – frontendová logika */
"use strict";

const $ = (id) => document.getElementById(id);
const tooltip = $("tooltip");

const map = L.map("map").setView([49.8, 15.5], 7); // výchozí pohled na ČR
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const trackLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const visitLayer = L.layerGroup().addTo(map);
const playLayer = L.layerGroup().addTo(map);
const locLayer = L.layerGroup().addTo(map);
const canvasRenderer = L.canvas({ padding: 0.3 });
let heatLayer = null;

const state = { points: [], heatCells: [], visits: [], fitted: false };

const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------------------------------------------------------------- období

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateToTs(value, endOfDay) {
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0);
  return Math.floor(dt.getTime() / 1000) + (endOfDay ? 86400 : 0);
}

function currentRange() {
  const f = $("dateFrom").value, t = $("dateTo").value;
  return {
    from_ts: f ? dateToTs(f, false) : null,
    to_ts: t ? dateToTs(t, true) : null,
  };
}

function setPreset(days) {
  const today = new Date();
  if (days === "all") {
    $("dateFrom").value = "";
    $("dateTo").value = "";
  } else {
    const from = new Date(today.getTime() - days * 86400 * 1000);
    $("dateFrom").value = toDateStr(from);
    $("dateTo").value = toDateStr(today);
  }
  loadAll();
}

document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => setPreset(b.dataset.days === "all" ? "all" : Number(b.dataset.days))));
$("loadBtn").addEventListener("click", loadAll);

// ------------------------------------------------------------------ API

async function api(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {}))
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadAll() {
  const r = currentRange();
  $("loadBtn").disabled = true;
  try {
    const tz = -new Date().getTimezoneOffset();
    const [pts, heat, visits, stats] = await Promise.all([
      api("/api/points", r),
      api("/api/heatmap", r),
      api("/api/visits", r),
      api("/api/stats", { ...r, tz_offset_min: tz }),
    ]);
    state.points = pts.points;
    state.heatCells = heat.cells;
    state.visits = visits.visits;
    renderTracks();
    renderPoints();
    renderHeat();
    renderVisits();
    renderStats(stats, pts);
    if (!state.fitted) fitToData();
  } catch (e) {
    alert("Načtení selhalo: " + e.message);
  } finally {
    $("loadBtn").disabled = false;
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
  for (const seg of splitSegments(state.points)) {
    L.polyline(seg.map((p) => [p[1], p[2]]), {
      color: css("--series-1"),
      weight: 2,
      opacity: 0.75,
    }).addTo(trackLayer);
  }
}

function renderPoints() {
  pointLayer.clearLayers();
  if (!$("layerPoints").checked) return;
  const pts = state.points;
  const step = Math.max(1, Math.ceil(pts.length / 20000)); // strop kvůli plynulosti
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    L.circleMarker([p[1], p[2]], {
      renderer: canvasRenderer,
      radius: 3.5,
      color: css("--series-1"),
      weight: 1,
      fillColor: css("--series-1"),
      fillOpacity: 0.55,
    }).bindTooltip(new Date(p[0] * 1000).toLocaleString("cs"))
      .on("click", () => whenIWasHere(p[1], p[2]))
      .addTo(pointLayer);
  }
}

function renderHeat() {
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  if (!$("layerHeat").checked || !state.heatCells.length) return;
  const maxC = Math.max(...state.heatCells.map((c) => c[2]));
  const data = state.heatCells.map((c) => [c[0], c[1], Math.log(1 + c[2]) / Math.log(1 + maxC)]);
  heatLayer = L.heatLayer(data, { radius: 12, blur: 18, maxZoom: 17, max: 1.0 }).addTo(map);
}

function renderVisits() {
  visitLayer.clearLayers();
  if (!$("layerVisits").checked) return;
  for (const v of state.visits) {
    const from = new Date(v.start_ts * 1000), to = new Date(v.end_ts * 1000);
    const hours = ((v.end_ts - v.start_ts) / 3600).toFixed(1);
    L.circleMarker([v.lat, v.lon], {
      radius: 5,
      color: css("--series-2"),
      fillColor: css("--series-2"),
      fillOpacity: 0.6,
      weight: 1,
    }).bindPopup(
      `<b>${escapeHtml(v.name || v.semantic || "Místo")}</b><br>` +
      (v.address ? escapeHtml(v.address) + "<br>" : "") +
      `${from.toLocaleString("cs")} – ${to.toLocaleTimeString("cs")}<br>${hours} h`
    ).addTo(visitLayer);
  }
}

["layerTracks", "layerPoints", "layerHeat", "layerVisits"].forEach((id) =>
  $(id).addEventListener("change", () => {
    renderTracks();
    renderPoints();
    renderHeat();
    renderVisits();
  }));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ------------------------------------------------------------ statistiky

const TYPE_LABELS = {
  "IN_PASSENGER_VEHICLE": "Autem", "IN PASSENGER VEHICLE": "Autem",
  "DRIVING": "Autem", "WALKING": "Pěšky", "RUNNING": "Běh",
  "CYCLING": "Na kole", "IN_BUS": "Autobusem", "IN BUS": "Autobusem",
  "IN_TRAIN": "Vlakem", "IN TRAIN": "Vlakem", "IN_TRAM": "Tramvají",
  "IN TRAM": "Tramvají", "IN_SUBWAY": "Metrem", "IN SUBWAY": "Metrem",
  "FLYING": "Letadlem", "MOTORCYCLING": "Na motorce", "IN_FERRY": "Trajektem",
  "SAILING": "Lodí", "SKIING": "Lyže", "UNKNOWN": "Neznámé",
  "UNKNOWN_ACTIVITY_TYPE": "Neznámé",
};
const typeLabel = (t) => TYPE_LABELS[t] || t.replaceAll("_", " ").toLowerCase();

function tile(value, label) {
  return `<div class="tile"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

function renderStats(s, pts) {
  $("statTiles").innerHTML =
    tile(s.total_km.toLocaleString("cs"), "km celkem") +
    tile(s.days_with_data.toLocaleString("cs"), "dní se záznamem") +
    tile(s.visits.toLocaleString("cs"), "návštěv míst") +
    tile(s.visit_hours.toLocaleString("cs"), "hodin na místech");

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
      `<li><a data-i="${i}">${escapeHtml(p.label)}</a> — ${p.count}×, ${p.hours.toLocaleString("cs")} h</li>`)
    .join("");
  $("topPlaces").querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      const p = s.top_places[Number(a.dataset.i)];
      map.setView([p.lat, p.lon], 15);
    }));

  $("dbInfo").textContent =
    `Zobrazeno ${pts.sampled.toLocaleString("cs")} z ${pts.total.toLocaleString("cs")} bodů` +
    (pts.step > 1 ? ` (vzorkování 1:${pts.step})` : "");
}

// Sloupcový graf km/měsíc – SVG, jedna řada (modrá), tooltip na hover.
function renderMonthlyChart(monthly) {
  const el = $("monthlyChart");
  if (!monthly || monthly.length < 2) {
    el.innerHTML = "";
    $("monthlyTitle").hidden = true;
    return;
  }
  $("monthlyTitle").hidden = false;

  const W = 308, H = 126, padL = 30, padB = 16, padT = 14;
  const plotW = W - padL - 4, plotH = H - padT - padB;
  const maxKm = Math.max(...monthly.map((m) => m.km), 1);
  const n = monthly.length;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(18, slot - 2));
  const y = (km) => padT + plotH * (1 - km / maxKm);
  const peakIdx = monthly.findIndex((m) => m.km === maxKm);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kilometry po měsících">`;
  for (const f of [0.5, 1]) {
    const gy = y(maxKm * f);
    svg += `<line class="gridline" x1="${padL}" y1="${gy}" x2="${W - 4}" y2="${gy}"/>`;
    svg += `<text x="${padL - 4}" y="${gy + 3}" text-anchor="end">${Math.round(maxKm * f).toLocaleString("cs")}</text>`;
  }
  monthly.forEach((m, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const by = y(m.km);
    const h = Math.max(0, padT + plotH - by);
    const r = Math.min(4, barW / 2, h); // zaoblený jen horní konec, ukotveno k základně
    svg += `<path class="bar" data-i="${i}" d="M${x},${padT + plotH} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>`;
    if (i === peakIdx && h > 10)
      svg += `<text class="peak" x="${x + barW / 2}" y="${by - 3}" text-anchor="middle">${Math.round(m.km).toLocaleString("cs")}</text>`;
  });
  svg += `<line class="baseline" x1="${padL}" y1="${padT + plotH}" x2="${W - 4}" y2="${padT + plotH}"/>`;
  const every = Math.ceil(n / 6);
  monthly.forEach((m, i) => {
    if (i % every !== 0) return;
    const x = padL + i * slot + slot / 2;
    const [yy, mm] = m.month.split("-");
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle">${Number(mm)}/${yy.slice(2)}</text>`;
  });
  svg += "</svg>";
  el.innerHTML = svg;

  el.querySelectorAll(".bar").forEach((bar) => {
    bar.addEventListener("mousemove", (ev) => {
      const m = monthly[Number(bar.dataset.i)];
      tooltip.innerHTML = `<span class="t-label">${m.month}</span> <b>${m.km.toLocaleString("cs")} km</b>`;
      tooltip.hidden = false;
      tooltip.style.left = ev.clientX + 12 + "px";
      tooltip.style.top = ev.clientY - 10 + "px";
    });
    bar.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  });
}

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
      `<span class="muted"> — ${r.count}×, ${r.hours.toLocaleString("cs")} h</span></li>`).join("") + "</ul>";
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
      map.setView([lat, lon], 15);
      whenIWasHere(lat, lon, a.dataset.kind === "mine" ? r.label : r.display_name);
    }));
}

map.on("click", (e) => {
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
    const res = await api("/api/at_location", { lat, lon, radius_m: radius, ...r });
    const hrs = (res.total_s / 3600).toLocaleString("cs", { maximumFractionDigits: 1 });
    $("locSummary").textContent = res.count
      ? `${res.count}× ve zvoleném období, celkem ${hrs} h`
      : "Ve zvoleném období tu žádný pobyt není. Zkuste větší okruh nebo období Vše.";
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

$("locRadius").addEventListener("change", () => {
  if (loc.lat !== null) whenIWasHere(loc.lat, loc.lon, loc.label);
});
$("locCloseBtn").addEventListener("click", () => {
  $("locPanel").hidden = true;
  locLayer.clearLayers();
});
$("locExportBtn").addEventListener("click", () => {
  if (loc.lat === null) return;
  const r = currentRange();
  location.href = buildUrl("/api/export_location.xlsx", {
    lat: loc.lat, lon: loc.lon, radius_m: Number($("locRadius").value),
    ...r, tz_offset_min: -new Date().getTimezoneOffset(), label: loc.label,
  });
});

// ---------------------------------------------------------------- exporty

function buildUrl(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {}))
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

$("exportXlsx").addEventListener("click", () => {
  location.href = buildUrl("/api/export.xlsx",
    { ...currentRange(), tz_offset_min: -new Date().getTimezoneOffset() });
});
$("exportGpx").addEventListener("click", () => {
  location.href = buildUrl("/api/export.gpx", currentRange());
});

// -------------------------------------------------------- přehrávání dne

const play = { points: [], timer: null, t: 0, marker: null, trail: null };

async function playDay() {
  stopPlayback();
  const dateVal = $("playDate").value;
  if (!dateVal) { alert("Vyberte den k přehrání."); return; }
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

function startPlayback(day) {
  playLayer.clearLayers();
  play.points = day.points;
  const pts = play.points;
  play.t = pts[0][0];
  play.trail = L.polyline([], { color: css("--accent-red"), weight: 3 }).addTo(playLayer);
  play.marker = L.circleMarker([pts[0][1], pts[0][2]], {
    radius: 8, color: "#fff", weight: 2,
    fillColor: css("--accent-red"), fillOpacity: 1,
  }).addTo(playLayer);
  map.fitBounds(pts.map((p) => [p[1], p[2]]), { padding: [40, 40] });

  for (const v of day.visits) {
    L.circleMarker([v.lat, v.lon], {
      radius: 5, color: css("--series-2"), fillColor: css("--series-2"), fillOpacity: 0.5, weight: 1,
    }).bindTooltip(v.name || v.semantic || "Místo").addTo(playLayer);
  }
  const km = day.activities.reduce((a, x) => a + (x.distance_m || 0), 0) / 1000;
  $("playInfo").textContent =
    `${day.points.length} bodů, ${day.visits.length} návštěv` +
    (km ? `, ${km.toFixed(1)} km dle aktivit` : "");

  $("playBtn").textContent = "⏸ Zastavit";
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

function renderPlayhead(t) {
  const pts = play.points;
  let i = pts.findIndex((p) => p[0] > t);
  if (i < 1) i = 1;
  const a = pts[i - 1], b = pts[i] || a;
  const gap = b[0] - a[0];
  const f = gap > 0 && gap < 900 ? Math.min(1, (t - a[0]) / gap) : 0;
  const lat = a[1] + (b[1] - a[1]) * f, lon = a[2] + (b[2] - a[2]) * f;
  play.marker.setLatLng([lat, lon]);
  play.trail.setLatLngs(pts.slice(0, i).map((p) => [p[1], p[2]]).concat([[lat, lon]]));
  $("playClock").textContent = new Date(t * 1000).toLocaleTimeString("cs");
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  $("playSlider").value = Math.round(((t - t0) / (t1 - t0)) * 1000);
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
  $("playBtn").textContent = "▶ Přehrát";
}

// ----------------------------------------------------------------- import

$("importBtn").addEventListener("click", async () => {
  const f = $("importFile").files[0];
  if (!f) { alert("Vyberte soubor k importu."); return; }
  const fd = new FormData();
  fd.append("file", f);
  $("importBtn").disabled = true;
  $("importStatus").textContent = `Nahrávám a zpracovávám ${f.name} … (u velkých souborů to může trvat minuty)`;
  try {
    const res = await fetch("/api/import", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || res.status);
    $("importStatus").textContent =
      `Hotovo: +${body.points.toLocaleString("cs")} bodů, +${body.visits.toLocaleString("cs")} návštěv, ` +
      `+${body.activities.toLocaleString("cs")} aktivit (${body.files} souborů).`;
    state.fitted = false;
    loadAll();
  } catch (e) {
    $("importStatus").textContent = "Import selhal: " + e.message;
  } finally {
    $("importBtn").disabled = false;
  }
});

// ------------------------------------------------------------------ start

(async function init() {
  $("playDate").value = toDateStr(new Date());
  try {
    const r = await api("/api/range");
    if (r.max_ts) $("playDate").value = toDateStr(new Date(r.max_ts * 1000));
  } catch (e) { /* prázdná DB */ }
  loadAll();
})();
