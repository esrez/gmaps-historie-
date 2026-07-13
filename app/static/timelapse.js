/* Časosběrná mapa: přehraje historii měsíc po měsíci. Trasy se kreslí
   kumulativně – starší měsíce blednou, právě přehrávaný je zvýrazněný.
   Data se stahují po měsících s předstihem (prefetch), takže animace
   neškube ani u víceleté historie. */
import { $, apiFetch, dateToTs, toast } from "./common.js";
import { icon } from "./icons.js";

const MONTH_NAMES = ["leden", "únor", "březen", "duben", "květen", "červen",
  "červenec", "srpen", "září", "říjen", "listopad", "prosinec"];

export function initTimelapse({ map, css, onEnter, onExit }) {
  let layer = null;        // vrstva časosběru
  let bar = null;          // plovoucí lišta
  let months = [];         // ["2021-01", ...]
  let idx = 0;             // index právě přehrávaného měsíce
  let timer = null;
  let speedMs = 800;       // délka jednoho měsíce
  let active = false;
  let gen = 0;             // generace – zahodí opožděné odpovědi po zavření
  const cache = new Map(); // "YYYY-MM" → pole úseků [[lat,lon],...]
  const drawn = new Map(); // "YYYY-MM" → [L.polyline,...] (kvůli restylu)

  function monthRange(m) {
    const [y, mo] = m.split("-").map(Number);
    const from = dateToTs(`${y}-${String(mo).padStart(2, "0")}-01`, false);
    const next = mo === 12 ? `${y + 1}-01-01`
      : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
    return { from_ts: from, to_ts: dateToTs(next, false) - 1 };
  }

  function monthLabel(m) {
    const [y, mo] = m.split("-").map(Number);
    return `${MONTH_NAMES[mo - 1]} ${y}`;
  }

  async function monthData(m) {
    if (cache.has(m)) return cache.get(m);
    const res = await apiFetch("/api/points",
      { params: { ...monthRange(m), limit: 8000 } });
    const segs = [];
    const b = res.breaks || [];
    for (let i = 0; i < b.length; i++) {
      const seg = res.points.slice(b[i], b[i + 1] ?? res.points.length)
        .map((p) => [p[1], p[2]]);
      if (seg.length > 1) segs.push(seg);
    }
    cache.set(m, segs);
    return segs;
  }

  const prefetch = (i) => {
    for (const m of months.slice(i, i + 3)) {
      if (!cache.has(m)) monthData(m).catch(() => {});
    }
  };

  const pastStyle = () => ({ color: css("--series-1"), weight: 1.6,
                             opacity: 0.3, interactive: false,
                             lineJoin: "round", lineCap: "round" });
  const nowStyle = () => ({ color: css("--series-3"), weight: 2.6,
                            opacity: 0.95, interactive: false,
                            lineJoin: "round", lineCap: "round" });

  async function showMonth(i, { instant = false } = {}) {
    const myGen = gen;
    idx = Math.max(0, Math.min(months.length - 1, i));
    const m = months[idx];
    const segs = await monthData(m).catch(() => []);
    if (!active || myGen !== gen) return;

    // skok zpět (posuvníkem): měsíce za cílem zmizí
    for (const [key, lines] of drawn) {
      if (key > m) {
        lines.forEach((l) => layer.removeLayer(l));
        drawn.delete(key);
      }
    }
    // dřívější zvýrazněný měsíc přebarvit na „minulost"
    for (const [key, lines] of drawn) {
      if (key !== m) lines.forEach((l) => l.setStyle(pastStyle()));
    }
    // doplnit chybějící minulé měsíce při skoku vpřed (jen z cache – rychlé)
    if (instant) {
      for (const key of months.slice(0, idx)) {
        if (!drawn.has(key) && cache.has(key)) {
          drawn.set(key, cache.get(key).map((s) =>
            L.polyline(s, pastStyle()).addTo(layer)));
        }
      }
    }
    if (!drawn.has(m)) {
      drawn.set(m, segs.map((s) => L.polyline(s, nowStyle()).addTo(layer)));
    } else {
      drawn.get(m).forEach((l) => l.setStyle(nowStyle()));
    }
    bar.querySelector(".tl-label").textContent = monthLabel(m);
    const slider = bar.querySelector(".tl-slider");
    slider.value = idx;
    prefetch(idx + 1);
  }

  function play() {
    if (timer) return;
    if (idx >= months.length - 1) idx = -1;   // přehrát od začátku
    bar.querySelector(".tl-play").innerHTML = icon("pause", 15);
    const step = async () => {
      if (!active) return;
      if (idx >= months.length - 1) { pause(); return; }
      await showMonth(idx + 1);
      timer = setTimeout(step, speedMs);
    };
    timer = setTimeout(step, 50);
  }

  function pause() {
    clearTimeout(timer);
    timer = null;
    if (bar) bar.querySelector(".tl-play").innerHTML = icon("play", 15);
  }

  function exit() {
    if (!active) return;
    active = false;
    gen++;
    pause();
    map.removeLayer(layer);
    layer = null;
    drawn.clear();
    cache.clear();
    bar.remove();
    bar = null;
    document.removeEventListener("keydown", onKey);
    onExit?.();
  }

  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); exit(); }
    if (e.code === "Space" && !e.target.matches("input, select, textarea")) {
      e.preventDefault();
      e.stopPropagation();       // nekolidovat s přehráváním dne
      timer ? pause() : play();
    }
  }

  function buildBar() {
    bar = document.createElement("div");
    bar.id = "timelapseBar";
    bar.className = "floating";
    bar.innerHTML =
      `<button class="tl-play" title="Přehrát / pozastavit">${icon("play", 15)}</button>` +
      `<b class="tl-label">…</b>` +
      `<input type="range" class="tl-slider" min="0" max="${months.length - 1}" value="0">` +
      `<span class="tl-speed">` +
      [[1600, "½×"], [800, "1×"], [400, "2×"], [200, "4×"]].map(([ms, l]) =>
        `<button data-ms="${ms}" class="${ms === speedMs ? "active" : ""}">${l}</button>`).join("") +
      `</span>` +
      `<button class="tl-close" title="Zavřít časosběr (Esc)">${icon("x", 14)}</button>`;
    document.getElementById("app").appendChild(bar);
    bar.querySelector(".tl-play").addEventListener("click", () => (timer ? pause() : play()));
    bar.querySelector(".tl-close").addEventListener("click", exit);
    bar.querySelector(".tl-slider").addEventListener("input", (e) => {
      pause();
      showMonth(Number(e.target.value), { instant: true });
    });
    bar.querySelectorAll(".tl-speed button").forEach((b) =>
      b.addEventListener("click", () => {
        speedMs = Number(b.dataset.ms);
        bar.querySelectorAll(".tl-speed button").forEach((x) =>
          x.classList.toggle("active", x === b));
      }));
  }

  async function enter() {
    if (active) return;
    // rozsah: zvolené období, jinak celá databáze
    let lo = $("dateFrom").value ? dateToTs($("dateFrom").value, false) : null;
    let hi = $("dateTo").value ? dateToTs($("dateTo").value, true) : null;
    if (lo === null || hi === null) {
      try {
        const r = await apiFetch("/api/range");
        lo = lo ?? r.min_ts;
        hi = hi ?? r.max_ts;
      } catch (e) { /* spadne níž na kontrolu */ }
    }
    if (!lo || !hi || hi <= lo) {
      toast("Časosběr potřebuje data – nejdřív něco naimportujte.", "error");
      return;
    }
    months = [];
    const d = new Date(lo * 1000);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    const end = new Date(hi * 1000);
    while (d <= end) {
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      d.setMonth(d.getMonth() + 1);
    }
    if (!months.length) return;
    active = true;
    gen++;
    layer = L.layerGroup().addTo(map);
    buildBar();
    document.addEventListener("keydown", onKey);
    onEnter?.();
    idx = 0;
    prefetch(0);
    await showMonth(0);
    play();
  }

  $("timelapseBtn")?.addEventListener("click", () => (active ? exit() : enter()));
  return { exit, isActive: () => active };
}
