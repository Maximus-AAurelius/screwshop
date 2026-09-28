$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'data\phone-check.txt'
$lines = @("ScrewShop phone check $(Get-Date -Format s)")
$lines += "--- Wi-Fi network type (phones need Private) ---"
Get-NetConnectionProfile | ForEach-Object { $lines += "$($_.InterfaceAlias): $($_.Name) = $($_.NetworkCategory)" }
$lines += "--- Computer addresses ---"
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $lines += "$($_.InterfaceAlias): $($_.IPAddress)" }
$lines += "--- Listening ports ---"
foreach ($p in 5050, 5443) {
  $l = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
  if ($l) { $lines += "port ${p}: listening on $(($l | ForEach-Object LocalAddress) -join ', ')" } else { $lines += "port ${p}: NOT listening" }
}
$lines += "--- Server answers (from this computer) ---"
$lines += "http 5050:  " + (& curl.exe -s -m 5 -o NUL -w "%{http_code}" http://localhost:5050/api/status)
$lines += "https 5443: " + (& curl.exe -sk -m 5 -o NUL -w "%{http_code}" https://localhost:5443/api/status)
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1).IPAddress
if ($ip) {
  $lines += "https via Wi-Fi address ${ip}: " + (& curl.exe -sk -m 5 -o NUL -w "%{http_code}" "https://${ip}:5443/api/status" -H "Host: ${ip}:5443")
}
$lines += "--- Firewall rules mentioning ScrewShop / Python / ports ---"
Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'ScrewShop|python' } | ForEach-Object {
  $port = ($_ | Get-NetFirewallPortFilter).LocalPort; $app = ($_ | Get-NetFirewallApplicationFilter).Program
  $lines += "$($_.DisplayName) | $($_.Action) | profile=$($_.Profile) | port=$port | app=$app"
}
$lines += "--- Newest server log lines ---"
$lines += Get-Content (Join-Path $root 'data\server.log') -Tail 8 -ErrorAction SilentlyContinue
$lines | Set-Content -Encoding UTF8 $out
$lines | ForEach-Object { Write-Host $_ }
