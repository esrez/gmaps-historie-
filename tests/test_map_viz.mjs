import assert from "node:assert/strict";
import { test } from "node:test";
import {
  speedColor, hourColor, segAvgKmh, heatGradientCss,
  trackColorFn, trackLegendYears, HEAT_PALETTES,
} from "../app/static/map-viz.js";

test("rychlostní škála: pěšky / město / dálnice", () => {
  assert.equal(speedColor(3), "#9ec5f4");
  assert.equal(speedColor(20), "#6da7ec");
  assert.equal(speedColor(120), "#0d366b");
});

test("denní doba: noc přes půlnoc, den, večer", () => {
  assert.equal(hourColor(23), "#3d4a8a");
  assert.equal(hourColor(2), "#3d4a8a");
  assert.equal(hourColor(12), "#2a78d6");
  assert.equal(hourColor(19), "#8a5cd6");
});

test("průměrná rychlost úseku z časů a souřadnic", () => {
  // ~11.1 km za 600 s = 66.6 km/h
  const seg = [[0, 50.0, 14.0], [600, 50.1, 14.0]];
  const kmh = segAvgKmh(seg);
  assert.ok(kmh > 60 && kmh < 75, kmh);
});

test("paleta heatmapy dá CSS gradient", () => {
  const css = heatGradientCss("fire");
  assert.match(css, /^linear-gradient\(90deg,/);
  assert.ok(HEAT_PALETTES.fire[1]);
});

test("barvení podle roku seskupí legendu", () => {
  const segs = [
    [[Date.UTC(2024, 0, 1) / 1000, 50, 14], [Date.UTC(2024, 0, 1) / 1000 + 60, 50.01, 14]],
    [[Date.UTC(2025, 5, 1) / 1000, 50, 14], [Date.UTC(2025, 5, 1) / 1000 + 60, 50.01, 14]],
  ];
  assert.deepEqual(trackLegendYears("year", segs), [2024, 2025]);
  assert.equal(trackLegendYears("speed", segs), null);
  const fn = trackColorFn("hour", ["#111", "#222"]);
  assert.equal(typeof fn(segs[0], 0), "string");
});
