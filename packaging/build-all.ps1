#Requires -Version 5.1
<#
.SYNOPSIS
    Build the complete FatFish Windows desktop distributable from a clean checkout.

.DESCRIPTION
    Runs the four stages in the only order that works:

      1. icons     -- regenerate build/icon.ico etc. from packaging/make_assets.py
      2. ui        -- npm run build: React/TS bundle into minimost/src/minimost/desktop_ui
      3. server    -- PyInstaller: packaging/dist/minimost-server/minimost-server.exe
      4. installer -- electron-builder: desktop/release/FatFish-Setup-<version>-x64.exe

    Stage 2 must come before stage 3 because the PyInstaller spec packages the
    built interface; stage 3 must come before stage 4 because electron-builder
    copies the frozen server into resources/server.

.PARAMETER SkipIcons
    Keep the icons that are already committed (they are generated, so this is safe).

.PARAMETER SkipInstaller
    Stop after the frozen server: useful for testing the backend alone.

.PARAMETER Makensis
    Path to makensis.exe. Defaults to the copy electron-builder caches, then PATH.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File packaging\build-all.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File packaging\build-all.ps1 -SkipIcons -SkipInstaller
#>
[CmdletBinding()]
param(
    [string] $Python = "",
    [string] $Makensis = "",
    [switch] $SkipIcons,
    [switch] $SkipInstaller,
    [string] $ElectronMirror = "https://npmmirror.com/mirrors/electron/",
    [string] $BuilderMirror = "https://npmmirror.com/mirrors/electron-builder-binaries/"
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Desktop = Join-Path $Root 'desktop'
$Packaging = Join-Path $Root 'packaging'

function Write-Stage([string] $Text) {
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Resolve-Python {
    if ($Python) { return $Python }
    $venv = Join-Path $Root '.venv\Scripts\python.exe'
    if (Test-Path $venv) { return $venv }
    return 'python'
}

# npm keeps its cache and logs under the user profile by default, which fails in
# locked-down environments. Pointing both at the repository keeps the build
# reproducible and leaves no state outside it.
$env:npm_config_cache = Join-Path $Root '.npm-cache'
$env:npm_config_logs_dir = Join-Path $Root '.npm-cache\_logs'
$env:ELECTRON_MIRROR = $ElectronMirror
$env:ELECTRON_BUILDER_BINARIES_MIRROR = $BuilderMirror
$env:electron_config_cache = Join-Path $Root '.electron-cache'

$PythonExe = Resolve-Python
Write-Host "repository : $Root"
Write-Host "python     : $PythonExe"

if (-not $SkipIcons) {
    Write-Stage '1/4 icons'
    & $PythonExe (Join-Path $Packaging 'make_assets.py')
    if ($LASTEXITCODE -ne 0) { throw 'icon generation failed' }
}

Write-Stage '2/4 desktop interface'
Push-Location $Desktop
try {
    if (-not (Test-Path (Join-Path $Desktop 'node_modules'))) {
        Write-Host 'installing npm dependencies...'
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }
    # npm's allow-scripts policy can skip Electron's binary download; repair it.
    if (-not (Test-Path (Join-Path $Desktop 'node_modules\electron\dist\electron.exe'))) {
        Write-Host 'downloading the Electron binary...'
        node (Join-Path $Desktop 'node_modules\electron\install.js')
        if ($LASTEXITCODE -ne 0) { throw 'Electron binary download failed' }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'interface build failed' }
} finally {
    Pop-Location
}

$Index = Join-Path $Root 'minimost\src\minimost\desktop_ui\index.html'
if (-not (Test-Path $Index)) { throw "interface build produced no index.html at $Index" }

Write-Stage '3/4 frozen backend'
& $PythonExe -m PyInstaller (Join-Path $Packaging 'minimost-server.spec') `
    --distpath (Join-Path $Packaging 'dist') `
    --workpath (Join-Path $Packaging 'build') `
    --noconfirm
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed' }

$Exe = Join-Path $Packaging 'dist\minimost-server\minimost-server.exe'
if (-not (Test-Path $Exe)) { throw "PyInstaller produced no executable at $Exe" }

if ($SkipInstaller) {
    Write-Host ''
    Write-Host "done: $Exe" -ForegroundColor Green
    return
}

Write-Stage '4/4 installer'
# electron-builder produces the unpacked application; makensis wraps it. See
# packaging/fatfish-installer.nsi for why electron-builder's own NSIS target is
# not used.
Push-Location $Desktop
try {
    npx electron-builder --win --x64 --dir --config electron-builder.yml
    if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
} finally {
    Pop-Location
}

& powershell -ExecutionPolicy Bypass -File (Join-Path $Packaging 'make-installer.ps1') -Makensis $Makensis
if ($LASTEXITCODE -ne 0) { throw 'installer compilation failed' }

Write-Host ''
Write-Host 'Build finished. Artifacts:' -ForegroundColor Green
Get-ChildItem (Join-Path $Desktop 'release') -Filter '*.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB)) }
Get-ChildItem (Join-Path $Desktop 'release') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  $($_.FullName)" }
