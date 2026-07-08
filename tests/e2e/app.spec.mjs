import { test, expect } from "@playwright/test";

test.describe("mapa", () => {
  test("načte statistiky, grafy a kalendář", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs [data-tab="stat"]');
    await expect(page.locator("#statTiles .tile")).toHaveCount(4);
    await expect(page.locator("#statTiles")).toContainText("km celkem");
    await expect(page.locator("#monthlyChart svg")).toBeVisible();
    await expect(page.locator("#calendar svg")).toBeVisible();
    expect(await page.locator("#calendar rect[data-d]").count()).toBeGreaterThan(300);
  });

  test("kalendář spustí přehrávání dne", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs [data-tab="stat"]');
    await page.locator("#calendar svg").waitFor();
    // najdi den s jízdou (tmavá výplň) a klikni
    const day = page.locator('#calendar rect[data-d]:not([fill="transparent"])').first();
    await day.click();
    await expect(page.locator("#playBtn")).toHaveAttribute("data-state", "playing");
    await page.click("#timelineToggle");
    await expect(page.locator("#dayTimeline li").first()).toBeVisible();
  });

  test("kdy jsem tu byl přes hledání", async ({ page }) => {
    await page.goto("/");
    await page.fill("#searchInput", "work");
    await page.click("#searchBtn");
    await page.locator('#searchResults a[data-kind="mine"]').first().click();
    await expect(page.locator("#locSummary")).toContainText("ve zvoleném období");
    expect(await page.locator("#locStays li").count()).toBeGreaterThan(0);
  });

  test("kontrola kvality dat proběhne", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs [data-tab="nastroje"]');
    await page.click("#qualityBtn");
    await expect(page.locator("#qualityReport")).not.toBeEmpty({ timeout: 15000 });
  });

  test("exporty odpovídají", async ({ page }) => {
    for (const url of ["/api/export.xlsx", "/api/export.gpx", "/api/backup"]) {
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(200);
    }
  });
});

test.describe("kniha jízd", () => {
  test("vygeneruje jízdy, upraví km a exportuje", async ({ page }) => {
    await page.goto("/kniha");
    await page.fill("#dateFrom", "2025-06-01");
    await page.fill("#dateTo", "2025-06-30");
    await page.dispatchEvent("#dateTo", "change");

    await page.fill("#setPlate", "1AB 2345");
    await page.dispatchEvent("#setPlate", "change");
    await page.click("#generateBtn");
    await expect(page.locator("#genStatus")).toContainText("Vytvořeno", { timeout: 15000 });
    // výchozí zobrazení po dnech: den se souhrnem km, rozbalit kliknutím
    await expect(page.locator("#tripsBody tr.dayRow").first()).toBeVisible();
    expect(await page.locator("#tripsBody tr.dayRow").count()).toBeGreaterThan(3);
    await page.locator("#tripsBody tr.dayRow").first().click();

    // úprava km → propagace na stejnou trasu + pravidlo
    const km = page.locator("#tripsBody tr:not(.dayRow) input.km").first();
    await km.fill("9,4");
    await km.dispatchEvent("change");
    await expect(page.locator("#toast")).toContainText("Doplněno 10 km");
    await expect(page.locator("#rulesList")).toContainText("10 km");

    // undo je dostupné a funguje
    await expect(page.locator("#undoBtn")).toBeVisible();
    await page.click("#undoBtn");
    await expect(page.locator("#toast")).toContainText("Akce vrácena");

    for (const url of ["/api/trips/export.xlsx", "/api/trips/export.pdf"]) {
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(200);
    }
  });

  test("hromadný výběr dne skutečně smaže a jde vrátit", async ({ page }) => {
    await page.goto("/kniha");
    await page.fill("#dateFrom", "2025-06-01");
    await page.fill("#dateTo", "2025-06-30");
    await page.dispatchEvent("#dateTo", "change");
    await page.locator("#tripsBody tr.dayRow").first().waitFor();
    const before = await page.locator("#tripsBody tr.dayRow").count();
    await expect(page.locator("#bulkDelBtn")).toBeHidden();
    await page.locator("#tripsBody tr.dayRow .selDay").first().check();
    await expect(page.locator("#bulkDelBtn")).toContainText("Smazat vybrané");
    page.once("dialog", (d) => d.accept());   // potvrzení mazání
    await page.click("#bulkDelBtn");
    await expect(page.locator("#toast")).toContainText("Smazáno");
    await expect(page.locator("#tripsBody tr.dayRow")).toHaveCount(before - 1);
    // hromadné smazání je jeden krok zpět
    await expect(page.locator("#undoBtn")).toBeVisible();
    await page.click("#undoBtn");
    await expect(page.locator("#toast")).toContainText("Akce vrácena");
    await expect(page.locator("#tripsBody tr.dayRow")).toHaveCount(before);
  });

  test("mobilní zobrazení má karty místo tabulky", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/kniha");
    await page.fill("#dateFrom", "2025-06-01");
    await page.fill("#dateTo", "2025-06-30");
    await page.dispatchEvent("#dateTo", "change");
    await page.locator("#tripsBody tr").first().waitFor();
    // thead je skrytý a buňky mají popisky (karty); rozbalit den na jízdy
    await expect(page.locator("#tripsTable thead")).toBeHidden();
    await page.locator("#tripsBody tr.dayRow").first().click();
    const label = await page.locator('#tripsBody tr:not(.dayRow) td[data-l="Km"]').first()
      .evaluate((td) => getComputedStyle(td, "::before").content);
    expect(label).toContain("Km");
    await ctx.close();
  });
});
