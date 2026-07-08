; Inno Setup installer for GMapsHistorie
#define AppName "GMaps Historie"
#define AppVersion "2.0.0"
#define AppPublisher "GMaps Historie"
#define AppExeName "GMapsHistorie.exe"

[Setup]
AppId={{A20F0A74-7A14-4BE8-A4FA-2C71B43F4F3F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\GMapsHistorie
DefaultGroupName=GMaps Historie
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=GMapsHistorie-Setup
Compression=lzma
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern

[Languages]
Name: "czech"; MessagesFile: "compiler:Languages\Czech.isl"

[Files]
Source: "dist\GMapsHistorie.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "scripts\update_windows.py"; DestDir: "{app}\scripts"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\GMaps Historie"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\GMaps Historie"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Vytvořit ikonu na ploše"; GroupDescription: "Další úlohy:"; Flags: unchecked

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Spustit GMaps Historie"; Flags: nowait postinstall skipifsilent
