/* Sdílené pomocné funkce pro obě stránky (mapa i kniha jízd) – ES modul. */

import { icon } from "./icons.js";

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
  const LABELS = {
    "": icon("contrast", 13) + " auto",
    dark: icon("moon", 13) + " tmavý",
    light: icon("sun", 13) + " světlý",
  };
  const current = () => localStorage.getItem("theme") || "";
  btn.innerHTML = LABELS[current()];
  btn.title = "Přepnout vzhled (auto / tmavý / světlý)";
  btn.addEventListener("click", () => {
    const order = ["", "dark", "light"];
    const next = order[(order.indexOf(current()) + 1) % order.length];
    if (next) localStorage.setItem("theme", next);
    else localStorage.removeItem("theme");
    location.reload();   // barvy map/grafů se čtou při vykreslení
  });
}

/* PWA: registrace service workeru (offline UI, instalace na plochu).
   updateViaCache:"none" + reload při převzetí novým SW zajistí, že se po
   nasazení nové verze prohlížeč sám přepne na aktuální kód (jinak by starý
   SW mohl donekonečna servírovat zastaralé soubory z mezipaměti). */
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || refreshing) return;   // první převzetí není aktualizace
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
    .then((reg) => reg.update())
    .catch(() => { /* http bez TLS */ });
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

/* ---------------------------------------------------------- dialogy
   Vlastní modální potvrzení/dotaz místo syrových confirm()/prompt():
   jednotný vzhled se zbytkem aplikace, Enter = potvrdit, Esc = zrušit,
   „danger" varianta pro destruktivní akce. Vrací Promise. */

let _dlg = null;

function _dialogEl() {
  if (_dlg) return _dlg;
  _dlg = document.createElement("div");
  _dlg.id = "appDialog";
  _dlg.hidden = true;
  _dlg.innerHTML = `
    <div class="dlgCard" role="dialog" aria-modal="true">
      <h3 class="dlgTitle"></h3>
      <p class="dlgMsg"></p>
      <input class="dlgInput" type="text">
      <div class="dlgBtns">
        <button class="dlgCancel" type="button">Zrušit</button>
        <button class="dlgOk primary" type="button"></button>
      </div>
    </div>`;
  document.body.appendChild(_dlg);
  return _dlg;
}

function _openDialog({ title, message, okLabel, danger, input, value, placeholder }) {
  const el = _dialogEl();
  el.querySelector(".dlgTitle").textContent = title || "";
  el.querySelector(".dlgTitle").hidden = !title;
  const msg = el.querySelector(".dlgMsg");
  msg.textContent = message || "";
  msg.hidden = !message;
  const inp = el.querySelector(".dlgInput");
  inp.hidden = !input;
  inp.value = value || "";
  inp.placeholder = placeholder || "";
  const ok = el.querySelector(".dlgOk");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", !!danger);
  el.hidden = false;
  const prevFocus = document.activeElement;
  (input ? inp : ok).focus();
  if (input) inp.select();

  return new Promise((resolve) => {
    const done = (result) => {
      el.hidden = true;
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("mousedown", onOutside);
      ok.onclick = el.querySelector(".dlgCancel").onclick = null;
      prevFocus?.focus?.();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      if (e.key === "Enter") { e.preventDefault(); done(input ? inp.value : true); }
    };
    const onOutside = (e) => { if (e.target === el) done(null); };
    el.addEventListener("keydown", onKey);
    el.addEventListener("mousedown", onOutside);
    ok.onclick = () => done(input ? inp.value : true);
    el.querySelector(".dlgCancel").onclick = () => done(null);
  });
}

/* Potvrzení: resolves true/false. Pro destruktivní akce danger: true. */
export async function appConfirm(message, { title = "Potvrzení", okLabel = "Ano",
                                            danger = false } = {}) {
  return (await _openDialog({ title, message, okLabel, danger })) === true;
}

/* Dotaz na text: resolves zadaný řetězec, nebo null při zrušení. */
export function appPrompt(message, { title = "", value = "", placeholder = "",
                                     okLabel = "Uložit" } = {}) {
  return _openDialog({ title, message, okLabel, input: true, value, placeholder });
}
