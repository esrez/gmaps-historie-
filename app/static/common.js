/* Sdílené pomocné funkce pro obě stránky (mapa i kniha jízd). */
"use strict";

const $ = (id) => document.getElementById(id);

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toTimeStr(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function partsToTs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = (timeStr || "0:0").split(":").map(Number);
  return Math.floor(new Date(y, m - 1, d, hh, mm).getTime() / 1000);
}

function dateToTs(value, endOfDay) {
  return partsToTs(value, "0:0") + (endOfDay ? 86400 : 0);
}

/* Rozsah z polí #dateFrom / #dateTo (obě stránky používají stejná id). */
function currentRange() {
  const f = $("dateFrom").value, t = $("dateTo").value;
  return {
    from_ts: f ? dateToTs(f, false) : null,
    to_ts: t ? dateToTs(t, true) : null,
  };
}

function buildUrl(path, params) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {}))
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

async function apiFetch(path, { method = "GET", params, body } = {}) {
  const res = await fetch(buildUrl(path, params), {
    method,
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
