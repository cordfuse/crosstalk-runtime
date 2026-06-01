#define AppName "Crosstalk Runtime"
#define AppPublisher "Cordfuse"
#define AppURL "https://crosstalk.sh"
#define ExeName "crosstalk.exe"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
DefaultDirName={autopf}\crosstalk
DefaultGroupName=Crosstalk
DisableProgramGroupPage=yes
OutputDir=Output
OutputBaseFilename=crosstalk-runtime-setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
; No desktop shortcut — this is a CLI tool
DisableStartupPrompt=yes
UninstallDisplayIcon={app}\{#ExeName}

[Files]
Source: "crosstalk-windows-x64.exe"; DestDir: "{app}"; DestName: "{#ExeName}"; Flags: ignoreversion

[Registry]
; Add install dir to system PATH
Root: HKLM; \
  Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
  ValueType: expandsz; \
  ValueName: "Path"; \
  ValueData: "{olddata};{app}"; \
  Check: NeedsAddPath('{app}')

[Run]
; Create data dir for the daemon
Filename: "{cmd}"; \
  Parameters: "/C mkdir ""{commonappdata}\crosstalk"" 2>nul"; \
  Flags: runhidden

[UninstallRun]
; Stop + remove service on uninstall
Filename: "{app}\{#ExeName}"; \
  Parameters: "uninstall --purge"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "UninstallService"

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(
    HKEY_LOCAL_MACHINE,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path', OrigPath)
  then begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';',
    ';' + Uppercase(OrigPath) + ';') = 0;
end;

[Messages]
FinishedLabel=Crosstalk Runtime has been installed.%n%nOpen a terminal as Administrator and run:%n%n    crosstalk install <your-transport-git-url>%n%nThis will clone your transport, generate an SSH key, and register the Windows service.
