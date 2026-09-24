# ScrewShop on your iPhone

This computer hosts the studio and saves all files. Keep it awake.

- **At home (same Wi-Fi):** follow "Home Wi-Fi" below.
- **Away from home, or a friend's phone:** use Tailscale instead (see [FRIENDS-SETUP.md](FRIENDS-SETUP.md)). No profile needed.

Your current addresses are always listed on the computer in **Settings → DEVICES & FRIENDS**.

## Home Wi-Fi

1. Open ScrewShop on the computer, then **Settings → DEVICES & FRIENDS**.
2. **If you installed a ScrewShop profile before 2026-09-24, remove it first:** iPhone Settings → General → VPN & Device Management → *ScrewShop Local Connection* → Remove Profile. The old certificate was retired because it had no limits; the new one can only vouch for your home network and this computer.
3. In Safari on the iPhone, open the **profile** link shown in Settings (`http://<computer-ip>:5050/ScrewShop.mobileconfig`) and download it.
4. iPhone Settings → Profile Downloaded → Install.
5. Settings → General → About → Certificate Trust Settings → turn on **ScrewShop Private Local CA** ([Apple instructions](https://support.apple.com/en-us/102390)). You can compare its fingerprint with `data/tls/fingerprint.txt` on the computer.
6. Open the **studio** link (`https://<computer-ip>:5443/barwork`). Plain `http://` links now forward there automatically.
7. Type your name (e.g. "Travis iPhone") and the one-time code shown in Settings on the computer.
8. Safari Share menu → Add to Home Screen ([Apple instructions](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios)).

## Security notes

- Phones and friends can only use ScrewShop over HTTPS. Plain Wi-Fi HTTP only hands out the certificate profile.
- Each device has its own key. Remove one any time in Settings; **UNPAIR ALL DEVICES** locks everyone out.
- Pairing codes work once. Ten wrong tries locks that device out for five minutes.
- The certificate is limited by name constraints: even if its key leaked, it could not impersonate a bank or any public website.
- Windows Firewall: allow ScrewShop's Python on **Private** networks only (Windows Security → Firewall & network protection → Allow an app). Never open router ports. Guest Wi-Fi may block devices from seeing each other.
- Recording on a real iPhone has not been physically tested yet.
