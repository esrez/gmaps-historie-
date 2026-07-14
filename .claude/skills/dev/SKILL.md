---
name: dev
description: Vývojový postup pro GMaps Historie – spuštění aplikace, testy (pytest, ESLint, Playwright e2e), ověřování změn v prohlížeči, screenshoty, konvence commitů a vydávání verzí. Použij při jakékoli práci na kódu tohoto repozitáře.
---

# Vývoj GMaps Historie

Self-hosted FastAPI + SQLite aplikace s vanilla-JS frontendem (Leaflet).
Žádný build frontendu – soubory v `app/static/` se servírují přímo.

## Mapa projektu

- `app/routers/` – HTTP endpointy (map_data, stats, pages, import_, sync,
  backup, quality, export, profiles); `app/trips.py` = celá kniha jízd,
  `app/places.py` = pojmenovaná místa
- `app/services/` – logika bez HTTP (geo, simplify, aggregations, quality, demo)
- `app/core/` – auth, backup, config, updater, rate_limit, events (SSE)
- `app/importer.py` – autodetekce všech formátů Google exportu
- `app/static/app.js` – hlavní modul (~2000 řádků); vyčleněné moduly
  (`places-ui.js`, `map-tools.js`, `timelapse.js`, `import-ui.js`,
  `year-card.js`, `day-playback.js`…) dostávají závislosti přes
  `initXxx({ map, css, … })` – při další extrakci drž stejný vzor
- `tests/` – pytest (`conftest.py` má fixtures `test_db`+`client`,
  `fixtures.py` generátory Google exportů), `tests/e2e/app.spec.mjs` –
  Playwright proti demo datům (server si spouští `playwright.config.mjs`
  na portu 8177)

## Ověření změny (spouštěj po každé úpravě)

```bash
ruff check app/ tests/ run.py        # lint backendu
pytest -q                            # ~90 testů, běží pod TZ=Europe/Prague
npm run lint                         # ESLint frontendu (0 nálezů = OK)
npx playwright test                  # 28 e2e testů (celé UI)
```

- Po úpravě `.js` vždy aspoň `node --input-type=module --check < soubor`
  (ESLint to pokryje také). CI (`.github/workflows/ci.yml`) spouští totéž.
- V sandboxu bez lokálního Pythonu: venv je v
  `$SCRATCHPAD/venvtest/bin/{python,ruff}`; Playwright potřebuje
  `CHROMIUM_PATH=/opt/pw-browsers/chromium-*/chrome-linux/chrome`.
- Vizuální ověření: nastartuj server nad demo daty a projdi UI v prohlížeči
  (screenshot přes throwaway Playwright skript):

```bash
DB_PATH=/tmp/demo.db python -c "from app.services.demo import generate_demo; generate_demo()"
DB_PATH=/tmp/demo.db DISABLE_BACKGROUND=1 UPDATE_CHECK_URL= uvicorn app.main:app --port 8188
```

- Screenshoty pro README: `node scripts/make_screenshots.mjs http://127.0.0.1:8188`
  (proti bohatému demu z `generate_demo`, ne e2e seedu).

## Konvence

- **Čeština všude**: commit zprávy, komentáře, UI texty, dokumentace.
  V JS řetězcích nepoužívej české uvozovky „" přes shellové sed/heredoc –
  rozbíjejí parser; po každé shellové editaci `node --check`.
- Commit přes soubor (`git commit -F msg.txt`) – závorky a diakritika
  v `-m` rozbíjejí shell. Zprávy končí trailerem
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Vývoj na větvi `claude/maps-location-history-tool-72c3r2`, hotové celky
  `git merge --no-ff` do `main` a push obojího (push s retry 2s/4s/8s/16s).
- Ke každé změně: záznam do `CHANGELOG.md` (sekce Nevydáno), případně
  `docs/NAVOD.md` (uživatelské chování) a `docs/API.md` (endpointy).
- Nové chování = nový test (regresní testy pojmenované podle chyby).

## Záludnosti, které už jednou kously

- `xml.etree` `Element` bez potomků je **falsy** – nikdy `el or fallback`,
  vždy `if el is None`.
- SQLite „database is locked": každé nové surové připojení musí mít
  `busy_timeout`; `db.after_import` má retry a nesmí shodit hlavní operaci.
- SQLite limit hloubky výrazu: dlouhé OR seznamy řeš temp tabulkou + JOIN
  (viz `_points_by_transport` v `app/services/geo.py`).
- Frontend drží stav v URL hashi (období, přehrávání) – testy a screenshoty
  musí mezi kroky navigovat na čistou adresu, jinak stav prosakuje.
- `[hidden]` atribut přebíjí `display:flex` jen díky globálnímu pravidlu
  ve `style.css` – neodstraňovat.
- Checkboxy vrstev žijí v **popoveru na mapě** (`#layersPop`) – v e2e ho
  otevři přes `#ctlLayers` (helper `openLayers`/`closeLayers` v app.spec).
  Klik mimo popover (jiný prvek, záložka) ho zavře.
- OSRM a mapové dlaždice nejsou ze sandboxu dostupné – síťové věci mockuj
  (`map_data._osrm_fetch`, `pages._fetch_latest_release`).
- PyInstaller: verze se čte ze souboru `VERSION` bundlovaného ve specu;
  po změně spec/ikony ověř `datas` v `gmaps-historie.spec`.

## Vydání verze

1. Zvednout `VERSION`, přesunout Nevydáno v `CHANGELOG.md` pod novou verzi.
2. Testy + merge do `main` + push.
3. Tag `vX.Y.Z` pushne **uživatel** (sandbox nemá právo na tagy):
   `git tag vX.Y.Z && git push origin vX.Y.Z` → GitHub Actions
   (`windows-build.yml`) sestaví **portable** `GMapsHistorie.exe`
   a vytvoří Release (jen exe – instalátor se nevydává).
