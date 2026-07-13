# Uživatelský návod

Podrobný průvodce aplikací GMaps Historie. Rychlý přehled je v [README](../README.md).

## 1. První spuštění

1. Spusťte aplikaci (Docker, `python run.py`, nebo na Windows dvojklikem na
   `start-windows.bat` / `GMapsHistorie.exe`) → poběží na `http://…:8000`.
2. Při prázdné databázi se sám otevře **průvodce pro začátečníky**, který
   ve třech krocích vysvětlí, kde vzít data z Googlu (s odkazy na Google
   Takeout i export z telefonu) a jak je nahrát. Průvodce lze kdykoli znovu
   otevřít tlačítkem **?** v hlavičce (nebo „Kde vzít data z Googlu?" v sekci
   Import). Zaškrtnutím „Nezobrazovat po spuštění" se přestane otevírat sám.
   Průvodce nabízí i tlačítko **„Jen si to vyzkoušet"** – nahraje ~3 měsíce
   ukázkových dat (dojíždění, nákupy, výlety), abyste si aplikaci prohlédli
   bez vlastního exportu. Funguje jen nad prázdnou databází, ukázku pak
   smažete např. přepnutím na nový profil.
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
přeskočí. Velké soubory (i miliony bodů) se zpracovávají na pozadí, streamovaně
a po dávkách; na mapě se pak body chytře vzorkují a trasy zjednodušují
(Douglas–Peucker), takže i **několik let historie najednou** se vykreslí během
pár sekund a aplikace zůstává svižná. Po přiblížení se automaticky dotáhne plný
detail viditelného výřezu. Alternativy: nakopírovat soubor do `data/import/`
(naimportuje se sám do minuty), nebo z příkazové řádky
`docker compose exec gmaps-historie python -m app.importer /data/soubor.json`.

**Přehled importu.** Po dokončení uvidíte, co se přesně stalo: kolik přibylo GPS
bodů, návštěv a cest, z kolika souborů, a **kolik souborů se přeskočilo a proč**
(typicky soubory, které nejsou data o poloze – nastavení a jiné služby v ZIPu;
to je v pořádku). Nakonec je vypsáno, co je teď **celkem v databázi** a **rozsah
dat** (od–do). Když se nenašla žádná data, program to zřetelně oznámí a poradí,
který soubor z Googlu vybrat. Hned po importu se mapa přepne na **Vše** a skočí
na vaše data, takže je uvidíte bez dalšího klikání. Zároveň proběhne
**autokontrola kvality**: nepřesné body, teleporty, vadné návštěvy a
duplicitní cesty. Zjištění se vypíší pod souhrnem, na záložce Nástroje se
objeví tečka a tlačítko „Zkontrolovat a opravit" vás zavede k návrhům oprav
(nic se nemaže samo).

## 2. Mapa

Mapa zabírá celou obrazovku; ovládání je v plovoucím panelu vlevo se
záložkami **Mapa · Místa · Statistiky · Analýza · Nástroje**. Panel lze
šipkou vpravo nahoře **sbalit** (▾/▸), **roztáhnout tažením za pravou
hranu** (šířka se pamatuje – širší panel = komplexnější přehled statistik)
a hlavně ho lze **odsunout tažením za
hlavičku** (kurzor ruky), takže se dostanete k celé mapě a můžete s ní volně
posouvat i tam, kde panel původně překážel. Dole je plovoucí lišta přehrávání
dne, vpravo dole legenda vrstev (obojí je průchozí pro myš – mapa jde posouvat
i pod nimi). Když zvolený výběr nemá žádná data, mapa je **chytrá**: zjistí, co
v databázi vůbec je, a poví vám kolik bodů a **rozsah dat** máte – stačí tedy
kliknout „Zobrazit všechna data" a mapa skočí přesně na ně (a zruší i případné
omezení výřezem). Když je databáze prázdná, kartička vás pošle rovnou na import.

- **Období** – od/do nebo předvolby (7/30/90 dní, Rok, Letos, Loni, Vše).
- **Vrstvy** – Trasy (klik = přehrát den), Jednotlivé body (čas po najetí),
  Heatmapa, Navštívená místa (velikost = strávený čas; při oddálení se shlukují).
- **Heatmapa s režimy** – „pohyb" ukáže, kudy jezdíte (hustota GPS bodů,
  volitelně jen ráno/den/večer/noc – např. kde býváte večer), „strávený čas"
  ukáže, kde pobýváte (váha = délka pobytu). Heatmapa tak slouží i jako
  další pohled na statistiky.
