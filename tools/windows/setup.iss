; Offline: ISCC /DWebViewInstaller=<signed x64 Evergreen standalone installer> setup.iss
; Online:  ISCC /DOnlineSetup=1 /DWebViewInstaller=<signed Evergreen bootstrapper> setup.iss
#ifdef SignedRelease
  #ifndef AppBinary
    #error A signed release requires an explicit signed, staged AppBinary.
  #endif
  #define AppSignatureFlag "signcheck"
#else
  #define AppSignatureFlag ""
#endif
#ifndef AppBinary
  #define AppBinary SourcePath + "..\..\src-tauri\target\release\vexssh.exe"
#endif
#ifndef WebViewInstaller
  #error Supply the path to the Microsoft WebView2 installer matching the build mode.
#endif
#define AppVersion GetStringFileInfo(AppBinary, "ProductVersion")
#ifdef OnlineSetup
  #define RuntimeFile "MicrosoftEdgeWebview2Setup.exe"
  #define SetupSuffix "-Online-Setup"
  #define RuntimeAction "Downloading and installing Microsoft Edge WebView2 Runtime..."
  #define RetryAdvice "Check your internet connection and run VEXSSH Setup again."
#else
  #define RuntimeFile "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
  #define SetupSuffix "-Setup"
  #define RuntimeAction "Installing Microsoft Edge WebView2 Runtime..."
  #define RetryAdvice "Run VEXSSH Setup again to retry."
#endif

[Setup]
#ifdef SignedRelease
SignTool=VexsshPublisher
SignedUninstaller=yes
#endif
AppId=com.vexssh.desktop
AppName=VEXSSH
AppVersion={#AppVersion}
AppPublisher=VEXSSH
DefaultDirName={localappdata}\Programs\VEXSSH
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
SetupArchitecture=x64
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
SetupIconFile=..\..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\VEXSSH.exe
OutputBaseFilename=VEXSSH-{#AppVersion}-Windows-x64{#SetupSuffix}
VersionInfoVersion={#GetVersionNumbersString(AppBinary)}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoDescription=VEXSSH Installer
Compression=lzma2/max
SolidCompression=no
CloseApplications=no
RestartApplications=no

[Files]
Source: "{#WebViewInstaller}"; DestName: "{#RuntimeFile}"; Flags: dontcopy nocompression
Source: "{#AppBinary}"; DestDir: "{app}"; DestName: "VEXSSH.exe"; Flags: replacesameversion {#AppSignatureFlag}
Source: "..\dbbridge\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\VEXSSH"; Filename: "{app}\VEXSSH.exe"; WorkingDir: "{app}"; AppUserModelID: "com.vexssh.desktop"
Name: "{userprograms}\VEXSSH"; Filename: "{app}\VEXSSH.exe"; WorkingDir: "{app}"; AppUserModelID: "com.vexssh.desktop"

[Code]
const
  RuntimeKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasRuntimeAt(Root: Integer): Boolean;
var
  Value: String;
  Version: Int64;
begin
  Result := RegQueryStringValue(Root, RuntimeKey, 'pv', Value) and
    StrToVersion(Value, Version) and (Version > 0);
end;

function HasRuntime: Boolean;
begin
  Result := HasRuntimeAt(HKLM32) or HasRuntimeAt(HKCU);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if HasRuntime then
    Exit;

  WizardForm.PreparingLabel.Caption := '{#RuntimeAction}';
  WizardForm.Update;
  ExtractTemporaryFile('{#RuntimeFile}');
  if not Exec(ExpandConstant('{tmp}\{#RuntimeFile}'), '/silent /install', '',
    SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := 'Could not start the Microsoft WebView2 installer. ' + SysErrorMessage(ExitCode)
  else if (ExitCode = 3010) or (ExitCode = 1641) then begin
    NeedsRestart := True;
    Result := 'Restart Windows and run VEXSSH Setup again to finish installation.';
  end
  else if not HasRuntime then
    Result := Format('Microsoft Edge WebView2 Runtime is still unavailable (installer code %d). {#RetryAdvice}', [ExitCode]);
end;
