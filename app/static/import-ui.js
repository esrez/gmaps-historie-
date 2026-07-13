/* Import dat: nahrání souboru, sledování průběhu, přehledný souhrn
   a autokontrola kvality. Háčky na okolí (průvodce, obnovení mapy) dostává
   zvenku, aby modul nezávisel na zbytku app.js. */
import { $, apiFetch, escapeHtml, toast } from "./common.js";
import { icon } from "./icons.js";

const api = (path, params) => apiFetch(path, { params });

let hooks = { onImported: () => {}, wizardOpen: () => false, closeWizardSoon: () => {} };

export function initImportUi(h) {
  hooks = { ...hooks, ...h };
  $("importBtn").addEventListener("click", () => startImport($("importFile").files[0]));
}

// stav importu se ukazuje v Nástrojích i (běží-li) v okně průvodce
function setImportStatus(msg) {
  $("importStatus").textContent = msg;
  const w = document.getElementById("wizImportStatus");
  if (w) w.textContent = msg;
}

async function startImport(file) {
  if (!file) { toast("Nejdřív vyberte soubor k importu.", "error"); return; }
  const fd = new FormData();
  fd.append("file", file);
  $("importBtn").disabled = true;
  setImportStatus(`Nahrávám ${file.name} …`);
  try {
    const res = await fetch("/api/import", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || res.status);
    await watchImport(body.job_id);   // import běží na pozadí, sledujeme průběh
  } catch (e) {
    setImportStatus("Import selhal: " + e.message);
    toast("Import selhal", "error");
    $("importBtn").disabled = false;
  }
}

async function watchImport(jobId) {
  const fmt = (v) => v.toLocaleString("cs");
  while (true) {
    let s;
    try {
      s = await api(`/api/import/status/${jobId}`);
    } catch (e) {
      setImportStatus("Nelze zjistit stav importu: " + e.message);
      break;
    }
    if (s.status === "running") {
      setImportStatus(
        `Zpracovávám… +${fmt(s.points)} bodů, +${fmt(s.visits)} návštěv, +${fmt(s.activities)} aktivit`);
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (s.status === "done") {
      await renderImportSummary(s);
      toast(s.points || s.visits || s.activities
        ? "Import dokončen." : "Import proběhl, ale nenašla se žádná data.",
        s.points || s.visits || s.activities ? "success" : "error");
      if (hooks.wizardOpen()) hooks.closeWizardSoon();
      hooks.onImported();   // období = vše + skok na data, ať je hned vidět
    } else {
      setImportStatus("Import selhal: " + s.error);
      toast("Import selhal", "error");
    }
    break;
  }
  $("importBtn").disabled = false;
}

/* Přehledný souhrn importu: co přibylo, které soubory se přeskočily a proč,
   a co je teď celkem v databázi (aby bylo jasné, co se stalo a proč). */
async function renderImportSummary(s) {
  const fmt = (v) => (v || 0).toLocaleString("cs");
  const box = $("importStatus");
  const nothing = !s.points && !s.visits && !s.activities;
  const parts = [];

  parts.push(
    `<div class="impHead ${nothing ? "warn" : "ok"}">` +
    `${icon(nothing ? "alert" : "check", 18)} ` +
    (nothing ? "Import proběhl, ale nepřidala se žádná data"
             : "Import dokončen") + "</div>");

  parts.push(
    `<ul class="impStats"><li>+<b>${fmt(s.points)}</b> GPS bodů</li>` +
    `<li>+<b>${fmt(s.visits)}</b> návštěv míst</li>` +
    `<li>+<b>${fmt(s.activities)}</b> cest/aktivit</li>` +
    `<li>z <b>${fmt(s.files)}</b> souborů` +
    (s.skipped ? `, <b>${fmt(s.skipped)}</b> přeskočeno` : "") + "</li></ul>");

  if (nothing) {
    parts.push('<p class="muted">Nejčastější příčina: vybraný soubor není ' +
      'export historie polohy, nebo je to prázdný/jiný ZIP. Stáhněte z Googlu ' +
      '„Location History (Timeline)" a vyberte <b>Timeline.json</b> nebo celý ' +
      '<b>ZIP</b> z Takeoutu.</p>');
  }

  if (s.skipped_names && s.skipped_names.length) {
    const items = s.skipped_names.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
    const more = s.skipped > s.skipped_names.length
      ? `<li class="muted">…a další (${fmt(s.skipped - s.skipped_names.length)})</li>` : "";
    parts.push(
      `<details class="impDetails"><summary>Přeskočené soubory (${fmt(s.skipped)})</summary>` +
      `<ul class="impSkip">${items}${more}</ul>` +
      '<p class="muted">Přeskočí se soubory, které nejsou data o poloze ' +
      '(nastavení, jiné služby) – to je v pořádku.</p></details>');
  }

  // co je teď celkem v databázi + rozsah dat
  try {
    const r = await api("/api/range");
    if (r.min_ts && r.max_ts) {
      const fmtD = (ts) => new Date(ts * 1000).toLocaleDateString("cs");
      parts.push(
        `<p class="impTotal">Celkem v databázi: <b>${fmt(r.points)}</b> bodů, ` +
        `<b>${fmt(r.visits)}</b> návštěv · data od <b>${fmtD(r.min_ts)}</b> ` +
        `do <b>${fmtD(r.max_ts)}</b>.</p>`);
    }
  } catch (e) { /* nevadí */ }

  box.innerHTML = parts.join("");
  const w = document.getElementById("wizImportStatus");
  if (w) w.innerHTML = box.innerHTML;
  autoQualityCheck();   // autokontrola dat – dokreslí zjištění, až doběhne
}

/* Autokontrola kvality dat po importu: nepřesné body, teleporty, vadné
   návštěvy, duplicitní cesty. Zjištění se ukáže pod souhrnem importu a na
   záložce Nástroje se objeví tečka, dokud se problémy nevyřeší. */
async function autoQualityCheck() {
  let q;
  try { q = await api("/api/quality"); } catch (e) { return; }
  const problems = [
    [q.low_accuracy, "nepřesných bodů"],
    [q.outliers, "teleportů (skoků v datech)"],
    [q.bad_visits, "vadných návštěv"],
    [q.duplicate_activities, "duplicitních cest"],
  ].filter(([n]) => n > 0);
  const tab = document.querySelector('#tabs [data-tab="nastroje"]');
  tab.classList.toggle("hasIssues", problems.length > 0);
  const box = $("importStatus");
  if (!problems.length) {
    box.insertAdjacentHTML("beforeend",
      `<p class="impTotal">${icon("check", 13)} Autokontrola: data vypadají v pořádku.</p>`);
    return;
  }
  const list = problems.map(([n, label]) =>
    `<b>${n.toLocaleString("cs")}</b> ${label}`).join(", ");
  box.insertAdjacentHTML("beforeend",
    `<p class="impTotal">${icon("alert", 13)} Autokontrola našla ${list}. ` +
    "Nic se nemaže samo – projděte návrhy oprav. " +
    '<button id="qcOpenBtn">Zkontrolovat a opravit</button></p>');
  document.getElementById("qcOpenBtn")?.addEventListener("click", () => {
    $("qualityBtn").click();
    $("qualityBtn").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

export { startImport };
