import { test, expect } from "@playwright/test";


// vrstvy jsou v popoveru na mapě – před manipulací ho otevřít / zavřít
async function openLayers(page) {
  if (await page.locator("#layersPop").isHidden()) await page.click("#ctlLayers");
}
async function closeLayers(page) {
  if (!await page.locator("#layersPop").isHidden()) await page.click("#ctlLayers");
}

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
    await expect(page.locator("#statTiles .tile")).toHaveCount(11);
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
    await openLayers(page);
    await page.check("#layerHeat");
    await page.uncheck("#layerTracks");
    await page.selectOption("#transportFilter", "CAR");
    await closeLayers(page);
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

  test("Rok v pohybu stáhne PNG kartu se souhrnem", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    await page.click('#tabs [data-tab="stat"]');
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#yearCardBtn"),
    ]);
    expect(dl.suggestedFilename()).toMatch(/^rok-v-pohybu-\d{4}\.png$/);
    const fs = await import("node:fs");
    const buf = fs.readFileSync(await dl.path());
    expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("ovládací sloupec mapy: přiblížit na data funguje", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    for (const id of ["#ctlFit", "#ctlLocate", "#ctlFull"]) {
      await expect(page.locator(id)).toBeVisible();
    }
    // odzoomovat pryč a vrátit se tlačítkem na data
    await page.evaluate(() => { window.map.setView([40, -100], 4, { animate: false }); });
    await page.click("#ctlFit");
    await page.waitForTimeout(600);
    const z = await page.evaluate(() => window.map.getZoom());
    expect(z).toBeGreaterThan(8);   // seed data jsou v Praze – fit přiblíží
    // Soukromí: přichytávání k silnicím je opt-in a výchozí vypnuté
    await page.click('#tabs [data-tab="nastroje"]');
    await expect(page.locator("#roadSnap")).not.toBeChecked();
  });

  test("nápověda zkratek na ? a stav aplikace v Nástrojích", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("?");
    await expect(page.locator("#shortcutHelp")).toBeVisible();
    await expect(page.locator("#shortcutHelp")).toContainText("mezerník");
    await page.keyboard.press("Escape");
    await expect(page.locator("#shortcutHelp")).toBeHidden();
    // stav aplikace: velikost DB + kontrola integrity
    await page.click('#tabs [data-tab="nastroje"]');
    await expect(page.locator("#appHealth")).toContainText("MB");
    await page.click("#dbCheckBtn");
    await expect(page.locator("#dbCheckResult")).toContainText("v pořádku");
    // demo data nejdou nahrát do neprázdné databáze (guard)
    const res = await page.request.post("/api/demo");
    expect(res.status()).toBe(409);
  });

  test("panel jde roztáhnout za pravou hranu a šířka se pamatuje", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    const width = () => page.locator("#panel")
      .evaluate((el) => el.getBoundingClientRect().width);
    const before = await width();
    const h = await page.locator("#panelResize").boundingBox();
    await page.mouse.move(h.x + 5, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 225, h.y + h.height / 2, { steps: 6 });
    await page.mouse.up();
    const after = await width();
    expect(after).toBeGreaterThan(before + 150);
    // po reloadu šířka zůstává; statistiky ukazují 8 dlaždic
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    expect(await width()).toBeGreaterThan(before + 150);
    await page.click('#tabs [data-tab="stat"]');
    await expect(page.locator("#statTiles .tile")).toHaveCount(11);
    await expect(page.locator("#statTiles")).toContainText("hodin na cestách");
    await expect(page.locator("#statTiles")).toContainText("různých míst");
  });

  test("kalendář: najetí ukáže tooltip s detaily a náhled dne na mapě", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    await page.click('#tabs [data-tab="stat"]');
    await page.locator("#calendar svg").waitFor();
    const day = page.locator('#calendar rect[data-rec="km"]').first();
    await day.hover();
    // vlastní tooltip s km a nápovědou ke kliknutí
    await expect(page.locator("#tooltip")).toBeVisible();
    await expect(page.locator("#tooltip")).toContainText("km");
    await expect(page.locator("#tooltip")).toContainText("kliknutím přehrajete");
    // duchový náhled se dotáhne přes /api/day (debounce ~200 ms)
    const reqDay = page.waitForRequest((r) => r.url().includes("/api/day"), { timeout: 5000 });
    await day.hover({ position: { x: 2, y: 2 } });
    await reqDay;
    // den bez záznamu: tooltip říká „bez záznamu" a nic nenačítá
    const empty = page.locator('#calendar rect[data-d]:not([data-rec])').first();
    await empty.hover();
    await expect(page.locator("#tooltip")).toContainText("bez záznamu");
  });

  test("heatmapa: režim strávený čas a denní doba fungují", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    await openLayers(page);
    await page.check("#layerHeat");
    // režim „strávený čas" pošle mode=visits
    const reqVisits = page.waitForRequest((r) =>
      r.url().includes("/api/heatmap") && r.url().includes("mode=visits"));
    await page.selectOption("#heatMode", "visits");
    await reqVisits;
    // filtr denní doby pošle hour_from/hour_to (jen v režimu pohyb)
    await page.selectOption("#heatMode", "points");
    const reqHours = page.waitForRequest((r) =>
      r.url().includes("hour_from=17") && r.url().includes("hour_to=22"));
    await page.selectOption("#heatHours", "17-22");
    await reqHours;
  });

  test("časosběr měsíců: animace běží, posuvník i Esc fungují", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    await page.click("#timelapseBtn");
    await expect(page.locator("#timelapseBar")).toBeVisible();
    // animace postupuje: popisek měsíce se po chvíli změní (nebo dojede na konec)
    await page.waitForFunction(() => {
      const t = document.querySelector(".tl-label")?.textContent;
      return t && t !== "…";
    });
    await expect(page.locator(".tl-label")).toContainText("2025");
    // posuvník skočí na začátek
    await page.locator(".tl-slider").fill("0");
    await page.waitForTimeout(400);
    // Esc zavře a vrátí běžné trasy
    await page.keyboard.press("Escape");
    await expect(page.locator("#timelapseBar")).toHaveCount(0);
  });

  test("zajímavosti, rytmus týdne a statistiky na mapě", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    // vrstvy statistik: kružnice akčního rádia mají DOM popisky
    await openLayers(page);
    await page.check("#statRadius");
    await page.check("#statRoutes");
    // divIcon má 0×0 box (obsah přetéká transformem) → testujeme počet, ne viditelnost
    await expect(page.locator(".radiusLbl")).toHaveCount(3, { timeout: 10000 });
    // Analýza: zajímavosti + punchcard se dopočítají při otevření
    await page.click('#tabs [data-tab="analyza"]');
    await expect(page.locator("#insightFacts")).toContainText("Akční rádius");
    await expect(page.locator("#insightFacts")).toContainText("Typický všední den");
    await expect(page.locator("#punchcard svg")).toBeVisible();
    expect(await page.locator("#punchcard .pc").count()).toBeGreaterThan(5);
    // vypnutí vrstvy popisky odstraní (klik na záložku popover zavřel)
    await page.click('#tabs [data-tab="mapa"]');
    await openLayers(page);
    await page.uncheck("#statRadius");
    await page.uncheck("#statRoutes");
    await closeLayers(page);
    await page.waitForTimeout(400);
    await expect(page.locator(".radiusLbl")).toHaveCount(0);
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
    await openLayers(page);
    await page.selectOption("#trackColorMode", "year");
    await expect(page.locator("#trackYearLegend")).toContainText("2025");
    await page.selectOption("#trackColorMode", "alt");   // zpět – legenda zmizí
    await closeLayers(page);
    await expect(page.locator("#trackYearLegend")).toHaveCount(0);
  });

  test("prázdné období nabídne dostupný rozsah a Zobrazit vše vrátí data", async ({ page }) => {
    await page.goto("/");
    // počkat na DOKONČENÉ úvodní načtení – na pomalém CI je tlačítko Načíst
    // během initu disabled a předčasný klik by se tiše zahodil (flaky test)
    await page.waitForFunction(() =>
      document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));
    await page.waitForFunction(() => !document.querySelector("#loadBtn").disabled);
    await page.waitForTimeout(600);   // nechat doběhnout post-fit dotažení výřezu
    // zvolím období bez dat (daleká budoucnost) → chytrá kartička, ne jen „nejsou data"
    await page.fill("#dateFrom", "2099-01-01");
    await page.fill("#dateTo", "2099-12-31");
    await page.click("#loadBtn");
    const empty = page.locator("#emptyState");
    await expect(empty).toBeVisible({ timeout: 10000 });
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

test.describe("ovládání oken a návštěvy", () => {
  const loaded = (page) => page.waitForFunction(() =>
    document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));

  test("lišta přehrávání jde skrýt, stav přežije reload a přehrání ji vrátí", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await expect(page.locator("#playbackBar")).toBeVisible();
    await page.click("#playbarHide");
    await expect(page.locator("#playbackBar")).toBeHidden();
    await expect(page.locator("#playbarShow")).toBeVisible();
    await page.reload();
    await loaded(page);
    await expect(page.locator("#playbackBar")).toBeHidden();
    // přehrání dne z kalendáře lištu automaticky ukáže
    await page.click('#tabs [data-tab="stat"]');
    await page.locator("#calendar svg").waitFor();
    await page.locator('#calendar rect[data-rec="km"]').first().click();
    await expect(page.locator("#playbackBar")).toBeVisible();
    await expect(page.locator("#playbarShow")).toBeHidden();
  });

  test("panel si pamatuje pozici; dvojklik na hlavičku vše vrátí", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    const head = await page.locator("#panelHead").boundingBox();
    // táhnout za levou část hlavičky (mimo tlačítka vpravo)
    await page.mouse.move(head.x + 40, head.y + 10);
    await page.mouse.down();
    await page.mouse.move(head.x + 40 + 180, head.y + 10 + 70, { steps: 6 });
    await page.mouse.up();
    const panelX = async () => (await page.locator("#panel").boundingBox()).x;
    const moved = await panelX();
    expect(moved).toBeGreaterThan(100);
    await page.reload();
    await loaded(page);
    expect(Math.abs((await panelX()) - moved)).toBeLessThan(4);
    // dvojklik = návrat na výchozí pozici (left 12px)
    await page.locator("#panelHead").dblclick({ position: { x: 40, y: 10 } });
    expect(await panelX()).toBeLessThan(30);
  });

  test("návštěvy: popisky v mapě a akce v bublině včetně smazání", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    // nechat jen vrstvu návštěv, ať klik trefí jejich značku
    await openLayers(page);
    await page.uncheck("#layerTracks");
    await page.uncheck("#layerMyPlaces");
    await page.check("#visitNames");
    await closeLayers(page);
    await page.click("#panelCollapse");   // panel nesmí překrývat značky
    // návštěvy jsou ve shluku – klik na shluk mapu přiblíží a značky rozbalí
    const cluster = page.locator(".marker-cluster").first();
    if (await cluster.count()) await cluster.click();
    const tip = page.locator(".leaflet-tooltip.visitName").first();
    await expect(tip).toBeVisible({ timeout: 10000 });
    // klik na shluk mohl otevřít obecný popup mapy – zavřít, ať nepřekáží
    await page.evaluate(() => { window.map?.closePopup(); });

    const before = (await page.request.get("/api/visits").then((r) => r.json()))
      .visits.length;
    // značky se kreslí na canvas (žádné DOM elementy) – kliknout těsně
    // pod popisek, kde leží střed značky
    const tb = await tip.boundingBox();
    await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height + 10);
    const popup = page.locator(".leaflet-popup").last();
    await expect(popup).toContainText("Přehrát den");
    await expect(popup).toContainText("Kdy jsem tu byl?");
    await expect(popup).toContainText("Smazat návštěvu");

    await popup.locator('[data-act="del"]').click();
    // žádný potvrzovací dialog – akce proběhne hned a toast nabídne Zpět
    await expect(page.locator("#toast")).toContainText("smazána");
    const after = (await page.request.get("/api/visits").then((r) => r.json()))
      .visits.length;
    expect(after).toBe(before - 1);
    await page.locator("#toast .toastAction").click();
    await expect(page.locator("#toast")).toContainText("obnovena");
    const restored = (await page.request.get("/api/visits").then((r) => r.json()))
      .visits.length;
    expect(restored).toBe(before);
    // filtr min. délky pobytu je uložené nastavení
    await openLayers(page);
    await page.selectOption("#visitMinStay", "60");
    await page.reload();
    await loaded(page);
    expect(await page.locator("#visitMinStay").inputValue()).toBe("60");
  });
});

