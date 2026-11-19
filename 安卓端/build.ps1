<#
.SYNOPSIS
    Build and sign the FatFish Android APK.

.DESCRIPTION
    This is a deliberately small, reproducible build: aapt2 -> javac -> d8 ->
    zipalign -> apksigner, with no Gradle daemon and no remote dependencies at
    build time. The same commands work on a developer machine with an Android
    SDK installed, and on CI where the SDK is unpacked into a known folder.

    The produced APK is debug-signed with a local key. That is enough to
    sideload it on a phone; publishing to an app store requires replacing the
    keystore (see README).
#>
[CmdletBinding()]
param(
    [string] $Sdk = "",
    [string] $Jdk = "",
    [string] $VersionName = "1.2.0",
    [int] $VersionCode = 6,
    [string] $Output = ""
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $Here "app"
$BuildDir = Join-Path $Here "build"
$DistDir = if ($Output) { $Output } else { Join-Path $Here "dist" }
$MinSdk = 26
$TargetSdk = 34

function Fail([string] $Message) {
    Write-Host ""
    Write-Host "[build] $Message" -ForegroundColor Red
    exit 1
}

function Resolve-Sdk {
    if ($Sdk) { return (Resolve-Path $Sdk).Path }
    $candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $Here ".android-toolchain\sdk"), (Join-Path $Here "..\.android-toolchain\sdk"))
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate "platforms\android-35"))) {
            return (Resolve-Path $candidate).Path
        }
    }
    return ""
}

function Resolve-Jdk {
    if ($Jdk) { return (Resolve-Path $Jdk).Path }
    $candidates = @($env:JAVA_HOME, (Join-Path $Here "..\.android-toolchain\jdk\zulu17.54.21-ca-jdk17.0.13-win_x64"))
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate "bin\javac.exe"))) {
            return (Resolve-Path $candidate).Path
        }
    }
    return ""
}

$Sdk = Resolve-Sdk
if (-not $Sdk) { Fail "找不到 Android SDK。请设置 ANDROID_HOME，或用 -Sdk 指向包含 platforms\android-35 的目录。" }
$Jdk = Resolve-Jdk
if (-not $Jdk) { Fail "找不到 JDK 17。请设置 JAVA_HOME，或用 -Jdk 指向 JDK 17。" }

$BuildTools = Join-Path $Sdk "build-tools\35.0.0"
$AndroidJar = Join-Path $Sdk "platforms\android-35\android.jar"
foreach ($tool in @("aapt2.exe", "d8.bat", "zipalign.exe", "apksigner.bat")) {
    if (-not (Test-Path (Join-Path $BuildTools $tool))) { Fail "缺少构建工具：$(Join-Path $BuildTools $tool)" }
}
if (-not (Test-Path $AndroidJar)) { Fail "缺少 android.jar：$AndroidJar" }

$Javac = Join-Path $Jdk "bin\javac.exe"
$Jar = Join-Path $Jdk "bin\jar.exe"
$Keytool = Join-Path $Jdk "bin\keytool.exe"
foreach ($tool in @($Javac, $Jar, $Keytool)) {
    if (-not (Test-Path $tool)) { Fail "缺少 JDK 工具：$tool" }
}

$env:JAVA_HOME = $Jdk
$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$env:Path = (Join-Path $Jdk "bin") + ";" + $BuildTools + ";" + $env:Path

