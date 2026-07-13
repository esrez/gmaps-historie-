/* Moje místa: vrstva na mapě, přehled v záložce Místa, kreslení polygonů
   a interaktivní úprava tvaru (kruh/polygon). Závislosti na mapě a zbytku
   aplikace se předávají přes initPlacesUI (stejný vzor jako map-tools.js). */
import { $, toTimeStr, currentRange, apiFetch, escapeHtml, toast,
         isDarkTheme, appConfirm, appPrompt } from "./common.js";
import { icon } from "./icons.js";

const api = (path, params) => apiFetch(path, { params });

export function initPlacesUI({ map, locLayer, myPlacesLayer, css,
                               whenIWasHere, loadAll, measureCleanup }) {

async function renderMyPlaces() {
  myPlacesLayer.clearLayers();
  if (!$("layerMyPlaces").checked) return;
  let all;
  const stats = {};
  try {
    const r = currentRange();
    const [pl, st] = await Promise.all([
      api("/api/places"),
      api("/api/places/stats", r),
    ]);
    all = pl.places;
    for (const s of st.stats) stats[s.id] = s;
  } catch (e) { return; }
  const color = isDarkTheme() ? "#9085e9" : "#4a3aa7";
  for (const p of all) {
    const style = { color, weight: 2, fillColor: color, fillOpacity: 0.07,
                    dashArray: "5 5" };
    const shape = p.polygon
      ? L.polygon(p.polygon, style)
      : L.circle([p.lat, p.lon], { radius: p.radius_m, ...style });
    // bublina rovnou říká, jak dlouho jsem tu ve zvoleném období byl
    const s = stats[p.id];
    const info = s && s.count
      ? `${s.count}×, ${(s.secs / 3600).toLocaleString("cs", { maximumFractionDigits: 1 })} h ve zvoleném období`
      : "ve zvoleném období bez pobytu";
    const base = `<b>${escapeHtml(p.name)}</b><br>${info}`;
    const tail = "<br><i>kliknutím zobrazíte pobyty</i>";
    shape.bindTooltip(base + tail, { sticky: true });
    // adresa (reverzní geokódování) se doplní do bubliny až při najetí
    shape.on("tooltipopen", async () => {
      const addr = await reverseGeocode(p.lat, p.lon);
      if (addr) shape.setTooltipContent(
        `${base}<br><span class="tipAddr">${escapeHtml(addr)}</span>${tail}`);
    });
    shape.on("click", (ev) => {
      L.DomEvent.stop(ev);
      whenIWasHere(p.lat, p.lon, p.name);
    });
    shape.addTo(myPlacesLayer);
  }
}

$("layerMyPlaces").addEventListener("change", renderMyPlaces);

// ------------------------------------------------ přehled „Moje místa"

let placesData = [];   // [{...place, count, secs}] pro zvolené období

function fmtDur(secs) {
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

// ---------- reverzní geokódování (souřadnice → adresa) s mezipamětí ----------
// Šetrné k Nominatim: výsledky se drží v localStorage a stahují jen na vyžádání.
let geoStore = {};
try { geoStore = JSON.parse(localStorage.getItem("revgeo") || "{}"); } catch (e) { geoStore = {}; }
const geoInflight = new Map();

async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (key in geoStore) return geoStore[key];
  // soukromí: bez souhlasu se souřadnice nikam neposílají (jen dřív zjištěné)
  if (!$("geoOnline")?.checked) return null;
  if (geoInflight.has(key)) return geoInflight.get(key);
  const pr = (async () => {
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2" +
        `&lat=${lat}&lon=${lon}&accept-language=cs&zoom=18`);
      const d = await r.json();
      const addr = d.display_name || null;
      geoStore[key] = addr;
      try { localStorage.setItem("revgeo", JSON.stringify(geoStore)); } catch (e) { /* plno */ }
      return addr;
    } catch (e) { return null; }
  })();
  geoInflight.set(key, pr);
  return pr;
}

// ---------- našeptávač názvů míst (datalist sdílený všemi poli) ----------
const suggestSet = new Set();

