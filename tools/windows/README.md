# Signing a Windows release

Run this from the release checkout after building the Windows executable. Put the Windows SDK's `signtool.exe` and Inno Setup 7's `ISCC.exe` on the signing machine's PATH. Use a publisher code-signing certificate trusted by the target Windows machines, with its private key available through the current user's Personal certificate store or its hardware provider. [Microsoft SignTool reference](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)

Set these environment variables in the release shell.

| Variable | Value |
| --- | --- |
| `VEXSSH_SIGNING_THUMBPRINT` | Publisher certificate's 40-digit hexadecimal thumbprint. This identifies the certificate. SHA-256 is used to sign the files. |
| `VEXSSH_TIMESTAMP_URL` | RFC 3161 timestamp URL supplied by the signing provider. |
| `VEXSSH_WEBVIEW_BOOTSTRAPPER` | Full path to Microsoft's signed Evergreen WebView2 bootstrapper. |

This PowerShell example produces a portable executable and the online installer in a fresh staging directory. A failed signing, timestamp or trust check stops the build.

```powershell
$ErrorActionPreference = 'Stop'
$thumb = $env:VEXSSH_SIGNING_THUMBPRINT
$tsa = $env:VEXSSH_TIMESTAMP_URL
if ($thumb -notmatch '^[a-fA-F0-9]{40}$' -or !$tsa) { throw 'Set the signing thumbprint and timestamp URL.' }
$tool = (Get-Command signtool.exe -CommandType Application).Source
$compiler = (Get-Command ISCC.exe -CommandType Application).Source
$runtime = (Resolve-Path -LiteralPath $env:VEXSSH_WEBVIEW_BOOTSTRAPPER).Path
$binary = Get-Item -LiteralPath 'src-tauri/target/release/vexssh.exe'
$version = $binary.VersionInfo.ProductVersion
$stage = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("vexssh-signed-" + [guid]::NewGuid()))).FullName
$portable = Join-Path $stage "VEXSSH-$version-Windows-x64-Portable.exe"
$setup = Join-Path $stage "VEXSSH-$version-Windows-x64-Online-Setup.exe"

function Test-PublisherSignature($file) {
    & $tool verify /pa /all /tw $file
    if ($LASTEXITCODE -ne 0) { throw "Signature or timestamp check failed for $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumb) {
        throw "Unexpected publisher on $file"
    }
}

Copy-Item -LiteralPath $binary.FullName -Destination $portable
& $tool sign /s My /sha1 $thumb /fd SHA256 /tr $tsa /td SHA256 $portable
if ($LASTEXITCODE -ne 0) { throw 'Portable signing failed.' }
Test-PublisherSignature $portable

$signer = '/SVexsshPublisher=$q{0}$q sign /s My /sha1 {1} /fd SHA256 /tr $q{2}$q /td SHA256 $f' -f $tool, $thumb, $tsa
& $compiler $signer "/O$stage" /DSignedRelease=1 /DOnlineSetup=1 "/DAppBinary=$portable" "/DWebViewInstaller=$runtime" tools/windows/setup.iss
if ($LASTEXITCODE -ne 0) { throw 'Signed installer build failed.' }
Test-PublisherSignature $setup
Get-FileHash -LiteralPath $portable, $setup -Algorithm SHA256
```

Inno uses the named signing tool for Setup and its uninstaller. Test the installer in a clean Windows account with its normal trust store. Run the same publisher and timestamp check on the installed app and `unins000.exe`. Confirm the installed app's SHA-256 matches the portable file, then publish the two verified files. [Inno Setup signing](https://jrsoftware.org/inno-setup/documentation/topic_setup_signtool.htm) · [Signed uninstaller](https://jrsoftware.org/inno-setup/documentation/topic_setup_signeduninstaller.htm)

## Release notes

Start the GitHub release description with `## What's changed` and a short list of changes users will notice. Under `## Windows downloads`, link **Installer** and **Portable** directly to the Windows executables attached to that tag. The repository's download button opens GitHub Releases.

The **Update Windows downloads** workflow puts a version-sorted list in the first public release on GitHub. It refreshes on release changes and keeps the same download link when a new version appears. If a publishing workflow uses the repository's `GITHUB_TOKEN`, dispatch **Update Windows downloads** after publishing so the list refreshes in that workflow too.
