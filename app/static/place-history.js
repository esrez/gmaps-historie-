/* Historie místa – vizuální časová osa pobytů (modul pro whenIWasHere). */
import { $, escapeHtml } from "./common.js";
import { icon } from "./icons.js";

function fmtHours(secs) {
  return (secs / 3600).toLocaleString("cs", { maximumFractionDigits: 1 });
}

function fmtDur(secs) {
  if (secs >= 5400) return (secs / 3600).toFixed(1) + " h";
  return Math.round(secs / 60) + " min";
}

function monthKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("cs", { month: "long", year: "numeric" });
}

function groupByMonth(stays) {
  const map = new Map();
  for (const s of stays) {
    const k = monthKey(s.start_ts);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return [...map.entries()];
}

function monthBuckets(stays) {
  if (!stays.length) return [];
  const sorted = stays.slice().sort((a, b) => a.start_ts - b.start_ts);
  const first = new Date(sorted[0].start_ts * 1000);
  const last = new Date(sorted[sorted.length - 1].start_ts * 1000);
  const buckets = [];
  const cur = new Date(first.getFullYear(), first.getMonth(), 1);
  const end = new Date(last.getFullYear(), last.getMonth(), 1);
  while (cur <= end) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({ key, count: 0, secs: 0 });
    cur.setMonth(cur.getMonth() + 1);
  }
  const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
  for (const s of stays) {
    const b = byKey[monthKey(s.start_ts)];
    if (b) { b.count += 1; b.secs += s.duration_s; }
  }
  return buckets;
}

