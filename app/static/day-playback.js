/**
 * Vizuální časová osa dne a ovládání přehrávání.
 * Pruhy = pohyb / pobyt; kliknutím nebo tažením posun v čase.
 */
import { $ } from "./common.js";

const MOVE_TYPES = {
  IN_PASSENGER_VEHICLE: 1, DRIVING: 1, IN_VEHICLE: 1, MOTORCYCLING: 1,
  WALKING: 2, ON_FOOT: 2, RUNNING: 2,
  CYCLING: 3, BICYCLING: 3,
  IN_BUS: 4, IN_TRAM: 4, IN_SUBWAY: 4, IN_TRAIN: 4, IN_FERRY: 4,
  IN_PUBLIC_TRANSPORT: 4,
};

/** Sestaví pruhy pohybu a pobytů pro celý kalendářní den. */
export function buildDayBands(day, dayStartTs) {
  const dayEndTs = dayStartTs + 86400;
  const bands = [];

  for (const v of day.visits || []) {
    if (v.end_ts <= dayStartTs || v.start_ts >= dayEndTs) continue;
    bands.push({
      start: Math.max(v.start_ts, dayStartTs),
      end: Math.min(v.end_ts, dayEndTs),
      kind: "visit",
      label: v.name || v.semantic || "Místo",
    });
  }

  for (const a of day.activities || []) {
    if (a.end_ts <= dayStartTs || a.start_ts >= dayEndTs) continue;
    const tn = (a.type || "").toUpperCase().replaceAll(" ", "_");
    bands.push({
      start: Math.max(a.start_ts, dayStartTs),
      end: Math.min(a.end_ts, dayEndTs),
      kind: "move",
      moveKind: MOVE_TYPES[tn] || 0,
      label: a.type,
    });
  }

  // Doplnění pohybu z GPS tam, kde chybí aktivita (min. 30 s, 30 m)
  const pts = day.points || [];
  let segStart = null, prev = null;
  const flushSeg = (endTs) => {
    if (segStart === null || prev === null) return;
    if (endTs - segStart >= 30) {
      const covered = bands.some((b) => b.kind === "move"
        && b.start <= segStart + 5 && b.end >= endTs - 5);
      if (!covered) {
        bands.push({ start: segStart, end: endTs, kind: "move", moveKind: 0 });
      }
    }
    segStart = null;
  };

  for (const p of pts) {
    const ts = p[0], lat = p[1], lon = p[2];
    if (ts < dayStartTs || ts >= dayEndTs) continue;
    if (!prev) { prev = p; continue; }
    const dt = ts - prev[0];
    const dist = haversineM(prev[1], prev[2], lat, lon);
    const moving = dt > 0 && dt < 900 && dist >= 30;
    if (moving) {
      if (segStart === null) segStart = prev[0];
    } else {
      flushSeg(prev[0]);
    }
    prev = p;
  }
  if (prev) flushSeg(prev[0]);

  return bands.sort((a, b) => a.start - b.start);
}

function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6_371_000;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const MOVE_COLORS = [
  "var(--series-1)",   // auto / obecný pohyb
  "#5a9fd4",           // chůze
  "#3d9e6f",           // kolo
  "#9b7ad4",           // MHD
];

export class DayScrubber {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dayStart = 0;
    this.bands = [];
    this.playTime = null;
    this._seekCb = null;
    this._isPlayingCb = null;
    this._pauseCb = null;
    this._resumeCb = null;
    this._dragging = false;
    this._wasPlaying = false;

    canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    canvas.addEventListener("pointermove", (e) => this._onMove(e));
    canvas.addEventListener("pointerup", (e) => this._onUp(e));
    canvas.addEventListener("pointercancel", (e) => this._onUp(e));
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement || canvas);
    this._resize();
  }

  onSeek(cb) { this._seekCb = cb; }
  onPauseDuringSeek(isPlayingCb, pauseCb, resumeCb) {
    this._isPlayingCb = isPlayingCb;
    this._pauseCb = pauseCb;
    this._resumeCb = resumeCb;
  }

  setDay(day, dayStartTs) {
    this.dayStart = dayStartTs;
    this.bands = buildDayBands(day, dayStartTs);
    const end = new Date(dayStartTs * 1000);
    end.setHours(23, 59);
    $("playClockStart").textContent = "00:00";
    $("playClockEnd").textContent = "24:00";
    this._render();
  }

  setTime(ts) {
    this.playTime = ts;
    this._render();
  }

  timeAtX(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return this.dayStart + ratio * 86400;
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const w = Math.max(200, (parent?.clientWidth || 400) - 72);
    const h = 36;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;
    this._render();
  }

  _tsToX(ts) {
    return ((ts - this.dayStart) / 86400) * this._w;
  }

  _onDown(e) {
    this._dragging = true;
    this.canvas.setPointerCapture(e.pointerId);
    this._wasPlaying = !!this._isPlayingCb?.();
    if (this._wasPlaying) this._pauseCb?.();
    this._seek(e.clientX);
  }

  _onMove(e) {
    if (!this._dragging) return;
    this._seek(e.clientX);
  }

  _onUp(e) {
    if (!this._dragging) return;
    this._dragging = false;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* — */ }
    if (this._wasPlaying) this._resumeCb?.();
  }

  _seek(clientX) {
    const t = this.timeAtX(clientX);
    this.playTime = t;
    this._render();
    this._seekCb?.(t);
  }

  _render() {
    const ctx = this.ctx, w = this._w, h = this._h;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);

    const trackY = h * 0.38, trackH = h * 0.24;
    ctx.fillStyle = cssVar("--surface-3") || "#e8ecf2";
    roundRect(ctx, 0, trackY, w, trackH, 4);
    ctx.fill();

    for (const b of this.bands) {
      const x1 = this._tsToX(b.start);
      const x2 = this._tsToX(b.end);
      const bw = Math.max(x2 - x1, 2);
      if (b.kind === "visit") {
        ctx.fillStyle = cssVar("--series-2") || "#e67e22";
        ctx.globalAlpha = 0.55;
      } else {
        ctx.fillStyle = MOVE_COLORS[b.moveKind] || MOVE_COLORS[0];
        ctx.globalAlpha = b.moveKind === 0 ? 0.45 : 0.85;
      }
      roundRect(ctx, x1, h * 0.12, bw, h * 0.76, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (this.playTime != null) {
      const x = this._tsToX(this.playTime);
      ctx.strokeStyle = cssVar("--accent-red") || "#e74c3c";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 2);
      ctx.lineTo(x + 0.5, h - 2);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(x, 4, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Rychlostní tlačítka – vrací hodnotu v „sekundách dne za 1 s reálného času“. */
export const PLAY_SPEEDS = [
  { value: 60, label: "1×", title: "1 minuta za sekundu" },
  { value: 300, label: "5×", title: "5 minut za sekundu" },
  { value: 900, label: "15×", title: "15 minut za sekundu" },
  { value: 3600, label: "60×", title: "1 hodina za sekundu" },
];

export function initSpeedButtons(container, hiddenInput, onChange) {
  container.innerHTML = PLAY_SPEEDS.map((s) =>
    `<button type="button" class="pb-speed-btn" data-speed="${s.value}" title="${s.title}">${s.label}</button>`
  ).join("");
  const sync = (val) => {
    container.querySelectorAll(".pb-speed-btn").forEach((b) =>
      b.classList.toggle("active", Number(b.dataset.speed) === val));
    hiddenInput.value = String(val);
  };
  sync(Number(hiddenInput.value) || 300);
  container.querySelectorAll(".pb-speed-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const v = Number(btn.dataset.speed);
      sync(v);
      onChange?.(v);
    }));
  return sync;
}

export function formatPlayClock(ts) {
  return new Date(ts * 1000).toLocaleTimeString("cs", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function daySummaryText(day) {
  const km = (day.activities || []).reduce((a, x) => a + (x.distance_m || 0), 0) / 1000;
  const moves = (day.activities || []).length;
  const visits = (day.visits || []).length;
  const parts = [`${day.points?.length || 0} bodů`];
  if (moves) parts.push(`${moves} přesunů`);
  if (visits) parts.push(`${visits} pobytů`);
  if (km > 0) parts.push(`${km.toFixed(1)} km`);
  return parts.join(" · ");
}
