/* Vygeneruje screenshoty aplikace pro README (spouštět proti seed demu):
   DB_PATH=.shots/db.db python scripts/seed_demo.py
   node scripts/make_screenshots.mjs http://127.0.0.1:PORT
   Pozn.: mapové dlaždice vyžadují internet; bez něj je podklad jednolitý. */
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8177";
const exe = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1360, height: 850 } });

await page.goto(base + "/");
await page.waitForFunction(() => document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
// zavřít případnou připomínku starých dat (demo je schválně historické)
await page.locator("#staleCloseBtn").click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(2500);   // dlaždice + shluky
await page.screenshot({ path: "docs/screenshots/mapa.png" });

// heatmapa (režim pohyb – kudy jezdím); bez vrstvy tras, ať vynikne
await page.uncheck("#layerTracks");
await page.check("#layerHeat");
await page.waitForSelector("canvas.leaflet-heatmap-layer", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.screenshot({ path: "docs/screenshots/heatmapa.png" });
await page.uncheck("#layerHeat");
await page.waitForTimeout(600);

// přehrávání dne – klik na den se záznamem v kalendáři (bez vrstvy tras,
// ať je vidět jen stopa přehrávaného dne)
await page.click('#tabs [data-tab="stat"]');
await page.locator("#calendar svg").waitFor();
await page.locator('#calendar rect[data-rec="km"]').first().click();
await page.waitForTimeout(2500);
await page.click("#timelineToggle").catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: "docs/screenshots/prehravani.png" });
await page.click('#tabs [data-tab="mapa"]');
await page.check("#layerTracks");

// čistý start (stav přehrávání se drží v URL hashi)
await page.goto(base + "/");
await page.waitForFunction(() => document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
await page.locator("#staleCloseBtn").click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(1000);

// časosběr měsíců (tlačítko je v záložce Mapa)
await page.click("#timelapseBtn");
await page.waitForTimeout(4000);
await page.screenshot({ path: "docs/screenshots/casosber.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// tmavý režim (opět čistá adresa bez přehrávání)
await page.emulateMedia({ colorScheme: "dark" });
await page.goto(base + "/");
await page.waitForFunction(() => document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
await page.locator("#staleCloseBtn").click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(2000);
await page.screenshot({ path: "docs/screenshots/tmavy.png" });
await page.emulateMedia({ colorScheme: "light" });
await page.goto(base + "/");
await page.waitForFunction(() => document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
await page.locator("#staleCloseBtn").click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(1200);

await page.click('#tabs [data-tab="stat"]');
await page.waitForTimeout(900);
await page.locator("#panel").screenshot({ path: "docs/screenshots/statistiky.png" });

await page.click('#tabs [data-tab="analyza"]');
await page.waitForTimeout(700);
await page.locator("#panel").screenshot({ path: "docs/screenshots/analyza.png" });

await page.goto(base + "/kniha");
await page.click('[data-preset="lastMonth"]');   // demo data jsou relativní k dnešku
await page.waitForTimeout(400);
await page.click("#generateBtn");
await page.waitForFunction(() => document.querySelector("#genStatus")?.textContent.includes("Vytvořeno"), null, { timeout: 20000 });
await page.waitForTimeout(600);
await page.screenshot({ path: "docs/screenshots/kniha.png" });

console.log("Screenshoty uloženy do docs/screenshots/");
await browser.close();
