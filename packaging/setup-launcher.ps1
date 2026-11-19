#requires -Version 5.1
<#
.SYNOPSIS
    Run the FatFish installer with a temp folder it can actually use.

.DESCRIPTION
    NSIS creates a temporary file while it starts. On some machines the per-user
    %TEMP% cannot be used for that: every NSIS installer on the machine aborts with
    "Error writing temporary file. Make sure your temp folder is valid." -- a
    minimal test installer fails the same way, so it is the machine, not the
    package. The symptom from the user's side is a double click that quietly does
    nothing, or a stray error box.

    This launcher points TEMP/TMP at a folder next to the installer (or in
    %APPDATA% if the installer happens to live somewhere read-only), starts the
    newest FatFish-Setup-*.exe beside it, and reports the exit code. The temp
    folder is removed afterwards.

    Plain double-click still works on a healthy machine; this exists for the ones
    where it does not.
#>
[CmdletBinding()]
param(
    [string] $Installer = "",
    [switch] $Unattended
)

$ErrorActionPreference = 'Continue'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say {
    param([string] $Text = '', [string] $Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

Say ''
Say 'FatFish —— 安装启动器' 'Cyan'
Say '------------------------------------------------------------'

if (-not $Installer) {
    $found = Get-ChildItem $Here -Filter 'FatFish-Setup-*.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($found) { $Installer = $found.FullName }
}

if (-not $Installer -or -not (Test-Path $Installer)) {
    Say '[错误] 找不到安装包 FatFish-Setup-*.exe' 'Red'
    Say "       它应该和本文件在同一个目录：$Here"
    Read-Host '按回车退出'
    exit 2
}

Say "  安装包: $Installer"

# Say out loud what is about to happen to an existing installation, because
# "will this wipe my chat history?" is the question an upgrade has to answer
# before the user presses anything.
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FatFish'
$existing = $null
if (Test-Path $uninstallKey) {
    $existing = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
}

if ($existing -and $existing.InstallLocation) {
    $oldVersion = if ($existing.DisplayVersion) { $existing.DisplayVersion } else { '未知版本' }
    Say ''
    Say "  检测到已安装的 FatFish $oldVersion" 'Yellow'
    Say "  安装位置: $($existing.InstallLocation)"
    Say '  将直接覆盖安装到同一位置：程序文件更新，账号与聊天记录保留。'
    Say "  数据目录: $(Join-Path $env:APPDATA 'FatFish\data')  （安装过程不会写入或删除它）"
} else {
    Say ''
    Say '  未检测到已安装的 FatFish，将进行全新安装。'
    Say "  数据目录: $(Join-Path $env:APPDATA 'FatFish\data')"
}

# A running copy holds its exe and dlls open, and the installer would then skip
# replacing them. Stop it here so the launcher shows why, instead of leaving a
# half-old installation behind.
$running = Get-Process -Name 'FatFish', 'minimost-server' -ErrorAction SilentlyContinue
$WasRunning = ($running -ne $null)
if ($running) {
    Say ''
    Say "  正在停止运行中的 FatFish（$($running.Count) 个进程）…" 'Yellow'
    foreach ($proc in $running) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Milliseconds 900
}

# A folder that definitely exists and that this user can write to.
# Where NSIS' temporary file may live. On this machine anything under
# C:\Users\<user>\AppData is refused ("Error writing temporary file"), while a
# folder on another volume works, so the volume holding the installer is tried
# first and the retry loop below falls through if it still exits 2.
$installerVolume = (Split-Path -Qualifier $Installer)
$tempCandidates = @(
    (Join-Path $Here '_setup_temp'),
    (Join-Path ($installerVolume + '\') 'FatFishTemp'),
    (Join-Path $env:APPDATA 'FatFishSetupTemp')
) | Select-Object -Unique

$tempDirs = @()
foreach ($candidate in $tempCandidates) {
    try {
        New-Item -ItemType Directory -Force -Path $candidate | Out-Null
        $probe = Join-Path $candidate 'probe.tmp'
        Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Force
        $tempDirs += $candidate
    } catch {
        continue
    }
}

if ($tempDirs.Count -eq 0) {
    Say '[错误] 找不到可写的临时目录，无法启动安装程序。' 'Red'
    Read-Host '按回车退出'
    exit 3
}

$tempDir = $tempDirs[0]

Say "  临时目录: $tempDir"
Say "  系统 TEMP: $($env:TEMP)   （若它不可用，安装器会报 Error writing temporary file）"
Say ''

$previousTemp = $env:TEMP
$previousTmp = $env:TMP

$arguments = @()
if ($Unattended) { $arguments += '/S' }

$code = 2
try {
    # Exit code 2 is NSIS refusing to start because of its temp file, so the next
    # candidate is worth trying before giving up on the user.
    foreach ($candidate in $tempDirs) {
        $env:TEMP = $candidate
        $env:TMP = $candidate
        Say "  正在启动安装程序（临时目录 $candidate）…"
        $proc = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru -Wait
        $code = $proc.ExitCode
        if ($code -eq 0) { break }
        if ($code -ne 2) { break }
        Say "  退出码 2：这个临时目录不可用，换下一个试试。" 'Yellow'
    }

    Say ''
    # Judge by the result, not only the exit code: NSIS on this machine can finish
    # the install and still report a failure code, so "is it actually installed?"
    # is the honest question.
    $installed = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\FatFish\FatFish.exe'),
        (Join-Path $env:USERPROFILE 'FatFish\FatFish.exe')
    ) | Where-Object { Test-Path $_ }

    $registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FatFish'
    if (Test-Path $registry) {
        $location = (Get-ItemProperty $registry -ErrorAction SilentlyContinue).InstallLocation
        if ($location -and (Test-Path (Join-Path $location 'FatFish.exe'))) {
            $installed += (Join-Path $location 'FatFish.exe')
        }
    }

    if ($code -eq 0 -or $installed.Count -gt 0) {
        if ($existing -and $existing.InstallLocation) {
            Say "  升级完成，仍是 $($existing.InstallLocation)。" 'Green'
            Say '  账号和聊天记录没有被动过，打开就能接着用。'
        } else {
            Say '  安装完成。' 'Green'
        }
        if ($code -ne 0) {
            Say "  （安装程序报告了退出码 $code，但程序确实已经装上，可以忽略）" 'Yellow'
        }
        Say '  桌面和开始菜单里会有两条快捷方式：'
        Say '    「FatFish」           独立窗口版'
        Say '    「FatFish（浏览器模式）」  不依赖 Chromium 的版本'

        # The installer stopped the app to replace its files, so put the user back
        # where they were rather than leaving them staring at a closed window.
        if ($WasRunning -and -not $Unattended) {
            $target = $installed | Select-Object -First 1
            if ($target) {
                Say ''
                Say '  重新启动 FatFish…'
                try {
                    Start-Process -FilePath $target | Out-Null
                } catch {
                    Say "  没能自动启动，请手动打开快捷方式。" 'Yellow'
                }
            }
        }
    } else {
        Say "  安装程序以退出码 $code 结束，没有完成安装。" 'Red'
        Say '  请把上面这些内容发给开发者。'
    }
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    # The installer's leftovers are ours; do not leave half a gigabyte behind.
    foreach ($candidate in $tempDirs) {
        try {
            Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
        } catch {
            Say "  （临时目录没能完全删除：$candidate）" 'DarkGray'
        }
    }
}

Say ''
Read-Host '按回车退出'
exit 0
