/* Kniha jízd – logika stránky */
"use strict";

const $ = (id) => document.getElementById(id);
const TZ_MIN = -new Date().getTimezoneOffset();

let trips = [];

// ------------------------------------------------------------- pomocné

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

async function api(path, { method = "GET", params, body } = {}) {
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

function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ------------------------------------------------------------ nastavení

const SETTINGS = ["setPlate", "setDriver", "setPurpose", "setWorkdays",
                  "setHourFrom", "setHourTo", "setMinKm"];

function loadSettings() {
  for (const id of SETTINGS) {
    const saved = localStorage.getItem("kniha." + id);
    if (saved === null) continue;
    const el = $(id);
    if (el.type === "checkbox") el.checked = saved === "true";
    else el.value = saved;
  }
}
function saveSettings() {
  for (const id of SETTINGS) {
    const el = $(id);
    localStorage.setItem("kniha." + id, el.type === "checkbox" ? el.checked : el.value);
  }
}
SETTINGS.forEach((id) => $(id).addEventListener("change", saveSettings));

function setMonthPreset(which) {
  const now = new Date();
  const base = which === "lastMonth"
    ? new Date(now.getFullYear(), now.getMonth() - 1, 1)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  $("dateFrom").value = toDateStr(base);
  $("dateTo").value = toDateStr(end);
  loadTrips();
}
document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => setMonthPreset(b.dataset.preset)));
["dateFrom", "dateTo"].forEach((id) => $(id).addEventListener("change", loadTrips));

// -------------------------------------------------------------- tabulka

async function loadTrips() {
  try {
    const data = await api("/api/trips", { params: currentRange() });
    trips = data.trips;
    renderTable(data.total_km);
  } catch (e) {
    $("tripsSummary").textContent = "Načtení jízd selhalo: " + e.message;
  }
}

function renderTable(totalKm) {
  const body = $("tripsBody");
  body.innerHTML = "";
  let prevMonth = "";
  for (const t of trips) {
    const s = new Date(t.start_ts * 1000);
    const e = new Date(t.end_ts * 1000);
    const tr = document.createElement("tr");
    tr.dataset.id = t.id;
    const month = `${s.getFullYear()}-${s.getMonth()}`;
    if (prevMonth && month !== prevMonth) tr.classList.add("monthStart");
    prevMonth = month;
    tr.innerHTML = `
      <td><input type="date" data-f="date" value="${toDateStr(s)}"></td>
      <td><input type="time" data-f="dep" value="${toTimeStr(s)}"></td>
      <td><input type="time" data-f="arr" value="${toTimeStr(e)}"></td>
      <td><input type="text" data-f="origin" value="${escapeAttr(t.origin)}"></td>
      <td><input type="text" data-f="destination" value="${escapeAttr(t.destination)}"></td>
      <td><input type="text" inputmode="decimal" class="km" data-f="km" value="${t.km}"></td>
      <td><input type="text" data-f="purpose" value="${escapeAttr(t.purpose)}"></td>
      <td style="text-align:center"><input type="checkbox" data-f="private" ${t.private ? "checked" : ""}></td>
      <td><button class="del" title="Smazat jízdu">✕</button></td>`;
    tr.querySelectorAll("input").forEach((inp) =>
      inp.addEventListener("change", () => onCellChange(t, inp)));
    tr.querySelector(".del").addEventListener("click", () => onDelete(t, tr));
    body.appendChild(tr);
  }
  $("totalKm").textContent = (totalKm ?? trips.reduce((a, t) => a + t.km, 0))
    .toLocaleString("cs", { maximumFractionDigits: 1 });
  $("tripsSummary").textContent = trips.length
    ? `${trips.length} jízd ve zvoleném období`
    : "Žádné jízdy – zvolte období a klikněte na Generovat jízdy, nebo přidejte jízdu ručně.";
}

