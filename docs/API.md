# API reference

Interaktivní dokumentace se schématy: `http://server:8000/api/docs` (Swagger UI).
Časy jsou unixové sekundy (UTC); lokální převody řeší server podle `TZ`.
Většina endpointů přijímá `from_ts`/`to_ts` (vynechané = bez omezení).

## Historie polohy

| Endpoint | Metoda | Popis |
|---|---|---|
| `/api/range` | GET | rozsah dat a počty záznamů v databázi |
| `/api/points` | GET | GPS body; `limit` (vzorkování), volitelný výřez `min_lat`/`max_lat`/`min_lon`/`max_lon` |
| `/api/heatmap` | GET | agregované buňky; `precision` = desetinná místa mřížky (2–6), volitelný výřez |
| `/api/visits` | GET | navštívená místa se jmény a časy |
| `/api/day` | GET | body + návštěvy + cesty jednoho dne (`from_ts`, `to_ts` povinné) |
| `/api/stats` | GET | souhrn: km, dny, návštěvy, po měsících, top místa, rekordy (`records`: nejdelší den/cesta/série); `min_stay_min` (výchozí 2) vyřadí průjezdy |
| `/api/analysis` | GET | km podle dne v týdnu, aktivita po hodinách, km po letech, místa po měsících |
| `/api/search_visits` | GET | fulltext ve vlastních místech (`q`) |
| `/api/at_location` | GET | pobyty v okruhu (`lat`, `lon`, `radius_m`, `min_stay_min` – výchozí 2 min vyřadí průjezdy); slučuje GPS pobyty se záznamy návštěv |
| `/api/calendar` | GET | denní km + počty bodů pro kalendář roku (`year`) |
| `/api/pmtiles/status` | GET | dostupnost offline mapy `data/map.pmtiles` |
| `/api/pmtiles` | GET | servíruje PMTiles s podporou HTTP Range |
| `/api/places` | GET/POST | vlastní názvy míst (zákazník, adresa…); POST upsert dle blízkosti, volitelně `polygon` |
| `/api/places/{id}` | PATCH/DELETE | úprava podle id: `name`, `radius_m`, `polygon` (`[]` zruší oblast), `lat`/`lon` (posun středu kruhu) / smazání |
| `/api/places/stats` | GET | pobyt na pojmenovaných místech v období (pro bubliny na mapě i přehled) |
| `/api/places/{id}/stays` | GET | jednotlivé pobyty na daném místě v období (kdy od–do a jak dlouho) |

## Import a údržba

| Endpoint | Metoda | Popis |
|---|---|---|
| `/api/import` | POST | upload souboru (JSON/ZIP); vrací `job_id`, běží na pozadí |
| `/api/import/status/{job_id}` | GET | průběh importu (počty, stav, chyba) |
| `/api/autoimport` | GET | log souborů zpracovaných ze složky `data/import/` |
| `/api/quality` | GET | kontrola: nepřesné body (`accuracy_limit`), teleporty, vadné návštěvy, duplicitní cesty, dny bez dat |
| `/api/cleanup` | POST | opravy; `dry_run=true` jen počítá; přepínače `remove_*`; po skutečném mazání VACUUM |
| `/api/backup` | GET | stáhne čerstvou zálohu databáze (a založí ji do rotace) |
| `/api/backups` | GET | seznam dostupných záloh (jméno, velikost, čas) |
| `/api/restore` | POST | obnoví DB z vybrané zálohy (`name`); současný stav se předtím zazálohuje |
| `/api/version` | GET | verze frontendu (otisk statických souborů; verzuje i cache PWA) |

## Exporty

| Endpoint | Metoda | Popis |
|---|---|---|
| `/api/export.xlsx` | GET | listy Návštěvy, Cesty, Km po měsících, Top místa, GPS body |
| `/api/export.gpx` | GET | trasa pro jiné mapové aplikace (`limit`) |
| `/api/export_location.xlsx` | GET | pobyty na místě (`lat`, `lon`, `radius_m`, `label`) |

## Kniha jízd (`/api/trips`)

| Endpoint | Metoda | Popis |
|---|---|---|
| `/api/trips` | GET | jízdy v období; volitelně `plate`; vrací i `total_km` (bez vyřazených) |
| `/api/trips` | POST | ruční přidání jízdy (JSON dle `TripIn`) |
| `/api/trips/{id}` | PATCH | částečná úprava (libovolná pole `TripPatch`) |
| `/api/trips/{id}` | DELETE | smazání jízdy; jde vrátit |
| `/api/trips/bulk_delete` | POST | smazání více jízd (`ids`) jedním krokem; jde vrátit |
| `/api/trips` | DELETE | smazání jízd v období (volitelně `plate`); jde vrátit |
| `/api/trips/generate` | POST | vygeneruje jízdy z cest autem (pracovní dny/hodiny, min. km, zaokrouhlení, pravidla, duplicity; `city_mode` slučuje místní jízdy pod město); jde vrátit |
| `/api/trips/propagate` | POST | doplní km všem jízdám na stejné trase + uloží pravidlo; jde vrátit |
| `/api/trips/apply_rules` | POST | přepočítá km v období podle pravidel; jde vrátit |
| `/api/trips/rules` | GET/POST | výpis / upsert pravidla (`origin` volitelný, `destination`, `km`) |
| `/api/trips/rules/{id}` | DELETE | smazání pravidla |
| `/api/trips/odometer` | GET/PUT | roční tachometr per SPZ; vrací i `booked_km` a `remaining_km` |
| `/api/trips/undo` | GET/POST | info o poslední hromadné akci / její vrácení |
| `/api/trips/suggest` | GET | našeptávač: známá místa a používané účely |
| `/api/trips/missing_days` | GET | dny s jízdou autem chybějící v knize |
| `/api/trips/alerts` | GET | neúplné jízdy, překročené tachometry |
| `/api/trips/export.xlsx` | GET | kniha jízd pro import do SPZ (bez vyřazených; volitelně `plate`) |
| `/api/trips/export.pdf` | GET | tisková kniha jízd s měsíčními součty |

## Zabezpečení

Je-li nastaveno `AUTH_PASSWORD`, všechny cesty vyžadují HTTP Basic
(uživatelské jméno libovolné). Bez něj je API otevřené – provozujte jen
v důvěryhodné síti.
