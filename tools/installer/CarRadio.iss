; CarRadio player installer (Inno Setup 6). Built by tools/build.ps1, which passes
; /DAppVersion=... /DStage=<staging folder> /DOutDir=<output folder>.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F0B5E2C-3C1D-4E0B-9C61-5B1C0B5D7A11}
AppName=CarRadio
AppVersion={#AppVersion}
AppPublisher=D3K1D
DefaultDirName={localappdata}\Programs\CarRadio
DefaultGroupName=CarRadio
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=CarRadio-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayName=CarRadio {#AppVersion}
UninstallDisplayIcon={app}\CarRadioCompanion.exe
MinVersion=10.0.19041

[Tasks]
Name: "beamngmod"; Description: "Install the CarRadio mod into BeamNG.drive for single player (BeamMP servers send it automatically)"; Check: BeamNGModsFolderExists
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#Stage}\companion\CarRadioCompanion.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\companion\appcapture.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\carradio_d3k1d.zip"; DestDir: "{app}\mod"; Flags: ignoreversion
Source: "{#Stage}\carradio_d3k1d.zip"; DestDir: "{code:BeamNGModsFolder}"; Tasks: beamngmod; Flags: ignoreversion
Source: "{#Stage}\README.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\CarRadio Companion"; Filename: "{app}\CarRadioCompanion.exe"
Name: "{group}\Uninstall CarRadio"; Filename: "{uninstallexe}"
Name: "{userdesktop}\CarRadio Companion"; Filename: "{app}\CarRadioCompanion.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\CarRadioCompanion.exe"; Description: "Start CarRadio Companion now"; Flags: nowait postinstall skipifsilent

[Code]
function BeamNGModsFolder(Param: String): String;
begin
  Result := ExpandConstant('{localappdata}\BeamNG\BeamNG.drive\current\mods');
end;

function BeamNGModsFolderExists(): Boolean;
begin
  Result := DirExists(BeamNGModsFolder(''));
end;
