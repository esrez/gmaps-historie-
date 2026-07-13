# Windows 11 – instalátor a aktualizace

## Výstup buildu

Po spuštění `build-windows-installer.bat` na **Windows 11** vznikne v `dist\`:

| Soubor | Účel |
|---|---|
| `GMapsHistorie-Setup-2.0.0.exe` | Instalační program (čeština) |
| `GMapsHistorie.exe` | Spustitelná aplikace |
| `GMapsHistorie-update.zip` | Balík pro aktualizaci |

## Požadavky pro sestavení

### Lokálně na Windows 11

1. **Python 3.11+** s PATH
2. **[Inno Setup 6](https://jrsoftware.org/isinfo.php)** (`iscc` v PATH)
3. Příkaz:

```bat
build-windows-installer.bat
```

### Z macOS (bez Windows VM)

PyInstaller a Inno Setup na Macu nespustíte – použijte **GitHub Actions**:

1. Push na `main` (změny v kódu) **nebo** ručně: GitHub → **Actions** → **Windows build** → **Run workflow**
2. Po dokončení (~15–25 min) stáhněte **Artifacts** → `gmaps-historie-windows-2.0.0.zip`
3. Uvnitř jsou `GMapsHistorie-Setup-2.0.0.exe`, `GMapsHistorie.exe` a update ZIP

Tag `v2.0.0` spustí build automaticky při push.

## Co instalátor nabízí

- **Český průvodce** – licence, úvod, volba úloh, dokončení
- **Instalace do Program Files** (vyžaduje souhlas administrátora – standardní bezpečný postup)
- **Data mimo Program Files** – databáze v `%LOCALAPPDATA%\GMapsHistorie\data` (zápis bez admin práv)
- **Zástupce** – Start, volitelně plocha, „Aktualizovat…“, odinstalace
- **Volitelný autostart** po přihlášení (vypnuto ve výchozím stavu)
- **Volitelná URL aktualizací** – zadáte při instalaci (např. `https://vas-server.cz/api/update`)
- **Odinstalace** – nabídne smazání lokálních dat
- **Jedna instance** – opětovné spuštění, když už aplikace běží, jen otevře
  okno v prohlížeči (nespustí druhý server)
- **Korektní ukončení** – tlačítko *Ukončit aplikaci* (Nástroje → O aplikaci),
  Ctrl+C v okně konzole i zavření okna konzole aplikaci čistě zastaví

## Aktualizace (3 způsoby)

### 1. Z nabídky Start
**Aktualizovat GMaps Historie** → spustí vestavěný updater

### 2. Příkazová řádka
```bat
cd "C:\Program Files\GMapsHistorie"
GMapsHistorie.exe --update
```

### 3. Ze serveru
1. Nahrajte `GMapsHistorie-update.zip` do `data\update\` na běžícím serveru
2. Ujistěte se, že `/api/update` vrací novější verzi
3. Spusťte aktualizaci na klientovi

Updater před přepsáním zálohuje starý `.exe` do `backups\`.

## Bezpečnost

| Opatření | Popis |
|---|---|
| Data lokálně | Historie polohy neopouští počítač |
| AppData | Uživatelská data nejsou v Program Files |
| Záloha exe | Před aktualizací se uloží `.bak` |
| Ověření ZIP | Kontrola `version.json` a `dist/GMapsHistorie.exe` |
| Admin jen při instalaci | Běžný provoz nevyžaduje elevaci |

**Digitální podpis:** Pro produkční nasazení doporučujeme podepsat `GMapsHistorie-Setup.exe` kódem podepisujícím certifikátem (Authenticode). Bez podpisu může Windows SmartScreen zobrazit varování – jde o běžné chování u nepodpsaných aplikací.

## Konfigurace po instalaci

Soubor `C:\Program Files\GMapsHistorie\version.ini`:

```ini
[install]
version=2.0.0
update_url=https://vas-server.cz/api/update
```

## Verze

Číslo verze se bere ze souboru `VERSION` v kořeni projektu.

## Vydání nové verze (GitHub Release)

1. Zvyšte číslo v souboru `VERSION` a doplňte sekci v `CHANGELOG.md`
   (v tomto vydání už hotovo).
2. Vytvořte a pushněte tag:
   ```
   git tag v2.1.0
   git push origin v2.1.0
   ```
3. GitHub Actions (workflow „Windows build") automaticky postaví
   `GMapsHistorie.exe`, instalátor i update balíček a **vytvoří GitHub
   Release** s popisem z první sekce CHANGELOG. Hotové soubory se objeví
   na stránce Releases – uživatelé si je stáhnou přímo odtud.
