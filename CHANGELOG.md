# Změny

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
