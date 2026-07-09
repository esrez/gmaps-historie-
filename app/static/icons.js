/* Jednotné čárové SVG ikony (styl Lucide) – nahrazují emoji, které vypadají
   na každém systému jinak. Použití: element s data-icon="name", nebo icon(name). */

const P = (d) => `<path d="${d}"/>`;

const ICONS = {
  search: P("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z") + P("M16 16l5 5"),
  layers: P("M12 3 3 8l9 5 9-5-9-5z") + P("M3 13l9 5 9-5") ,
  chart: P("M4 20V10") + P("M10 20V4") + P("M16 20v-8") + P("M22 20H2"),
  tools: P("M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.9 2.9-2-2 2.9-2.9z"),
  download: P("M12 3v12") + P("M7 10l5 5 5-5") + P("M4 21h16"),
  upload: P("M12 21V9") + P("M7 14l5-5 5 5") + P("M4 3h16"),
  pin: P("M12 21s-7-6.6-7-11.5A7 7 0 0 1 19 9.5C19 14.4 12 21 12 21z") +
       '<circle cx="12" cy="9.5" r="2.5"/>',
  play: P("M7 4l13 8-13 8V4z"),
  pause: P("M7 4h4v16H7z") + P("M13 4h4v16h-4z"),
  calendar: P("M4 6h16v15H4z") + P("M4 10h16") + P("M8 3v5") + P("M16 3v5"),
  car: P("M4 15l1.5-5.5A2 2 0 0 1 7.4 8h9.2a2 2 0 0 1 1.9 1.5L20 15") +
       P("M3 15h18v4h-2") + '<circle cx="7" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/>',
  pencil: P("M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"),
  undo: P("M4 10h10a5 5 0 0 1 0 10h-3") + P("M8 6l-4 4 4 4"),
  trash: P("M5 7h14") + P("M9 7V4h6v3") + P("M7 7l1 13h8l1-13"),
  x: P("M6 6l12 12") + P("M18 6L6 18"),
  plus: P("M12 5v14") + P("M5 12h14"),
  check: P("M4 12l5 5L20 7"),
  alert: P("M12 3 2 20h20L12 3z") + P("M12 9v5") + P("M12 17.5v.5"),
  polygon: P("M7 4h10l4 8-6 8H8l-5-8 4-8z"),
  save: P("M5 3h11l3 3v15H5V3z") + P("M8 3v5h7V3") + P("M8 13h8v8"),
  refresh: P("M20 12a8 8 0 1 1-2.3-5.7") + P("M20 3v5h-5"),
  sun: '<circle cx="12" cy="12" r="4"/>' + P("M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5l2 2M17.5 17.5l2 2M19.5 4.5l-2 2M6.5 17.5l-2 2"),
  moon: P("M20 13.5A8.5 8.5 0 1 1 10.5 4a7 7 0 0 0 9.5 9.5z"),
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  file: P("M6 2h9l4 4v16H6V2z") + P("M14 2v5h5"),
  map: P("M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z") + P("M9 4v14") + P("M15 6v14"),
  wand: P("M6 18 18 6") + P("M15 3v3M18 9h3M19 4l1 1"),
  chevR: P("M9 5l7 7-7 7"),
  chevL: P("M15 5l-7 7 7 7"),
  help: '<circle cx="12" cy="12" r="9"/>' + P("M9.2 9.3a3 3 0 0 1 5.6 1.4c0 2-2.8 2.3-2.8 4") + P("M12 17.5v.5"),
  external: P("M14 4h6v6") + P("M20 4l-9 9") + P("M18 14v5H5V6h5"),
  phone: P("M8 3h8v18H8z") + P("M11 18h2"),
  cloud: P("M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17.5 9a3.5 3.5 0 0 1 .5 9H7z"),
  rocket: P("M12 3c3 1 5 4 5 8l-2.5 2.5h-5L7 11c0-4 2-7 5-8z") +
          P("M7 14l-2 2 3 .5.5 3 2-2") + '<circle cx="12" cy="9" r="1.4"/>',
  lock: P("M6 11h12v9H6z") + P("M8 11V8a4 4 0 0 1 8 0v3"),
  ruler: P("M3 15 15 3l6 6L9 21z") + P("M7 11l2 2M11 7l2 2M15 11l2 2"),
  image: P("M4 5h16v14H4z") + P("M4 16l5-5 4 4 3-3 4 4") + '<circle cx="9" cy="9" r="1.5"/>',
  unlock: P("M6 11h12v9H6z") + P("M8 11V8a4 4 0 0 1 7.5-2"),
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/>' + P("M4 6v12a8 3 0 0 0 16 0V6") + P("M4 12a8 3 0 0 0 16 0"),
};

export function icon(name, size = 15) {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* Nahradí <span data-icon="x"> inline SVG – pro ikony psané přímo v HTML. */
export function mountIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 15);
  });
}
