#requires -Version 5.1
<#
.SYNOPSIS
    Start the installed FatFish backend and open the chat interface.

.DESCRIPTION
    This is the launch path that does not involve Electron, shipped inside the
    installer for machines where Chromium refuses to start (the window appears and
    closes instantly, before any of the app's own code runs).

    The backend it starts is the one installed next to this script at
    resources\server\minimost-server.exe, and the interface is the same React
    bundle the desktop window would load. Data lives in %APPDATA%\FatFish\data,
    shared with the desktop window, so switching between the two keeps one
    history.
#>
[CmdletBinding()]
param(
    [int] $Port = 5000
)

$ErrorActionPreference = 'Continue'

$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $InstallDir 'resources\server\minimost-server.exe'
$DataDir = Join-Path $env:APPDATA 'FatFish\data'
$Url = "http://127.0.0.1:$Port/app/"
$HealthUrl = "http://127.0.0.1:$Port/app/health"

function Say {
    param([string] $Text = '', [string] $Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

function Test-Healthy {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 1
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

Say ''
Say 'FatFish —— 启动' 'Cyan'
Say '------------------------------------------------------------'

if (-not (Test-Path $Server)) {
    Say "[错误] 安装目录不完整，找不到后端：" 'Red'
    Say "       $Server"
    Say '       请重新安装。'
    Read-Host '按回车退出'
    exit 2
}

$env:MINIMOST_DATA_DIR = $DataDir
$env:MINIMOST_DESKTOP = '1'
$env:MINIMOST_SKIP_TLS = '1'

Say "  后端 : $Server"
Say "  数据 : $DataDir"
Say "  地址 : $Url"
Say ''

if (Test-Healthy) {
    Say '  服务已经在运行，直接打开界面。' 'Yellow'
} else {
    Say '  正在启动后端...'
    try {
        Start-Process -FilePath $Server `
            -ArgumentList '--host', '127.0.0.1', '--port', $Port `
            -WorkingDirectory (Split-Path -Parent $Server) `
            -WindowStyle Minimized | Out-Null
    } catch {
        Say "  [错误] 无法启动后端：$($_.Exception.Message)" 'Red'
        Say ''
        Say '  如果提示"操作已被用户取消"，说明这台机器禁止启动未签名的程序。'
        Say '  请改用「FatFish（桌面窗口）」快捷方式，或联系开发者。'
        Read-Host '按回车退出'
        exit 3
    }

    $ok = $false
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Healthy) { $ok = $true; break }
    }

    if (-not $ok) {
        Say '  [失败] 后端 60 秒内没有就绪。' 'Red'
        $log = Join-Path $DataDir 'server.log'
        if (Test-Path $log) {
            Say ''
            Say "  ---- server.log（最后 20 行）----"
            Get-Content -LiteralPath $log -Tail 20 -Encoding UTF8
            Say '  --------------------------------'
        } else {
            Say "  也没有生成 $log，后端进程可能根本没起来。"
        }
        Read-Host '按回车退出'
        exit 1
    }
    Say '  后端已就绪。' 'Green'
}

Say '  正在打开浏览器…'
try {
    Start-Process $Url | Out-Null
} catch {
    Say "  [提示] 自动打开浏览器失败，请手动访问 $Url" 'Yellow'
}

Say ''
Say "  界面地址：$Url"
Say '  关掉这个窗口不影响使用；停止服务请用开始菜单里的「停止FatFish」。'
Start-Sleep -Seconds 3
exit 0
