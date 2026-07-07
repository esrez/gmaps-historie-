# Uživatelský návod

Podrobný průvodce aplikací GMaps Historie. Rychlý přehled je v [README](../README.md).

## 1. První spuštění

1. `docker compose up -d --build` → aplikace běží na `http://server:8000`.
2. Při prázdné databázi se sama otevře sekce **Import dat** s nápovědou.
3. Nahrajte export z Googlu (viz níže) – formát se pozná automaticky.

### Kde vzít data z Googlu

| Zdroj | Soubor | Poznámka |
|---|---|---|
| Telefon (Android) | `Timeline.json` | Nastavení → Poloha → Časová osa → Exportovat |
| Telefon (iPhone) | `Timeline.json` | Google Maps → profil → Vaše časová osa → Nastavení |
| Starý Takeout | `Records.json` | surové GPS body, může mít gigabajty |
| Starý Takeout | `Semantic Location History/…` | měsíční JSON s názvy míst |
| Starý Takeout | celý `.zip` | projde se všechno uvnitř |

Import je **idempotentní** – stejný soubor můžete nahrát vícekrát, duplicity se
přeskočí. Velké soubory se zpracovávají na pozadí s ukazatelem průběhu.
Alternativy: nakopírovat soubor do `data/import/` (naimportuje se sám do
minuty), nebo z příkazové řádky
`docker compose exec gmaps-historie python -m app.importer /data/soubor.json`.

## 2. Mapa

- **Období** – od/do nebo předvolby (7/30/90 dní, Rok, Letos, Loni, Vše).
- **Vrstvy** – Trasy (klik = přehrát den), Jednotlivé body (čas po najetí),
  Heatmapa, Navštívená místa (velikost = strávený čas; při oddálení se shlukují).
- **Detail podle výřezu** – při zoomu se automaticky dotáhne plný detail
  viditelné oblasti. Vypnutím se vrátí jeden vzorek pro celé období.
- **Podkladové mapy** – přepínač vpravo nahoře (OSM, světlá, tmavá, satelit).
- **Hledání místa** – vaše místa i libovolná adresa (OpenStreetMap).
- **„Kdy jsem tu byl?"** – klik do mapy → seznam všech pobytů v okruhu
  100 m–1 km s daty, časy a délkou; export do Excelu; klik na pobyt přehraje den.
- **Statistiky / Analýza** – km celkem a po měsících, rozpad podle dopravy,
  top místa; km podle dne v týdnu, aktivita podle hodiny, km po letech.
- **Přehrávání dne** – ◀ ▶ listování, rychlost přehrávání, stopa obarvená
  rychlostí (světlá = pomalu), aktuální km/h, chronologická osa dne.
- Pohled i období se drží v adrese – funguje záložkování a obnovení stránky.

## 3. Kniha jízd (`/kniha`)

Typický postup na konci měsíce:

1. Zvolte **Tento/Minulý měsíc**, vyplňte SPZ, řidiče a účel (pamatuje se).
2. **⚙ Generovat jízdy** – vytvoří jízdy z rozpoznaných cest autem; filtruje
   pracovní dny a hodiny, ignoruje mikro-jízdy, přeskakuje duplicity
   a už existující záznamy (ruční úpravy se nikdy nepřepíšou).
3. Zkontrolujte **upozornění** nad tabulkou: chybějící dny (tlačítko Doplnit),
   neúplné jízdy, překročený tachometr.
4. Upravte tabulku – vše je editovatelné přímo v řádku; uložení potvrdí
   zelené bliknutí.
5. **Export XLSX pro SPZ** (import v programu SPZ od Milk Computers – vozidlo
   s toutéž SPZ musí být v SPZ založené) nebo **Export PDF** pro tisk.

### Pravidla kilometrů

Pevné km pro trasu/místo. Vzniknou automaticky: zadáte-li jízdě km, doplní se
všem jízdám na téže trase (obousměrně) a uloží se pravidlo. Ruční správa
v sekci Pravidla kilometrů; „Použít pravidla na období" přepočítá existující
jízdy. Vypnout lze přepínačem „Po zadání km doplnit stejnou trasu".

### Tachometr, soukromé jízdy, více vozidel

- **Tachometr**: zadejte roční nájezd → aplikace ukazuje „v knize X km,
  zbývá Y km". Vede se zvlášť pro každou SPZ.
- **Soukr.** = soukromá jízda firemním autem (v knize zůstává označená).
- **Vl. auto** = jízda vlastním autem – z knihy, součtů i exportů zmizí.
- Více vozidel: zapněte „Zobrazovat jen jízdy tohoto vozidla" a přepínejte SPZ.

## 4. Údržba dat

**🔍 Zkontrolovat data** najde: GPS „teleporty" (osamocené nemožné skoky),
body s horší přesností než limit, vadné návštěvy, duplicitní cesty z překryvu
exportů a dny bez dat. **🧹 Opravit** ukáže přesné počty a maže až po
potvrzení; poté se soubor databáze zkomprimuje. Originální exporty od Googlu
si nechte – kdykoli je lze naimportovat znovu.

**Zálohy**: automaticky každý den do `data/backups/` (14 posledních),
ručně tlačítkem. Obnovení: zastavit kontejner, nahradit `data/history.db`
souborem zálohy, spustit.

## 5. Provoz

| Co | Jak |
|---|---|
| Heslo | `AUTH_PASSWORD` v docker-compose (jméno při přihlášení libovolné) |
| Časová zóna | `TZ` v docker-compose (výchozí Europe/Prague, řeší letní čas) |
| Umístění dat | `./data` na hostiteli (databáze, zálohy, auto-import) |
| Aktualizace | `git pull && docker compose up -d --build` |
| Logy | `docker compose logs -f` |
| Interaktivní API | `http://server:8000/api/docs` |

## 6. Řešení potíží

- **Mapa je prázdná** – zkontrolujte období (zkuste „Vše") a `/api/range`.
- **Import hlásí chybu** – část dat už mohla být uložena; po opravě souboru
  import spusťte znovu, duplicity se přeskočí.
- **Špatné časy** – nastavte `TZ` v docker-compose na svou zónu.
- **SPZ odmítá import** – vozidlo se stejnou SPZ musí být v programu SPZ
  založené; prázdného řidiče si SPZ doplní z karty vozidla.
