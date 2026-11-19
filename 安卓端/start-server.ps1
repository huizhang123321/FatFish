<#
.SYNOPSIS
    Start the FatFish server on the LAN so the Android client can connect.

.DESCRIPTION
    Runs the source checkout's Flask server (not the installed frozen server),
    which guarantees the phone receives the current mobile interface. Data goes
    to the same %APPDATA%\FatFish\data directory as the desktop app, so the
    phone and desktop share accounts and history.

    Close the desktop FatFish window first: two processes must not open the
    same SQLite databases.
#>
[CmdletBinding()]
param(
    [int] $Port = 5000,
    [switch] $Http,
    [string] $DataDir = "$env:APPDATA\FatFish\data",
    [switch] $AllowDesktopRunning
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$Source = Join-Path $Root "minimost\src"

if (-not (Test-Path $Python)) {
    Write-Host "[错误] 找不到 .venv Python：$Python" -ForegroundColor Red
    exit 1
}

$running = Get-Process -Name FatFish, minimost-server -ErrorAction SilentlyContinue
if ($running -and -not $AllowDesktopRunning) {
    Write-Host "[停止] 检测到 FatFish 桌面进程：" -ForegroundColor Red
    $running | ForEach-Object { Write-Host ("         " + $_.ProcessName + " (PID " + $_.Id + ")") }
    Write-Host "       两个进程同时打开同一个数据库会锁死。请先退出桌面窗口，再运行此脚本。" -ForegroundColor Yellow
    Write-Host "       如果确认数据目录不同，可加 -AllowDesktopRunning 强制启动。"
    exit 2
}

$env:PYTHONPATH = $Source
$env:MINIMOST_DATA_DIR = $DataDir
if ($Http) {
    $env:MINIMOST_SKIP_TLS = "1"
    $scheme = "http"
} else {
    Remove-Item Env:MINIMOST_SKIP_TLS -ErrorAction SilentlyContinue
    $scheme = "https"
}

# Only private LAN addresses are useful to a phone; VPN/virtual adapters
# (Radmin, VMware, etc.) otherwise appear first and send people to the wrong IP.
$addresses = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object {
        $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
        $_.IPAddressToString -match "^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)"
    } |
    Select-Object -ExpandProperty IPAddressToString -Unique

Write-Host ""
Write-Host "FatFish 服务端（供 Android 客户端连接）" -ForegroundColor Cyan
Write-Host "  数据目录 : $DataDir"
Write-Host "  协议     : $scheme"
Write-Host "  端口     : $Port"
if ($addresses) {
    Write-Host "  手机填写 :"
    foreach ($address in $addresses) {
        Write-Host ("             " + $address + ":" + $Port) -ForegroundColor Green
    }
} else {
    Write-Host ("  手机填写 : <这台电脑的局域网 IPv4>:" + $Port) -ForegroundColor Yellow
}
if ($Http) {
    Write-Host "  HTTP 是明文连接，仅建议在完全可信的局域网中使用。" -ForegroundColor Yellow
}
Write-Host "  防火墙   : 需放行 TCP $Port，并且只对专用/局域网配置文件放行。"
Write-Host "  停止     : 按 Ctrl+C。聊天记录、账号和文件都在电脑上。"
Write-Host ""

& $Python -m minimost --host 0.0.0.0 --port $Port
exit $LASTEXITCODE
