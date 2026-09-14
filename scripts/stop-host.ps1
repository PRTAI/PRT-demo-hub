$ErrorActionPreference = 'Stop'
$prtRoot = Split-Path -Parent $PSScriptRoot
foreach ($prtName in @('supervisor', 'server')) {
    $prtPidFile = Join-Path $prtRoot ".host-runtime/$prtName.pid"
    if (-not (Test-Path -LiteralPath $prtPidFile)) { continue }
    $prtProcessId = [int](Get-Content -LiteralPath $prtPidFile -Raw)
    $prtProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$prtProcessId"
    $prtExpected = if ($prtName -eq 'supervisor') { '*host-supervisor.mjs*' } else { '*--env-file=.env.host server/index.mjs*' }
    if ($prtProcess -and $prtProcess.Name -eq 'node.exe' -and $prtProcess.CommandLine -like $prtExpected) {
        Stop-Process -Id $prtProcessId -ErrorAction Stop
    } elseif ($prtProcess) { throw "PID $prtProcessId belongs to a different process; refusing to stop it." }
    Remove-Item -LiteralPath $prtPidFile
}
Write-Output 'PRT host server stopped.'
