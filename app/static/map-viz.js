/* Vizuální možnosti mapy: barvy tras, palety heatmapy, legendy. */

export const YEAR_COLORS = ["#2a78d6", "#1baf7a", "#e0810f", "#8a5cd6", "#d64583", "#0f9bb0"];

export function yearColor(y) {
  return YEAR_COLORS[((y % YEAR_COLORS.length) + YEAR_COLORS.length) % YEAR_COLORS.length];
}

export function segYear(seg) {
  return new Date(seg[0][0] * 1000).getFullYear();
}

/* Stejné prahy jako stopa přehrávání dne – legenda i barvy sedí k sobě. */
export const SPEED_STEPS = [
  [6, "#9ec5f4", "pěšky"],
  [25, "#6da7ec", "město"],
  [60, "#3987e5", "silnice"],
  [100, "#256abf", "rychle"],
  [Infinity, "#0d366b", "dálnice"],
];

export function speedColor(kmh) {
  for (const [limit, color] of SPEED_STEPS)
    if (kmh < limit) return color;
  return SPEED_STEPS[SPEED_STEPS.length - 1][1];
}

export function segmentSpeedKmh(a, b) {
  const dt = b[0] - a[0];
  if (dt <= 0 || dt > 900) return 0;
  const dLat = (b[1] - a[1]) * 111;
  const dLon = (b[2] - a[2]) * 111 * Math.cos((a[1] * Math.PI) / 180);
  return (Math.hypot(dLat, dLon) / dt) * 3600;
}

export function segAvgKmh(seg) {
  let dist = 0;
  let time = 0;
  for (let i = 1; i < seg.length; i++) {
    const dt = seg[i][0] - seg[i - 1][0];
    if (dt <= 0 || dt > 900) continue;
    const dLat = (seg[i][1] - seg[i - 1][1]) * 111;
    const dLon = (seg[i][2] - seg[i - 1][2]) * 111
      * Math.cos((seg[i - 1][1] * Math.PI) / 180);
    dist += Math.hypot(dLat, dLon);
    time += dt;
  }
  return time > 0 ? (dist / time) * 3600 : 0;
}

export const HOUR_BUCKETS = [
  { label: "noc 22–5", color: "#3d4a8a", test: (h) => h >= 22 || h < 5 },
  { label: "ráno 5–9", color: "#e0810f", test: (h) => h >= 5 && h < 9 },
  { label: "den 9–17", color: "#2a78d6", test: (h) => h >= 9 && h < 17 },
  { label: "večer 17–22", color: "#8a5cd6", test: (h) => h >= 17 && h < 22 },
];

export function hourColor(h) {
  for (const b of HOUR_BUCKETS)
    if (b.test(h)) return b.color;
  return HOUR_BUCKETS[2].color;
}

export function segHour(seg) {
  const mid = seg[Math.floor(seg.length / 2)];
  return new Date(mid[0] * 1000).getHours();
}

export const HEAT_PALETTES = {
  classic: { 0.4: "blue", 0.6: "cyan", 0.7: "lime", 0.8: "yellow", 1: "red" },
  fire: { 0.2: "#2b0000", 0.45: "#c0392b", 0.7: "#e67e22", 0.88: "#f1c40f", 1: "#fff6c2" },
  cool: { 0.25: "#0b1d36", 0.5: "#1b4f8a", 0.72: "#5fa8d3", 0.9: "#b8e0f5", 1: "#f0fbff" },
  teal: { 0.2: "#06281f", 0.45: "#0b6b4f", 0.7: "#1baf7a", 0.88: "#7dcea0", 1: "#e8f8f5" },
};

export function heatGradientCss(palette) {
  const g = HEAT_PALETTES[palette] || HEAT_PALETTES.classic;
  const stops = Object.entries(g)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([p, c]) => `${c} ${Math.round(Number(p) * 100)}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export function readTrackStyle() {
  const weight = Number(document.getElementById("trackWeight")?.value || 2.5);
  const opacity = Number(document.getElementById("trackOpacity")?.value || 0.9);
  return {
    weight: Number.isFinite(weight) ? weight : 2.5,
    opacity: Number.isFinite(opacity) ? opacity : 0.9,
  };
}

export function readHeatStyle() {
  const radius = Number(document.getElementById("heatRadius")?.value || 12);
  const palette = document.getElementById("heatPalette")?.value || "classic";
  const r = Number.isFinite(radius) ? radius : 12;
  return {
    radius: r,
    blur: Math.round(r * 1.5),
    maxZoom: 17,
    max: 1.0,
    gradient: HEAT_PALETTES[palette] || HEAT_PALETTES.classic,
    palette,
  };
}

function legendBox(id, parentId) {
  let box = document.getElementById(id);
  if (!box) {
    box = document.createElement("div");
    box.id = id;
    const parent = document.getElementById(parentId);
    if (!parent) return null;
    parent.prepend(box);
  }
  return box;
}

function chip(color, label) {
  return `<span class="lg-year"><span class="lg-line" style="background:${color}"></span>${label}</span>`;
}

/* Dynamická legenda nad statickou legendou vrstev. */
export function renderTrackLegend(mode, years) {
  const box = legendBox("trackVizLegend", "mapLegend");
  if (!box) return;
  if (mode === "year" && years && years.length) {
    box.innerHTML = years.map((y) => chip(yearColor(y), String(y))).join(" ");
    box.hidden = false;
    return;
  }
  if (mode === "speed") {
    box.innerHTML = SPEED_STEPS.map(([, color, label]) => chip(color, label)).join(" ");
    box.hidden = false;
    return;
  }
  if (mode === "hour") {
    box.innerHTML = HOUR_BUCKETS.map((b) => chip(b.color, b.label)).join(" ");
    box.hidden = false;
    return;
  }
  box.innerHTML = "";
  box.hidden = true;
}

export function renderHeatLegend(on, palette) {
  const box = legendBox("heatVizLegend", "mapLegend");
  if (!box) return;
  if (!on) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML =
    `<span class="lg-heat"><span class="lg-heatBar" style="background:${heatGradientCss(palette)}"></span>`
    + "heatmapa: málo → hodně</span>";
}

export function trackColorFn(mode, shadePair) {
  if (mode === "year") return (seg) => yearColor(segYear(seg));
  if (mode === "speed") return (seg) => speedColor(segAvgKmh(seg));
  if (mode === "hour") return (seg) => hourColor(segHour(seg));
  return (_seg, i) => shadePair[i % 2];
}

export function trackLegendYears(mode, segments) {
  if (mode !== "year") return null;
  return [...new Set(segments.map(segYear))].sort();
}
