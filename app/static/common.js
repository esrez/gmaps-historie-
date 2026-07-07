/* Sdílené pomocné funkce pro obě stránky (mapa i kniha jízd) – ES modul. */

export const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------- téma
   auto (podle systému) → dark → light; uložené volby přebijí systém. */
const savedTheme = localStorage.getItem("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

export function isDarkTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function initThemeToggle(btn) {
  const LABELS = { "": "🌓 auto", dark: "🌙 tmavý", light: "☀️ světlý" };
  const current = () => localStorage.getItem("theme") || "";
  btn.textContent = LABELS[current()];
  btn.title = "Přepnout vzhled (auto / tmavý / světlý)";
  btn.addEventListener("click", () => {
    const order = ["", "dark", "light"];
    const next = order[(order.indexOf(current()) + 1) % order.length];
    if (next) localStorage.setItem("theme", next);
    else localStorage.removeItem("theme");
    location.reload();   // barvy map/grafů se čtou při vykreslení
  });
}

/* PWA: registrace service workeru (offline UI, instalace na plochu). */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* http bez TLS */ });
}

export function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function toTimeStr(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function partsToTs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = (timeStr || "0:0").split(":").map(Number);
  return Math.floor(new Date(y, m - 1, d, hh, mm).getTime() / 1000);
}

export function dateToTs(value, endOfDay) {
  return partsToTs(value, "0:0") + (endOfDay ? 86400 : 0);
}

/* Rozsah z polí #dateFrom / #dateTo (obě stránky používají stejná id).
   Obrácené období (od > do) se automaticky prohodí, aby nešlo udělat chybu. */
export function currentRange() {
  let f = $("dateFrom").value, t = $("dateTo").value;
  if (f && t && f > t) {
    [f, t] = [t, f];
    $("dateFrom").value = f;
    $("dateTo").value = t;
    toast("Datum OD bylo později než DO – období jsem prohodil.", "info");
  }
  return {
    from_ts: f ? dateToTs(f, false) : null,
    to_ts: t ? dateToTs(t, true) : null,
  };
}

/* Nenápadné oznámení v rohu obrazovky (náhrada za alert). */
let _toastTimer = null;
export function toast(msg, type = "info") {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "show " + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ""; }, 4000);
}

export function buildUrl(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {}))
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export async function apiFetch(path, { method = "GET", params, body, signal } = {}) {
  const res = await fetch(buildUrl(path, params), {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch (e) { /* — */ }
    throw new Error(msg);
  }
  return res.json();
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
