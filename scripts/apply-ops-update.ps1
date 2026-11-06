[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceSnapshotPath,
    [string]$ProjectDirectory = 'J:\PRT-demo-hub-test',
    [string]$OutputDirectory = 'J:\PRT-demo-hub-ops-update',
    [string]$BackupDirectory = 'J:\PRT-backups'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$prtSnapshot = (Resolve-Path -LiteralPath $SourceSnapshotPath).Path
$prtProject = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$prtOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $prtOutput) { throw 'OutputDirectory must be a new directory. Choose a new path to preserve existing source.' }
if (-not (Test-Path -LiteralPath (Join-Path $prtProject '.env') -PathType Leaf)) { throw 'The deployed .env file is missing.' }
$prtParent = Split-Path -Parent $prtOutput
$prtName = Split-Path -Leaf $prtOutput
New-Item -ItemType Directory -Path $prtParent -Force | Out-Null
$prtSnapshotParent = Split-Path -Parent $prtSnapshot
$prtSnapshotName = Split-Path -Leaf $prtSnapshot
# A fixed importer from the deployed image validates all paths and hashes. No downloaded script runs on Windows.
& docker run --rm --network none --read-only --cap-drop ALL `
    --mount "type=bind,source=$prtSnapshotParent,target=/input,readonly" `
    --mount "type=bind,source=$prtParent,target=/output" `
    --entrypoint node prt-datahub:production `
    scripts/apply-ops-source.mjs "/input/$prtSnapshotName" "/output/$prtName"
if ($LASTEXITCODE -ne 0) { throw 'Source validation/import failed. No deployment was performed.' }
Copy-Item -LiteralPath (Join-Path $prtProject '.env') -Destination (Join-Path $prtOutput '.env')
& powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $prtProject 'scripts/update-docker.ps1') `
    -ProjectDirectory $prtOutput -BackupDirectory $BackupDirectory -EnableOps
if ($LASTEXITCODE -ne 0) { throw 'Deployment failed. See the update script output; data was not automatically restored.' }
Write-Host "Operations source deployed. Use this directory for future updates: $prtOutput"
