<#
.SYNOPSIS
    Regenerate Android launcher icons from the desktop application's icon.

.DESCRIPTION
    The desktop icon (desktop/build/icon.png, 512x512) is the visual source of
    truth. This script resamples it into every Android density bucket and also
    derives the adaptive-icon foreground layers. It uses System.Drawing, so no
    ImageMagick or Python image library is needed.

    Run it after the desktop icon changes:

        powershell -ExecutionPolicy Bypass -File .\make-icons.ps1

    The generated PNGs are committed so a normal APK build does not depend on
    the desktop icon file being present.
#>
[CmdletBinding()]
param(
    [string] $Source = "",
    [switch] $Quiet
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Source) {
    $Source = Join-Path (Split-Path -Parent $Here) "desktop\build\icon.png"
}
if (-not (Test-Path $Source)) {
    Write-Host "[icons] desktop icon not found: $Source" -ForegroundColor Red
    exit 1
}
$Source = (Resolve-Path $Source).Path
$Res = Join-Path $Here "app\res"

Add-Type -AssemblyName System.Drawing

function Resize-Icon {
    param(
        [string] $Destination,
        [int] $Size
    )
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $image = [System.Drawing.Image]::FromFile($Source)
        try {
            $graphics.DrawImage($image, 0, 0, $Size, $Size)
        } finally {
            $image.Dispose()
        }
    } finally {
        $graphics.Dispose()
    }
    $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

$brandDir = Join-Path $Res "drawable-nodpi"
New-Item -ItemType Directory -Force $brandDir | Out-Null
Copy-Item -LiteralPath $Source -Destination (Join-Path $brandDir "brand_icon.png") -Force

$buckets = @(
    @{ Dir = "mipmap-mdpi"; Legacy = 48 },
    @{ Dir = "mipmap-hdpi"; Legacy = 72 },
    @{ Dir = "mipmap-xhdpi"; Legacy = 96 },
    @{ Dir = "mipmap-xxhdpi"; Legacy = 144 },
    @{ Dir = "mipmap-xxxhdpi"; Legacy = 192 }
)

foreach ($bucket in $buckets) {
    $dir = Join-Path $Res $bucket.Dir
    New-Item -ItemType Directory -Force $dir | Out-Null
    $legacy = [int]$bucket.Legacy
    Resize-Icon -Destination (Join-Path $dir "ic_launcher.png") -Size $legacy
    Resize-Icon -Destination (Join-Path $dir "ic_launcher_round.png") -Size $legacy
    # Adaptive icons are 108dp; 108/48 = 2.25.
    Resize-Icon -Destination (Join-Path $dir "ic_launcher_foreground.png") -Size ([int]($legacy * 2.25))
    if (-not $Quiet) { Write-Host ("[icons] " + $bucket.Dir + " legacy=" + $legacy + " foreground=" + [int]($legacy * 2.25)) }
}

if (-not $Quiet) {
    Write-Host "[icons] source: $Source" -ForegroundColor Green
    Write-Host "[icons] done" -ForegroundColor Green
}
