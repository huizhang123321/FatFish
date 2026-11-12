#Requires -Version 5.1
<#
.SYNOPSIS
    Build the FatFish Windows installer from an electron-builder "win-unpacked"
    directory using a hand-written NSIS script.

.DESCRIPTION
    electron-builder's own NSIS target was not usable here: it compiles a helper
    installer (BUILD_UNINSTALLER) and *executes* it to obtain the uninstaller
    binary, launching that child through a stripped environment so it exits
    non-zero even after writing the file, which aborts the build. This script
    compiles packaging/fatfish-installer.nsi instead, where the uninstaller is
    written into the install directory at install time -- no helper process is
    ever run during the build.

    Run `npx electron-builder --win --x64 --dir` (or `npm run pack`) first: this
    only wraps an already packaged application directory.

.PARAMETER AppDir
    The packaged application directory. Defaults to desktop\release\win-unpacked.

.PARAMETER OutFile
    Installer path to produce. Defaults to
    desktop\release\FatFish-Setup-<version>-x64.exe.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File packaging\make-installer.ps1
#>
[CmdletBinding()]
param(
    [string] $AppDir = "",
    [string] $OutFile = "",
    [string] $Makensis = ""
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Desktop = Join-Path $Root 'desktop'
$Release = Join-Path $Desktop 'release'
$Script = Join-Path $Root 'packaging\fatfish-installer.nsi'

if (-not $AppDir) { $AppDir = Join-Path $Release 'win-unpacked' }
if (-not (Test-Path $AppDir)) {
    throw "packaged application not found at $AppDir`nRun:  cd desktop; npm run pack"
}
if (-not (Test-Path (Join-Path $AppDir 'FatFish.exe'))) {
    throw "FatFish.exe missing from $AppDir -- the directory is not a complete electron-builder package"
}

$PackageJson = Get-Content (Join-Path $Desktop 'package.json') -Raw | ConvertFrom-Json
$Version = $PackageJson.version
if (-not $OutFile) {
    $OutFile = Join-Path $Release ("FatFish-Setup-{0}-x64.exe" -f $Version)
}

function Find-Makensis {
    if ($Makensis) {
        if (-not (Test-Path $Makensis)) { throw "makensis not found at $Makensis" }
        return $Makensis
    }
    $candidates = @()
    # electron-builder caches the NSIS toolchain here after its first NSIS build.
    $cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
    if (Test-Path $cache) {
        $candidates += Get-ChildItem $cache -Recurse -Filter 'makensis.exe' -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName
    }
    $candidates += Get-ChildItem (Join-Path $Root '.electron-cache') -Recurse -Filter 'makensis.exe' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    # Prefer the real compiler over the helper copy that ships in Bin\.
    $preferred = $candidates | Where-Object { $_ -notmatch '\\Bin\\makensis\.exe$' } | Select-Object -First 1
    if ($preferred) { return $preferred }
    if ($candidates.Count -gt 0) { return $candidates[0] }

    $onPath = Get-Command makensis -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw @"
makensis.exe not found.
Install NSIS from https://nsis.sourceforge.io/ or let electron-builder fetch it once:
    cd desktop; npx electron-builder --win nsis --x64
Then re-run, or pass -Makensis <path>.
"@
}

$MakensisExe = Find-Makensis
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null

Write-Host "app dir  : $AppDir"
Write-Host "out file : $OutFile"
Write-Host "makensis : $MakensisExe"
Write-Host "version  : $Version"

$arguments = @(
    "/DAPP_DIR=$AppDir"
    "/DOUT_FILE=$OutFile"
    "/DAPP_VERSION=$Version"
    $Script
)

# makensis detects Unicode only from a byte-order mark; without one it decodes the
# script with the system ANSI code page, and the Chinese shortcut names produce
# "Bad text encoding". Editing the script with any normal editor drops the BOM, so
# it is restored here rather than relied upon.
$scriptBytes = [System.IO.File]::ReadAllBytes($Script)
$hasBom =
    $scriptBytes.Length -ge 3 -and
    $scriptBytes[0] -eq 0xEF -and
    $scriptBytes[1] -eq 0xBB -and
    $scriptBytes[2] -eq 0xBF
if (-not $hasBom) {
    $text = [System.IO.File]::ReadAllText($Script, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($Script, $text, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host 'restored the UTF-8 BOM on the installer script'
}

& $MakensisExe @arguments
if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }

if (-not (Test-Path $OutFile)) { throw "makensis reported success but $OutFile is missing" }

# Ship the launcher next to the installer.
#
# On some machines every NSIS installer -- including a three-line test one --
# aborts with "Error writing temporary file" because the per-user %TEMP% cannot
# be used for NSIS' start-up temp file, which from the user's side looks like
# "double-clicking does nothing". setup-launcher.ps1 sets TEMP/TMP to a folder it
# has verified is writable and then starts the installer.
$packagingDir = Split-Path -Parent $Script
$launcherSource = Join-Path $packagingDir 'setup-launcher.cmd'
$launcherScript = Join-Path $packagingDir 'setup-launcher.ps1'
$outputDir = Split-Path -Parent $OutFile
if ((Test-Path $launcherSource) -and (Test-Path $launcherScript)) {
    Copy-Item $launcherScript (Join-Path $outputDir 'setup-launcher.ps1') -Force
    Copy-Item $launcherSource (Join-Path $outputDir '安装 FatFish.cmd') -Force -ErrorAction SilentlyContinue
    if (Test-Path (Join-Path $outputDir '安装 FatFish.cmd')) {
        Write-Host 'launcher  : 安装 FatFish.cmd（TEMP 不可用时的入口）' -ForegroundColor Green
    } else {
        Write-Host 'launcher  : 复制中文文件名失败，保留 setup-launcher.cmd' -ForegroundColor Yellow
        Copy-Item $launcherSource (Join-Path $outputDir 'setup-launcher.cmd') -Force
    }
}

# Ship the standalone uninstaller next to it too.
#
# The uninstaller inside the install directory is the packaged NSIS one, which on
# this machine cannot start at all. This script removes the files, shortcuts and
# registry entries directly, so "uninstall" always has a working route.
$uninstallScript = Join-Path $packagingDir 'uninstall-fatfish.ps1'
$uninstallCmd = Join-Path $packagingDir 'uninstall-fatfish.cmd'
if ((Test-Path $uninstallScript) -and (Test-Path $uninstallCmd)) {
    Copy-Item $uninstallScript (Join-Path $outputDir 'uninstall-fatfish.ps1') -Force
    Copy-Item $uninstallCmd (Join-Path $outputDir '卸载 FatFish.cmd') -Force -ErrorAction SilentlyContinue
    if (Test-Path (Join-Path $outputDir '卸载 FatFish.cmd')) {
        Write-Host 'uninstall : 卸载 FatFish.cmd（独立卸载，不依赖 NSIS）' -ForegroundColor Green
    }
}

$info = Get-Item $OutFile
Write-Host ''
Write-Host ("installer built: {0}  ({1:N1} MB)" -f $info.FullName, ($info.Length / 1MB)) -ForegroundColor Green
