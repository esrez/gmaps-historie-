/* Kniha jízd – logika stránky (ES modul, sdílené helpery v common.js) */
import { $, toDateStr, toTimeStr, partsToTs, dateToTs, currentRange,
         buildUrl, apiFetch, escapeHtml, toast, initThemeToggle } from "./common.js";

initThemeToggle($("themeBtn"));

const api = apiFetch;
const RENDER_CHUNK = 250;   // řádků najednou; zbytek se dokreslí při doskrolování
let trips = [];
let rules = [];

// ------------------------------------------------------------ nastavení

const SETTINGS = ["setPlate", "setDriver", "setPurpose", "setWorkdays",
                  "setHourFrom", "setHourTo", "setMinKm", "setRoundUp", "setAutoFill",
                  "setFilterPlate", "setGroupDays", "setCityMode"];

// ------------------------------------------------------------ našeptávač

async function loadSuggest() {
  try {
    const s = await api("/api/trips/suggest");
    $("dlPlaces").innerHTML =
      s.places.map((v) => `<option value="${escapeHtml(v)}">`).join("");
    $("dlPurposes").innerHTML =
      s.purposes.map((v) => `<option value="${escapeHtml(v)}">`).join("");
  } catch (e) { /* nedostupné */ }
}

// aktivní filtr vozidla (prázdný objekt = všechna vozidla)
function plateFilter() {
  const plate = $("setPlate").value.trim();
  return $("setFilterPlate").checked && plate ? { plate } : {};
}

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

const roundUpOn = () => $("setRoundUp").checked;
const roundKm = (v) => (roundUpOn() ? Math.ceil(v - 1e-9) : Math.round(v * 10) / 10);

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
["setFilterPlate", "setPlate"].forEach((id) => $(id).addEventListener("change", loadTrips));

// -------------------------------------------------------------- tabulka

async function loadTrips() {
  try {
    const data = await api("/api/trips", { params: { ...currentRange(), ...plateFilter() } });
    trips = data.trips;
    renderTable(data.total_km);
    refreshOdometer(odoYear()); // rok podle zvoleného období
    refreshAlerts();
    refreshUndo();
  } catch (e) {
    $("tripsSummary").textContent = "Načtení jízd selhalo: " + e.message;
  }
}

function updateTotal(totalKm) {
  const total = totalKm ?? trips.reduce((a, t) => a + (t.excluded ? 0 : t.km), 0);
  $("totalKm").textContent = total.toLocaleString("cs", { maximumFractionDigits: 1 });
  const included = trips.filter((t) => !t.excluded).length;
  const excluded = trips.length - included;
  $("tripsSummary").textContent = trips.length
    ? `${included} jízd v knize${excluded ? ` (+ ${excluded} vlastním autem, mimo knihu)` : ""}`
    : "Žádné jízdy – zvolte období a klikněte na Generovat jízdy, nebo přidejte jízdu ručně.";
}

function buildRow(t, prevMonth) {
  const s = new Date(t.start_ts * 1000);
  const e = new Date(t.end_ts * 1000);
  const tr = document.createElement("tr");
  tr.dataset.id = t.id;
  if (t.excluded) tr.classList.add("excludedRow");
  const month = `${s.getFullYear()}-${s.getMonth()}`;
  if (prevMonth && month !== prevMonth) tr.classList.add("monthStart");
  tr.innerHTML = `
      <td data-l="Datum"><input type="date" data-f="date" value="${toDateStr(s)}"></td>
      <td data-l="Odjezd"><input type="time" data-f="dep" value="${toTimeStr(s)}"></td>
      <td data-l="Příjezd"><input type="time" data-f="arr" value="${toTimeStr(e)}"></td>
      <td data-l="Odkud"><input type="text" list="dlPlaces" data-f="origin" value="${escapeHtml(t.origin)}"></td>
      <td data-l="Kam"><input type="text" list="dlPlaces" data-f="destination" value="${escapeHtml(t.destination)}"></td>
      <td data-l="Km"><input type="text" inputmode="decimal" class="km" data-f="km" value="${t.km}"></td>
      <td data-l="Účel"><input type="text" list="dlPurposes" data-f="purpose" value="${escapeHtml(t.purpose)}"></td>
      <td data-l="Soukromá" class="cbCell"><input type="checkbox" data-f="private" ${t.private ? "checked" : ""}></td>
      <td data-l="Vlastní auto" class="cbCell"><input type="checkbox" data-f="excluded" ${t.excluded ? "checked" : ""}></td>
      <td class="delCell"><button class="del" title="Smazat jízdu">✕</button></td>`;
  tr.querySelectorAll("input").forEach((inp) =>
    inp.addEventListener("change", () => onCellChange(t, inp)));
  tr.querySelector(".del").addEventListener("click", () => onDelete(t, tr));
  return tr;
}

