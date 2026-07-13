# Změny

## 2.2.0 (2026-07)

### Testy a vývojářské zázemí
- pokrytí testy z 82 % na 88 %: nové testy pro upload import na pozadí
  (hlavní uživatelský tok), OwnTracks webhook, porovnání období, export
  pobytů místa, automatickou zálohu, profily (vytvoření/přepnutí/404),
  auth middleware (401/Basic/session cookie) a celý tok aktualizace
  (stažení → instalace → verze) – celkem 91 pytest testů
- přidán projektový skill `.claude/skills/dev` – postup ověřování změn,
  konvence a známé záludnosti pro práci na projektu

### Opravy z kontroly kódu
- **GPX import zahazoval časy** u standardního (namespacovaného) GPX –
  přes `/api/sync/gpx` i auto-import se nenaimportoval ani bod; opraveno
  (vč. round-trip testu na vlastní GPX export)
- **auto-import `.gpx`/`.geojson` ze složky `data/import/` byl celý
  rozbitý** (import z neexistujícího modulu) – soubory končily jako
  `.error`; opraveno + test
- **tachometr v upozorněních ignoroval SPZ** – při více vozidlech hlásil
  falešné překročení ročního nájezdu; nyní se porovnávají jen jízdy
  daného vozidla (a hláška vozidlo vypisuje)
- **CLI import (`python -m app.importer`) nepřepočítal agregace** –
  kalendář a měsíční km zůstaly prázdné do dalšího importu přes UI
- import přes UI přepočítával agregace dvakrát (zbytečná práce navíc)
- aktualizační balík se před rozbalením kontroluje na cesty mimo cílovou
  složku (zip slip) + test; GeoJSON LineString bez `ts` použije `start_ts`
- úklid: spojení SQLite v sync importech se zavírá i při chybě, seznam
  importních úloh v paměti se promazává

### Zveřejnění projektu
- přidána licence **MIT** (soubor `LICENSE`)
- **nové README** – představení aplikace s galerií 8 screenshotů (mapa,
  heatmapa, přehrávání dne, časosběr, statistiky, analýza, kniha jízd,
  tmavý režim), rychlý start pro Windows/Docker/Python, odznaky CI a licence
- screenshoty se nově generují z bohatších vestavěných ukázkových dat
  (`scripts/make_screenshots.mjs`)

### Windows 11
- **ikona v systémové liště** místo černého konzolového okna: klik otevře
  aplikaci, pravý klik nabídne Knihu jízd a Ukončit; výpisy jdou do
  `data/logs/app.log`
- **vlastní ikona aplikace** (exe, zástupci i instalátor – dosud generická)
- instalátor: volitelné **pravidlo brány firewall** pro přístup z domácí
  sítě (při odinstalaci se odstraní)
- **upozornění na novou verzi**: nenápadná kontrola vydání max. 1× denně
  (vypnutí `UPDATE_CHECK_URL=`), odkaz ke stažení v Nástroje → O aplikaci
- nová sekce **„Windows 11: tipy"** v návodu (výjimka Defenderu pro rychlý
  import, autostart, jiný port, umístění dat)

### Exporty
- **GPX** se dělí na `<trkseg>` po jednotlivých cestách – jiné aplikace už
  nekreslí rovné „teleportační" čáry mezi dny
- **GeoJSON** nově obsahuje trasy jako LineString (v QGIS apod. rovnou
  čitelné čáry); `points=false` vynechá surové body

### Kvalita kódu
- **ESLint** pro frontend (nedefinované proměnné, nepoužité symboly,
  `==` vs `===`) – `npm run lint`, kontroluje se i v CI
- **places-ui.js**: mapa míst, přehled v záložce Místa, kreslení polygonů
  a úprava tvaru vyčleněny z `app.js` do samostatného modulu
- backend: sloučení duplicitního výpočtu nejčastějších tras, importy na
  začátku modulů, ochrana proti neomezenému růstu paměti u rate-limiteru
  a brzdy proti hádání hesla
- sjednocená čeština v komentářích a hláškách, pojmenované konstanty
  místo magických čísel, potlačené zastaralé varování v testech

## 2.1.0 (2026-07)

### Výkon – víceletá historie (miliony bodů)
- `/api/points` z 16–20 s na **1,5–1,8 s** (rovinná Douglas–Peucker
  simplifikace, chytřejší vzorkování), heatmapa 3× rychlejší
- odstraněn R-tree index (B-tree je na těchto dotazech rychlejší) –
  rychlejší i import
- **oprava 500**: filtr dopravy padal u tisíců aktivit na limitu SQLite;
  nyní JOIN přes dočasnou tabulku intervalů
