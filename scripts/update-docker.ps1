[CmdletBinding()]
param(
    [string]$ProjectDirectory = '',
    [string]$BackupDirectory = 'J:\PRT-backups',
    [string]$HealthUrl = 'http://127.0.0.1:8001/api/health',
    [switch]$EnableOps
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProjectDirectory)) {
    $prtScriptDirectory = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($prtScriptDirectory)) {
        $prtScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if ([string]::IsNullOrWhiteSpace($prtScriptDirectory)) {
        throw 'Cannot determine the script directory. Specify -ProjectDirectory explicitly.'
    }
    $ProjectDirectory = Split-Path -Parent $prtScriptDirectory
}

function Invoke-PrtDocker {
    param([string[]]$DockerArguments)
    Write-Host ('> docker ' + ($DockerArguments -join ' '))
    & docker @DockerArguments
    $prtDockerExitCode = $LASTEXITCODE
    if ($prtDockerExitCode -eq 135) {
        throw 'Docker command failed (exit 135, usually SIGBUS in Linux). Update stopped. Check Docker/WSL disk space and storage I/O, then test Node and SQLite before retrying. Do not delete volumes or bypass the backup.'
    }
    if ($prtDockerExitCode -ne 0) {
        throw "Docker command failed (exit $prtDockerExitCode). Update stopped."
    }
}

