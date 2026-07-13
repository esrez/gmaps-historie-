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
  // velká čísla na ose kompaktně („729 tis."), jinak by se ořezávala vlevo
  const fmt = (v) => v >= 10000
    ? v.toLocaleString("cs", { notation: "compact", maximumFractionDigits: 0 })
    : v.toLocaleString("cs", { maximumFractionDigits: dec });

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

/* Skupiny dopravy pro skládaný graf – pevné pořadí i barvy (barva sleduje
   kategorii, nikdy pořadí v datech; „Ostatní" je neutrální šedá). */
const TRANSPORT_GROUPS = [
  { key: "car", label: "Autem", color: "var(--cat-1)" },
  { key: "walk", label: "Pěšky", color: "var(--cat-2)" },
  { key: "transit", label: "MHD/vlak", color: "var(--cat-3)" },
  { key: "bike", label: "Na kole", color: "var(--cat-4)" },
  { key: "other", label: "Ostatní", color: "var(--cat-other)" },
];

/* Skládaný sloupcový graf km po měsících podle dopravy. Mezi dílky sloupce
   jsou 2px mezery v barvě plochy, tooltip ukazuje rozpad celého měsíce. */
export function renderTransportChart(rows) {
  const el = $("transportChart");
  const legend = $("transportLegend");
  const used = TRANSPORT_GROUPS.filter((g) => (rows || []).some((r) => r[g.key] > 0));
  const total = (r) => used.reduce((a, g) => a + (r[g.key] || 0), 0);
  if (!rows || rows.length < 2 || !used.length) {
    el.innerHTML = ""; legend.innerHTML = "";
    return false;
  }
  const W = 308, H = 132, padL = 34, padB = 16, padT = 6;
  const plotW = W - padL - 4, plotH = H - padT - padB;
  const maxV = Math.max(...rows.map(total), 1e-9);
  const n = rows.length;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(18, slot - 2));
  const fmt = (v) => v >= 10000
    ? v.toLocaleString("cs", { notation: "compact", maximumFractionDigits: 0 })
    : v.toLocaleString("cs", { maximumFractionDigits: 0 });

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kilometry po měsících podle druhu dopravy">`;
  for (const f of [0.5, 1]) {
    const gy = padT + plotH * (1 - f);
    svg += `<line class="gridline" x1="${padL}" y1="${gy}" x2="${W - 4}" y2="${gy}"/>`;
    svg += `<text x="${padL - 4}" y="${gy + 3}" text-anchor="end">${fmt(maxV * f)}</text>`;
  }
  rows.forEach((r, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    let yTop = padT + plotH;
    used.forEach((g, gi) => {
      const v = r[g.key] || 0;
      if (v <= 0) return;
      const h = plotH * (v / maxV);
      yTop -= h;
      const isTop = used.slice(gi + 1).every((g2) => !(r[g2.key] > 0));
      const rr = isTop ? Math.min(3, barW / 2, h) : 0;   // zaoblený jen vršek sloupce
      svg += `<path class="bar seg" data-i="${i}" fill="${g.color}" d="M${x},${yTop + h} v${-(h - rr)} q0,${-rr} ${rr},${-rr} h${barW - 2 * rr} q${rr},0 ${rr},${rr} v${h - rr} z"/>`;
    });
  });
  svg += `<line class="baseline" x1="${padL}" y1="${padT + plotH}" x2="${W - 4}" y2="${padT + plotH}"/>`;
  const every = Math.ceil(n / 6);
  rows.forEach((r, i) => {
    if (i % every !== 0) return;
    const [yy, mm] = r.month.split("-");
    svg += `<text x="${padL + i * slot + slot / 2}" y="${H - 4}" text-anchor="middle">${Number(mm)}/${yy.slice(2)}</text>`;
  });
  svg += "</svg>";
  el.innerHTML = svg;

  legend.innerHTML = used.map((g) =>
    `<span class="lg-chip"><i style="background:${g.color}"></i>${g.label}</span>`).join("");

  el.querySelectorAll(".seg").forEach((seg) => {
    seg.addEventListener("mousemove", (ev) => {
      const r = rows[Number(seg.dataset.i)];
      const parts = used.filter((g) => r[g.key] > 0)
        .map((g) => `${g.label} <b>${r[g.key].toLocaleString("cs")} km</b>`);
      tooltip.innerHTML = `<span class="t-label">${r.month}</span> ` +
        `${parts.join(" · ")} · celkem <b>${total(r).toLocaleString("cs", { maximumFractionDigits: 1 })} km</b>`;
      tooltip.hidden = false;
      tooltip.style.left = ev.clientX + 12 + "px";
      tooltip.style.top = ev.clientY - 10 + "px";
    });
    seg.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  });
  return true;
}

/* Nejčastější trasy (odkud ⇄ kam, kolikrát, průměrné km). */
export function renderTopRoutes(routes) {
  const el = $("topRoutes");
  if (!routes || !routes.length) {
    el.innerHTML = '<p class="muted">Zatím nejsou rozpoznané opakované trasy ' +
      "mezi pojmenovanými místy (potřebují návštěvy míst z exportu telefonu).</p>";
    return;
  }
  const max = routes[0].count;
  el.innerHTML = routes.map((r) =>
    `<div class="routeRow">` +
    `<span class="routeName">${escapeHtml(r.from)} ⇄ ${escapeHtml(r.to)}</span>` +
    `<span class="routeBar"><i style="width:${Math.max(6, (r.count / max) * 100)}%"></i></span>` +
    `<b>${r.count}×</b>` +
    `<span class="muted">${r.km_avg != null ? "Ø " + r.km_avg.toLocaleString("cs") + " km" : ""}</span>` +
    `</div>`).join("");
}