function addSuggestion(value) {
  const v = (value || "").trim();
  if (!v || suggestSet.has(v)) return;
  suggestSet.add(v);
  const opt = document.createElement("option");
  opt.value = v;
  $("dlPlaceNames").appendChild(opt);
}

async function loadPlaceSuggest() {
  try {
    const s = await api("/api/trips/suggest");
    for (const v of s.places) addSuggestion(v);
  } catch (e) { /* nedostupné */ }
}

async function loadPlacesTab() {
  try {
    const r = currentRange();
    const [pl, st] = await Promise.all([
      api("/api/places"),
      api("/api/places/stats", r),
    ]);
    const stats = {};
    for (const s of st.stats) stats[s.id] = s;
    placesData = pl.places.map((p) => ({
      ...p, count: stats[p.id]?.count || 0, secs: stats[p.id]?.secs || 0,
    }));
  } catch (e) { placesData = []; }
  drawPlacesList();
}

function drawPlacesList() {
  const list = $("placesList");
  if (!placesData.length) {
    list.innerHTML =
      `<div id="placesEmpty">${icon("pin", 28)}` +
      "<p><b>Zatím žádná pojmenovaná místa</b></p>" +
      '<p class="muted">Pojmenujte místo v mapě (klik → „Pojmenovat místo"), ' +
      "nebo obkreslete oblast polygonem v záložce Mapa.</p></div>";
    return;
  }
  const q = $("placeSearch").value.trim().toLowerCase();
  const sort = $("placeSort").value;
  const items = placesData
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "cs")
      : sort === "count" ? b.count - a.count : b.secs - a.secs);
  if (!items.length) {
    list.innerHTML = '<p class="muted" style="padding:10px 4px">Nic nevyhovuje filtru.</p>';
    return;
  }
  list.innerHTML = items.map((p) => {
    const sub = p.count
      ? `${p.count}× · ${fmtDur(p.secs)} ve zvoleném období`
      : "ve zvoleném období bez pobytu";
    return `<div class="placeCard" data-id="${p.id}">
      <div class="placeHead">
        <span class="ic pinIc">${icon(p.polygon ? "polygon" : "pin", 16)}</span>
        <div class="pmeta">
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="psub">${sub}</div>
        </div>
        <span class="ptag">${p.polygon ? "oblast" : "kruh"}</span>
        <button class="pact edit" title="Přejmenovat">${icon("pencil", 14)}</button>
        <button class="pact del" title="Smazat místo">${icon("trash", 14)}</button>
      </div>
    </div>`;
  }).join("");
}

// jedno delegované klikání pro celý seznam (přežije překreslení)
$("placesList").addEventListener("click", async (ev) => {
  const card = ev.target.closest(".placeCard");
  if (!card) return;
  const id = Number(card.dataset.id);
  const p = placesData.find((x) => x.id === id);
  if (!p) return;

  if (ev.target.closest(".edit")) { startPlaceEdit(card, p); return; }
  if (ev.target.closest(".del")) {
    if (!await appConfirm(`Smazat pojmenování místa „${p.name}"?`,
        { okLabel: "Smazat", danger: true })) return;
    await apiFetch(`/api/places/${id}`, { method: "DELETE" });
    toast("Místo smazáno.", "success");
    renderMyPlaces();
    loadPlacesTab();
    return;
  }
  if (ev.target.closest(".placeEditPanel")) return;   // klik uvnitř editace

  // klik na kartu: přepnout detail s pobyty + doletět na mapě
  if (p.polygon) map.flyToBounds(p.polygon, { maxZoom: 16, duration: 0.7 });
  else map.flyTo([p.lat, p.lon], 15, { duration: 0.7 });
  const open = card.querySelector(".placeBody");
  if (open) { open.remove(); card.querySelector(".placeAddr")?.remove(); return; }
  await expandPlace(card, id);
});

