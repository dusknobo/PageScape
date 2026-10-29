param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [string]$ApiBase = 'http://127.0.0.1:6806'
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $projectRoot 'dist'
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'plugin.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'PageScape') { throw 'Unexpected plugin package.' }
$resolvedWorkspace = (Resolve-Path -LiteralPath $Workspace).Path.TrimEnd('\')
$active = Invoke-RestMethod -Uri "$ApiBase/api/system/getWorkspaceInfo" -Method Post -ContentType 'application/json' -Body '{}' -NoProxy
if ($active.code -ne 0 -or $active.data.workspaceDir.TrimEnd('\') -ine $resolvedWorkspace) {
    throw 'The running SiYuan API does not match the requested workspace.'
}
$pluginsRoot = [IO.Path]::GetFullPath((Join-Path $resolvedWorkspace 'data\plugins'))
$target = [IO.Path]::GetFullPath((Join-Path $pluginsRoot $manifest.name))
if (-not $target.StartsWith($pluginsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid plugin target.' }
$qaRoot = Join-Path $projectRoot '.qa'
New-Item -ItemType Directory -Path $qaRoot -Force | Out-Null
$legacyTarget = Join-Path $pluginsRoot 'siyuan-child-cards'
if (Test-Path -LiteralPath $legacyTarget) {
    $legacyBody = @{packageName='siyuan-child-cards'; enabled=$false} | ConvertTo-Json -Compress
    $legacyDisabled = Invoke-RestMethod -Uri "$ApiBase/api/petal/setPetalEnabled" -Method Post -ContentType 'application/json' -Body $legacyBody -NoProxy
    if ($legacyDisabled.code -ne 0) { throw "Cannot disable legacy plugin: $($legacyDisabled.msg)" }
}
if (Test-Path -LiteralPath $target) {
    $backup = Join-Path $qaRoot ('installed-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $target -Destination $backup -Recurse
    $disableBody = @{packageName=$manifest.name; enabled=$false} | ConvertTo-Json -Compress
    $disabled = Invoke-RestMethod -Uri "$ApiBase/api/petal/setPetalEnabled" -Method Post -ContentType 'application/json' -Body $disableBody -NoProxy
    if ($disabled.code -ne 0) { throw "Cannot disable previous plugin: $($disabled.msg)" }
}
New-Item -ItemType Directory -Path (Join-Path $target 'i18n') -Force | Out-Null
$files = @('index.js','index.css','plugin.json','README.md','README.en.md','LICENSE','icon.png','preview.png','i18n/zh_CN.json','i18n/en_US.json','docs/images/overview.png')
$hashes = @()
foreach ($file in $files) {
    $source = Join-Path $sourceRoot $file
    $destination = Join-Path $target $file
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($sourceHash -ne $installedHash) { throw "File verification failed: $file" }
    $hashes += @{file=$file; sha256=$installedHash}
}
$body = @{packageName=$manifest.name; enabled=$true} | ConvertTo-Json -Compress
$enabled = Invoke-RestMethod -Uri "$ApiBase/api/petal/setPetalEnabled" -Method Post -ContentType 'application/json' -Body $body -NoProxy
if ($enabled.code -ne 0 -or -not $enabled.data.enabled -or $enabled.data.incompatible) {
    throw "SiYuan did not enable the plugin: $($enabled.msg)"
}
$result = [ordered]@{
    installedAt = [DateTimeOffset]::Now.ToString('o')
    workspace = $resolvedWorkspace
    target = $target
    name = $manifest.name
    version = $enabled.data.version
    enabled = $enabled.data.enabled
    incompatible = $enabled.data.incompatible
    verifiedFiles = $hashes
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $qaRoot 'install-result.json') -Encoding utf8
[PSCustomObject]@{name=$result.name; version=$result.version; enabled=$result.enabled; target=$result.target; verifiedFiles=$hashes.Count} | ConvertTo-Json