// ------------------------------------------------- zobrazení po dnech

const expandedDays = new Set();   // rozbalené dny (přežije překreslení)

function dayGroups() {
  const groups = [];
  let cur = null;
  for (const t of trips) {
    const date = toDateStr(new Date(t.start_ts * 1000));
    if (!cur || cur.date !== date) {
      cur = { date, items: [] };
      groups.push(cur);
    }
    cur.items.push(t);
  }
  return groups;
}

function dayKm(g) {
  return g.items.reduce((a, t) => a + (t.excluded ? 0 : t.km), 0);
}

function dayRoute(g) {
  const seq = [];
  for (const t of g.items) {
    if (t.excluded) continue;
    for (const v of [t.origin, t.destination]) {
      const s = (v || "").trim();
      if (s && seq[seq.length - 1] !== s) seq.push(s);
    }
  }
  let s = seq.join(" → ");
  if (s.length > 72) s = s.slice(0, 69) + "…";
  return s;
}

function buildDayRow(g) {
  const open = expandedDays.has(g.date);
  const tr = document.createElement("tr");
  tr.className = "dayRow" + (open ? " open" : "");
  tr.dataset.date = g.date;
  const d = new Date(g.date);
  const excl = g.items.filter((t) => t.excluded).length;
  tr.innerHTML = `
    <td colspan="5"><span class="chev">${open ? "▾" : "▸"}</span>
      <b>${d.toLocaleDateString("cs", { weekday: "short", day: "numeric", month: "numeric", year: "numeric" })}</b>
      <span class="muted">· ${g.items.length} ${g.items.length === 1 ? "jízda" : g.items.length < 5 ? "jízdy" : "jízd"}
      ${escapeHtml(dayRoute(g))}</span></td>
    <td class="num" data-l="Km"><b>${dayKm(g).toLocaleString("cs", { maximumFractionDigits: 1 })}</b></td>
    <td colspan="4" class="muted dayNote">${excl ? excl + "× vlastní auto" : ""}</td>`;
  tr.addEventListener("click", () => {
    if (open) expandedDays.delete(g.date);
    else expandedDays.add(g.date);
    renderTable();
  });
  return tr;
}

function refreshDayHeader(t) {
  const date = toDateStr(new Date(t.start_ts * 1000));
  const g = dayGroups().find((x) => x.date === date);
  const tr = $("tripsBody").querySelector(`tr.dayRow[data-date="${date}"]`);
  if (!g || !tr) return;
  tr.querySelector("td.num b").textContent =
    dayKm(g).toLocaleString("cs", { maximumFractionDigits: 1 });
  const excl = g.items.filter((x) => x.excluded).length;
  tr.querySelector(".dayNote").textContent = excl ? excl + "× vlastní auto" : "";
}

// Dlouhá období se vykreslují po dávkách – tabulka s tisíci řádky by jinak
// zamrzala; další dávka se dokreslí, jakmile uživatel doskroluje na konec.
let renderObserver = null;

