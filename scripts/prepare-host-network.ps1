#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
# Remove only this application's old Docker Desktop bridge.
netsh interface portproxy delete v4tov4 listenaddress=192.168.110.54 listenport=8080
$prtRuleName = 'PRT-DataHub-LAN-8080'
if (-not (Get-NetFirewallRule -Name $prtRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $prtRuleName -DisplayName 'PRT DataHub LAN TCP 8080' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 192.168.110.54 -LocalPort 8080 -RemoteAddress LocalSubnet -Profile Any | Out-Null
}
Write-Output 'Host network configured. No Docker port forwarding is needed.'
