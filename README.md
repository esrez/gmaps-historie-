# GMaps Historie

Self-hosted nástroj pro práci s historií polohy z Google Maps. Naimportujete
export z Googlu, a v prohlížeči pak máte interaktivní mapu tras, heatmapu,
statistiky a přehrávání jednotlivých dní. Vše běží na vašem serveru, data
neopouští váš stroj (kromě stahování mapových dlaždic z OpenStreetMap).

## Funkce

- **Mapa tras a bodů** – trasy, jednotlivé GPS body (s časem po najetí myší)
  i navštívená místa, filtrování podle období (vč. předvoleb Letos/Loni);
  najetí na trasu ukáže čas, kliknutí na ni rovnou přehraje daný den
- **Detail podle výřezu mapy** – při posunu či přiblížení se automaticky
  dotáhne plný detail jen pro viditelnou oblast (žádné hrubé vzorkování
  při zoomu) a heatmapa přepne na jemnější mřížku; s indikátorem načítání
- **Stav v adrese** – zvolené období a pohled na mapu se drží v URL, takže
  funguje záložkování, sdílení odkazu i obnovení stránky
- **Přehrávání se stopou obarvenou rychlostí** – světlá = chůze, tmavá =
  rychlá jízda, u ukazatele běží aktuální km/h; velikost značek míst
  odpovídá času tam strávenému
- **4 mapové podklady** – OpenStreetMap, světlý a tmavý (Carto), satelitní
  (Esri); tmavý se předvolí podle vzhledu systému; měřítko na mapě
- **Shlukování míst** – při oddálení se navštívená místa slučují do
  přehledných clusterů s počtem
- **Heatmapa** – kde trávíte nejvíc času / kudy nejčastěji jezdíte
- **Hledání místa** – vyhledá vaše navštívená místa i libovolnou adresu/obec
  (OpenStreetMap Nominatim)
- **„Kdy jsem tu byl?"** – klikněte kamkoli do mapy (nebo na výsledek hledání)
  a dostanete seznam všech svých pobytů v daném okruhu: datum, od–do, délka.
  Kliknutím na pobyt se den rovnou přehraje; seznam jde exportovat do Excelu
- **Statistiky** – celkové kilometry, rozpad podle dopravního prostředku,
  kilometry po měsících (graf), nejnavštěvovanější místa, hodiny strávené na místech
- **Přehrávání dne** – animace pohybu ve zvoleném dni s časovou osou, rychlostí
  přehrávání a listováním po dnech (◀ ▶)
- **Export do Excelu** – listy Návštěvy, Cesty, Km po měsících, Top místa
  a GPS body za zvolené období; zvlášť i export pobytů na konkrétním místě
- **Export do GPX** – trasy pro použití v jiných mapových aplikacích
- **Analýza** – kilometry podle dne v týdnu, aktivita podle hodiny dne,
  kilometry a počty cest po letech
- **Údržba dat s automatickými opravami** – kontrola najde GPS „teleporty"
  (osamocené nereálné skoky), body s nízkou přesností (volitelný limit
  50/100/200 m), vadné návštěvy a dny bez dat; oprava je nejdřív ukáže
  a smaže až po potvrzení
- **Upozornění v knize jízd** – dny s jízdou autem, které v knize chybí
  (s tlačítkem Doplnit nyní), neúplné jízdy a překročený roční tachometr
- **Moderní rozhraní** – mapa přes celou obrazovku, plovoucí panel se
  záložkami (Mapa / Statistiky / Analýza / Nástroje), plovoucí lišta
  přehrávání, legenda vrstev, jednotné SVG ikony, dlaždice statistik
  s trendem oproti minulému období a mini-grafem, prázdné stavy s navigací
- **Průvodce pro začátečníky** – při prvním spuštění (prázdná databáze) se
  otevře jednoduchý průvodce, který krok za krokem ukáže, **kde vzít data
  z Google historie polohy** (odkazy na Google Takeout i export z telefonu)
  a jak je nahrát; dostupný i kdykoli později tlačítkem **?** v hlavičce
- **Intuitivní ovládání** – nenápadná oznámení místo vyskakovacích oken,
  obrácené období se samo prohodí, potvrzení uložení přímo v řádku tabulky,
  navádění k importu při prázdné databázi
- **Zálohování** – automatická denní záloha databáze do `data/backups/`
  (rotace 14 dní) + tlačítko pro okamžité stažení zálohy
- **Volitelné heslo** – nastavením `AUTH_PASSWORD` v docker-compose se celá
  aplikace schová za přihlášení (HTTP Basic)
- **Import na pozadí** – i vícegigabajtový Records.json se zpracovává na
  pozadí s průběžným ukazatelem; server zůstává použitelný