function renderTable(totalKm) {
  const body = $("tripsBody");
  body.innerHTML = "";
  renderObserver?.disconnect();
  const grouped = $("setGroupDays").checked;

  // jednotný dávkový vykreslovač: položka = den (skupina) nebo jízda
  const units = grouped ? dayGroups() : trips;
  const chunkSize = grouped ? 40 : RENDER_CHUNK;
  let rendered = 0;

  const appendUnit = (frag, i) => {
    if (grouped) {
      const g = units[i];
      frag.appendChild(buildDayRow(g));
      if (expandedDays.has(g.date)) {
        for (const t of g.items) frag.appendChild(buildRow(t, ""));
      }
    } else {
      const prev = i > 0
        ? `${new Date(units[i - 1].start_ts * 1000).getFullYear()}-${new Date(units[i - 1].start_ts * 1000).getMonth()}`
        : "";
      frag.appendChild(buildRow(units[i], prev));
    }
  };

  const renderChunk = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(rendered + chunkSize, units.length);
    for (; rendered < end; rendered++) appendUnit(frag, rendered);
    body.appendChild(frag);
    if (rendered < units.length) sentinel();
  };
  const sentinel = () => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="10" class="muted" style="text-align:center">… načítám další</td>`;
    body.appendChild(tr);
    renderObserver = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) {
        renderObserver.disconnect();
        tr.remove();
        renderChunk();
      }
    });
    renderObserver.observe(tr);
  };
  renderChunk();
  updateTotal(totalKm);
}

$("setGroupDays").addEventListener("change", () => renderTable());

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
    if (isNaN(v) || v < 0) {
      inp.value = t.km;
      toast("Neplatná hodnota km – vráceno zpět.", "error");
      return;
    }
    patch.km = roundKm(v);
    inp.value = patch.km;
  } else if (f === "private" || f === "excluded") {
    patch[f] = inp.checked;
  } else {
    patch[f] = inp.value;
  }
  try {
    const updated = await api(`/api/trips/${t.id}`, { method: "PATCH", body: patch });
    Object.assign(t, updated);
    row.classList.remove("flashOk");
    void row.offsetWidth; // restart animace
    row.classList.add("flashOk");
    if (f === "excluded") {
      row.classList.toggle("excludedRow", t.excluded);
      refreshOdometer();
      refreshAlerts();
    }
    if (f === "km" && $("setAutoFill").checked && (t.destination || t.origin)) {
      await propagateKm(t);
      return; // propagate překreslí tabulku i pravidla
    }
    updateTotal();
    refreshDayHeader(t);
    if (f === "origin" || f === "destination" || f === "purpose") loadSuggest();
  } catch (e) {
    toast("Uložení selhalo: " + e.message, "error");
  }
}

async function propagateKm(t) {
  const res = await api("/api/trips/propagate", {
    method: "POST",
    body: {
      trip_id: t.id, km: t.km, ...currentRange(),
      round_up: roundUpOn(), save_rule: true,
    },
  });
  trips = res.trips;
  renderTable(res.total_km);
  loadRules();
  refreshOdometer();
  toast(`Doplněno ${res.km} km do ${res.updated} jízd na stejné trase (pravidlo uloženo).`,
    "success");
}

async function onDelete(t, tr) {
  if (!confirm(`Smazat jízdu ${new Date(t.start_ts * 1000).toLocaleDateString("cs")} (${t.km} km)?`)) return;
  await api(`/api/trips/${t.id}`, { method: "DELETE" });
  trips = trips.filter((x) => x.id !== t.id);
  tr.remove();
  updateTotal();
  refreshOdometer();
  refreshAlerts();
  toast("Jízda smazána.", "success");
}

// -------------------------------------------------------------- pravidla

async function loadRules() {
  try {
    rules = (await api("/api/trips/rules")).rules;
  } catch (e) { rules = []; }
  $("rulesList").innerHTML = rules.map((r) =>
    `<li>${r.origin ? escapeHtml(r.origin) + " ⇄ " : "→ "}` +
    `<b>${escapeHtml(r.destination)}</b>: ${r.km.toLocaleString("cs")} km ` +
    `<button class="del" data-id="${r.id}" title="Smazat pravidlo">✕</button></li>`).join("")
    || '<li class="muted">Zatím žádná pravidla.</li>';
  $("rulesList").querySelectorAll("button.del").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/trips/rules/${b.dataset.id}`, { method: "DELETE" });
      loadRules();
    }));
}

