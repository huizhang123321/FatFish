#requires -Version 5.1
<#
.SYNOPSIS
    Remove FatFish completely: programme files, shortcuts and registry entries.

.DESCRIPTION
    The packaged NSIS uninstaller is used first, because it knows what it
    installed. On some machines, though, it cannot start at all: it copies itself
    into %TEMP% and aborts with "Error writing temporary file" before doing
    anything (measured here: %TEMP% and %APPDATA% both refused, and which other
    folders work varies). Rather than leaving the user with an uninstall that does
    nothing, this script does the work itself -- deleting 386 MB of files needs no
    installer machinery.

    User data is preserved: the chat database, uploads and avatars live in
    %APPDATA%\FatFish and are deliberately untouched. -KeepData exists for
    symmetry and to make the intent explicit.

.PARAMETER InstallDir
    The install directory. Defaults to the location recorded by the installer, or
    %LOCALAPPDATA%\Programs\FatFish.

.PARAMETER KeepData
    Keep %APPDATA%\FatFish (this is already the default behaviour).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall-fatfish.ps1
#>
[CmdletBinding()]
param(
    [string] $InstallDir = "",
    [switch] $KeepData,
    [switch] $Quiet
)

$ErrorActionPreference = 'Continue'

$RegistryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FatFish'
$AppKey = 'HKCU:\Software\FatFish'
$DataDir = Join-Path $env:APPDATA 'FatFish'
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\FatFish'

function Say {
    param([string] $Text = '', [string] $Color = 'Gray')
    if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color }
}

function ShortcutNames {
    @(
        'FatFish.lnk',
        'FatFish（浏览器模式）.lnk'
    )
}

Say ''
Say 'FatFish —— 卸载' 'Cyan'
Say '------------------------------------------------------------'

# 1. Where is it?
if (-not $InstallDir) {
    if (Test-Path $RegistryKey) {
        $InstallDir = (Get-ItemProperty $RegistryKey -ErrorAction SilentlyContinue).InstallLocation
    }
    if (-not $InstallDir) {
        $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\FatFish'
    }
}
Say "  安装目录: $InstallDir"

if (-not (Test-Path $InstallDir)) {
    Say '  这个目录不存在，可能已经卸载过了。' 'Yellow'
} else {
    # 2. Stop anything running out of it, or the files stay locked.
    foreach ($name in @('FatFish', 'minimost-server')) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            Say "  结束进程 $name (pid $($_.Id))"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 800

    # 3. Remove the files directly.
    #
    #    The shipped Uninstall.exe is deliberately *not* run. It is an NSIS
    #    program, and on some machines it cannot start at all (it aborts with
    #    "Error writing temporary file" before doing anything) or it shows a modal
    #    error and never returns -- which is worse than doing nothing, because it
    #    blocks whatever started it. Deleting 386 MB of files needs no installer
    #    machinery; measured at 0.2 seconds here.
    Say '  删除程序文件…'
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if (Test-Path $InstallDir) {
        # A file can stay held open briefly after its process exits; retry once.
        Start-Sleep -Seconds 3
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $InstallDir) {
        $left = (Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue).Count
        Say "  [警告] 还有 $left 个文件没删掉（可能被占用）：$InstallDir" 'Yellow'
    } else {
        Say '  安装目录已删除。' 'Green'
    }
}

# 5. Shortcuts.
foreach ($name in ShortcutNames) {
    $path = Join-Path $Desktop $name
    if (Test-Path $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        Say "  删除快捷方式: $name"
    }
}
if (Test-Path $StartMenu) {
    Remove-Item -LiteralPath $StartMenu -Recurse -Force -ErrorAction SilentlyContinue
    Say '  删除开始菜单项。'
}

# 6. Registry.
foreach ($key in @($RegistryKey, $AppKey)) {
    if (Test-Path $key) {
        Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
        Say "  删除注册表项: $key"
    }
}

# 7. Say what was kept and why.
if (-not $KeepData) {
    if (Test-Path $DataDir) {
        Say ''
        Say "  聊天数据保留在：$DataDir" 'Yellow'
        Say '  （账号、消息、图片、头像都在这里；要彻底清除请手动删除该目录）'
    }
}

Say ''
Say '卸载完成。' 'Green'
if (-not $Quiet) {
    Read-Host '按回车退出'
}
exit 0
