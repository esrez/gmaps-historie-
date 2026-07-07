# GMaps Historie

Self-hosted nástroj pro práci s historií polohy z Google Maps. Naimportujete
export z Googlu, a v prohlížeči pak máte interaktivní mapu tras, heatmapu,
statistiky a přehrávání jednotlivých dní. Vše běží na vašem serveru, data
neopouští váš stroj (kromě stahování mapových dlaždic z OpenStreetMap).

## Funkce

- **Mapa tras a bodů** – trasy, jednotlivé GPS body (s časem po najetí myší)
  i navštívená místa, filtrování podle období (vč. předvoleb Letos/Loni);
  najetí na trasu ukáže čas, kliknutí na ni rovnou přehraje daný den
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
- **Intuitivní ovládání** – sbalovací sekce, nenápadná oznámení místo
  vyskakovacích oken, obrácené období se samo prohodí, potvrzení uložení
  přímo v řádku tabulky, navádění k importu při prázdné databázi
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
- **Automatické testy** – sada pytest testů (importér, API, kniha jízd)
  spouštěná v GitHub Actions při každém push
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

## Spuštění bez Dockeru

Vyžaduje Python 3.11+.

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
# import z CLI:
python -m app.importer cesta/k/Timeline.json
```

Cestu k databázi lze změnit proměnnou prostředí `DB_PATH`
(výchozí `data/history.db`).

## Bezpečnost

Ve výchozím stavu aplikace nemá přihlašování – počítá s během v důvěryhodné
domácí síti. Doporučujeme v `docker-compose.yml` odkomentovat
`AUTH_PASSWORD=...` – aplikace pak vyžaduje heslo (jméno je libovolné).
Pokud ji vystavujete do internetu, přidejte navíc reverse proxy s HTTPS
(např. nginx, Caddy, Tailscale…). Jde o citlivá osobní data.

## Architektura

| Vrstva | Technologie |
|---|---|
| Backend | Python, FastAPI, SQLite (WAL) |
| Import | autodetekce formátu, streamované čtení přes `ijson` |
| Frontend | Leaflet + leaflet.heat, vanilla JS, bez build kroku |
| Nasazení | Docker / docker-compose |

API je popsané na `http://server:8000/api/docs` (Swagger UI).