async function expandPlace(card, id) {
  const p = placesData.find((x) => x.id === id);
  const body = document.createElement("div");
  body.className = "placeBody";
  body.innerHTML = '<p class="muted">Načítám pobyty…</p>';
  card.appendChild(body);
  // adresa místa (reverzní geokódování) v záhlaví detailu
  if (p) {
    const addrEl = document.createElement("div");
    addrEl.className = "placeAddr muted";
    addrEl.innerHTML = `${icon("pin", 12)} zjišťuji adresu…`;
    reverseGeocode(p.lat, p.lon).then((addr) => {
      addrEl.innerHTML = `${icon("pin", 12)} ${addr ? escapeHtml(addr)
        : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`}`;
      addSuggestion(addr);
    });
    card.insertBefore(addrEl, body);
  }
  try {
    const d = await api(`/api/places/${id}/stays`, currentRange());
    if (!d.stays.length) {
      body.innerHTML = '<p class="muted">Ve zvoleném období tu nemáte žádný pobyt.</p>';
      return;
    }
    body.innerHTML = "<ol>" + d.stays.map((s) => {
      const a = new Date(s.start_ts * 1000), b = new Date(s.end_ts * 1000);
      const day = a.toLocaleDateString("cs", { weekday: "short", day: "numeric", month: "numeric" });
      return `<li><span>${day} ${toTimeStr(a)}–${toTimeStr(b)}</span><b>${fmtDur(s.secs)}</b></li>`;
    }).join("") + "</ol>";
  } catch (e) {
    body.innerHTML = `<p class="muted">Načtení selhalo: ${escapeHtml(e.message)}</p>`;
  }
}

let radiusPreview = null;

function clearRadiusPreview() {
  if (radiusPreview) { map.removeLayer(radiusPreview); radiusPreview = null; }
}

function startPlaceEdit(card, p) {
  if (card.querySelector(".placeEditPanel")) return;
  card.querySelector(".placeBody")?.remove();   // zavřít případný detail pobytů
  const circle = !p.polygon;
  const panel = document.createElement("div");
  panel.className = "placeEditPanel";
  panel.innerHTML =
    `<label class="peRow">Název<input class="peName" type="text" list="dlPlaceNames" value="${escapeHtml(p.name)}"></label>` +
    (circle
      ? `<label class="peRow">Okruh (m)<input class="peRadius" type="number" min="20" step="10" value="${Math.round(p.radius_m)}"></label>`
      : "") +
    `<div class="peActions">` +
      `<button type="button" class="peShape">${icon("pencil", 13)} ${p.polygon ? "Upravit body na mapě" : "Upravit na mapě (posun/velikost)"}</button>` +
      `<button type="button" class="peArea">${icon("polygon", 13)} ${p.polygon ? "Překreslit celou oblast" : "Vymezit oblast (polygon)"}</button>` +
      (p.polygon ? `<button type="button" class="peToCircle">${icon("refresh", 13)} Zpět na kruh</button>` : "") +
    `</div>` +
    `<div class="peSave"><button type="button" class="primary peOk">${icon("check", 13)} Uložit</button>` +
    `<button type="button" class="peCancel">Zrušit</button></div>`;
  card.appendChild(panel);
  const nameI = panel.querySelector(".peName");
  const radiusI = panel.querySelector(".peRadius");
  nameI.focus();
  nameI.select();

  // adresu místa nabídnout jako možný název (našeptávač)
  reverseGeocode(p.lat, p.lon).then((addr) => { if (addr) addSuggestion(addr); });

  // živý náhled okruhu při psaní
  if (radiusI) {
    const preview = () => {
      clearRadiusPreview();
      const rv = Number(radiusI.value);
      if (rv >= 20) {
        radiusPreview = L.circle([p.lat, p.lon], { radius: rv, color: css("--series-2"),
          weight: 1.5, dashArray: "4 4", fillOpacity: 0.06 }).addTo(map);
      }
    };
    radiusI.addEventListener("input", preview);
  }

  const close = () => { clearRadiusPreview(); panel.remove(); };
  const save = async () => {
    const name = nameI.value.trim();
    if (!name) { toast("Název nesmí být prázdný.", "error"); return; }
    const body = {};
    if (name !== p.name) body.name = name;
    if (radiusI) {
      const rv = Number(radiusI.value);
      if (!(rv >= 20)) { toast("Okruh musí být alespoň 20 m.", "error"); return; }
      if (Math.round(rv) !== Math.round(p.radius_m)) body.radius_m = rv;
    }
    if (!Object.keys(body).length) { close(); return; }
    try {
      await apiFetch(`/api/places/${p.id}`, { method: "PATCH", body });
      toast("Místo upraveno.", "success");
      close();
      renderMyPlaces();
      loadPlacesTab();
    } catch (e) { toast("Úprava selhala: " + e.message, "error"); }
  };

  panel.querySelector(".peOk").addEventListener("click", save);
  panel.querySelector(".peCancel").addEventListener("click", close);
  panel.querySelector(".peShape").addEventListener("click", () => { close(); startGeometryEdit(p); });
  panel.querySelector(".peArea").addEventListener("click", () => { close(); startAreaRedraw(p); });
  panel.querySelector(".peToCircle")?.addEventListener("click", async () => {
    if (!await appConfirm("Zrušit vymezenou oblast? Místo se vrátí na kruhový okruh.",
        { okLabel: "Zrušit oblast", danger: true })) return;
    try {
      await apiFetch(`/api/places/${p.id}`, { method: "PATCH", body: { polygon: [] } });
      toast("Oblast zrušena, místo je nyní kruhové.", "success");
      close();
      renderMyPlaces();
      loadPlacesTab();
    } catch (e) { toast("Úprava selhala: " + e.message, "error"); }
  });
  nameI.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    else if (e.key === "Escape") close();
  });
}

$("placeSearch").addEventListener("input", drawPlacesList);
$("placeSort").addEventListener("change", drawPlacesList);

// ------------------------------------------- kreslení oblasti (polygon)

const drawState = { active: false, pts: [], preview: null, editPlaceId: null, editName: "" };

function drawCleanup() {
  drawState.active = false;
  drawState.pts = [];
  drawState.editPlaceId = null;
  drawState.editName = "";
  if (drawState.preview) { map.removeLayer(drawState.preview); drawState.preview = null; }
  locLayer.clearLayers();
  map.getContainer().style.cursor = "";
  map.doubleClickZoom.enable();
  $("drawPolyBtn").innerHTML = `${icon("polygon")} Pojmenovat oblast (polygon)`;
}

function beginDraw() {
  measureCleanup();   // ať se nástroje nepletou
  drawState.active = true;
  drawState.pts = [];
  map.doubleClickZoom.disable();
  map.getContainer().style.cursor = "crosshair";
  $("drawPolyBtn").innerHTML = `${icon("check")} Dokončit oblast`;
  toast(drawState.editPlaceId
    ? `Obkreslete novou oblast pro „${drawState.editName}", pak Dokončit (dvojklik). Esc zruší.`
    : "Klikáním do mapy obkreslete oblast (min. 3 body), pak Dokončit. Esc zruší.");
}

$("drawPolyBtn").addEventListener("click", () => {
  if (drawState.active) { finishPolygonDraw(); return; }
  drawState.editPlaceId = null;   // nová oblast
  beginDraw();
});

// Spustí překreslení oblasti existujícího místa (z editace v záložce Místa).
function startAreaRedraw(p) {
  document.querySelector('#tabs [data-tab="mapa"]').click();   // cleanup proběhne dřív, než začneme
  if (p.polygon) map.flyToBounds(p.polygon, { maxZoom: 16, duration: 0.6 });
  else map.flyTo([p.lat, p.lon], 16, { duration: 0.6 });
  if (p.polygon) {   // ukázat stávající oblast jako vodítko
    L.polygon(p.polygon, { color: css("--series-2"), weight: 1.5, dashArray: "2 4",
                           fill: false, interactive: false }).addTo(locLayer);
  }
  drawState.editPlaceId = p.id;
  drawState.editName = p.name;
  beginDraw();
}

function addDrawVertex(lat, lng) {
  drawState.pts.push([lat, lng]);
  L.circleMarker([lat, lng], { radius: 4, color: css("--accent-red"),
                               fillOpacity: 1 }).addTo(locLayer);
  if (drawState.preview) map.removeLayer(drawState.preview);
  drawState.preview = L.polygon(drawState.pts, {
    color: css("--accent-red"), weight: 2, dashArray: "4 4", fillOpacity: 0.08,
  }).addTo(map);
}

async function finishPolygonDraw() {
  if (drawState.pts.length < 3) {
    toast("Oblast potřebuje alespoň 3 body.", "error");
    return;
  }
  try {
    if (drawState.editPlaceId) {
      await apiFetch(`/api/places/${drawState.editPlaceId}`, {
        method: "PATCH", body: { polygon: drawState.pts },
      });
      toast(`Oblast upravena: ${drawState.editName}`, "success");
    } else {
      const name = await appPrompt("Název oblasti (zákazník, sklad, areál…):",
        { title: "Pojmenovat oblast", placeholder: "Zákazník Novák" });
      if (name === null || !name.trim()) { drawCleanup(); return; }
      await apiFetch("/api/places", {
        method: "POST", body: { name: name.trim(), polygon: drawState.pts },
      });
      toast(`Oblast pojmenována: ${name.trim()}`, "success");
    }
  } catch (e) {
    toast("Uložení oblasti selhalo: " + e.message, "error");
  }
  drawCleanup();
  renderMyPlaces();
  loadAll();
}

map.on("dblclick", () => { if (drawState.active) finishPolygonDraw(); });

// ------------------------- interaktivní úprava tvaru uloženého místa
// polygon: táhnutelné body + „+" pro přidání + pravý klik pro smazání;
// kruh: prostřední značka posune střed, krajní mění velikost (poloměr).

const geomState = { active: false, place: null, verts: [], center: null, radius: 0, shape: null };

function geomHandleIcon(kind) {
  if (kind === "mid") {
    return L.divIcon({ className: "geomHandle mid", html: "+", iconSize: [16, 16], iconAnchor: [8, 8] });
  }
  return L.divIcon({ className: "geomHandle " + kind, iconSize: [15, 15], iconAnchor: [8, 8] });
}

function geomCleanup() {
  geomState.active = false;
  geomState.place = null;
  geomState.verts = [];
  geomState.center = null;
  if (geomState.shape) { map.removeLayer(geomState.shape); geomState.shape = null; }
  locLayer.clearLayers();
  document.getElementById("geomBar")?.remove();
  map.doubleClickZoom.enable();
}

function startGeometryEdit(p) {
  drawCleanup();
  geomCleanup();
  measureCleanup();
  document.querySelector('#tabs [data-tab="mapa"]').click();
  geomState.active = true;
  geomState.place = p;
  if (p.polygon) {
    geomState.verts = p.polygon.map(([a, b]) => [a, b]);
    map.flyToBounds(p.polygon, { maxZoom: 17, duration: 0.5 });
    redrawPolyEditor();
    toast("Táhněte body oblasti. Značka plus mezi body přidá bod, pravý klik bod smaže.");
  } else {
    geomState.center = [p.lat, p.lon];
    geomState.radius = p.radius_m;
    map.flyTo(geomState.center, 16, { duration: 0.5 });
    redrawCircleEditor();
    toast("Táhněte prostřední značku pro posun místa, krajní pro změnu velikosti.");
  }
  showGeomBar(p.name);
}

function redrawPolyEditor() {
  locLayer.clearLayers();
  if (geomState.shape) map.removeLayer(geomState.shape);
  const verts = geomState.verts;
  geomState.shape = L.polygon(verts, { color: css("--series-2"), weight: 2,
    fillColor: css("--series-2"), fillOpacity: 0.1 }).addTo(map);
  verts.forEach((v, i) => {
    const h = L.marker(v, { draggable: true, icon: geomHandleIcon("vertex"), zIndexOffset: 1000 });
    h.on("drag", (e) => { verts[i] = [e.latlng.lat, e.latlng.lng]; geomState.shape.setLatLngs(verts); });
    h.on("dragend", redrawPolyEditor);
    h.on("contextmenu", (e) => { L.DomEvent.stop(e); removeVertex(i); });
    h.addTo(locLayer);
  });
  verts.forEach((v, i) => {
    const n = verts[(i + 1) % verts.length];
    const mid = [(v[0] + n[0]) / 2, (v[1] + n[1]) / 2];
    const m = L.marker(mid, { icon: geomHandleIcon("mid") });
    m.on("click", (e) => { L.DomEvent.stop(e); verts.splice(i + 1, 0, mid); redrawPolyEditor(); });
    m.addTo(locLayer);
  });
  updateGeomInfo();
}

function removeVertex(i) {
  if (geomState.verts.length <= 3) { toast("Oblast musí mít alespoň 3 body.", "error"); return; }
  geomState.verts.splice(i, 1);
  redrawPolyEditor();
}

function edgeLatLng() {
  const [lat, lon] = geomState.center;
  const dLon = geomState.radius / (111320 * Math.cos((lat * Math.PI) / 180));
  return L.latLng(lat, lon + dLon);
}

function redrawCircleEditor() {
  locLayer.clearLayers();
  if (geomState.shape) map.removeLayer(geomState.shape);
  geomState.shape = L.circle(geomState.center, { radius: geomState.radius,
    color: css("--series-2"), weight: 2, fillColor: css("--series-2"), fillOpacity: 0.08 }).addTo(map);
  const c = L.marker(geomState.center, { draggable: true, icon: geomHandleIcon("center"), zIndexOffset: 1000 });
  c.on("drag", (e) => { geomState.center = [e.latlng.lat, e.latlng.lng]; geomState.shape.setLatLng(geomState.center); });
  c.on("dragend", redrawCircleEditor);
  c.addTo(locLayer);
  const edge = L.marker(edgeLatLng(), { draggable: true, icon: geomHandleIcon("edge"), zIndexOffset: 1000 });
  edge.on("drag", (e) => {
    geomState.radius = Math.max(20, map.distance(geomState.center, e.latlng));
    geomState.shape.setRadius(geomState.radius);
    updateGeomInfo();
  });
  edge.on("dragend", redrawCircleEditor);
  edge.addTo(locLayer);
  updateGeomInfo();
}

function showGeomBar(name) {
  document.getElementById("geomBar")?.remove();
  const bar = document.createElement("div");
  bar.id = "geomBar";
  bar.className = "floating";
  bar.innerHTML =
    `<span class="gbName">${icon("pencil", 13)} <b>${escapeHtml(name)}</b></span>` +
    '<span id="geomInfo" class="muted"></span>' +
    `<button type="button" class="primary" id="geomSave">${icon("check", 13)} Uložit tvar</button>` +
    '<button type="button" id="geomCancel">Zrušit</button>';
  document.getElementById("app").appendChild(bar);
  bar.querySelector("#geomSave").addEventListener("click", saveGeom);
  bar.querySelector("#geomCancel").addEventListener("click", geomCleanup);
}

function updateGeomInfo() {
  const el = document.getElementById("geomInfo");
  if (!el || !geomState.place) return;
  el.textContent = geomState.place.polygon
    ? `${geomState.verts.length} bodů`
    : `okruh ${Math.round(geomState.radius)} m`;
}

async function saveGeom() {
  const p = geomState.place;
  if (!p) return;
  let body;
  if (p.polygon) {
    if (geomState.verts.length < 3) { toast("Oblast musí mít alespoň 3 body.", "error"); return; }
    body = { polygon: geomState.verts };
  } else {
    body = { radius_m: Math.round(geomState.radius),
             lat: geomState.center[0], lon: geomState.center[1] };
  }
  try {
    await apiFetch(`/api/places/${p.id}`, { method: "PATCH", body });
    toast("Tvar místa uložen.", "success");
    geomCleanup();
    renderMyPlaces();
    loadAll();
  } catch (e) { toast("Uložení selhalo: " + e.message, "error"); }
}

  return {
    renderMyPlaces,
    loadPlacesTab,
    loadPlaceSuggest,
    drawCleanup,
    geomCleanup,
    addDrawVertex,
    drawActive: () => drawState.active,
    geomActive: () => geomState.active,
    cancelModes() {
      if (drawState.active) drawCleanup();
      if (geomState.active) geomCleanup();
    },
  };
}