/* Všední dny vs. víkend – souhrnný řádek nad grafem dnů v týdnu. */
export function renderWorkWeekend(weekdayKm) {
  const el = $("workWeekend");
  const work = weekdayKm.slice(0, 5).reduce((a, d) => a + d.km, 0);
  const wkend = weekdayKm.slice(5).reduce((a, d) => a + d.km, 0);
  const sum = work + wkend;
  if (!(sum > 0)) { el.innerHTML = ""; return; }
  const pw = Math.round((work / sum) * 100);
  el.innerHTML =
    `<div class="wwBar"><i class="ww-work" style="width:${pw}%"></i>` +
    `<i class="ww-end" style="width:${100 - pw}%"></i></div>` +
    `<div class="wwLabels"><span><i class="dot ww-work"></i>Všední dny ` +
    `<b>${work.toLocaleString("cs", { maximumFractionDigits: 0 })} km</b> (${pw} %)</span>` +
    `<span><i class="dot ww-end"></i>Víkend ` +
    `<b>${wkend.toLocaleString("cs", { maximumFractionDigits: 0 })} km</b> (${100 - pw} %)</span></div>`;
}

/* Rytmus týdne (punchcard): den × hodina, velikost kolečka = kolik záznamů.
   Jedna barva (sekvenční kódování velikostí), tooltip s přesným počtem. */
export function renderPunchcard(el, cells) {
  if (!cells || !cells.length) { el.innerHTML = ""; return false; }
  const DAYS = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];
  const toRow = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };  // %w → Po..Ne
  const grid = new Map(cells.map(([w, h, c]) => [`${toRow[w]}-${h}`, c]));
  const maxC = Math.max(...cells.map((c) => c[2]), 1);
  const cw = 12.4, rh = 15, padL = 26, padT = 6;
  const W = padL + 24 * cw + 4, H = padT + 7 * rh + 16;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Aktivita podle dne v týdnu a hodiny">`;
  DAYS.forEach((d, r) => {
    svg += `<text x="${padL - 6}" y="${padT + r * rh + 10}" text-anchor="end">${d}</text>`;
  });
  for (let h = 0; h < 24; h += 4) {
    svg += `<text x="${padL + h * cw + cw / 2}" y="${H - 3}" text-anchor="middle">${h}</text>`;
  }
  for (let r = 0; r < 7; r++) {
    for (let h = 0; h < 24; h++) {
      const c = grid.get(`${r}-${h}`) || 0;
      if (!c) continue;
      const rad = 1.4 + 4.4 * Math.sqrt(c / maxC);
      svg += `<circle class="pc" data-d="${DAYS[r]}" data-h="${h}" data-c="${c}" ` +
        `cx="${padL + h * cw + cw / 2}" cy="${padT + r * rh + rh / 2}" r="${rad.toFixed(1)}"/>`;
    }
  }
  svg += "</svg>";
  el.innerHTML = svg;
  el.querySelectorAll(".pc").forEach((dot) => {
    dot.addEventListener("mousemove", (ev) => {
      tooltip.innerHTML = `<span class="t-label">${dot.dataset.d} ${dot.dataset.h}:00–${dot.dataset.h}:59</span> ` +
        `<b>${Number(dot.dataset.c).toLocaleString("cs")} záznamů</b>`;
      tooltip.hidden = false;
      tooltip.style.left = ev.clientX + 12 + "px";
      tooltip.style.top = ev.clientY - 10 + "px";
    });
    dot.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  });
  return true;
}

/* Zajímavosti: akční rádius, noci mimo domov, typický den, nejdál od domova. */
export function renderInsightFacts(el, ins) {
  const rows = [];
  const fmtKm = (m) => (m / 1000).toLocaleString("cs", { maximumFractionDigits: 1 });
  if (ins.radius) {
    rows.push([icon("target", 13), "Akční rádius",
      `${fmtKm(ins.radius.p90_m)} km`,
      `90 % záznamů do této vzdálenosti od: ${escapeHtml(ins.home.label)}`]);
  }
  if (ins.farthest) {
    rows.push([icon("pin", 13), "Nejdál od domova",
      `${ins.farthest.km.toLocaleString("cs")} km`,
      new Date(ins.farthest.date).toLocaleDateString("cs")]);
  }
  if (ins.away_nights != null) {
    rows.push([icon("moon", 13), "Nocí mimo domov",
      `${ins.away_nights}`, "poslední bod dne dál než 30 km"]);
  }
  if (ins.first_move && ins.last_move) {
    rows.push([icon("sun", 13), "Typický všední den",
      `${ins.first_move} – ${ins.last_move}`, "první a poslední pohyb (medián)"]);
  }
  el.innerHTML = rows.length
    ? rows.map(([ic, label, val, sub]) =>
        `<div class="recRow">${ic}<span>${label}</span>` +
        `<b>${val}</b><span class="muted">${sub}</span></div>`).join("")
    : '<p class="muted">Pro zajímavosti je potřeba víc dat (a rozpoznaný domov).</p>';
}

export function renderAnalysis(a) {
  renderTopRoutes(a.top_routes);
  renderTransportChart(a.monthly_by_type);
  renderWorkWeekend(a.weekday_km);
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