$("ruleAddBtn").addEventListener("click", async () => {
  const dest = $("ruleDest").value.trim();
  const km = parseFloat(String($("ruleKm").value).replace(",", "."));
  if (!dest || isNaN(km)) { toast("Vyplňte cíl (kam) a km.", "error"); return; }
  await api("/api/trips/rules", {
    method: "POST",
    body: { origin: $("ruleOrigin").value.trim(), destination: dest, km: roundKm(km) },
  });
  $("ruleOrigin").value = ""; $("ruleDest").value = ""; $("ruleKm").value = "";
  loadRules();
});

$("applyRulesBtn").addEventListener("click", async () => {
  const res = await api("/api/trips/apply_rules", {
    method: "POST",
    params: { ...currentRange(), round_up: roundUpOn() },
  });
  $("genStatus").textContent = `Pravidla přepočítala ${res.updated} jízd.`;
  loadTrips();
});

// ------------------------------------------------------------- tachometr

function odoYear() {
  const from = $("dateFrom").value;
  return from ? Number(from.slice(0, 4)) : new Date().getFullYear();
}

async function refreshOdometer(explicitYear) {
  const year = explicitYear ?? (Number($("odoYear").value) || odoYear());
  $("odoYear").value = year;
  const plate = $("setPlate").value.trim();
  try {
    const o = await api("/api/trips/odometer", { params: { year, plate } });
    const label = plate ? `${plate} ${year}` : String(year);
    if (o.odometer_km !== null) {
      $("odoKm").value = o.odometer_km;
      const fmt = (v) => v.toLocaleString("cs", { maximumFractionDigits: 1 });
      $("odoInfo").innerHTML =
        `Tachometr ${label}: <b>${fmt(o.odometer_km)} km</b> · ` +
        `v knize ${fmt(o.booked_km)} km · ` +
        `zbývá <b>${fmt(o.remaining_km)} km</b>`;
    } else {
      $("odoKm").value = "";
      $("odoInfo").textContent =
        `Pro ${label} není stav tachometru zadán (v knize ${o.booked_km.toLocaleString("cs")} km).`;
    }
  } catch (e) {
    $("odoInfo").textContent = "";
  }
}

$("odoSaveBtn").addEventListener("click", async () => {
  const year = Number($("odoYear").value);
  const km = parseFloat(String($("odoKm").value).replace(",", "."));
  if (!year || isNaN(km)) { toast("Vyplňte rok a km.", "error"); return; }
  await api("/api/trips/odometer", {
    method: "PUT",
    body: { year, km, plate: $("setPlate").value.trim() },
  });
  toast("Stav tachometru uložen.", "success");
  refreshOdometer();
  refreshAlerts();
});
$("odoYear").addEventListener("change", refreshOdometer);

// ------------------------------------------------------------ upozornění

async function refreshAlerts() {
  const r = currentRange();
  const box = $("knihaAlerts");
  if (r.from_ts === null || r.to_ts === null) { box.innerHTML = ""; return; }
  try {
    const [missing, al] = await Promise.all([
      api("/api/trips/missing_days", {
        params: { ...r, workdays_only: $("setWorkdays").checked,
                  min_km: parseFloat($("setMinKm").value) || 0 },
      }),
      api("/api/trips/alerts", { params: r }),
    ]);
    const items = [];
    if (missing.days.length) {
      const sample = missing.days.slice(0, 6)
        .map((d) => `${new Date(d.date).toLocaleDateString("cs")} (${d.km} km)`).join(", ");
      items.push(`🚗 <b>${missing.days.length} dní s jízdou autem chybí v knize</b>: ` +
        `${sample}${missing.days.length > 6 ? "…" : ""} ` +
        `<button id="fillMissingBtn">⚙ Doplnit nyní</button>`);
    }
    if (al.incomplete_trips) {
      items.push(`✏️ <b>${al.incomplete_trips} jízd je neúplných</b> (chybí km nebo cíl).`);
    }
    for (const o of al.odometer_exceeded) {
      items.push(`⚠️ <b>Rok ${o.year}: v knize ${o.booked_km.toLocaleString("cs")} km, ` +
        `ale tachometr jen ${o.odometer_km.toLocaleString("cs")} km</b> – zkontrolujte km jízd.`);
    }
    box.innerHTML = items.length
      ? `<div class="warnBox">${items.map((i) => `<div>${i}</div>`).join("")}</div>`
      : "";
    const fill = $("fillMissingBtn");
    if (fill) fill.addEventListener("click", () => $("generateBtn").click());
  } catch (e) {
    box.innerHTML = "";
  }
}

