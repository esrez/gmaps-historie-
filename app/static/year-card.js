/* „Rok v pohybu" – sdílitelná PNG karta s ročním souhrnem (km, dny, top
   místa, rekordy, mini graf měsíců). Kreslí se přímo do canvasu, takže
   nepotřebuje žádnou knihovnu a vypadá všude stejně (pevný světlý vzhled). */
import { $, apiFetch, dateToTs, toast } from "./common.js";

const api = (path, params) => apiFetch(path, { params });

const C = {   // pevná paleta karty (validovaná světlá)
  bg: "#fcfcfb", ink: "#0b0b0b", sub: "#52514e", muted: "#75736b",
  grid: "#e1e0d9", blue: "#2a78d6", green: "#1baf7a",
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCard(year, s) {
  const W = 1080, H = 640, P = 56;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const fmt = (v) => (v || 0).toLocaleString("cs", { maximumFractionDigits: 0 });

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.blue;
  ctx.fillRect(0, 0, W, 6);

  ctx.fillStyle = C.muted;
  ctx.font = "600 20px system-ui, sans-serif";
  ctx.fillText("GMAPS HISTORIE", P, P + 8);
  ctx.fillStyle = C.ink;
  ctx.font = "700 52px system-ui, sans-serif";
  ctx.fillText(`Rok v pohybu ${year}`, P, P + 64);

  // hlavní číslo: km celkem
  ctx.fillStyle = C.blue;
  ctx.font = "800 96px system-ui, sans-serif";
  const kmTxt = fmt(s.total_km);
  ctx.fillText(kmTxt, P, 232);
  const kmW = ctx.measureText(kmTxt).width;   // změřit ještě velkým fontem
  ctx.fillStyle = C.sub;
  ctx.font = "600 30px system-ui, sans-serif";
  ctx.fillText("km celkem", P + kmW + 22, 230);

  // tři dlaždice vedle sebe
  const tiles = [
    [fmt(s.days_with_data), "dní na cestách"],
    [fmt(s.visits), "návštěv míst"],
    [fmt(s.visit_hours), "hodin na místech"],
  ];
  tiles.forEach(([v, l], i) => {
    const x = P + i * 200;
    ctx.fillStyle = C.ink;
    ctx.font = "700 36px system-ui, sans-serif";
    ctx.fillText(v, x, 312);
    ctx.fillStyle = C.muted;
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillText(l, x, 338);
  });

  // top místa (vpravo nahoře)
  const rx = W / 2 + 60;
  ctx.fillStyle = C.muted;
  ctx.font = "600 15px system-ui, sans-serif";
  ctx.fillText("NEJČASTĚJŠÍ MÍSTA", rx, 150);
  (s.top_places || []).slice(0, 3).forEach((p, i) => {
    const y = 186 + i * 40;
    ctx.fillStyle = C.green;
    ctx.beginPath();
    ctx.arc(rx + 8, y - 7, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.font = "600 21px system-ui, sans-serif";
    let name = p.label;
    while (ctx.measureText(name).width > 330 && name.length > 4) name = name.slice(0, -2) + "…";
    ctx.fillText(name, rx + 28, y);
    ctx.fillStyle = C.muted;
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillText(`${p.count}× · ${fmt(p.hours)} h`, rx + 28, y + 18);
  });

  // rekordy (vpravo pod místy)
  const r = s.records || {};
  const recs = [];
  if (r.longest_day) recs.push([`${r.longest_day.km.toLocaleString("cs")} km`, "nejvíc za den"]);
  if (r.longest_trip) recs.push([`${r.longest_trip.km.toLocaleString("cs")} km`, "nejdelší cesta"]);
  if (r.longest_streak_days > 1) recs.push([`${r.longest_streak_days} dní`, "série s jízdou"]);
  if (recs.length) {
    ctx.fillStyle = C.muted;
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.fillText("REKORDY", rx, 344);
    recs.forEach(([v, l], i) => {
      const x = rx + i * 165;
      ctx.fillStyle = C.ink;
      ctx.font = "700 26px system-ui, sans-serif";
      ctx.fillText(v, x, 380);
      ctx.fillStyle = C.muted;
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText(l, x, 400);
    });
  }

  // mini graf: km po měsících přes celou šířku dole
  const byMonth = new Map((s.monthly_km || []).map((m) => [m.month, m.km]));
  const vals = Array.from({ length: 12 },
    (_, i) => byMonth.get(`${year}-${String(i + 1).padStart(2, "0")}`) || 0);
  const gx = P, gw = W - 2 * P, gy = 440, gh = 120;
  const maxV = Math.max(...vals, 1);
  ctx.strokeStyle = C.grid;
  ctx.beginPath();
  ctx.moveTo(gx, gy + gh);
  ctx.lineTo(gx + gw, gy + gh);
  ctx.stroke();
  const slot = gw / 12;
  const MON = ["led", "úno", "bře", "dub", "kvě", "čvn",
               "čvc", "srp", "zář", "říj", "lis", "pro"];
  vals.forEach((v, i) => {
    const bw = Math.min(46, slot - 14);
    const x = gx + i * slot + (slot - bw) / 2;
    const h = Math.max(2, gh * (v / maxV));
    ctx.fillStyle = C.blue;
    roundRect(ctx, x, gy + gh - h, bw, h, Math.min(5, h / 2));
    ctx.fill();
    ctx.fillStyle = C.muted;
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(MON[i], x + bw / 2, gy + gh + 20);
    ctx.textAlign = "left";
  });
  ctx.fillStyle = C.muted;
  ctx.font = "600 15px system-ui, sans-serif";
  ctx.fillText("KM PO MĚSÍCÍCH", gx, gy - 12);

  ctx.fillStyle = C.muted;
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText("vytvořeno aplikací GMaps Historie · data zůstávají u vás", P, H - 22);
  return canvas;
}

export function initYearCard(getYear) {
  $("yearCardBtn")?.addEventListener("click", async () => {
    const year = getYear();
    const btn = $("yearCardBtn");
    btn.disabled = true;
    try {
      const s = await api("/api/stats", {
        from_ts: dateToTs(`${year}-01-01`, false),
        to_ts: dateToTs(`${year}-12-31`, true),
      });
      if (!s.points && !s.total_km) {
        toast(`Pro rok ${year} nejsou žádná data.`, "error");
        return;
      }
      const canvas = drawCard(year, s);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `rok-v-pohybu-${year}.png`;
      a.click();
      toast(`Karta Rok v pohybu ${year} uložena jako PNG.`, "success");
    } catch (e) {
      toast("Kartu se nepodařilo vytvořit: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}