test.describe("statistiky a panel", () => {
  const loaded = (page) => page.waitForFunction(() =>
    document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));

  test("výběr dlaždic statistik se pamatuje", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await page.click('#tabs [data-tab="stat"]');
    await expect(page.locator("#statTiles .tile")).toHaveCount(11);
    await page.click("#statCustomize");
    await page.uncheck('#statPicker input[data-tile="speed"]');
    await page.uncheck('#statPicker input[data-tile="visitsPerDay"]');
    await expect(page.locator("#statTiles .tile")).toHaveCount(9);
    await page.reload();
    await loaded(page);
    await page.click('#tabs [data-tab="stat"]');
    await expect(page.locator("#statTiles .tile")).toHaveCount(9);
    // vrátit zpět, ať neovlivníme ostatní testy s počtem 11
    await page.click("#statCustomize");
    await page.check('#statPicker input[data-tile="speed"]');
    await page.check('#statPicker input[data-tile="visitsPerDay"]');
    await expect(page.locator("#statTiles .tile")).toHaveCount(11);
  });

  test("obnovení stránky nespouští přehrávání samo", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await page.click('#tabs [data-tab="stat"]');
    await page.locator("#calendar svg").waitFor();
    await page.locator('#calendar rect[data-rec="km"]').first().click();
    await expect(page.locator("#playBtn")).toHaveAttribute("data-state", "playing");
    await page.reload();
    await loaded(page);
    // den je připravený (datum vyplněné), ale nepřehrává se
    await expect(page.locator("#playDate")).not.toHaveValue("");
    await expect(page.locator("#playBtn")).not.toHaveAttribute("data-state", "playing");
  });

  test("sbalení panelu funguje i s nastavenou výškou", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await page.evaluate(() => {
      document.getElementById("panel").style.height = "700px";
    });
    await page.click("#panelCollapse");
    const box = await page.locator("#panel").boundingBox();
    expect(box.height).toBeLessThan(120);
    await page.click("#panelCollapse");
    await expect(page.locator("#tabs")).toBeVisible();
  });
});