- **Auto-import ze složky** – soubory nakopírované do `data/import/` se samy
  naimportují do minuty (po zpracování dostanou příponu `.imported`)
- **Ochrana proti duplicitám** – při kombinaci starého Takeoutu a nového
  exportu se stejná cesta nezapočítá dvakrát (kontrola kvality je umí najít
  a odstranit, generování knihy jízd je přeskakuje)
- **Časová osa dne** – u přehrávání se zobrazí chronologický přehled
  „odjezd → místo (hodiny) → přesun (km)" s prokliky na mapu
- **Kniha jízd navíc**: více vozidel (filtr dle SPZ, tachometr pro každé
  vozidlo zvlášť), **export do PDF** pro tisk (měsíční součty, česká
  diakritika) a **vrácení poslední hromadné akce** (generování, propagace km,
  použití pravidel i smazání období)
- **Vlastní názvy míst** – místa lze pojmenovat (zákazník, adresa…) místo
  souřadnic; názvy se použijí v top místech, na mapě, v hledání i v knize
  jízd a jdou kdykoli upravit (Home/Work se překládá na Domov/Práce);
  velké objekty lze obkreslit **polygonem** a vrstva „Moje místa" je ukazuje
- **Přehled „Moje místa"** (samostatná záložka) – seznam všech pojmenovaných
  míst s počtem návštěv a časem ve zvoleném období, filtrování a řazení;
  klik na místo ho ukáže na mapě a rozbalí **jednotlivé pobyty** (kdy od–do
  a jak dlouho jste tam byli); přímo v seznamu lze **upravit vyhrazený prostor**
  (okruh v metrech s živým náhledem i překreslení polygonu), přejmenovat
  s **našeptávačem** a smazat. U souřadnic se dopočítá **adresa** (reverzní
  geokódování) – v detailu i v bublině na mapě
- **Kniha jízd po dnech** – řádek dne se součtem km a trasou, rozbalení na
  editovatelné jízdy; mezisoučty měsíců, přilepená hlavička i celkový součet,
  hromadný výběr a mazání jízd či celých dnů; pole s **našeptávačem** míst
  a účelů; km bez údaje od Googlu se dopočítají ze skutečné GPS stopy,
  takže kniha souhlasí s mapou
- **Zápis po městech** – místní jízdy v rámci města se sloučí do řádku
  „Brno" se sečtenými km, mezi městy „Brno → Praha" (vestavěný offline
  číselník českých měst); na mapě mají cesty směrové šipky, střídavé
  odstíny pro rozlišení a bubliny míst ukazují délku pobytu v období
- **Kalendářový přehled roku** – mřížka všech dnů obarvená podle najetých km
  (šedě dny se záznamem bez jízdy); kliknutí na den ho rovnou přehraje
- **Rekordy období** – nejvíc km za den, nejdelší jednotlivá cesta a nejdelší
  série po sobě jdoucích dní s jízdou, přímo ve statistikách