async function onCellChange(t, inp) {
  const f = inp.dataset.f;
  const patch = {};
  const row = inp.closest("tr");
  const get = (name) => row.querySelector(`[data-f="${name}"]`).value;
  if (f === "date" || f === "dep" || f === "arr") {
    const start = partsToTs(get("date"), get("dep"));
    let end = partsToTs(get("date"), get("arr"));
    if (end < start) end += 86400; // příjezd po půlnoci
    patch.start_ts = start;
    patch.end_ts = end;
  } else if (f === "km") {
    const v = parseFloat(String(inp.value).replace(",", "."));
    if (isNaN(v) || v < 0) { inp.value = t.km; return; }
    patch.km = Math.round(v * 10) / 10;
    inp.value = patch.km;
  } else if (f === "private") {
    patch.private = inp.checked;
  } else {
    patch[f] = inp.value;
  }
  try {
    const updated = await api(`/api/trips/${t.id}`, { method: "PATCH", body: patch });
    Object.assign(t, updated);
    $("totalKm").textContent = trips.reduce((a, x) => a + x.km, 0)
      .toLocaleString("cs", { maximumFractionDigits: 1 });
  } catch (e) {
    alert("Uložení selhalo: " + e.message);
  }
}

async function onDelete(t, tr) {
  if (!confirm(`Smazat jízdu ${new Date(t.start_ts * 1000).toLocaleDateString("cs")} (${t.km} km)?`)) return;
  await api(`/api/trips/${t.id}`, { method: "DELETE" });
  trips = trips.filter((x) => x.id !== t.id);
  tr.remove();
  renderTable();
}

// ---------------------------------------------------------------- akce

$("generateBtn").addEventListener("click", async () => {
  const r = currentRange();
  if (r.from_ts === null || r.to_ts === null) {
    alert("Nejdřív zvolte období (od–do).");
    return;
  }
  $("generateBtn").disabled = true;
  $("genStatus").textContent = "Generuji…";
  try {
    const res = await api("/api/trips/generate", {
      method: "POST",
      body: {
        ...r,
        tz_offset_min: TZ_MIN,
        workdays_only: $("setWorkdays").checked,
        hour_from: Number($("setHourFrom").value),
        hour_to: Number($("setHourTo").value),
        min_km: parseFloat($("setMinKm").value) || 0,
        purpose: $("setPurpose").value,
        driver: $("setDriver").value,
        plate: $("setPlate").value,
      },
    });
    $("genStatus").textContent =
      `Vytvořeno ${res.created} nových jízd (prohledáno ${res.scanned} cest autem).`;
    loadTrips();
  } catch (e) {
    $("genStatus").textContent = "Generování selhalo: " + e.message;
  } finally {
    $("generateBtn").disabled = false;
  }
});

$("addBtn").addEventListener("click", async () => {
  const base = $("dateTo").value || toDateStr(new Date());
  const t = await api("/api/trips", {
    method: "POST",
    body: {
      start_ts: partsToTs(base, "08:00"),
      end_ts: partsToTs(base, "08:30"),
      km: 0,
      origin: "", destination: "",
      purpose: $("setPurpose").value,
      driver: $("setDriver").value,
      plate: $("setPlate").value,
      private: false,
    },
  });
  trips.push(t);
  trips.sort((a, b) => a.start_ts - b.start_ts);
  renderTable();
});

$("exportBtn").addEventListener("click", () => {
  location.href = buildUrl("/api/trips/export.xlsx",
    { ...currentRange(), tz_offset_min: TZ_MIN });
});

$("clearBtn").addEventListener("click", async () => {
  const r = currentRange();
  if (r.from_ts === null || r.to_ts === null) {
    alert("Nejdřív zvolte období (od–do).");
    return;
  }
  if (!confirm("Opravdu smazat VŠECHNY jízdy ve zvoleném období?")) return;
  const res = await api("/api/trips", { method: "DELETE", params: r });
  $("genStatus").textContent = `Smazáno ${res.deleted} jízd.`;
  loadTrips();
});

// ---------------------------------------------------------------- start

loadSettings();
setMonthPreset("thisMonth");