// ---------------------------------------------------------------- akce

$("generateBtn").addEventListener("click", async () => {
  const r = currentRange();
  if (r.from_ts === null || r.to_ts === null) {
    toast("Nejdřív zvolte období (od–do).", "error");
    return;
  }
  $("generateBtn").disabled = true;
  $("genStatus").textContent = "Generuji…";
  try {
    const res = await api("/api/trips/generate", {
      method: "POST",
      body: {
        ...r,
        workdays_only: $("setWorkdays").checked,
        hour_from: Number($("setHourFrom").value),
        hour_to: Number($("setHourTo").value),
        min_km: parseFloat($("setMinKm").value) || 0,
        round_up: roundUpOn(),
        city_mode: $("setCityMode").checked,
        purpose: $("setPurpose").value,
        driver: $("setDriver").value,
        plate: $("setPlate").value,
      },
    });
    $("genStatus").textContent =
      `Vytvořeno ${res.created} nových jízd (prohledáno ${res.scanned} cest autem` +
      (res.skipped_duplicates ? `, ${res.skipped_duplicates} duplicit přeskočeno` : "") + ").";
    if (res.created) toast(`Vytvořeno ${res.created} jízd (lze vrátit tlačítkem Zpět).`, "success");
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
      excluded: false,
    },
  });
  trips.push(t);
  trips.sort((a, b) => a.start_ts - b.start_ts);
  expandedDays.add(toDateStr(new Date(t.start_ts * 1000)));   // rovnou k editaci
  renderTable();
});

$("exportBtn").addEventListener("click", () => {
  location.href = buildUrl("/api/trips/export.xlsx", { ...currentRange(), ...plateFilter() });
});

$("exportPdfBtn").addEventListener("click", () => {
  location.href = buildUrl("/api/trips/export.pdf",
    { ...currentRange(), ...plateFilter(), driver: $("setDriver").value.trim() });
});

$("clearBtn").addEventListener("click", async () => {
  const r = currentRange();
  if (r.from_ts === null || r.to_ts === null) {
    toast("Nejdřív zvolte období (od–do).", "error");
    return;
  }
  if (!confirm("Opravdu smazat VŠECHNY jízdy ve zvoleném období?"
    + ($("setFilterPlate").checked ? " (jen filtrované vozidlo)" : ""))) return;
  const res = await api("/api/trips", { method: "DELETE", params: { ...r, ...plateFilter() } });
  toast(`Smazáno ${res.deleted} jízd (lze vrátit tlačítkem Zpět).`, "success");
  loadTrips();
});

// ------------------------------------------------------- vrácení akce

async function refreshUndo() {
  try {
    const u = await api("/api/trips/undo");
    $("undoBtn").hidden = !u.available;
    if (u.available) {
      const OPS = { generate: "generování", propagate: "propagaci km",
                    apply_rules: "použití pravidel", delete_range: "smazání období" };
      $("undoBtn").textContent = `↩ Vrátit ${OPS[u.op] || u.op} (${u.affected} jízd)` +
        (u.steps > 1 ? ` · ${u.steps} kroků zpět` : "");
    }
  } catch (e) { $("undoBtn").hidden = true; }
}

$("undoBtn").addEventListener("click", async () => {
  try {
    const res = await api("/api/trips/undo", { method: "POST" });
    toast(`Akce vrácena (${res.restored + res.removed} jízd). Další krok zpět: znovu Vrátit.`, "success");
    loadTrips();
  } catch (e) {
    toast("Vrácení selhalo: " + e.message, "error");
  }
});

// ---------------------------------------------------------------- start

loadSettings();
loadRules();
loadSuggest();
setMonthPreset("thisMonth");
