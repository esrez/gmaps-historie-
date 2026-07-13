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

await page.click('#tabs [data-tab="stat"]');
await page.waitForTimeout(900);
await page.locator("#panel").screenshot({ path: "docs/screenshots/statistiky.png" });

await page.click('#tabs [data-tab="analyza"]');
await page.waitForTimeout(700);
await page.locator("#panel").screenshot({ path: "docs/screenshots/analyza.png" });

await page.goto(base + "/kniha");
await page.fill("#dateFrom", "2025-06-01");
await page.fill("#dateTo", "2025-06-30");
await page.dispatchEvent("#dateTo", "change");
await page.waitForTimeout(400);
await page.click("#generateBtn");
await page.waitForFunction(() => document.querySelector("#genStatus")?.textContent.includes("Vytvořeno"), null, { timeout: 20000 });
await page.waitForTimeout(600);
await page.screenshot({ path: "docs/screenshots/kniha.png" });

console.log("Screenshoty uloženy do docs/screenshots/");
await browser.close();