- **Detail podle výřezu** – při zoomu se automaticky dotáhne plný detail
  viditelné oblasti. Vypnutím se vrátí jeden vzorek pro celé období.
- **Podkladové mapy** – přepínač vpravo nahoře (OSM, světlá, tmavá, satelit).
- **Ovládací sloupec** (vpravo pod vrstvami) – přiblížit na moje data,
  ukázat moji aktuální polohu, celá obrazovka.
- **Přichycení k silnicím** – v Soukromí lze zapnout srovnání přehrávaného
  dne na silniční síť (online služba OSRM; výchozí vypnuto, souřadnice dne
  se posílají jen s vaším souhlasem).
- **Statistiky na mapě** – „Akční rádius" nakreslí kolem domova kružnice,
  uvnitř kterých leží 50/90/99 % všech záznamů; „Nejčastější trasy (pavouk)"
  spojí nejčastější dvojice míst čarami s tloušťkou podle četnosti.
- **Barvy tras** – „střídat odstíny" rozliší sousední jízdy, „**podle roku**"
  dá každému roku vlastní barvu (legenda vpravo dole) – u víceleté historie
  na první pohled vidíte, kudy jste kdy jezdili.
- **Časosběr měsíců** – přehraje historii měsíc po měsíci: starší trasy
  blednou, právě přehrávaný měsíc je zvýrazněný oranžově. Lišta nahoře má
  play/pauzu (mezerník), posuvník měsíců a rychlost ½–4×; Esc zavře.
  Přehrává zvolené období, bez volby celou databázi.
- **Měřit vzdálenost** – klikáním do mapy měříte délku trasy; u každého bodu
  se ukáže průběžná vzdálenost a nahoře celkový součet. Dvojklik nebo Esc
  měření ukončí, dalším klikem na tlačítko ho smažete.
- **Uložit mapu (PNG)** – aktuální výřez mapy i s trasami, body a heatmapou
  se stáhne jako obrázek PNG (dole razítko se zvoleným obdobím a atribucí) –
  hodí se do e-mailu nebo dokumentu.
- **Hledání místa** – vaše místa i libovolná adresa (OpenStreetMap).
- **„Kdy jsem tu byl?"** – klik do mapy → seznam všech pobytů v okruhu
  100 m–1 km s daty, časy a délkou; export do Excelu; klik na pobyt přehraje den.
  Pobyty kratší než zvolený **min. pobyt** (výchozí 2 min) se nepočítají –
  pouhý průjezd místem se tak neoznačí jako návštěva; totéž platí pro
  statistiky návštěv a top místa.
- **Statistiky / Analýza** (záložky) – km celkem a po měsících, rozpad podle
  dopravy, top místa; **Zajímavosti** (akční rádius, nejdál od domova, noci
  mimo domov, typický začátek a konec všedního dne), **Rytmus týdne**
  (den × hodina – kdy se hýbete), **nejčastější trasy** (odkud ⇄ kam,
  kolikrát a průměrné km), **km po měsících podle dopravy** (skládaný graf auto/pěšky/MHD/kolo),
  **všední dny vs. víkend**, km podle dne v týdnu, aktivita podle hodiny,
  km po letech. Dlaždice ukazují **šipku trendu** (± % oproti předchozímu
  stejně dlouhému období) a miniaturní křivku km po měsících. Blok **Rekordy
  období** shrnuje nejvíc najetých km za den, nejdelší jednotlivou cestu
  a nejdelší sérii po sobě jdoucích dní s jízdou.
- **Porovnání období** – lze zapnout druhé období, které se vykreslí
  oranžově přes hlavní modré trasy (tlačítko „Stejné období loni" nastaví
  posun o rok) – pohodlné srovnání letos vs. loni.
- **Přehrávání dne** – plovoucí lišta dole jako u video přehrávače:
  ◀ ▶ listování, rychlost přehrávání, stopa obarvená rychlostí
  (světlá = pomalu), aktuální km/h; ikona kalendáře otevře chronologickou
  osu dne.
