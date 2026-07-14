# Windows – portable aplikace

GMaps Historie se pro Windows šíří jako **jediný portable soubor
`GMapsHistorie.exe`** – žádná instalace, žádná admin práva. Stáhnete,
spustíte, hotovo.

## Použití

1. Stáhněte `GMapsHistorie.exe` z [Releases](https://github.com/esrez/gmaps-historie-/releases)
   a uložte kamkoli (Plocha, `C:\Aplikace`, USB disk…).
2. Spusťte. Objeví se **ikona v systémové liště** (vedle hodin) a otevře se
   prohlížeč s aplikací. Klik na ikonu aplikaci otevře znovu, pravý klik
   nabídne Knihu jízd a Ukončit.
3. První spuštění trvá o něco déle (jednosouborový balík se rozbaluje do
   dočasné složky).

**Kde jsou data:** databáze, zálohy a logy žijí
v `%LOCALAPPDATA%\GMapsHistorie\data` – **přežijí výměnu exe za novější
verzi** i přesun samotného exe. Vlastní umístění lze vynutit proměnnou
`DATA_DIR`.

**Jedna instance:** opětovné spuštění, když už aplikace běží, jen otevře
prohlížeč (nespustí druhý server).

Pozn.: antivirus někdy neznámý spustitelný soubor prověřuje déle nebo hlásí
falešný poplach – u PyInstaller balíčků je to běžné; zdrojový kód je veřejný
a exe staví GitHub Actions přímo z něj.

### Automatický start po přihlášení

Win+R → `shell:startup` → do otevřené složky vložte **zástupce**
`GMapsHistorie.exe` a v jeho vlastnostech doplňte parametr `--no-browser`
(cíl: `...\GMapsHistorie.exe --no-browser`). Aplikace pak startuje tiše
do systémové lišty.

### Přístup z telefonu (domácí síť)

Spusťte s `HOST=0.0.0.0` (např. zástupce s cílem
`cmd /c "set HOST=0.0.0.0 && start GMapsHistorie.exe"`); Windows se při
prvním spuštění zeptá na povolení v bráně firewall – povolte **privátní
sítě**. Pak funguje `http://IP-počítače:8000` a nastavte `AUTH_PASSWORD`.

### Aktualizace

Aplikace jednou denně nenápadně zkontroluje nová vydání (vypnutí:
`UPDATE_CHECK_URL=`). Když je k dispozici novější verze, v **Nástroje →
O aplikaci** se objeví odkaz ke stažení a tlačítko **„Stáhnout
a aktualizovat"**:

1. aplikace stáhne nový `GMapsHistorie.exe` z GitHub Releases vedle sebe,
2. **ověří ho** (velikost dle vydání, hlavička spustitelného souboru
   a zkušební spuštění s `--version`),
3. po vašem potvrzení se ukončí, pomocný skript soubory prohodí
   (stará verze zůstane vedle jako `GMapsHistorie-old.exe`) a nová verze
   se sama spustí; stránka v prohlížeči se pak sama obnoví.

Nic se neděje bez potvrzení a data zůstávají (jsou mimo exe). Ruční cesta
– stáhnout exe z Releases a nahradit soubor – samozřejmě funguje dál.

Pro pokročilé: aplikace umí i aktualizaci z vlastního serveru
(`GMapsHistorie.exe --update`, adresa přes `UPDATE_URL`; balík
`GMapsHistorie-update.zip` vzniká při buildu a server ho servíruje přes
`/api/update/package`).

## Sestavení exe ze zdrojáků

### Lokálně na Windows

1. **Python 3.11+** v PATH
2. ```bat
   build-windows-exe.bat
   ```
3. Výsledek: `dist\GMapsHistorie.exe` (+ `dist\GMapsHistorie-update.zip`
   pro vlastní aktualizační server)

### Z macOS / Linuxu (bez Windows)

PyInstaller nekompiluje křížově – použijte **GitHub Actions**:

1. Push na `main` (změny v kódu) **nebo** ručně: GitHub → **Actions** →
   **Windows build** → **Run workflow**
2. Po dokončení stáhněte **Artifacts** → `gmaps-historie-windows-<verze>.zip`

**Kontrola po buildu:**
`python scripts\smoke_test.py --package dist\GMapsHistorie-update.zip`

## Verze

Číslo verze se bere ze souboru `VERSION` v kořeni projektu.

## Vydání nové verze (GitHub Release)

1. Zvyšte číslo v souboru `VERSION` a doplňte sekci v `CHANGELOG.md`.
2. Vytvořte a pushněte tag (číslo = obsah souboru `VERSION`):
   ```
   git tag v2.2.0
   git push origin v2.2.0
   ```
3. GitHub Actions (workflow „Windows build") automaticky postaví portable
   `GMapsHistorie.exe` a **vytvoří GitHub Release** s popisem z první sekce
   CHANGELOG. Na Releases se publikuje **jen portable exe** – žádný
   instalátor.

## Bezpečnost

Ve výchozím stavu aplikace naslouchá jen na `127.0.0.1` (tento počítač).
Pro přístup z jiných zařízení nastavte `HOST=0.0.0.0` + `AUTH_PASSWORD`;
do internetu ji vystavujte jen za reverse proxy s HTTPS.
