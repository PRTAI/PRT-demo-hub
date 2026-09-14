#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$prtLanAddress = '192.168.110.54'
if (-not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $prtLanAddress -ErrorAction SilentlyContinue)) {
    throw 'LAN address changed. Update the application origin and Feishu callback before running this script.'
}
# Bind only the LAN interface: forwarding 0.0.0.0 to 127.0.0.1 on the same port could loop.
# Docker itself publishes 0.0.0.0:8080; this bridges Windows to Docker Desktop localhost forwarding.
netsh interface portproxy add v4tov4 listenaddress=$prtLanAddress listenport=8080 connectaddress=127.0.0.1 connectport=8080
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Windows port forwarding rule.' }
Restart-Service -Name iphlpsvc -ErrorAction Stop
$prtRuleName = 'PRT-DataHub-LAN-8080'
if (-not (Get-NetFirewallRule -Name $prtRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $prtRuleName -DisplayName 'PRT DataHub LAN TCP 8080' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $prtLanAddress -LocalPort 8080 -RemoteAddress LocalSubnet -Profile Any | Out-Null
}
Add-Type -AssemblyName System.Net.Http
$prtHandler = New-Object System.Net.Http.HttpClientHandler
$prtHandler.UseProxy = $false
$prtClient = New-Object System.Net.Http.HttpClient($prtHandler)
$prtClient.Timeout = [TimeSpan]::FromSeconds(10)
try { $prtHealth = $prtClient.GetStringAsync("http://${prtLanAddress}:8080/api/health").GetAwaiter().GetResult() | ConvertFrom-Json }
finally { $prtClient.Dispose(); $prtHandler.Dispose() }
if (-not $prtHealth.ok) { throw 'The forwarding rule was created but the application health check failed.' }
Write-Host "PRT DataHub is reachable at http://${prtLanAddress}:8080"
