/* Grafy a dlaždice statistik – čistý „listový" modul bez vazby na mapu.
   Importuje jen sdílené helpery; volá se z app.js. */
import { $, escapeHtml } from "./common.js";
import { icon } from "./icons.js";

const tooltip = $("tooltip");

export const TYPE_LABELS = {
  IN_PASSENGER_VEHICLE: "Autem", DRIVING: "Autem", WALKING: "Pěšky",
  RUNNING: "Běh", CYCLING: "Na kole", IN_BUS: "Autobusem", IN_TRAIN: "Vlakem",
  IN_TRAM: "Tramvají", IN_SUBWAY: "Metrem", FLYING: "Letadlem",
  MOTORCYCLING: "Na motorce", IN_FERRY: "Trajektem", SAILING: "Lodí",
  SKIING: "Lyže", UNKNOWN: "Neznámé", UNKNOWN_ACTIVITY_TYPE: "Neznámé",
};
export const typeLabel = (t) => TYPE_LABELS[t.replaceAll(" ", "_")]
  || t.replaceAll("_", " ").toLowerCase();

export function tile(value, label, extra = "") {
  return `<div class="tile"><div class="value">${value}${extra}</div><div class="label">${label}</div></div>`;
}

/* Šipka ↑/↓ s procenty oproti předchozímu stejně dlouhému období. */
export function trend(cur, prev) {
  if (prev == null || !(prev > 0)) return "";
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (!Number.isFinite(pct) || pct === 0) return "";
  const up = pct > 0;
  return `<span class="trend ${up ? "up" : "down"}" ` +
    `title="oproti předchozímu stejně dlouhému období">${up ? "↑" : "↓"}${Math.abs(pct)} %</span>`;
}

/* Miniaturní křivka km po měsících v rohu dlaždice. */
export function sparkline(monthly) {
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

/* Rekordy období: nejdelší den, nejdelší cesta, nejdelší série dní s jízdou. */
export function renderRecords(r) {
  const box = $("records");
  if (!r) { box.innerHTML = ""; return; }
  const fmtDay = (d) => new Date(d).toLocaleDateString("cs",
    { day: "numeric", month: "numeric", year: "numeric" });
  const rows = [];
  if (r.longest_day) {
    rows.push([icon("calendar", 13), "Nejvíc za den",
      `${r.longest_day.km.toLocaleString("cs")} km`, fmtDay(r.longest_day.date)]);
  }
  if (r.longest_trip) {
    rows.push([icon("car", 13), "Nejdelší cesta",
      `${r.longest_trip.km.toLocaleString("cs")} km`, fmtDay(r.longest_trip.date)]);
  }
  if (r.longest_streak_days > 1) {
    rows.push([icon("refresh", 13), "Série dní s jízdou",
      `${r.longest_streak_days} dní`, "po sobě jdoucích"]);
  }
  box.innerHTML = rows.length
    ? "<h3>Rekordy období</h3>" + rows.map(([ic, label, val, sub]) =>
        `<div class="recRow">${ic}<span>${label}</span>` +
        `<b>${val}</b><span class="muted">${escapeHtml(sub)}</span></div>`).join("")
    : "";
}

// Obecný sloupcový graf – SVG, jedna řada (modrá), tooltip na hover.
// items: [{label, value, tip?}]; opts: {unit, tickEvery, aria, decimals}
export function renderBarChart(el, items, opts = {}) {
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

export function renderMonthlyChart(monthly) {
  const items = (monthly || []).map((m) => {
    const [yy, mm] = m.month.split("-");
    return { label: `${Number(mm)}/${yy.slice(2)}`, tip: m.month, value: m.km };
  });
  const shown = renderBarChart($("monthlyChart"), items,
    { unit: "km", aria: "Kilometry po měsících" });
  $("monthlyTitle").hidden = !shown;
}

export function renderAnalysis(a) {
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