test.describe("intuitivní ovládání", () => {
  const loaded = (page) => page.waitForFunction(() =>
    document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));

  test("sekce panelu jdou sbalit a stav přežije reload", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await expect(page.locator("#layerCompare")).toBeVisible();
    await page.locator(".tab-page[data-page='mapa'] section")
      .filter({ hasText: "Porovnání období" }).locator("h2").first().click();
    await expect(page.locator("#layerCompare")).toBeHidden();
    await page.reload();
    await loaded(page);
    await expect(page.locator("#layerCompare")).toBeHidden();
    await page.locator(".tab-page[data-page='mapa'] section")
      .filter({ hasText: "Porovnání období" }).locator("h2").first().click();
    await expect(page.locator("#layerCompare")).toBeVisible();
  });

  test("pravý klik na mapě otevře nabídku akcí", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await page.click("#panelCollapse");
    await page.mouse.click(900, 450, { button: "right" });
    const menu = page.locator("#mapMenu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Kdy jsem tu byl?");
    await expect(menu).toContainText("Kopírovat souřadnice");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    // položka „Kdy jsem tu byl?" opravdu spustí dotaz
    await page.mouse.click(900, 450, { button: "right" });
    await menu.locator('[data-mact="stays"]').click();
    await expect(page.locator("#locSummary")).not.toBeEmpty({ timeout: 10000 });
  });

  test("nástroje mapy fungují z ikonové lišty na mapě", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await page.click("#ctlMeasure");
    await expect(page.locator("#measureBtn")).toContainText("Ukončit měření");
    await page.keyboard.press("Escape");
    await page.click("#ctlTimelapse");
    await expect(page.locator("#timelapseBar")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("hledání a vrstvy na mapě", () => {
  const loaded = (page) => page.waitForFunction(() =>
    document.querySelector("#dbInfo")?.textContent.includes("Zobrazeno"));

  test("popover Vrstvy přepíná podklad i datové vrstvy", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await expect(page.locator("#layersPop")).toBeHidden();
    await page.click("#ctlLayers");
    const pop = page.locator("#layersPop");
    await expect(pop).toBeVisible();
    // podkladové mapy jsou přepínače, výběr se pamatuje
    await expect(pop.locator('input[name="baseMap"]')).toHaveCount(4);
    await pop.locator('input[name="baseMap"]').nth(3).check();   // Satelit
    // datová vrstva funguje odsud stejně jako dřív z panelu
    await page.uncheck("#layerTracks");
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await page.reload();
    await loaded(page);
    expect(await page.evaluate(() => localStorage.getItem("map.baseLayer")))
      .toContain("Esri");
    await page.click("#ctlLayers");
    await expect(page.locator("#layerTracks")).not.toBeChecked();
  });

  test("hledání na mapě rozbalí a zavře výsledky", async ({ page }) => {
    await page.goto("/");
    await loaded(page);
    await expect(page.locator("#mapSearch")).toBeVisible();
    await expect(page.locator("#searchResults")).toBeHidden();
    await page.fill("#searchInput", "Práce");
    await page.click("#searchBtn");
    await expect(page.locator("#searchResults")).toBeVisible();
    // vlastní navštívené místo se najde a klik na něj výsledky zavře
    const mine = page.locator('#searchResults a[data-kind="mine"]').first();
    if (await mine.count()) {
      await mine.click();
      await expect(page.locator("#searchResults")).toBeHidden();
    } else {
      await page.keyboard.press("Escape");
      await expect(page.locator("#searchResults")).toBeHidden();
    }
  });
});
