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
$lines += "--- Server program (firewall rules must match this or the ports) ---"
foreach ($p in 5050, 5443) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $lines += "port ${p}: " + (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").ExecutablePath }
}
# Plain-English verdict: the usual reasons an iPhone "can't open the page".
$problems = @()
$cats = Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -notmatch 'Tailscale|vEthernet' }
if ($cats | Where-Object NetworkCategory -ne 'Private') { $problems += "Windows calls this Wi-Fi 'Public'. Run Fix Phone Network.cmd and answer Y for your home Wi-Fi." }
$portRule = Get-NetFirewallRule -DisplayName 'ScrewShop phone access (home Wi-Fi)' -ErrorAction SilentlyContinue | Where-Object Enabled -eq 'True'
if (-not $portRule) { $problems += "No firewall rule for ScrewShop's ports. Run Fix Phone Network.cmd (once, as admin)." }
foreach ($p in 5050, 5443) { if (-not (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)) { $problems += "ScrewShop isn't listening on port $p. Run Restart ScrewShop.cmd." } }
if (-not $ip) { $problems += "No home-network (192.168.x.x) address. Connect this computer to your home Wi-Fi." }
$lines += "--- VERDICT ---"
if ($problems) { $lines += $problems | ForEach-Object { "PROBLEM: $_" } } else { $lines += "OK: computer side looks ready. If the iPhone still can't connect: same Wi-Fi (not Guest, not cellular), VPN off on the phone, and type the address exactly as Settings shows it." }
if ($ip) { $lines += "Phone profile link: http://${ip}:5050/ScrewShop.mobileconfig"; $lines += "Phone studio link:  https://${ip}:5443/barwork" }
$lines += "--- Newest server log lines ---"
$lines += Get-Content (Join-Path $root 'data\server.log') -Tail 8 -ErrorAction SilentlyContinue
$lines | Set-Content -Encoding UTF8 $out
$lines | ForEach-Object { Write-Host $_ }