# aapt2 (build-tools 35) cannot open a resource directory whose path contains
# non-ASCII characters on this Windows host. Keep the build itself on an ASCII
# temporary path when the checkout path is non-ASCII, then copy the signed APK
# back beside this script. The source of truth never moves.
$SourceAppDir = Join-Path $Here "app"
$AsciiHome = $Here -match "^[\x00-\x7F]+$"
if ($AsciiHome) {
    $AppDir = $SourceAppDir
    $BuildDir = Join-Path $Here "build"
} else {
    $TempRoot = [System.IO.Path]::GetTempPath().TrimEnd("\")
    if ($TempRoot -notmatch "^[\x00-\x7F]+$") {
        Fail "当前路径和系统临时目录都包含中文，aapt2 无法构建。请把项目放到纯英文路径，或把 TEMP 指向纯英文目录。"
    }
    $WorkRoot = Join-Path $TempRoot ("fatfish-android-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force $WorkRoot | Out-Null
    $AppDir = Join-Path $WorkRoot "app"
    $BuildDir = Join-Path $WorkRoot "build"
    Copy-Item -Recurse -Force $SourceAppDir $AppDir
    Copy-Item -LiteralPath $AndroidJar -Destination (Join-Path $WorkRoot "android.jar") -Force
    $AndroidJar = Join-Path $WorkRoot "android.jar"
    Write-Host "检测到中文工程路径，构建暂存到：$WorkRoot" -ForegroundColor DarkGray
}

$KeystoreDir = Join-Path $Here "keystore"
New-Item -ItemType Directory -Force $KeystoreDir | Out-Null

Write-Host ""
Write-Host "FatFish Android build" -ForegroundColor Cyan
Write-Host "  SDK    : $Sdk"
Write-Host "  JDK    : $Jdk"
Write-Host "  version: $VersionName ($VersionCode)"
Write-Host ""

New-Item -ItemType Directory -Force $BuildDir | Out-Null
New-Item -ItemType Directory -Force $DistDir | Out-Null
foreach ($item in @("res.zip", "base.apk", "unaligned.apk", "aligned.apk", "sources.txt")) {
    $path = Join-Path $BuildDir $item
    if (Test-Path $path) { Remove-Item -LiteralPath $path -Force }
}
foreach ($dir in @("gen", "classes", "dex")) {
    $path = Join-Path $BuildDir $dir
    if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    New-Item -ItemType Directory -Force $path | Out-Null
}

Write-Host "[1/6] aapt2 compile + link" -ForegroundColor Yellow
$aapt2 = Join-Path $BuildTools "aapt2.exe"
& $aapt2 compile --dir (Join-Path $AppDir "res") -o (Join-Path $BuildDir "res.zip")
if ($LASTEXITCODE -ne 0) { Fail "aapt2 compile 失败（$LASTEXITCODE）" }

$linkArgs = @(
    "link",
    "-o", (Join-Path $BuildDir "base.apk"),
    "-I", $AndroidJar,
    "--manifest", (Join-Path $AppDir "AndroidManifest.xml"),
    "--java", (Join-Path $BuildDir "gen"),
    "--min-sdk-version", "$MinSdk",
    "--target-sdk-version", "$TargetSdk",
    "--version-code", "$VersionCode",
    "--version-name", "$VersionName",
    "--auto-add-overlay",
    "-A", (Join-Path $AppDir "assets"),
    (Join-Path $BuildDir "res.zip")
)
& $aapt2 @linkArgs
if ($LASTEXITCODE -ne 0) { Fail "aapt2 link 失败（$LASTEXITCODE）" }

Write-Host "[2/6] javac" -ForegroundColor Yellow
$sources = @()
$sources += Get-ChildItem (Join-Path $AppDir "java") -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$sources += Get-ChildItem (Join-Path $BuildDir "gen") -Recurse -Filter *.java | ForEach-Object { $_.FullName }
if ($sources.Count -eq 0) { Fail "没有找到 Java 源文件。" }
$sourcesFile = Join-Path $BuildDir "sources.txt"
$sources | Set-Content -LiteralPath $sourcesFile -Encoding ASCII

$javacArgs = @(
    "-encoding", "UTF-8",
    "-source", "17",
    "-target", "17",
    "-classpath", $AndroidJar,
    "-Xlint:-options",
    "-d", (Join-Path $BuildDir "classes"),
    "@$sourcesFile"
)
& $Javac @javacArgs
if ($LASTEXITCODE -ne 0) { Fail "javac 失败（$LASTEXITCODE）" }

Write-Host "[3/6] d8" -ForegroundColor Yellow
$classes = Get-ChildItem (Join-Path $BuildDir "classes") -Recurse -Filter *.class | ForEach-Object { $_.FullName }
if ($classes.Count -eq 0) { Fail "javac 没有生成 class 文件。" }
$d8Args = @("--lib", $AndroidJar, "--min-api", "$MinSdk", "--output", (Join-Path $BuildDir "dex")) + $classes
& (Join-Path $BuildTools "d8.bat") @d8Args
if ($LASTEXITCODE -ne 0) { Fail "d8 失败（$LASTEXITCODE）" }

Write-Host "[4/6] package classes.dex" -ForegroundColor Yellow
Copy-Item (Join-Path $BuildDir "base.apk") (Join-Path $BuildDir "unaligned.apk") -Force
Push-Location (Join-Path $BuildDir "dex")
try {
    & $Jar uf (Join-Path $BuildDir "unaligned.apk") "classes.dex"
    if ($LASTEXITCODE -ne 0) { Fail "jar 写入 classes.dex 失败（$LASTEXITCODE）" }
} finally {
    Pop-Location
}

Write-Host "[5/6] zipalign + sign" -ForegroundColor Yellow
& (Join-Path $BuildTools "zipalign.exe") -f 4 (Join-Path $BuildDir "unaligned.apk") (Join-Path $BuildDir "aligned.apk")
if ($LASTEXITCODE -ne 0) { Fail "zipalign 失败（$LASTEXITCODE）" }

$keystore = Join-Path $KeystoreDir "fatfish-debug.jks"
if (-not (Test-Path $keystore)) {
    $keyArgs = @(
        "-genkeypair",
        "-keystore", $keystore,
        "-storepass", "fatfish",
        "-keypass", "fatfish",
        "-alias", "fatfish",
        "-keyalg", "RSA",
        "-keysize", "2048",
        "-validity", "10000",
        "-dname", "CN=FatFish, OU=Android, O=FatFish, L=Local, ST=Local, C=CN"
    )
    & $Keytool @keyArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "生成调试签名失败（$LASTEXITCODE）" }
}

$apkName = "FatFish-Android-$VersionName.apk"
$apkPath = Join-Path $DistDir $apkName
$signedApk = Join-Path $BuildDir $apkName
$signArgs = @(
    "sign",
    "--ks", $keystore,
    "--ks-pass", "pass:fatfish",
    "--key-pass", "pass:fatfish",
    "--ks-key-alias", "fatfish",
    "--min-sdk-version", "$MinSdk",
    "--out", $signedApk,
    (Join-Path $BuildDir "aligned.apk")
)
& (Join-Path $BuildTools "apksigner.bat") @signArgs
if ($LASTEXITCODE -ne 0) { Fail "apksigner 失败（$LASTEXITCODE）" }
Copy-Item -LiteralPath $signedApk -Destination $apkPath -Force

Write-Host "[6/6] verify" -ForegroundColor Yellow
$verifyArgs = @("verify", "--verbose", "--print-certs", $apkPath)
& (Join-Path $BuildTools "apksigner.bat") @verifyArgs | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Fail "APK 签名校验失败（$LASTEXITCODE）" }

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apkPath).Hash
$size = [math]::Round((Get-Item $apkPath).Length / 1MB, 2)
Write-Host ""
Write-Host "APK: $apkPath" -ForegroundColor Green
Write-Host "SHA-256: $hash"
Write-Host "大小: $size MB"
Write-Host ""
