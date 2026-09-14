$ErrorActionPreference = 'Stop'
$prtRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $prtRoot '.env.host'))) { throw 'Missing .env.host' }
$prtNode = (Get-Command node -ErrorAction Stop).Source
$prtRunner = Join-Path $PSScriptRoot 'host-supervisor.mjs'
Start-Process -FilePath $prtNode -WorkingDirectory $prtRoot -WindowStyle Hidden -ArgumentList ('"' + $prtRunner + '"') | Out-Null
Write-Output 'PRT host supervisor started. Logs: .host-runtime/server.log'
