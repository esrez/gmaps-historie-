/* Mapové nástroje: měření vzdálenosti a export výřezu do PNG.
   Samostatný modul – mapu, renderer a čtení CSS proměnných dostává zvenku,
   aby nezávisel na zbytku app.js. */
import { $, toast } from "./common.js";
import { icon } from "./icons.js";

export function initMapTools({ map, canvasRenderer, css, beforeMeasure }) {
  // ------------------------------------------------ měření vzdálenosti

  const measureState = { active: false, pts: [], layer: null, readout: null };

  function fmtDist(m) {
    return m < 1000 ? `${Math.round(m)} m`
      : `${(m / 1000).toLocaleString("cs", { maximumFractionDigits: m < 10000 ? 2 : 1 })} km`;
  }

  function measureCleanup() {
    measureState.active = false;
    measureState.pts = [];
    if (measureState.layer) { map.removeLayer(measureState.layer); measureState.layer = null; }
    if (measureState.readout) { measureState.readout.remove(); measureState.readout = null; }
    map.off("click", measureClick);
    map.off("mousemove", measureMove);
    map.off("dblclick", measureFinish);
    map.getContainer().style.cursor = "";
    map.doubleClickZoom.enable();
    $("measureBtn").innerHTML = `${icon("ruler")} Měřit vzdálenost`;
  }

  function measureTotal(extra) {
    let sum = 0;
    const pts = extra ? [...measureState.pts, extra] : measureState.pts;
    for (let i = 1; i < pts.length; i++) sum += map.distance(pts[i - 1], pts[i]);
    return sum;
  }

  function redrawMeasure(hoverLatLng) {
    if (measureState.layer) map.removeLayer(measureState.layer);
    const g = L.layerGroup();
    const line = measureState.pts.map((p) => [p.lat, p.lng]);
    if (hoverLatLng && measureState.pts.length)
      line.push([hoverLatLng.lat, hoverLatLng.lng]);
    if (line.length >= 2) {
      L.polyline(line, { color: css("--accent-red") || "#d64545", weight: 3,
                         dashArray: hoverLatLng ? "5 6" : null, renderer: canvasRenderer }).addTo(g);
    }
    measureState.pts.forEach((p, i) => {
      L.circleMarker([p.lat, p.lng], { radius: 4, color: css("--accent-red") || "#d64545",
        weight: 2, fillColor: "#fff", fillOpacity: 1, renderer: canvasRenderer }).addTo(g);
      if (i > 0) {
        let cum = 0;
        for (let k = 1; k <= i; k++) cum += map.distance(measureState.pts[k - 1], measureState.pts[k]);
        L.marker([p.lat, p.lng], { interactive: false, opacity: 0,
          icon: L.divIcon({ className: "measureLbl", html: fmtDist(cum),
                            iconSize: [0, 0], iconAnchor: [-6, 8] }) }).addTo(g);
      }
    });
    g.addTo(map);
    measureState.layer = g;
    const total = measureTotal(hoverLatLng && measureState.pts.length ? hoverLatLng : null);
    updateMeasureReadout(total);
  }

  function updateMeasureReadout(total) {
    if (!measureState.readout) {
      const el = document.createElement("div");
      el.id = "measureReadout";
      el.className = "floating";
      document.getElementById("app").appendChild(el);
      measureState.readout = el;
    }
    const n = measureState.pts.length;
    measureState.readout.innerHTML =
      `${icon("ruler", 14)} <b>${fmtDist(total)}</b>` +
      (n < 2 ? ' <span class="muted">– klikejte do mapy</span>'
             : ` <span class="muted">· ${n} bodů · dvojklik/Esc ukončí</span>`);
  }

  function measureClick(e) { measureState.pts.push(e.latlng); redrawMeasure(); }
  function measureMove(e) { if (measureState.pts.length) redrawMeasure(e.latlng); }
  function measureFinish() {
    if (measureState.pts.length >= 2) {
      redrawMeasure();   // dvojklik nepřiblíží (doubleClickZoom je vypnutý)
      toast(`Naměřeno ${fmtDist(measureTotal())}. Měření ukončeno.`, "success");
    }
    // ponechá čáru vykreslenou, jen ukončí režim přidávání
    measureState.active = false;
    map.off("click", measureClick);
    map.off("mousemove", measureMove);
    map.off("dblclick", measureFinish);
    map.getContainer().style.cursor = "";
    map.doubleClickZoom.enable();
    $("measureBtn").innerHTML = `${icon("ruler")} Měřit znovu`;
  }

  function startMeasure() {
    beforeMeasure?.();   // zavřít kreslení oblasti / editaci tvaru
    measureCleanup();
    measureState.active = true;
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = "crosshair";
    map.on("click", measureClick);
    map.on("mousemove", measureMove);
    map.on("dblclick", measureFinish);
    $("measureBtn").innerHTML = `${icon("x")} Ukončit měření`;
    updateMeasureReadout(0);
    toast("Klikáním do mapy měřte vzdálenost trasy. Dvojklik nebo Esc ukončí.");
  }

  $("measureBtn").addEventListener("click", () => {
    if (measureState.active) { measureCleanup(); return; }   // probíhá → ukončit a smazat
    startMeasure();   // i s hotovou čarou: uvnitř ji smaže a začne nové (Esc jen smaže)
  });

  // ------------------------------------------------ export mapy do PNG

  async function exportMapPng() {
    const btn = $("exportPngBtn");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = `${icon("image")} Připravuji…`;
    try {
      const size = map.getSize();
      const canvas = document.createElement("canvas");
      canvas.width = size.x;
      canvas.height = size.y;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = css("--surface-1") || "#ffffff";
      ctx.fillRect(0, 0, size.x, size.y);
      const base = map.getContainer().getBoundingClientRect();

      // 1) podkladové dlaždice (img) v pořadí, jak leží v DOM
      const tiles = [...map.getContainer().querySelectorAll(".leaflet-tile-pane img.leaflet-tile")]
        .filter((im) => im.complete && im.naturalWidth && (im.style.opacity === "" || Number(im.style.opacity) > 0.1));
      for (const im of tiles) {
        const r = im.getBoundingClientRect();
        try { ctx.drawImage(im, r.left - base.left, r.top - base.top, r.width, r.height); }
        catch (e) { /* ojedinělou dlaždici přeskoč */ }
      }
      // 2) vektorové/heat/webgl vrstvy – všechny <canvas> v mapě
      for (const cv of map.getContainer().querySelectorAll("canvas")) {
        if (!cv.width || !cv.height) continue;
        const r = cv.getBoundingClientRect();
        try { ctx.drawImage(cv, r.left - base.left, r.top - base.top, r.width, r.height); }
        catch (e) { /* WebGL bez preserveDrawingBuffer se přeskočí */ }
      }
      // 3) razítko dole: období + atribuce
      stampMap(ctx, size);

      let url;
      try { url = canvas.toDataURL("image/png"); }
      catch (e) {
        toast("Export se nezdařil kvůli ochraně dlaždic (CORS). Zkuste jiný podklad " +
              "(OpenStreetMap) a načtěte mapu znovu.", "error");
        return;
      }
      const tag = ($("dateFrom").value || "vse") + "_" + ($("dateTo").value || "vse");
      const a = document.createElement("a");
      a.href = url;
      a.download = `mapa-${tag}.png`;
      a.click();
      toast("Mapa uložena jako PNG.", "success");
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  function stampMap(ctx, size) {
    const period = ($("dateFrom").value || $("dateTo").value)
      ? `Období: ${$("dateFrom").value || "…"} – ${$("dateTo").value || "…"}`
      : "Všechna data";
    const attr = "© OpenStreetMap · GMaps Historie";
    ctx.font = "12px system-ui, sans-serif";
    const pad = 6, h = 20;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, size.y - h, size.x, h);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(period, pad, size.y - h / 2);
    const w = ctx.measureText(attr).width;
    ctx.fillText(attr, size.x - w - pad, size.y - h / 2);
  }

  $("exportPngBtn").addEventListener("click", exportMapPng);

  return {
    measureCleanup,
    measureActive: () => measureState.active,
    measureBusy: () => measureState.active || !!measureState.layer,
  };
}