export function revealPlaceHistory() {
  const panel = $("panel");
  if (panel?.classList.contains("collapsed")) $("panelCollapse")?.click();
  const tab = document.querySelector('#tabs [data-tab="mapa"]');
  if (tab && !tab.classList.contains("active")) tab.click();
  const sec = $("locPanel")?.closest("section");
  if (sec?.classList.contains("secCollapsed")) {
    sec.querySelector(":scope > h2")?.click();
  }
  requestAnimationFrame(() => {
    $("locPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

export function renderPlaceLoading(label) {
  $("locTitle").textContent = label;
  $("locCoords").textContent = "";
  $("locStats").innerHTML = "";
  $("locRhythm").innerHTML = "";
  $("locRhythm").hidden = true;
  $("locSummary").textContent = "Hledám pobyty…";
  $("locStays").innerHTML =
    `<div class="locEmpty muted">${icon("search", 18)} Prohledávám historii…</div>`;
}

export function renderPlaceEmpty(minStay) {
  $("locStats").innerHTML = "";
  $("locRhythm").innerHTML = "";
  $("locRhythm").hidden = true;
  $("locSummary").textContent = "";
  const tip = minStay
    ? `Průjezdy kratší než ${minStay} min se nepočítají.`
    : "Zkuste větší okruh nebo období Vše.";
  $("locStays").innerHTML =
    `<div class="locEmpty">` +
    `<div class="locEmptyIcon">${icon("pin", 28)}</div>` +
    `<p><b>Tu zatím žádný pobyt není</b></p>` +
    `<p class="muted">${tip}</p>` +
    `</div>`;
}

function renderStats(stays, totalS) {
  if (!stays.length) { $("locStats").innerHTML = ""; return; }
  const first = stays[0];
  const last = stays[stays.length - 1];
  const avg = totalS / stays.length;
  const items = [
    { k: "Pobytů", v: String(stays.length) },
    { k: "Celkem", v: `${fmtHours(totalS)} h` },
    { k: "Ø pobyt", v: fmtDur(avg) },
    {
      k: "První",
      v: new Date(first.start_ts * 1000).toLocaleDateString("cs", {
        day: "numeric", month: "short", year: "numeric",
      }),
    },
    {
      k: "Naposledy",
      v: new Date(last.start_ts * 1000).toLocaleDateString("cs", {
        day: "numeric", month: "short", year: "numeric",
      }),
    },
  ];
  $("locStats").innerHTML = items.map((it) =>
    `<div class="locStat"><span class="locStatVal">${escapeHtml(it.v)}</span>` +
    `<span class="locStatKey">${escapeHtml(it.k)}</span></div>`).join("");
}

function renderRhythm(stays) {
  const el = $("locRhythm");
  const buckets = monthBuckets(stays);
  if (buckets.length < 2) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const max = Math.max(...buckets.map((b) => b.count), 1);
  el.innerHTML =
    `<div class="locRhythmHead"><span>Rytmus návštěv</span>` +
    `<span class="muted">${buckets.length} měsíců</span></div>` +
    `<div class="locRhythmBars" role="img" aria-label="Pobyty po měsících">` +
    buckets.map((b) => {
      const h = Math.max(8, Math.round((b.count / max) * 100));
      const title = `${monthLabel(b.key)}: ${b.count}×, ${fmtHours(b.secs)} h`;
      return `<button type="button" class="locBar" data-month="${b.key}" ` +
        `title="${escapeHtml(title)}" style="--h:${h}%">` +
        `<i style="height:${h}%"></i></button>`;
    }).join("") +
    `</div>`;
}

function stayRowHtml(s, maxDur) {
  const d = new Date(s.start_ts * 1000);
  const from = d.toLocaleDateString("cs", {
    weekday: "short", day: "numeric", month: "numeric", year: "numeric",
  });
  const t1 = d.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" });
  const t2 = new Date(s.end_ts * 1000)
    .toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" });
  const dur = fmtDur(s.duration_s);
  const pct = Math.max(8, Math.round((s.duration_s / maxDur) * 100));
  const name = s.name ? escapeHtml(s.name) : "";
  return `<button type="button" class="stayRow" data-ts="${s.start_ts}" ` +
    `title="Přehraje den ${from}">` +
    `<span class="stayDate">${escapeHtml(from)}</span>` +
    `<span class="stayTime">${t1}–${t2}</span>` +
    `<span class="stayDurBar" aria-hidden="true"><i style="width:${pct}%"></i></span>` +
    `<span class="stayDur"><b>${dur}</b></span>` +
    `<span class="stayName">${name}</span>` +
    `<span class="stayPlay">${icon("play", 13)} den</span>` +
    `</button>`;
}

function renderTimeline(stays, onPlay) {
  const box = $("locStays");
  if (!stays.length) return;
  const newestFirst = stays.slice().reverse();
  const maxDur = Math.max(...newestFirst.map((s) => s.duration_s), 1);
  const groups = groupByMonth(newestFirst);
  box.innerHTML = groups.map(([key, list]) => {
    const secs = list.reduce((a, s) => a + s.duration_s, 0);
    return `<div class="stayGroup" data-month="${key}">` +
      `<div class="stayGroupHead">` +
      `<span>${escapeHtml(monthLabel(key))}</span>` +
      `<span class="muted">${list.length}× · ${fmtHours(secs)} h</span>` +
      `</div>` +
      list.map((s) => stayRowHtml(s, maxDur)).join("") +
      `</div>`;
  }).join("");

  box.querySelectorAll(".stayRow").forEach((btn) =>
    btn.addEventListener("click", () => onPlay(Number(btn.dataset.ts))));

  $("locRhythm").querySelectorAll(".locBar").forEach((btn) =>
    btn.addEventListener("click", () => {
      const g = box.querySelector(`.stayGroup[data-month="${btn.dataset.month}"]`);
      g?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      g?.classList.add("stayGroupPulse");
      setTimeout(() => g?.classList.remove("stayGroupPulse"), 900);
    }));
}

export function renderPlaceHistory(res, { label, coords, minStay, onPlay }) {
  $("locTitle").textContent = label;
  $("locCoords").textContent = coords;
  if (!res.count) {
    renderPlaceEmpty(minStay);
    return;
  }
  const stays = res.stays;
  renderStats(stays, res.total_s);
  renderRhythm(stays);
  const hrs = fmtHours(res.total_s);
  $("locSummary").textContent = minStay
    ? `${res.count}× ve zvoleném období · ${hrs} h celkem ` +
      `(průjezdy pod ${minStay} min se nepočítají)`
    : `${res.count}× ve zvoleném období · ${hrs} h celkem`;
  renderTimeline(stays, onPlay);
}
