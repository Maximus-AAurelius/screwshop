# Lets your iPhone reach ScrewShop on home Wi-Fi, and nobody on public Wi-Fi.
# Run once from "Fix Phone Network.cmd" (it asks Windows for admin permission).
#  1. Marks the Wi-Fi you're on now as Private (your home network).
#  2. Allows ScrewShop's two ports (5050 profile/redirect, 5443 secure studio) on Private networks only.
#     Port-based, so it keeps working when uv updates Python to a new folder.
#  3. Turns OFF (does not delete) the old "allow Python on Public networks" rules.
# Undo: Windows Security > Firewall > Advanced settings > Inbound Rules.
$ErrorActionPreference = 'Stop'
$ruleName = 'ScrewShop phone access (home Wi-Fi)'

Write-Host ''
Write-Host 'ScrewShop: set up home Wi-Fi for your iPhone' -ForegroundColor Cyan
$wifi = Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -and $_.InterfaceAlias -notmatch 'Tailscale|vEthernet|VirtualBox|VMware' }
if (-not $wifi) { Write-Host 'Not connected to a network. Connect to your home Wi-Fi and run this again.' -ForegroundColor Red; exit 1 }
foreach ($net in $wifi) {
    Write-Host ''
    Write-Host "Network: $($net.Name) ($($net.InterfaceAlias)) is $($net.NetworkCategory)."
    if ($net.NetworkCategory -ne 'Private') {
        $answer = Read-Host "Is '$($net.Name)' YOUR home network (not a cafe, hotel or school)? Type Y to mark it Private"
        if ($answer -match '^[Yy]') {
            Set-NetConnectionProfile -InterfaceIndex $net.InterfaceIndex -NetworkCategory Private
            Write-Host "  Marked Private." -ForegroundColor Green
        } else {
            Write-Host '  Left as is. Phones can only reach ScrewShop on networks marked Private.' -ForegroundColor Yellow
        }
    } else { Write-Host '  Already Private.' -ForegroundColor Green }
}

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Description 'iPhone access to ScrewShop on home Wi-Fi. Private networks only. Added by Fix Phone Network.cmd.' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5050,5443 -Profile Private | Out-Null
Write-Host ''
Write-Host "Allowed ScrewShop ports 5050 and 5443 on Private networks only." -ForegroundColor Green

$public = Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'python.exe' -and ($_.Profile -match 'Public' -or $_.Profile -eq 'Any') }
foreach ($rule in $public) {
    $app = ($rule | Get-NetFirewallApplicationFilter).Program
    Disable-NetFirewallRule -Name $rule.Name
    Write-Host "Turned off: allow Python on PUBLIC networks ($app)" -ForegroundColor Green
}
if (-not $public) { Write-Host 'No public-network Python rules to turn off.' }

Write-Host ''
Write-Host 'Done. Now on the computer open ScrewShop > Settings > DEVICES & FRIENDS and scan the QR codes with your iPhone.' -ForegroundColor Cyan
