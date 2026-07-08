; GMaps Historie – profesionální instalátor pro Windows 11 (Inno Setup 6)
; Sestavení: build-windows-installer.bat  (předá verzi z VERSION)

#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif

#define AppName "GMaps Historie"
#define AppPublisher "GMaps Historie"
#define AppURL "https://github.com/esrez/gmaps-historie-"
#define AppExeName "GMapsHistorie.exe"

[Setup]
AppId={{A20F0A74-7A14-4BE8-A4FA-2C71B43F4F3F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
AppCopyright=Copyright (C) 2025–2026 {#AppPublisher}
DefaultDirName={autopf}\GMapsHistorie
DefaultGroupName={#AppName}
DisableProgramGroupPage=no
OutputDir=dist
OutputBaseFilename=GMapsHistorie-Setup-{#AppVersion}
SetupIconFile=compiler:SetupClassicIcon.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile=installer\licence-cs.txt
InfoBeforeFile=installer\uvod-cs.txt
InfoAfterFile=installer\dokonceni-cs.txt
; Čeština jako jediný jazyk – konzistentní průvodce
ShowLanguageDialog=no

[Languages]
Name: "czech"; MessagesFile: "compiler:Languages\Czech.isl"

[CustomMessages]
czech.DataDirInfo=Vaše mapová data (databáze, zálohy, import) se ukládají do:%n%n  {code:GetDataDir}%n%nTato složka zůstane při aktualizaci zachována.
czech.UpdateUrlDesc=Adresa serveru pro kontrolu aktualizací (volitelné). Ponechte prázdné = pouze ruční aktualizace.
czech.UpdateUrlLabel=URL aktualizací (volitelné):
czech.TaskAutostart=Spustit GMaps Historie po přihlášení do Windows
czech.TaskUpdateMenu=Vytvořit zástupce „Aktualizovat GMaps Historie“

[Types]
Name: "full"; Description: "Úplná instalace"
Name: "compact"; Description: "Kompaktní instalace"
Name: "custom"; Description: "Vlastní instalace"; Flags: iscustom

[Components]
Name: "program"; Description: "Program GMaps Historie"; Types: full compact custom; Flags: fixed
Name: "shortcuts"; Description: "Zástupce v nabídce Start"; Types: full compact custom; Flags: fixed

[Tasks]
Name: "desktopicon"; Description: "Vytvořit zástupce na ploše"; GroupDescription: "Další úlohy:"; Components: shortcuts
Name: "autostart"; Description: "{cm:TaskAutostart}"; GroupDescription: "Další úlohy:"; Flags: unchecked
Name: "updatemenu"; Description: "{cm:TaskUpdateMenu}"; GroupDescription: "Další úlohy:"; Components: shortcuts; Flags: checkedonce

[Files]
Source: "dist\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion; Components: program
Source: "scripts\update_windows.py"; DestDir: "{app}\scripts"; Flags: ignoreversion; Components: program
Source: "installer\Aktualizovat.bat"; DestDir: "{app}"; Flags: ignoreversion; Components: program

[Dirs]
Name: "{app}\backups"; Permissions: users-modify
Name: "{app}\scripts"; Permissions: users-modify

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Components: shortcuts
Name: "{group}\Aktualizovat {#AppName}"; Filename: "{app}\Aktualizovat.bat"; WorkingDir: "{app}"; Tasks: updatemenu
Name: "{group}\Odinstalovat {#AppName}"; Filename: "{uninstallexe}"; Components: shortcuts
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "GMapsHistorie"; \
  ValueData: """{app}\{#AppExeName}"" --no-browser"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Spustit {#AppName}"; \
  Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}\backups"

[Code]
var
  UpdateUrlPage: TInputQueryWizardPage;

function GetDataDir(Param: String): String;
begin
  Result := ExpandConstant('{localappdata}\GMapsHistorie\data');
end;

procedure InitializeWizard;
begin
  UpdateUrlPage := CreateInputQueryPage(wpSelectTasks,
    'Aktualizace', 'Nastavení kontroly aktualizací',
    ExpandConstant('{cm:UpdateUrlDesc}'));
  UpdateUrlPage.Add('URL:', False);
  UpdateUrlPage.Values[0] := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  IniLines: TArrayOfString;
  UpdateUrl: String;
begin
  if CurStep = ssPostInstall then
  begin
    UpdateUrl := UpdateUrlPage.Values[0];
    SetArrayLength(IniLines, 3);
    IniLines[0] := '[install]';
    IniLines[1] := 'version={#AppVersion}';
    if UpdateUrl <> '' then
      IniLines[2] := 'update_url=' + UpdateUrl
    else
      IniLines[2] := 'update_url=';
    SaveStringsToFile(ExpandConstant('{app}\version.ini'), IniLines, False);
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not FileExists(ExpandConstant('{src}\dist\{#AppExeName}')) then
  begin
    MsgBox('Chybí dist\' + '{#AppExeName}' + '.' + #13#10 +
      'Nejdřív spusťte build-windows-exe.bat', mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  R: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := GetDataDir('');
    if DirExists(DataDir) then
    begin
      R := MsgBox('Odstranit také vaše lokální data (databáze a zálohy)?' + #13#10 +
        DataDir, mbConfirmation, MB_YESNO);
      if R = IDYES then
        DelTree(ExpandConstant('{localappdata}\GMapsHistorie'), True, True, True);
    end;
  end;
end;
