/* Filtry mapy a porovnání více období */
import { $, apiFetch } from "./common.js";

export const TRANSPORT_MODES = [
  { id: "", label: "Vše" },
  { id: "CAR", label: "Auto" },
  { id: "WALK", label: "Chůze" },
  { id: "BIKE", label: "Kolo" },
  { id: "TRANSIT", label: "MHD" },
];

export function transportParam() {
  const el = $("transportFilter");
  return el && el.value ? { transport: el.value } : {};
}

export async function loadMultiCompare(periods) {
  return apiFetch("/api/compare", {
    params: { periods: JSON.stringify(periods) },
  });
}

export function renderNewPlaces(places) {
  const el = $("newPlacesBox");
  if (!el) return;
  if (!places || !places.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = "<h3>Nová místa v období</h3><ul>" +
    places.map((p) =>
      `<li><a href="#" data-lat="${p.lat}" data-lon="${p.lon}">` +
      `${p.name || (p.lat.toFixed(3) + ", " + p.lon.toFixed(3))}</a> ` +
      `<span class="muted">(${p.visits}×)</span></li>`).join("") + "</ul>";
  el.querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    if (window.map) window.map.flyTo([Number(a.dataset.lat), Number(a.dataset.lon)], 15);
  }));
}
