[CmdletBinding()]
param([string]$ProjectDirectory = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($ProjectDirectory)) {
    $prtRepairDirectory = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($prtRepairDirectory)) { $prtRepairDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $ProjectDirectory = Split-Path -Parent $prtRepairDirectory
}
$prtRoot = (Resolve-Path -LiteralPath $ProjectDirectory).Path
foreach ($prtRequired in @('Dockerfile', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $prtRoot $prtRequired) -PathType Leaf)) {
        throw "Not a deployment source directory. Missing: $prtRequired"
    }
}
$prtRules = @(
    'node_modules', 'dist', '.git', '.env', '.env.*', 'data',
    '.preview-data', '.preview-backups', 'backups', 'test-results',
    'host-data', '.host-runtime', 'ops-backups', '.ops-workspace',
    'prt-ops-source.json', '*.log', '*.sqlite', '*.sqlite-*',
    '*.db', '*.db-wal', '*.db-shm', 'coverage', '.vite', '.cache',
    '.DS_Store', 'Thumbs.db', 'Desktop.ini'
)
$prtUtf8 = New-Object System.Text.UTF8Encoding($false)
$prtDockerPath = Join-Path $prtRoot '.dockerignore'
$prtExisting = ''
if (Test-Path -LiteralPath $prtDockerPath -PathType Leaf) { $prtExisting = [System.IO.File]::ReadAllText($prtDockerPath) }
$prtBlock = (@('# PRT deployment protections and required build metadata.') + $prtRules + @('!/.gitignore', '!/.dockerignore')) -join [Environment]::NewLine
if (-not $prtExisting.TrimEnd().EndsWith($prtBlock, [System.StringComparison]::Ordinal)) {
    $prtPrefix = ''
    if (-not [string]::IsNullOrWhiteSpace($prtExisting)) { $prtPrefix = $prtExisting.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine }
    [System.IO.File]::WriteAllText($prtDockerPath, $prtPrefix + $prtBlock + [Environment]::NewLine, $prtUtf8)
    Write-Host 'Prepared .dockerignore (kept existing custom rules; protected credentials/data and included build metadata).'
}
$prtGitPath = Join-Path $prtRoot '.gitignore'
if (-not (Test-Path -LiteralPath $prtGitPath)) {
    [System.IO.File]::WriteAllText($prtGitPath, ($prtRules + @('!.env.example', '!.env.*.example') -join [Environment]::NewLine) + [Environment]::NewLine, $prtUtf8)
    Write-Host 'Created missing .gitignore.'
}
foreach ($prtFile in @('.dockerignore', '.gitignore')) {
    if (-not (Test-Path -LiteralPath (Join-Path $prtRoot $prtFile) -PathType Leaf)) { throw "Build metadata is not a file: $prtFile" }
}
Write-Host 'Docker build metadata is ready. Application data, .env and containers were not changed.'
