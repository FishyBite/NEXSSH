# Run on a disposable Windows x64 desktop or CI runner after npm ci (Node 24+).
# The two installers and the generated test profile stay in the disposable account.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Rc7Setup,
    [Parameter(Mandatory)][string]$VexSetup,
    [switch]$DisposableAccount
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or !$DisposableAccount) {
    throw 'Run only in a disposable Windows account and pass -DisposableAccount.'
}
$baseline = (Resolve-Path -LiteralPath $Rc7Setup).Path
$candidate = (Resolve-Path -LiteralPath $VexSetup).Path
$node = (Get-Command node -CommandType Application).Source
$helper = Join-Path $PSScriptRoot 'windows-rc7-profile.mjs'
$candidateVersion = (Get-Content -Raw (Join-Path $PSScriptRoot '../src-tauri/tauri.conf.json') | ConvertFrom-Json).version
$target = Join-Path $env:LOCALAPPDATA 'Programs\NEXSSH\NEXSSH.exe'
$key = 'com.nexssh.desktop_is1'
$regRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')

function Get-AppRegistrations {
    foreach ($root in $regRoots) {
        Get-ItemProperty "$root\*" -ErrorAction SilentlyContinue |
            Where-Object { $_.PSChildName -eq $key -or $_.DisplayName -match '^(NEXSSH|VEXSSH)( |$)' }
    }
}

$locations = @((Split-Path $target), (Join-Path $env:LOCALAPPDATA 'Programs\VEXSSH'))
foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
    foreach ($id in @('com.nexssh.desktop', 'com.vexssh.desktop')) { $locations += Join-Path $base $id }
}
foreach ($folder in @($desktop, $programs)) {
    foreach ($name in @('NEXSSH', 'VEXSSH')) { $locations += Join-Path $folder "$name.lnk" }
}
if (@(Get-AppRegistrations).Count -or @($locations | Where-Object { Test-Path -LiteralPath $_ }).Count -or
    @(Get-Process -ErrorAction SilentlyContinue | Where-Object ProcessName -Match '^(NEXSSH|VEXSSH)').Count) {
    throw 'Existing installation, shortcut, running app or data directory. Use a clean account.'
}
if ((& cmdkey.exe /list | Out-String) -match '(?i)(nexssh|vexssh)') { throw 'An application credential already exists.' }
if ($LASTEXITCODE -ne 0) { throw 'Could not check the disposable credential vault.' }
foreach ($var in @('WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','NEXSSH_TEST_DATA_DIR','VEXSSH_TEST_DATA_DIR')) {
    if ([Environment]::GetEnvironmentVariable($var)) { throw "Unset $var in the disposable account." }
}

function Install-Setup([string]$Path) {
    $setup = Start-Process -FilePath $Path -ArgumentList '/CURRENTUSER /VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -PassThru
    if (!$setup.WaitForExit(300000) -or $setup.ExitCode -ne 0) { throw "Setup failed or timed out: $Path" }
}

function Assert-Installed([string]$Brand, [string]$Version) {
    $entries = @(Get-AppRegistrations)
    if ($entries.Count -ne 1 -or $entries[0].PSChildName -ne $key -or
        $entries[0].DisplayVersion -ne $Version -or $entries[0].DisplayName -notlike "$Brand*" -or
        (Get-Item -LiteralPath $target).VersionInfo.ProductVersion -ne $Version) {
        throw "Unexpected registration, path or executable version for $Brand $Version"
    }
    $shell = New-Object -ComObject WScript.Shell
    $explorer = New-Object -ComObject Shell.Application
    foreach ($folder in @($desktop, $programs)) {
        $path = Join-Path $folder "$Brand.lnk"
        if (!(Test-Path -LiteralPath $path)) { throw "Missing shortcut: $path" }
        $link = $shell.CreateShortcut($path)
        $id = $explorer.Namespace($folder).ParseName("$Brand.lnk").ExtendedProperty('System.AppUserModel.ID')
        if ($link.TargetPath -ine $target -or $link.Arguments -or $id -ne 'com.nexssh.desktop') {
            throw "Shortcut target or AppUserModelID changed: $path"
        }
        if ($Brand -eq 'VEXSSH' -and (Test-Path -LiteralPath (Join-Path $folder 'NEXSSH.lnk'))) {
            throw "Duplicate old shortcut in $folder"
        }
    }
}

function Test-Profile([string]$Mode, [string]$Brand) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port"
    try { $app = Start-Process -FilePath $target -PassThru } finally {
        Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    }
    try {
        & $node $helper $Mode $Brand $port $snapshot
        if ($LASTEXITCODE -ne 0) { throw "$Brand profile check failed." }
    } finally {
        if (!$app.HasExited) {
            [void]$app.CloseMainWindow()
            if (!$app.WaitForExit(10000)) { $app.Kill(); $app.WaitForExit() }
        }
    }
}

$snapshot = Join-Path ([IO.Path]::GetTempPath()) ("vexssh-upgrade-" + [guid]::NewGuid() + '.json')
try {
    Install-Setup $baseline
    Assert-Installed NEXSSH '1.0.0-rc.7'
    Test-Profile seed NEXSSH
    Install-Setup $candidate
    Assert-Installed VEXSSH $candidateVersion
    Test-Profile verify VEXSSH
    Write-Output 'PASS: RC7 upgraded in place; one registration, shortcut targets/IDs, host, saved vault key and WebView data verified.'
} finally {
    if (Test-Path -LiteralPath $snapshot) { Remove-Item -LiteralPath $snapshot }
}