- **oprava mizejících tras**: hranice úseků (`breaks`) posílá server,
  klient je nehádá z časových mezer po simplifikaci
- vykreslení tisíců cest najednou přes multi-čáry; po přiblížení se
  automaticky dotáhne detail výřezu a vrátí interaktivita

### Mapa
- **heatmapa s režimy**: pohyb (kudy jezdím, volitelně jen ráno/den/
  večer/noc) × strávený čas (kde pobývám, váha = délka pobytu)
- **kalendář s náhledem**: najetí na den ukáže tooltip (km, body) a
  čárkovanou stopu dne na mapě; klik den přehraje
- **časosběr měsíců**: animace historie měsíc po měsíci (starší trasy
  blednou, aktuální zvýrazněný; posuvník, rychlost ½–4×)
- **měření vzdálenosti** (M) a **export výřezu do PNG** s razítkem období
- **barvy tras podle roku** + legenda – u víceleté historie hned vidíte,
  kudy jste kdy jezdili
- **přichycení přehrávaného dne k silnicím** (OSRM, opt-in v Soukromí)
- ovládací sloupec: přiblížit na data, moje poloha, celá obrazovka
- čitelnější body a místa (bílé prstence), kulaté spoje čar, shluky
  v barvách aplikace; interaktivní úprava tvaru míst (okruh i polygon)

### Statistiky a analýza
- **roztažitelný panel**: pravou hranu jde táhnout (šířka se pamatuje) –
  dlaždice i grafy se přizpůsobí pro komplexní přehled
- **8 dlaždic**: nově Ø km/den se záznamem, cest celkem, hodin na cestách,
  různých navštívených míst
- **Zajímavosti**: akční rádius (50/90/99 % záznamů od domova), nejdál od
  domova, noci mimo domov, typický začátek/konec všedního dne
- **Rytmus týdne**: punchcard den × hodina – kdy se hýbete
- **statistiky na mapě**: kružnice akčního rádia kolem domova a „pavouk"
  nejčastějších tras (tloušťka = četnost)
- **nejčastější trasy** (odkud ⇄ kam, počet, průměrné km)
- **km po měsících podle dopravy** (skládaný graf), všední dny vs. víkend
- kalendář jasně odlišuje dny se záznamem od dní bez záznamu (+ legenda)
- **Rok v pohybu** – sdílitelná PNG karta s ročním souhrnem

### Kniha jízd
- **export CSV** pro český Excel, **roční souhrn** na vozidlo,
  **uzávěrka měsíce** (uzavřený měsíc generování nepřepíše)

### Import a data
- přehled importu: co přibylo, které soubory se přeskočily a proč,
  celkem v databázi; po importu se mapa sama přepne na data
- **autokontrola kvality** po importu (nepřesné body, teleporty,
  duplicity) s tečkou na Nástrojích a průvodcem opravou
- **ukázková data** na jedno kliknutí pro vyzkoušení bez vlastního exportu
- připomínka, když jsou data starší 30 dní

### Opravy stability
- **database is locked**: záložní spojení bez busy_timeout blokovala zápisy;
  nyní 15s timeout, přepočet agregací se opakuje a při trvalém zámku se jen
  odloží (žádná 500), VACUUM je tolerantní

### Soukromí a provoz
- **smazání období**: všechna polohová data ve zvoleném rozmezí jdou smazat
  (dovolená apod.); před smazáním se automaticky vytvoří záloha
- session cookie dostává **Secure** flag při provozu přes HTTPS (i za
  reverse proxy); rate-limit na sync endpointy (OwnTracks/GPX)
- mobil: **Wake Lock** (displej nezhasíná při přehrávání dne) a tlačítko
  „Nainstalovat jako aplikaci" (PWA)
- CI: build Windows .exe při tagu vydá **GitHub Release** s binárkami

### Aplikace
- vlastní dialogy místo systémových, klávesové zkratky s nápovědou (?),
  stav aplikace v „O aplikaci" (velikost DB, poslední záloha, kontrola
  integrity), plynulejší přechody, ukazatel načítání mapy
- soukromí: adresy míst online jen se souhlasem (výchozí vypnuto)
- přihlášení: brzda proti hádání hesla, sessions přežijí restart
- **oprava**: obnova zálohy se volala špatnou HTTP metodou (405)

## 2.0.0

První veřejné vydání: mapa s trasami/heatmapou/body, přehrávání dne,
statistiky, kniha jízd s XLSX/PDF exportem, místa (okruhy a polygony),
profily, zálohy, PWA, Docker i Windows .exe.