- **Vlastní názvy míst** – nový export z telefonu jména míst nenese, proto
  lze každé místo pojmenovat (zákazník, adresa…): tužkou ✏️ u top míst,
  odkazem v bublině místa na mapě, nebo v panelu „Kdy jsem tu byl?".
  Název platí pro okruh 250 m, použije se všude včetně knihy jízd
  a stejnou cestou ho lze změnit; prázdný název ho smaže.
  Tlačítkem **⬠ Pojmenovat oblast (polygon)** lze místo kruhu obkreslit
  celý areál (min. 3 body, dvojklik/tlačítko dokončí, Esc zruší) – přesnější
  pro velké objekty. Pojmenovaná místa zobrazuje vrstva „Moje místa" –
  bublina po najetí ukazuje, kolikrát a jak dlouho jste tam ve zvoleném
  období byli; najetí na značku návštěvy ukáže název a délku pobytu.
  Sousední samostatné cesty se na mapě střídají dvěma odstíny modré
  a uprostřed každé je směrová šipka.
- Pohled i období se drží v adrese – funguje záložkování a obnovení stránky.

### Přehled „Moje místa" (záložka Místa)

Samostatná záložka se seznamem všech pojmenovaných míst a časů ve zvoleném
období. Umožňuje:

- **filtrovat** podle názvu a **řadit** (nejvíc času / nejvíc návštěv / podle
  názvu);
- **klik na místo** ho ukáže na mapě (u polygonu přiblíží celý areál)
  a rozbalí **jednotlivé pobyty** – u každého datum, čas od–do a délku;
  v záhlaví detailu se může dopočítat **adresa** místa – jen když v Nástrojích →
  Soukromí zapnete „Zjišťovat adresy míst online" (výchozí vypnuto, souřadnice
  pak nikam neodcházejí);
- **upravit** místo přímo v seznamu (tužka): změna názvu a u kruhových míst
  **okruhu v metrech** (s živým náhledem). Tlačítkem **„Upravit … na mapě"**
  se spustí interaktivní úprava tvaru:
  - **kruh** – prostřední (modrá) značka posune místo, krajní (červená) mění
    velikost okruhu; nahoře je počet metrů;
  - **oblast (polygon)** – jednotlivé **body lze táhnout**, značka „+" mezi
    body přidá nový bod a **pravý klik** bod smaže (minimum 3);
  - změny se uloží tlačítkem **Uložit tvar** (Esc/Zrušit zahodí).
  Dále lze **Překreslit celou oblast** od začátku, nebo u polygonu
  **Zpět na kruh**;
- **smazat** místo (koš). Změna se hned promítne všude, kde se místo zobrazuje.

Pole pro název má **našeptávač** (dosud použité názvy míst i nabídnutá adresa
místa). Na mapě se po najetí na místo v **bublině** zobrazí i jeho adresa.
Každá karta rozlišuje, zda jde o **kruh** (okruh kolem bodu) nebo **oblast**
(polygon). Místa bez pobytu v období jsou označena jako „bez pobytu".

## 3. Kniha jízd (`/kniha`)

Typický postup na konci měsíce:

1. Zvolte **Tento/Minulý měsíc**, vyplňte SPZ, řidiče a účel (pamatuje se).
2. **⚙ Generovat jízdy** – vytvoří jízdy z rozpoznaných cest autem; filtruje
   pracovní dny a hodiny, ignoruje mikro-jízdy, přeskakuje duplicity
   a už existující záznamy (ruční úpravy se nikdy nepřepíšou).
   Volba **„Zapisovat po městech"** (výchozí): místní jízdy v rámci jednoho
   města se sloučí do jednoho řádku s jeho jménem a sečtenými km
   (Brno – Brno, 23 km), mezi městy se zapíše Brno → Praha. Města se
   určují z vestavěného číselníku (offline). Vypnutím volby se zapisují
   jednotlivé jízdy s názvy konkrétních míst.
3. Zkontrolujte **upozornění** nad tabulkou: chybějící dny (tlačítko Doplnit),
   neúplné jízdy, překročený tachometr.