$prtContainer = 'prt-datahub-production'
$prtDataVolume = 'prt-datahub-production_production-data'
$prtBackupVolume = 'prt-datahub-production_production-backups'
$prtCompose = @('compose', '-f', 'compose.production.yaml', '-f', 'compose.keep-data.yaml')
$prtServices = @('app')
$prtBackupComplete = $false
$prtHostBackup = $null
Push-Location -LiteralPath $ProjectDirectory
try {
    $prtRepairScript = Join-Path (Get-Location).Path 'scripts/repair-docker-build.ps1'
    if (-not (Test-Path -LiteralPath $prtRepairScript -PathType Leaf)) {
        throw 'Missing scripts/repair-docker-build.ps1. Sync the complete scripts directory before updating.'
    }
    & $prtRepairScript -ProjectDirectory (Get-Location).Path
    foreach ($prtFile in @('.env', '.gitignore', '.dockerignore', 'Dockerfile', 'Dockerfile.ops', 'README.md', 'index.html', 'vite.config.mjs', 'package.json', 'package-lock.json', 'compose.production.yaml', 'compose.keep-data.yaml', 'scripts/backup.mjs')) {
        if (-not (Test-Path -LiteralPath $prtFile -PathType Leaf)) {
            throw "Required file is missing: $prtFile"
        }
    }
    foreach ($prtDirectory in @('server', 'shared', 'src', 'public', 'scripts', 'tests', 'docs')) {
        if (-not (Test-Path -LiteralPath $prtDirectory -PathType Container)) { throw "Required source directory is missing: $prtDirectory" }
    }
    Get-Command docker -ErrorAction Stop | Out-Null
    Write-Host '[1/6] Checking Docker, Compose and existing data volumes...'
    Invoke-PrtDocker -DockerArguments @('version')
    Invoke-PrtDocker -DockerArguments @('volume', 'inspect', $prtDataVolume, $prtBackupVolume)
    $prtInspection = & docker inspect $prtContainer
    if ($LASTEXITCODE -ne 0) { throw 'Existing container not found. This script updates an existing deployment only.' }
    $prtExisting = @($prtInspection | ConvertFrom-Json)[0]
    $prtProjectLabel = $prtExisting.Config.Labels.PSObject.Properties['com.docker.compose.project']
    if ($null -eq $prtProjectLabel -or [string]::IsNullOrWhiteSpace([string]$prtProjectLabel.Value)) {
        throw 'Existing container has no Compose project label. Check its deployment before updating.'
    }
    $prtCompose = @('compose', '-p', [string]$prtProjectLabel.Value, '-f', 'compose.production.yaml', '-f', 'compose.keep-data.yaml')
    $prtConfigLabel = $prtExisting.Config.Labels.PSObject.Properties['com.docker.compose.project.config_files']
    $prtHadOps = $null -ne $prtConfigLabel -and ([string]$prtConfigLabel.Value).Contains('compose.ops.yaml')
    if ($EnableOps -or $prtHadOps) {
        foreach ($prtOpsFile in @('compose.ops.yaml', 'Dockerfile.ops', 'server/ops-worker.mjs')) {
            if (-not (Test-Path -LiteralPath $prtOpsFile -PathType Leaf)) { throw "Required operations file is missing: $prtOpsFile" }
        }
        $prtCompose += @('-f', 'compose.ops.yaml')
        $prtServices += 'ops-worker'
    }
    Write-Host ('Using existing Compose project: ' + $prtProjectLabel.Value)
    Invoke-PrtDocker -DockerArguments ($prtCompose + @('config', '--quiet'))
    if (-not $prtExisting.State.Running) { throw 'Start the existing container before creating the backup.' }
    foreach ($prtMount in @(
        @{ Destination = '/app/data'; Name = $prtDataVolume },
        @{ Destination = '/app/backups'; Name = $prtBackupVolume }
    )) {
        $prtMatch = @($prtExisting.Mounts | Where-Object { $_.Destination -eq $prtMount.Destination -and $_.Type -eq 'volume' -and $_.Name -eq $prtMount.Name })
        if ($prtMatch.Count -ne 1) { throw "Unexpected existing mount: $($prtMount.Destination). Check the deployment before updating." }
    }

    Write-Host '[2/6] Creating and exporting a verified backup...'
    $prtStamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $prtContainerBackup = "/app/backups/before-update-$prtStamp"
    $prtHostBackup = Join-Path ([System.IO.Path]::GetFullPath($BackupDirectory)) "before-update-$prtStamp"
    New-Item -ItemType Directory -Path $prtHostBackup -Force | Out-Null
    Write-Host "Creating backup inside container: $prtContainerBackup"
    Invoke-PrtDocker -DockerArguments @('exec', $prtContainer, 'node', 'scripts/backup.mjs', $prtContainerBackup)
    Write-Host "Container backup completed. Copying to Windows: $prtHostBackup"
    Invoke-PrtDocker -DockerArguments @('cp', "${prtContainer}:${prtContainerBackup}/.", $prtHostBackup)
    foreach ($prtBackupFile in @('platform.sqlite', 'manifest.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $prtHostBackup $prtBackupFile) -PathType Leaf)) {
            throw "Exported backup is missing: $prtBackupFile"
        }
    }
    $prtBackupComplete = $true
    Write-Host "Backup exported: $prtHostBackup"

    Write-Host '[3/6] Building the current source...'
    Invoke-PrtDocker -DockerArguments ($prtCompose + @('build') + $prtServices)
    Write-Host '[4/6] Recreating the application with the existing volumes...'
    Invoke-PrtDocker -DockerArguments ($prtCompose + @('up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180') + $prtServices)
    Write-Host '[5/6] Checking application health...'
    $prtHealth = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 20
    $prtHealth | ConvertTo-Json -Depth 5 | Write-Host
    if ($prtServices -contains 'ops-worker') {
        Invoke-PrtDocker -DockerArguments @('exec', $prtContainer, 'node', 'scripts/record-ops-deployment.mjs')
    }
    Write-Host '[6/6] Showing container status and recent logs...'
    Invoke-PrtDocker -DockerArguments ($prtCompose + @('ps'))
    Invoke-PrtDocker -DockerArguments ($prtCompose + @('logs', '--tail', '100', 'app'))
    Write-Host "Update completed. Backup: $prtHostBackup"
    Write-Host 'Refresh the browser with Ctrl+F5.'
} catch {
    Write-Warning 'Update failed. No automatic data restore was performed.'
    if ($prtBackupComplete) { Write-Warning "Verified backup: $prtHostBackup" }
    Write-Warning 'Check: docker logs --tail 100 prt-datahub-production'
    Write-Warning 'A failed or incomplete backup must not be used for restore. Do not bypass backup when storage errors are suspected.'
    throw
} finally {
    Pop-Location
}
