# ScrewShop on your iPhone

Your computer runs the studio and keeps every file. The iPhone is a screen and a microphone for it. The computer has to be on and awake, and ScrewShop has to be running.

- **At home, same Wi-Fi:** follow the steps below. About 5 minutes, once.
- **Away from home, or a friend's phone:** use Tailscale instead (see [FRIENDS-SETUP.md](FRIENDS-SETUP.md)). No profile needed.

## Before you start (once)

1. **Update the iPhone.** Settings → General → Software Update. iOS 18.0 and 18.1 had an Apple bug that hid the certificate trust switch (fixed in 18.2). Anything newer is fine.
2. **On the computer, double-click `Fix Phone Network.cmd`** in the ScrewShop folder and click **Yes** when Windows asks for permission. When it asks whether this is your home network, type **Y**. It does three things:
   - marks your home Wi-Fi as **Private** in Windows (it was Public);
   - allows ScrewShop's two ports (5050 and 5443) **on Private networks only**;
   - turns off old rules that let Python through on Public networks like cafés and hotels.
3. Double-click **`Phone Check.cmd`**. The **VERDICT** at the bottom should say `OK`. If it lists a PROBLEM, do what it says.
4. Remove any old ScrewShop profile from the iPhone if you tried before: iPhone Settings → General → **VPN & Device Management** → *ScrewShop Local Connection* → **Remove Profile**. ScrewShop made a new certificate on 2026-10-10, so an old profile won't work.

## Connect the iPhone

Put the phone on the **same Wi-Fi** as the computer (not Guest Wi-Fi, not cellular, phone VPN off).

On the computer, open ScrewShop → the **settings** button (top right) → scroll to **DEVICES & FRIENDS**. You'll see a one-time **pairing code** and two QR codes.

### Step 1: install the certificate profile (lets Safari trust your computer)

1. Open the iPhone **Camera** and point it at QR code **1 · Install the profile**. Tap the yellow link. It must open in **Safari**; profiles can't be installed from Chrome. (No camera? Type the "1. profile" address into Safari exactly: `http://<computer address>:5050/ScrewShop.mobileconfig`.)
2. Safari says *"This website is trying to download a configuration profile."* Tap **Allow**, then **Close**.
3. Within **8 minutes**, open the iPhone **Settings** app (iPhone deletes a profile that isn't installed in time). Near the top, under your name, tap **Profile Downloaded**, then **Install**. Enter your iPhone passcode, then **Install** again and **Done**.
4. Settings → General → About → scroll to the bottom → **Certificate Trust Settings** → turn on **ScrewShop Private Local CA** → **Continue** ([Apple's instructions](https://support.apple.com/en-us/102390)). **This switch is the step people miss.** Without it Safari says the connection isn't private.

### Step 2: open the studio and pair

1. Point the Camera at QR code **2 · Open the studio & pair** and open it in Safari. (Or type the "2. studio" address: `https://<computer address>:5443/barwork`.)
2. ScrewShop asks for **your name** (e.g. *Travis iPhone*) and the **pairing code** shown on the computer. Tap **CONNECT TO COMPUTER**.
3. The studio opens. The code changes right away, so each code works for one phone only.

### Step 3: put it on the Home Screen

Pair in Safari **first**, then: Safari **Share** button → **Add to Home Screen** → **Add** ([Apple's instructions](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios)). The icon opens ScrewShop full screen and stays signed in. If the icon ever shows the pairing screen, pair again inside it with a fresh code from the computer.

The first time you record, iPhone asks for the **microphone**. Tap **Allow**.

## If it doesn't work

| What you see on the iPhone | Fix |
|---|---|
| "Safari can't open the page" / it spins and times out | Same Wi-Fi as the computer? Run **Fix Phone Network.cmd** once, then **Phone Check.cmd**. Is ScrewShop running (open it on the computer)? Turn off any VPN on the phone. Guest Wi-Fi usually blocks devices from seeing each other. |
| "This connection is not private" | Step 1 part 4: turn on the trust switch for **ScrewShop Private Local CA**. If you can't find it, remove the profile and install it again from QR code 1. |
| No **Profile Downloaded** in Settings | It expired (8 minutes) or was replaced by another download. Scan QR code 1 again and install right away. |
| The profile link downloads nothing | It opened in Chrome or another app. Open it in **Safari**. |
| "Incorrect or already-used pairing code" | Type the code currently on the computer screen. Each code works once. Press **NEW CODE** on the computer if needed. |
| It worked yesterday, not today | The router may have given the computer a new address. Open Settings on the computer and scan QR code 2 again; ScrewShop picks up the new address by itself within about 30 seconds. To stop this happening, reserve the computer's address in your router (often called "DHCP reservation" or "static IP" in the router app). |
| Links with the computer's name (like `Tegridy`) | iPhones can't use that. Always use the number address the QR code gives you. |

On the computer, **Phone Check.cmd** writes `data\phone-check.txt` with a plain-English VERDICT. It's safe to share when asking for help.

## Security notes

- Phones and friends can only use ScrewShop over HTTPS. Plain Wi-Fi HTTP only hands out the certificate profile and forwards everything else to HTTPS.
- Each device has its own key. Remove one any time in Settings; **UNPAIR ALL DEVICES** locks everyone out.
- Pairing codes work once. Ten wrong tries locks that device out for five minutes.
- The certificate can only vouch for home-network addresses and this computer. Even if its key leaked, it could not impersonate a bank or any public website. You can compare its fingerprint with `data/tls/fingerprint.txt` on the computer.
- The firewall rule only opens ScrewShop's two ports, and only on networks you marked Private. Never open router ports.
- Recording on a real iPhone has not been physically tested yet.
