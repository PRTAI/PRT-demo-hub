[CmdletBinding()]
param([string]$ProjectDirectory = 'J:\PRT-demo-hub-test')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$prtEnvPath = Join-Path ([System.IO.Path]::GetFullPath($ProjectDirectory)) '.env'
if (-not (Test-Path -LiteralPath $prtEnvPath -PathType Leaf)) { throw 'Existing deployment .env is required.' }
$prtText = [System.IO.File]::ReadAllText($prtEnvPath)
if ($prtText -notmatch '(?m)^OPS_WORKER_TOKEN=\S{32,}\s*$') {
    $prtBytes = New-Object byte[] 48
    $prtRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $prtRng.GetBytes($prtBytes) } finally { $prtRng.Dispose() }
    $prtText = $prtText -replace '(?m)^OPS_WORKER_TOKEN=.*\r?\n?', ''
    $prtText += [Environment]::NewLine + 'OPS_WORKER_TOKEN=' + [Convert]::ToBase64String($prtBytes) + [Environment]::NewLine
}
$prtDefaults = [ordered]@{
    OPS_REASONING_EFFORT = 'max'
    OPS_MAX_TOKENS = ''
    OPS_GITHUB_TOKEN = ''
    OPS_GITHUB_REPOSITORY = 'PRTAI/PRT-demo-hub'
    OPS_GITHUB_BRANCH = 'feature/deepseek'
    OPS_GITHUB_BASE_BRANCH = 'main'
    OPS_HOST_BACKUP_DIR = 'J:/PRT-backups/ops'
}
foreach ($prtEntry in $prtDefaults.GetEnumerator()) {
    if ($prtText -notmatch ('(?m)^' + [regex]::Escape($prtEntry.Key) + '=')) {
        $prtText += [Environment]::NewLine + $prtEntry.Key + '=' + $prtEntry.Value
    }
}
[System.IO.File]::WriteAllText($prtEnvPath, $prtText + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'Operations defaults are ready. Fill OPS_GITHUB_TOKEN in the editor, save and close it, then run update-docker.ps1 -EnableOps.'
& notepad.exe $prtEnvPath