4. Tabulka se zobrazuje **po dnech**: řádek dne ukazuje počet jízd, trasu
   a součet km; kliknutím se den rozbalí na jednotlivé jízdy k úpravě
   (přepínač „Zobrazovat po dnech" vpravo nahoře vrátí plochý seznam).
   Období přes více měsíců dostane **mezisoučtové řádky měsíců**; hlavička
   tabulky, řádek dne i celkový součet zůstávají při rolování **přilepené**.
   Pole Odkud/Kam/Účel mají **našeptávač** známých míst a účelů;
   Soukr./Vl. auto jsou přepínače. Uložení potvrdí zelené bliknutí.
   Checkboxem vlevo lze vybrat jízdy či celé dny a smazat je najednou
   tlačítkem **Smazat vybrané**.
5. **Export XLSX pro SPZ** (import v programu SPZ od Milk Computers – vozidlo
   s toutéž SPZ musí být v SPZ založené) nebo **Export PDF** pro tisk.

### Pravidla kilometrů

Pevné km pro trasu/místo. Vzniknou automaticky: zadáte-li jízdě km, doplní se
všem jízdám na téže trase (obousměrně) a uloží se pravidlo. Ruční správa
v sekci Pravidla kilometrů; „Použít pravidla na období" přepočítá existující
jízdy. Vypnout lze přepínačem „Po zadání km doplnit stejnou trasu".

### Tachometr, soukromé jízdy, více vozidel

- **Tachometr**: zadejte roční nájezd → aplikace ukazuje „v knize X km,
  zbývá Y km". Vede se zvlášť pro každou SPZ. Nad tabulkou je navíc
  kompaktní **ukazatel** s proužkem najeto/zbývá (červený při překročení).
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
ručně tlačítkem. **Obnova přímo v aplikaci**: vyberte zálohu z nabídky
a klikněte na *Obnovit* – současná data se přepíšou, ale ještě předtím se
sama zazálohují, takže obnovu lze vzít zpět. (Alternativně offline: zastavit
kontejner, nahradit `data/history.db` souborem zálohy, spustit.)

> **Off-site záloha:** `data/history.db` je kompletní historie vaší polohy
> a žije jen na disku serveru. Doporučuji ji pravidelně kopírovat i mimo
> server – např. šifrovaně nástrojem [restic](https://restic.net):
> `restic -r /mnt/nas/gmaps backup /cesta/k/data/history.db`.

## 5. Instalace jako aplikace (PWA) a offline mapy

**Instalace na plochu:** v prohlížeči otevřete aplikaci a zvolte
„Přidat na plochu" / „Instalovat aplikaci" (Chrome/Edge: ikona v adresním
řádku). Poběží v samostatném okně a UI naběhne i bez připojení.
Pozn.: service worker vyžaduje HTTPS, nebo přístup přes `localhost`.

**Plně offline mapový podklad:** stáhněte si mapu ve formátu PMTiles
a uložte ji jako `data/map.pmtiles` – v přepínači vrstev přibude
„Offline (PMTiles)" a použije se automaticky. Jak mapu získat:

```bash
# nástroj pmtiles: https://github.com/protomaps/go-pmtiles/releases
# výřez České republiky z aktuálního sestavení světa (~1–2 GB):
pmtiles extract https://build.protomaps.com/20250101.pmtiles data/map.pmtiles \
    --bbox=12.0,48.5,18.9,51.1
```

Aktuální sestavení najdete na https://maps.protomaps.com/builds/. Bez
offline mapy se dlaždice stahují z OpenStreetMap (vyžaduje internet).

## 6. Ovládání navíc

- **Vzhled**: tlačítko vedle nadpisu přepíná auto → tmavý → světlý.
- **Zapamatování nastavení**: aplikace si pamatuje zapnuté **vrstvy**
  (trasy, body, heatmapa, navštívená místa, moje místa, detail podle výřezu),
  zvolený **mapový podklad** (OSM / světlý / tmavý / satelit / offline),
  **filtr dopravy**, okruh a min. pobyt u „Kdy jsem tu byl?", řazení míst,
  **rychlost přehrávání** i vybraný **vzhled**. Při dalším otevření tak vše
  zůstane tak, jak jste si to nastavil. Kniha jízd si stejně pamatuje SPZ,
  řidiče, účel a volby generování. (Ukládá se lokálně v prohlížeči.)
- **Klávesy** (na mapě): ◀ ▶ šipky listují dny přehrávání, mezerník
  spouští/zastavuje přehrávání.
- **Mobil**: kniha jízd se zobrazuje jako karty, panel mapy je vysouvací
  list; vše má větší dotykové plochy.
- **Undo**: kniha jízd drží posledních 10 akcí (generování, propagace,
  pravidla, mazání jednotlivých jízd i hromadné mazání) – tlačítko
  „Vrátit" lze použít opakovaně.
- **Smazat období (soukromí)**: Nástroje → Údržba dat umí smazat všechna
  polohová data ve zvoleném rozmezí (např. dovolenou). Ukáže počty, před
  smazáním automaticky vytvoří zálohu; kniha jízd zůstává.
- **Verze a stav**: záložka Nástroje → „O aplikaci" ukazuje verzi frontendu,
  velikost databáze, počty záznamů, čas poslední automatické zálohy
  (zálohuje se 1× denně) a tlačítko **Zkontrolovat databázi** (integrita
  SQLite; při potížích obnovte poslední zálohu).
- **Klávesové zkratky**: stiskem **?** se zobrazí přehled (← → den,
  mezerník přehrávání, M měření vzdálenosti, Esc zrušit/zavřít).
  Po `git pull && docker compose up -d --build` se díky ní sama zneplatní
  cache PWA, takže nové UI naběhne bez ručního mazání mezipaměti prohlížeče.

## 7. Provoz

| Co | Jak |
|---|---|
| Heslo | `AUTH_PASSWORD` v docker-compose (jméno při přihlášení libovolné) |
| Časová zóna | `TZ` v docker-compose (výchozí Europe/Prague, řeší letní čas) |
| Umístění dat | `./data` na hostiteli (databáze, zálohy, auto-import) |
| Aktualizace | `git pull && docker compose up -d --build` |
| Logy | `docker compose logs -f` |
| Interaktivní API | `http://server:8000/api/docs` |

## 8. Windows 11: tipy

Aplikace nainstalovaná z `GMapsHistorie-Setup-*.exe` běží **bez černého okna**
– po spuštění se objeví **ikona v systémové liště** (vedle hodin). Klik na ni
otevře aplikaci v prohlížeči, pravý klik nabídne Knihu jízd a Ukončit.
Výpisy programu najdete v `%LOCALAPPDATA%\GMapsHistorie\data\logs\app.log`.

| Co | Jak |
|---|---|
| Automatický start | úloha „Spustit po přihlášení do Windows" v instalátoru (běží tiše v liště) |
| Přístup z telefonu | úloha „Povolit přístup z domácí sítě" v instalátoru + spuštění s `HOST=0.0.0.0`; pak `http://IP-počítače:8000` |
| Umístění dat | `%LOCALAPPDATA%\GMapsHistorie\data` (databáze, zálohy, logy) – při aktualizaci zůstává |
| Jiný port | spustit s proměnnou `PORT=8080` (např. v zástupci: `cmd /c "set PORT=8080 && GMapsHistorie.exe"`) |
| Aktualizace | aplikace 1× denně nenápadně zkontroluje nová vydání (vypnutí: `UPDATE_CHECK_URL=`); odkaz je v Nástroje → O aplikaci, ruční aktualizace přes zástupce „Aktualizovat GMaps Historie" |

**Rychlejší import velkých Takeout ZIPů:** Windows Defender skenuje každý
zápis do databáze. Pokud import několika GB trvá dlouho, přidejte složku
`%LOCALAPPDATA%\GMapsHistorie` do výjimek: Zabezpečení Windows → Ochrana
před viry a hrozbami → Spravovat nastavení → Vyloučení. Je to bezpečné –
složka obsahuje jen vaši databázi a zálohy.

**OneDrive:** data se ukládají mimo synchronizované složky (Dokumenty,
Plocha), takže se databáze nesynchronizuje do cloudu – to je záměr
(soukromí a rychlost). Zálohy si případně kopírujte ručně ze složky
`…\GMapsHistorie\data\backups`.

## 9. Řešení potíží

- **Data se po importu nezobrazují na mapě** – klikněte v kartičce „Zobrazit
  všechna data" (nebo předvolbu **Vše**). Mapa mohla jen koukat jinam; kartička
  vypíše, kolik dat a v jakém rozsahu v databázi je.
- **Import říká, že se nic nenaimportovalo** – vybraný soubor nejspíš není
  export historie polohy. Stáhněte z Googlu „Location History (Timeline)"
  a vyberte `Timeline.json` nebo celý `.zip` z Takeoutu. Přehled importu vypíše,
  které soubory se přeskočily a proč.
- **Import hlásí chybu** – část dat už mohla být uložena; po opravě souboru
  import spusťte znovu, duplicity se přeskočí.
- **Špatné časy** – nastavte `TZ` v docker-compose na svou zónu.
- **SPZ odmítá import** – vozidlo se stejnou SPZ musí být v programu SPZ
  založené; prázdného řidiče si SPZ doplní z karty vozidla.
- **Aplikace vypadá staře / něco nereaguje po aktualizaci** – prohlížeč drží
  starou verzi v mezipaměti (PWA). Aplikace se od této verze přepne na nový
  kód sama; pokud ne, stačí **tvrdé obnovení** stránky (Ctrl+Shift+R, na Macu
  Cmd+Shift+R). Aktuální verzi frontendu ukazuje na mapě záložka Nástroje →
  „O aplikaci".
