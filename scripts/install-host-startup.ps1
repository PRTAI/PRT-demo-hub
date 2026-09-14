$ErrorActionPreference = 'Stop'
$prtRoot = Split-Path -Parent $PSScriptRoot
$prtStartup = [Environment]::GetFolderPath('Startup')
$prtShell = New-Object -ComObject WScript.Shell
$prtShortcut = $prtShell.CreateShortcut((Join-Path $prtStartup 'PRT DataHub.lnk'))
$prtShortcut.TargetPath = (Get-Command powershell.exe).Source
$prtShortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'start-host.ps1') + '"'
$prtShortcut.WorkingDirectory = $prtRoot
$prtShortcut.WindowStyle = 7
$prtShortcut.Description = 'Start PRT DataHub on Windows sign-in'
$prtShortcut.Save()
Write-Output 'Installed current-user Windows sign-in startup: PRT DataHub.lnk'
