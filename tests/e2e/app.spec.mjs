import { test, expect } from "@playwright/test";

test.describe("mapa", () => {
  test("průvodce s odkazy na stažení dat z Googlu", async ({ page }) => {
    await page.goto("/");
    // otevřít nápovědu (tlačítko ? v hlavičce) → rovnou krok s odkazy
    await page.click("#helpBtn");
    await expect(page.locator("#wizard")).toBeVisible();
    await expect(page.locator("#wizard")).toContainText("Kde vzít data");
    // odkazy míří na Google Takeout a nápovědu Googlu
    const hrefs = await page.locator("#wizard .wizLink").evaluateAll(
      (as) => as.map((a) => a.href));
    expect(hrefs.some((h) => h.includes("takeout.google.com"))).toBeTruthy();
    expect(hrefs.some((h) => h.includes("support.google.com"))).toBeTruthy();
    // poslední krok má tlačítko importu, pak zavřít
    await page.click("#wizNext");
    await expect(page.locator("#wizImportBtn")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#wizard")).toBeHidden();
  });

  test("načte statistiky, grafy a kalendář", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs [data-tab="stat"]');
    await expect(page.locator("#statTiles .tile")).toHaveCount(4);
    await expect(page.locator("#statTiles")).toContainText("km celkem");
    await expect(page.locator("#monthlyChart svg")).toBeVisible();
    await expect(page.locator("#calendar svg")).toBeVisible();
    expect(await page.locator("#calendar rect[data-d]").count()).toBeGreaterThan(300);
    // dny se záznamem jsou jasně odlišené (data-rec) a legenda to vysvětluje
    expect(await page.locator('#calendar rect[data-rec]').count()).toBeGreaterThan(0);
    await expect(page.locator(".calLegend")).toContainText("bez záznamu");
    // den bez záznamu má šedou výplň (ne modrou), den se záznamem naopak modrou
    const emptyFill = await page.locator('#calendar rect[data-d]:not([data-rec])').first()
      .getAttribute("fill");
    expect(emptyFill).not.toMatch(/^#(9ec5f4|6da7ec|3987e5|1c5cab|0d366b|cfe3fb)$/i);
  });

  test("kalendář spustí přehrávání dne", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs [data-tab="stat"]');
    await page.locator("#calendar svg").waitFor();
    // najdi den se záznamem km (modrá výplň) a klikni
    const day = page.locator('#calendar rect[data-rec="km"]').first();
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

  test("tlačítko Ukončit aplikaci je skryté mimo desktop režim", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs [data-tab="nastroje"]');
    // e2e server neběží jako desktopová aplikace → tlačítko musí být skryté
    await expect(page.locator("#quitBtn")).toBeHidden();
  });

  test("bez souhlasu se souřadnice neposílají do Nominatim", async ({ page }) => {
    let nominatim = 0;
    page.on("request", (r) => { if (r.url().includes("nominatim")) nominatim++; });
    await page.request.post("/api/places",
      { data: { lat: 50.1, lon: 14.39, name: "Soukromí Test", radius_m: 250 } });
    await page.goto("/");
    await expect(page.locator("#geoOnline")).not.toBeChecked();   // výchozí vypnuto
    await page.click('#tabs [data-tab="mista"]');
    await page.locator(".placeCard").filter({ hasText: "Soukromí Test" })
      .locator(".placeHead").click();
    await expect(page.locator(".placeAddr")).toContainText("50.1");   // jen souřadnice
    expect(nominatim).toBe(0);                                        // nic neodešlo ven
  });

  test("nastavení mapy se pamatují po znovunačtení", async ({ page }) => {
    await page.goto("/");
    await page.check("#layerHeat");
    await page.uncheck("#layerTracks");
    await page.selectOption("#transportFilter", "CAR");
    await page.click('#playSpeedBtns .pb-speed-btn[data-speed="3600"]');
    await page.waitForTimeout(200);
    await page.reload();
    await page.waitForTimeout(500);
    await expect(page.locator("#layerHeat")).toBeChecked();
    await expect(page.locator("#layerTracks")).not.toBeChecked();
    await expect(page.locator("#transportFilter")).toHaveValue("CAR");
    await expect(page.locator('#playSpeedBtns .pb-speed-btn.active')).toHaveAttribute("data-speed", "3600");
  });

  test("panel lze odsunout tažením a legenda nechytá myš", async ({ page }) => {
    await page.goto("/");
    // legenda i indikátor jsou průchozí pro myš (posun mapy pod nimi)
    for (const sel of ["#mapLegend", "#mapLoading"]) {
      expect(await page.locator(sel).evaluate((el) => getComputedStyle(el).pointerEvents))
        .toBe("none");
    }
    // přesun panelu tažením za hlavičku
    const left = () => page.locator("#panel").evaluate((el) => el.getBoundingClientRect().left);
    const before = await left();
    const box = await page.locator("#panelHead").boundingBox();
    await page.mouse.move(box.x + 140, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 440, box.y + 200, { steps: 8 });
    await page.mouse.up();
    expect(await left()).toBeGreaterThan(before + 100);
    // odkaz v hlavičce po přesunu stále funguje
    await expect(page.locator('#panelHead a.navlink')).toHaveAttribute("href", "/kniha");
  });

  test("moje místa: přehled, pobyty, přejmenování a okruh", async ({ page }) => {
    await page.goto("/");
    // pojmenovat místo přes API, ať máme co zobrazit
    await page.request.post("/api/places",
      { data: { lat: 50.1, lon: 14.39, name: "Zákazník Test", radius_m: 250 } });
    await page.click('#tabs [data-tab="mista"]');
    const card = page.locator(".placeCard").filter({ hasText: "Zákazník Test" });
    await expect(card).toBeVisible();
    // rozbalit → seznam pobytů
    await card.locator(".placeHead").click();
    await expect(card.locator(".placeBody li").first()).toBeVisible();
    // editace: přejmenování + změna okruhu (panel; cílíme globálně)
    await card.locator(".pact.edit").click();
    await page.locator("#placesList .peName").fill("Zákazník Přejmenovaný");
    await page.locator("#placesList .peRadius").fill("500");
    await page.locator("#placesList .peOk").click();
    await expect(page.locator("#toast")).toContainText("Místo upraveno");
    await expect(page.locator(".placeCard").filter({ hasText: "Zákazník Přejmenovaný" }))
      .toBeVisible();
    // okruh se opravdu uložil
    const places = await (await page.request.get("/api/places")).json();
    expect(places.places.find((p) => p.name === "Zákazník Přejmenovaný").radius_m).toBe(500);
  });

  test("interaktivní úprava tvaru místa na mapě (posun/velikost okruhu)", async ({ page }) => {
    await page.goto("/");
    await page.request.post("/api/places",
      { data: { lat: 49.195, lon: 16.606, name: "Tvar Test", radius_m: 250 } });
    await page.click('#tabs [data-tab="mista"]');
    const card = page.locator(".placeCard").filter({ hasText: "Tvar Test" });
    await card.locator(".pact.edit").click();
    await card.locator(".peShape").click();          // Upravit na mapě
    await expect(page.locator("#geomBar")).toBeVisible();
    // střed (modrá) + kraj (červená) úchyt
    await expect(page.locator(".geomHandle.center")).toBeVisible();
    await page.waitForTimeout(1000);                 // počkat na doletění mapy (flyTo)
    const edge = page.locator(".geomHandle.edge");
    const eb = await edge.boundingBox();
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
    await page.mouse.down();
    await page.mouse.move(eb.x + 120, eb.y, { steps: 8 });
    await page.mouse.up();
    await page.click("#geomSave");
    await expect(page.locator("#toast")).toContainText("Tvar místa uložen");
    await expect(page.locator("#geomBar")).toBeHidden();
    // poloměr se skutečně zvětšil
    const places = await (await page.request.get("/api/places")).json();
    expect(places.places.find((p) => p.name === "Tvar Test").radius_m).toBeGreaterThan(300);
  });

  test("exporty odpovídají", async ({ page }) => {
    for (const url of ["/api/export.xlsx", "/api/export.gpx", "/api/backup"]) {
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(200);
    }
  });

  test("měření vzdálenosti ukáže odečet a Esc ho smaže", async ({ page }) => {
    await page.goto("/");
    await page.locator("#map").waitFor();
    await page.click("#measureBtn");
    await expect(page.locator("#measureBtn")).toContainText("Ukončit měření");
    // dva kliky do volné části mapy (mimo panel vlevo)
    await page.locator("#map").click({ position: { x: 620, y: 240 } });
    await page.locator("#map").click({ position: { x: 760, y: 380 } });
    const readout = page.locator("#measureReadout");
    await expect(readout).toBeVisible();
    await expect(readout).toContainText(/\d/);
    await expect(readout).toContainText(/m|km/);
    // dvojklik ukončí měření – tlačítko nabídne „Měřit znovu"
    await page.locator("#map").dblclick({ position: { x: 680, y: 470 } });
    await expect(page.locator("#measureBtn")).toContainText("Měřit znovu");
    // „Měřit znovu" spustí NOVÉ měření (ne jen smaže) – readout zpět na startu
    await page.click("#measureBtn");
    await expect(page.locator("#measureBtn")).toContainText("Ukončit měření");
    await expect(readout).toContainText("klikejte do mapy");
    await page.keyboard.press("Escape");
    await expect(readout).toHaveCount(0);
  });

  test("export mapy stáhne PNG", async ({ page }) => {
    await page.goto("/");
    await page.locator("#map").waitFor();
    await page.waitForTimeout(400);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#exportPngBtn"),
    ]);
    expect(download.suggestedFilename()).toMatch(/^mapa-.*\.png$/);
    const path = await download.path();
    const fs = await import("node:fs");
    const buf = fs.readFileSync(path);
    // PNG signatura
    expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("analýza: doprava po měsících, všední vs. víkend, trasy", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs [data-tab="analyza"]');
    await expect(page.locator("#transportChart svg")).toBeVisible();
    await expect(page.locator("#transportLegend")).toContainText("Autem");
    await expect(page.locator("#workWeekend")).toContainText("Všední dny");
    await expect(page.locator("#topRoutes")).not.toBeEmpty();
  });

  test("barvení tras podle roku ukáže legendu roků", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    await page.selectOption("#trackColorMode", "year");
    await expect(page.locator("#trackYearLegend")).toContainText("2025");
    await page.selectOption("#trackColorMode", "alt");   // zpět – legenda zmizí
    await expect(page.locator("#trackYearLegend")).toHaveCount(0);
  });

  test("prázdné období nabídne dostupný rozsah a Zobrazit vše vrátí data", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => window.loadAll && document.querySelector("#dbInfo"));
    // zvolím období bez dat (daleká budoucnost) → chytrá kartička, ne jen „nejsou data"
    await page.fill("#dateFrom", "2099-01-01");
    await page.fill("#dateTo", "2099-12-31");
    await page.click("#loadBtn");
    const empty = page.locator("#emptyState");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("data máte");        // ví, že data v DB jsou
    await expect(empty).toContainText("bodů");
    // Zobrazit vše skutečně data vrátí a kartička zmizí
    await empty.locator("#emptyAllBtn").click();
    await expect(empty).toBeHidden();
    await expect(page.locator("#dbInfo")).toContainText("Zobrazeno");
    expect(await page.locator("#dateFrom").inputValue()).toBe("");
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
    await page.click("#bulkDelBtn");
    // vlastní modální potvrzení (místo nativního confirm)
    await page.locator("#appDialog .dlgOk").click();
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