- **Porovnání dvou období na mapě** – druhé období se vykreslí oranžově přes
  hlavní modré trasy (předvolba „stejné období loni") pro srovnání letos/loni
- **Widget tachometru v knize jízd** – proužek najeto/zbývá nad tabulkou,
  červený při překročení ročního nájezdu
- **Obnova zálohy přímo v aplikaci** – výběr z denních záloh a obnovení jedním
  klikem; současný stav se předtím sám zazálohuje, takže obnovu lze vzít zpět
- **Mobilní ovládání** – na telefonu se kniha jízd zobrazuje jako karty,
  boční panel mapy jako vysouvací sheet, větší dotykové plochy
- **PWA** – aplikaci lze nainstalovat na plochu telefonu/počítače; UI se
  cachuje a naběhne i bez připojení
- **Plně offline mapy** – volitelně vlastní mapový podklad ze souboru
  `data/map.pmtiles` (Protomaps); žádná dlaždice pak neopouští vaši síť
- **WebGL vykreslování** – nad 20 000 zobrazených bodů převezme kreslení
  WebGL vrstva, plynulé i pro statisíce bodů
- **Přepínač vzhledu** (auto/tmavý/světlý), **klávesové zkratky**
  (◀ ▶ = listování dnů, mezerník = přehrát/zastavit), **vícekrokové undo**
  v knize jízd (10 kroků zpět – vč. mazání jednotlivých i vybraných jízd),
  plynulé načítání dlouhých tabulek
- **Verzovaná PWA cache** – po aktualizaci serveru se mezipaměť sama
  zneplatní, nové UI naběhne bez ručního mazání cache (verze v Nástrojích)
- **Automatické testy** – pytest (50 testů: importér, API, kniha jízd, update)
  + smoke test (`scripts/smoke_test.py`) a Playwright e2e testy UI v GitHub Actions
- **Kniha jízd** (`/kniha`) – samostatná stránka pro firemní vozidlo:
  - automatické generování jízd z rozpoznaných cest autem, volitelně jen
    pracovní dny a pracovní doba (např. po–pá 6–18 h), s minimální délkou jízdy
  - odkud/kam se doplní podle vašich navštívených míst (Domov, Práce, názvy míst)
  - **pravidla kilometrů**: pevné km pro trasu či místo (např. Kancelář = 12 km);
    po zadání km v tabulce se stejná hodnota automaticky doplní všem jízdám na
    téže trase (obousměrně) a uloží se jako pravidlo; pravidla lze spravovat
    a hromadně aplikovat na období
  - **zaokrouhlování km nahoru** (volitelné)
  - **tachometr**: zadáte roční nájezd a aplikace průběžně ukazuje, kolik km
    je vykázáno v knize a kolik zbývá
  - **jízdy vlastním autem**: zaškrtnutím „Vl. auto" se jízda vyřadí z knihy
    (nezapočítává se a v exportu nebude), „Soukr." značí soukromou jízdu
    firemním vozem (v knize zůstává)
  - plně editovatelná tabulka (datum, časy, místa, km, účel),
    ruční přidávání jízd; opakované generování nepřepíše ruční úpravy
  - **export XLSX pro import do programu SPZ** (Milk Computers): sloupce SPZ,
    Datum, Odjezd, Příjezd, Odkud, Kam, Účel jízdy, Km, Řidič, Soukromá.
    Pozn.: vozidlo se stejnou SPZ musí být v programu SPZ založené, jinak
    import odmítne; prázdného řidiče si SPZ doplní z karty vozidla

Časy se všude převádějí podle proměnné `TZ` (výchozí Europe/Prague) se správným
letním/zimním časem – nastavte ji v `docker-compose.yml`, pokud jste jinde.
- **Import všech formátů Googlu** s automatickou detekcí:
  - nový export z telefonu (`Timeline.json`, Android i iOS varianta)
  - starý Google Takeout (`Records.json` – zvládá i vícegigabajtové soubory
    díky streamovanému čtení, a měsíční soubory ze `Semantic Location History`)
  - celý ZIP archiv z Takeoutu
  - opakovaný import je bezpečný – duplicity se automaticky přeskočí

## Jak získat data z Googlu

**Nový formát (od ~poloviny 2024):** historie polohy („Časová osa") žije jen
v telefonu. Export: *Nastavení → Poloha → Služby určování polohy → Časová osa
→ Exportovat data časové osy* (Android), příp. v aplikaci Google Maps
*profil → Vaše časová osa → ⋯ → Nastavení polohy → Exportovat*. Získáte
`Timeline.json`.

**Starý formát:** pokud máte starší export z [takeout.google.com](https://takeout.google.com)
(Historie polohy), použijte `Records.json` a/nebo složku
`Semantic Location History` – nebo rovnou celý stažený ZIP.

## Spuštění (Docker – doporučeno)

```bash
git clone <tento-repozitář>
cd gmaps-historie-
docker compose up -d --build
```

Aplikace poběží na `http://server:8000`. Databáze (SQLite) se ukládá do
`./data/history.db` na hostiteli.

### Import dat

Buď přes webové rozhraní (sekce **Import dat** v levém panelu – nahrajete
JSON nebo ZIP), nebo z příkazové řádky (vhodnější pro obří `Records.json`):

```bash
cp Timeline.json data/
docker compose exec gmaps-historie python -m app.importer /data/Timeline.json
```

## Spuštění bez Dockeru (Windows / Linux / macOS)

Aplikace je čistě Python + SQLite, takže běží i jako běžná aplikace bez
Dockeru. Vyžaduje jen **Python 3.11+**.

### Windows (dvojklik)

1. Nainstalujte [Python 3.11+](https://www.python.org/downloads/) a při
   instalaci zaškrtněte **„Add python.exe to PATH"**.
2. Stáhněte projekt (tlačítko *Code → Download ZIP* a rozbalte, nebo
   `git clone`).
3. Dvojklik na **`start-windows.bat`**. Při prvním spuštění se jednorázově
   vytvoří prostředí a nainstalují závislosti; pak se aplikace spustí a sama
   otevře prohlížeč na `http://127.0.0.1:8000`.

Databáze i zálohy zůstávají ve složce `data\` vedle programu. Pro příště stačí
`start-windows.bat` spustit znovu.

### Linux / macOS (a Windows z příkazové řádky)

```bash
pip install -r requirements.txt
python run.py            # nastartuje server a otevře prohlížeč
# nebo přímo:
uvicorn app.main:app --host 127.0.0.1 --port 8000
# import z CLI:
python -m app.importer cesta/k/Timeline.json
```

### Nastavení (proměnné prostředí)

| Proměnná | Význam | Výchozí |
|---|---|---|
| `HOST` | adresa naslouchání; `0.0.0.0` = dostupné v domácí síti | `127.0.0.1` |
| `PORT` | port | `8000` |
| `DB_PATH` | umístění databáze | `data/history.db` |
| `TZ` | časové pásmo (řeší letní čas) | `Europe/Prague` |
| `AUTH_PASSWORD` | když je nastaveno, vyžaduje heslo (HTTP Basic) | – |
| `OPEN_BROWSER` | `0` = neotvírat prohlížeč při startu | `1` |

Na Windows se proměnná nastaví např. `set HOST=0.0.0.0` před spuštěním
(nebo odkomentováním řádku v `start-windows.bat`). Zálohy, auto-import ze
složky `data\import\` i offline PMTiles fungují stejně jako v Dockeru.

> **Automatický start s Windows (volitelné):** zástupce na `start-windows.bat`
> vložte do složky po spuštění `shell:startup` (Win+R). Pro běh na pozadí bez
> okna lze použít Správce úloh → naplánovaná úloha spouštějící
> `.venv\Scripts\python.exe run.py`.

### Vytvoření jednoho `.exe` (uživatel nepotřebuje Python)

Pro rozdání ostatním lze aplikaci zabalit do **jediného spustitelného souboru**
pomocí [PyInstaller](https://pyinstaller.org) – uživatel pak nemá žádné
závislosti a jen soubor spustí.

Na Windows spusťte **`build-windows-exe.bat`** (nebo ručně
`pip install pyinstaller` a `pyinstaller gmaps-historie.spec`). Výsledek je
`dist\GMapsHistorie.exe` a automaticky i `dist\GMapsHistorie-update.zip`.
Ten stačí zkopírovat kamkoli a spustit – nastartuje
server, otevře prohlížeč a **data ukládá do složky `data\` vedle sebe**.
Do balíčku je zahrnutý Python, všechny knihovny i webové rozhraní; PDF export
s českou diakritikou i časová pásma fungují bez doinstalování.

**Instalační program:** `build-windows-installer.bat` (vyžaduje [Inno Setup 6](https://jrsoftware.org/isinfo.php))
vytvoří `dist\GMapsHistorie-Setup.exe`. Podrobnosti v
[docs/WINDOWS_INSTALLER.md](docs/WINDOWS_INSTALLER.md).

**Kontrola po buildu:** `python scripts\smoke_test.py --package dist\GMapsHistorie-update.zip`

Pozn.: `.exe` sestavíte na Windows, na Linuxu/macOS vznikne obdobná binárka
pro daný systém (PyInstaller nekřížově-nekompiluje). Antivirus někdy hlásí
neznámý spustitelný soubor – jde o běžný falešný poplach u PyInstaller balíčků.

## Bezpečnost

Ve výchozím stavu aplikace nemá přihlašování – počítá s během v důvěryhodné
domácí síti. Doporučujeme v `docker-compose.yml` odkomentovat
`AUTH_PASSWORD=...` – aplikace pak vyžaduje heslo (jméno je libovolné).
Pokud ji vystavujete do internetu, přidejte navíc reverse proxy s HTTPS
(např. nginx, Caddy, Tailscale…). Jde o citlivá osobní data.

## Dokumentace

- **[Uživatelský návod](docs/NAVOD.md)** – průvodce všemi funkcemi krok za
  krokem, provoz, řešení potíží
- **[API reference](docs/API.md)** – přehled všech endpointů; interaktivně
  na `http://server:8000/api/docs` (Swagger UI)

## Architektura

| Vrstva | Technologie |
|---|---|
| Backend | Python 3.11+, FastAPI (routery v `app/routers/`, služby v `app/services/`), SQLite WAL |
| Import | autodetekce formátu, streamované čtení přes `ijson`, běh na pozadí, SSE notifikace |
| Frontend | ES moduly (`app.js`, `map-filters.js`, `sync-events.js`), Leaflet, PWA |
| Zobrazování | data podle výřezu mapy s rušením rozpracovaných dotazů (AbortController), gzip API |
| Kvalita | pytest (50 testů) + ruff + smoke test v GitHub Actions |
| Nasazení | Docker / docker-compose, PyInstaller `.exe`, Inno Setup installer, in-place updater |

## Vývoj

```bash
pip install -r requirements.txt pytest httpx ruff
ruff check app/ tests/   # lint
pytest -q                # testy
python scripts/smoke_test.py
uvicorn app.main:app --reload
```
