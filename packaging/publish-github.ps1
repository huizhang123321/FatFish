#requires -Version 5.1
<#
.SYNOPSIS
    Publish this repository to GitHub, with the installer attached to a release.

.DESCRIPTION
    Three steps that are easy to get subtly wrong by hand:

    1. create the repository if it does not exist (a repository that already
       exists is left alone, so re-running this after a failure is safe);
    2. push the current branch;
    3. attach the installer to a release, because GitHub refuses files over
       100 MB and the installer is 152 MB -- a release asset has no such limit.

    The token is passed to git through an ephemeral HTTP header rather than being
    written into .git/config, so it does not end up on disk or in `git remote -v`.

.PARAMETER Repo
    Target repository as ``owner/name``.

.PARAMETER Token
    A GitHub personal access token with the ``repo`` scope. Never echoed.

.PARAMETER Tag
    Release tag to create (default ``v<package version>``).

.PARAMETER Installer
    Installer to attach to the release. Skipped when omitted.

.PARAMETER SkipPush
    Only create the repository and the release (for re-runs after a push).

.EXAMPLE
    .\publish-github.ps1 -Repo someone/FatFish -Token $env:GH_TOKEN
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Repo,
    [Parameter(Mandatory = $true)][string] $Token,
    [string] $Tag = "v1.1.0",
    [string] $Installer = "",
    [switch] $SkipPush
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here

function Say {
    param([string] $Text = '', [string] $Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

# The API needs a header; git needs a header too. Base64 of "x-access-token:<token>"
# is the documented form for GitHub over HTTPS.
$pair = "x-access-token:$Token"
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$apiHeaders = @{
    Authorization          = "Basic $basic"
    'User-Agent'           = 'FatFish-publish'
    'Accept'               = 'application/vnd.github+json'
}

Say ''
Say 'FatFish —— 发布到 GitHub' 'Cyan'
Say '------------------------------------------------------------'
Say "  仓库: $Repo"
Say "  版本: $Tag"

# ── 1. Repository ─────────────────────────────────────────────────────────
$owner, $name = $Repo.Split('/', 2)
$exists = $true
try {
    Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo" -Headers $apiHeaders -Method Get | Out-Null
    Say '  仓库已存在，直接使用。'
} catch {
    $exists = $false
}

if (-not $exists) {
    Say '  创建仓库…'
    $body = @{
        name        = $name
        description = 'FatFish - 纯本地运行的聊天软件（Electron + Flask + SQLite）'
        private     = $false
        has_issues  = $true
    } | ConvertTo-Json
    $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $apiHeaders -Method Get
    $owner = $me.login
    Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Headers $apiHeaders -Method Post `
        -Body $body -ContentType 'application/json' | Out-Null
    Say "  已创建: $owner/$name" 'Green'
}

# ── 2. Push ───────────────────────────────────────────────────────────────
if (-not $SkipPush) {
    Say '  推送代码…'
    Push-Location $Root
    try {
        $remotes = & git remote
        if ($remotes -notcontains 'origin') {
            & git remote add origin "https://github.com/$owner/$name.git"
        } else {
            & git remote set-url origin "https://github.com/$owner/$name.git"
        }
        $branch = & git branch --show-current
        # extraheader keeps the token out of .git/config and out of `remote -v`.
        & git -c "http.extraHeader=AUTHORIZATION: Basic $basic" push -u origin $branch 2>&1 |
            Select-Object -Last 4 | ForEach-Object { Say "    $_" }
        if ($LASTEXITCODE -ne 0) { throw "git push failed with exit code $LASTEXITCODE" }
        Say '  推送完成。' 'Green'
    } finally {
        Pop-Location
    }
}

# ── 3. Release with the installer ─────────────────────────────────────────
if ($Installer) {
    if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }
    $sizeMb = [math]::Round((Get-Item $Installer).Length / 1MB, 1)
    Say "  创建 Release 并上传安装包（$sizeMb MB）…"

    $releaseBody = @{
        tag_name = $Tag
        name     = "FatFish $Tag"
        body     = "Windows 安装包。直接运行即可；已安装旧版会被原地覆盖，账号与聊天记录保留。"
        draft    = $false
    } | ConvertTo-Json

    $release = $null
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$name/releases/tags/$Tag" `
            -Headers $apiHeaders -Method Get
        Say '  该版本的 Release 已存在，将作为新文件上传。'
    } catch {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$name/releases" `
            -Headers $apiHeaders -Method Post -Body $releaseBody -ContentType 'application/json'
    }

    $fileName = [IO.Path]::GetFileName($Installer)
    $uploadUrl = "https://uploads.github.com/repos/$owner/$name/releases/$($release.id)/assets?name=$fileName"
    $bytes = [IO.File]::ReadAllBytes((Resolve-Path $Installer))
    $asset = Invoke-RestMethod -Uri $uploadUrl -Headers $apiHeaders -Method Post `
        -Body $bytes -ContentType 'application/octet-stream' -TimeoutSec 1800
    Say "  已上传: $($asset.name)  ($([math]::Round($asset.size / 1MB, 1)) MB)" 'Green'
    Say "  下载地址: $($asset.browser_download_url)"
}

Say ''
Say '完成。' 'Green'
Say "  仓库: https://github.com/$owner/$name"
