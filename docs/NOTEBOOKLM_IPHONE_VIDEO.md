# NotebookLM video: "Connect your iPhone to ScrewShop"

## Setup (about 2 minutes)

1. Go to https://notebooklm.google.com and create a **new notebook** (keep it separate from the sampler video notebook so the two don't mix).
2. **Add sources:**
   - Copy everything under **SOURCE: Connect your iPhone to ScrewShop** (at the bottom of this file) and add it as **Copied text**.
   - Upload the five screenshots from `ScrewShop\docs\notebooklm-iphone\` (01 to 05) as image sources.
3. In the **Studio** panel, click the pencil / **Customize** on **Video Overview**. Choose the **Explainer** format if it asks. Paste **PROMPT A**. If the box won't take it all, use **PROMPT B**.
4. Generate. Watch it once against your own screen. If a step is wrong or missing, say so in the customize box and generate again (for example: "Spend longer on the Certificate Trust Settings switch").

Before you follow the video yourself, do the two computer steps in the source first: **Restart ScrewShop.cmd**, then **Fix Phone Network.cmd**.

---

## PROMPT A (full, paste into the Video Overview customize box)

```
Make a calm, step-by-step tutorial video that gets someone's iPhone connected
to ScrewShop, a music studio that runs on their own Windows computer. The
viewer is a rapper and producer, not a programmer. He tried this before and
Safari just said it couldn't open the page, so start by saying what was wrong
(Windows had his home Wi-Fi marked Public and the firewall had no rule for
ScrewShop) and that one double-click now fixes it.

Follow the source in this exact order and don't skip or merge steps:
Part 1 on the computer: Restart ScrewShop, Fix Phone Network (answer Y for
home Wi-Fi), Phone Check says OK, open Settings, DEVICES & FRIENDS.
Part 2 on the iPhone: same Wi-Fi, scan QR code 1, open in Safari, Allow,
then within 8 minutes Settings > Profile Downloaded > Install, then
Settings > General > About > Certificate Trust Settings and turn on
ScrewShop Private Local CA. Stress that this switch is the step people miss.
Part 3: scan QR code 2, type a name and the pairing code from the computer,
tap CONNECT TO COMPUTER, then Share > Add to Home Screen, pairing first.
Part 4: the troubleshooting table, one line per problem.

Say every button and menu name exactly as written in the source, in the
same words, and show which device the viewer should be looking at
(computer or iPhone) at each step. Use the screenshots for the computer
Settings screen and the iPhone pairing screens. For iPhone Settings screens
that have no screenshot, describe them in words; don't invent pictures of
menus. The real addresses use ports 5050 and 5443. Never read out the test
port numbers or the example pairing codes in the screenshots. Explain the
"why" in one short sentence per part (why the profile, why the trust
switch, why the code works only once). Keep it under 8 minutes.
```

## PROMPT B (short version, in case the box has a character limit)

```
Step-by-step iPhone setup for ScrewShop, for a non-programmer. Order:
computer (Restart, Fix Phone Network, Phone Check, Settings > DEVICES &
FRIENDS), iPhone (scan QR 1 in Safari, Allow, install profile within 8
minutes, turn on the Certificate Trust Settings switch), scan QR 2, name
and code, CONNECT TO COMPUTER, Add to Home Screen. Use exact button names.
Ports 5050 and 5443. Under 8 minutes.
```

---

## SOURCE: Connect your iPhone to ScrewShop

# Connect your iPhone to ScrewShop

## The big picture in plain words

ScrewShop is a music studio that runs on your Windows computer. Your songs, beats and recordings are saved on that computer, not in the cloud. Your iPhone connects to it over your home Wi-Fi and becomes a second screen and a microphone for the same studio.

Three things have to happen once, and then the iPhone just opens ScrewShop from its Home Screen:

1. **The computer has to let the phone in.** Windows' firewall blocks other devices unless the network is marked as your home (Private) network and there's a rule for ScrewShop.
2. **The iPhone has to trust the computer.** ScrewShop uses a secure (https) connection so the phone can use its microphone and keep your work private. Because it's your own computer and not a public website, you install a small certificate profile on the iPhone once and switch on trust for it.
3. **The phone has to be paired.** You type a one-time code shown on the computer. It works for one phone only, then changes, so nobody else can get in.

The computer has to be **on, awake, and running ScrewShop** whenever you use it from the phone.

## Why it didn't work before

When you tried before, Safari said it couldn't open the page. The ScrewShop checker found why: Windows had the home Wi-Fi marked **Public**, and the firewall had no rule letting phones reach ScrewShop's two ports. The ScrewShop program on the computer was running fine; the phone just wasn't allowed in. A new one-click fixer, **Fix Phone Network.cmd**, solves this. ScrewShop also made a fresh, standards-correct security certificate, so any old profile on the phone needs to be removed and the new one installed.

## What you need

- The Windows computer with ScrewShop, connected to your home Wi-Fi.
- An iPhone on a current version of iOS. (iOS 18.0 and 18.1 had an Apple bug that hid the trust switch; anything 18.2 or newer is fine.)
- Both on the **same Wi-Fi network**. Not the Guest network, not cellular data, and no VPN turned on on the phone.

## Part 1: on the computer (about 2 minutes, once)

**Step 1. Restart ScrewShop.** In the ScrewShop folder, double-click **Restart ScrewShop.cmd**. This loads the newest version, including the new certificate and the QR codes.

**Step 2. Let the phone in.** Double-click **Fix Phone Network.cmd**. Windows asks "Do you want to allow this app to make changes?" Click **Yes**. A blue window opens and asks: *Is this YOUR home network (not a cafe, hotel or school)? Type Y to mark it Private.* Type **Y** and press Enter. It then says it allowed ScrewShop's ports 5050 and 5443 on Private networks only, and turned off the old rules that let Python through on public networks. Why: phones can only reach ScrewShop on your home network, and nobody on coffee-shop Wi-Fi can.

**Step 3. Check it.** Double-click **Phone Check.cmd**. At the bottom, under **VERDICT**, it should say **OK: computer side looks ready**. If it says PROBLEM, it tells you exactly what to do.

**Step 4. Open the phone page on the computer.** Open ScrewShop. Click the **settings** button in the top-right corner (the icon with sliders). Scroll down to **DEVICES & FRIENDS**. (Screenshot 01.)

You'll see:
- A big **one-time pairing code**, like four letters/numbers, a dash, four more. Next to it, a **NEW CODE** button.
- **YOUR iPHONE ON HOME WI-FI** with two QR codes:
  - **1 · Install the profile**
  - **2 · Open the studio & pair**
- Under them, the same two addresses written out, starting with "1. profile:" and "2. studio:". The real addresses look like `http://192.168.1.67:5050/ScrewShop.mobileconfig` and `https://192.168.1.67:5443/barwork`. (The screenshots were taken on a test copy of ScrewShop, so they show different port numbers and an example code. Yours will say **5050** and **5443**.)

## Part 2: install the certificate profile on the iPhone (about 2 minutes, once)

**If you tried before, remove the old profile first:** iPhone **Settings** → **General** → **VPN & Device Management** → **ScrewShop Local Connection** → **Remove Profile**.

**Step 5. Scan QR code 1.** Open the iPhone **Camera** app and point it at QR code **1 · Install the profile** on the computer screen. A yellow link appears. Tap it. It must open in **Safari**. Profiles can only be installed from Safari, not Chrome. If you'd rather type, open Safari and type the "1. profile" address exactly.

**Step 6. Allow the download.** Safari says *"This website is trying to download a configuration profile. Do you want to allow this?"* Tap **Allow**. Then tap **Close**.

**Step 7. Install the profile. Do this within 8 minutes.** iPhone deletes a downloaded profile that isn't installed within 8 minutes. Open the iPhone **Settings** app. Near the top, just under your name, tap **Profile Downloaded**. Tap **Install** in the top-right corner. Enter your iPhone passcode. A warning says the profile has a root certificate; that's expected. Tap **Install** again, then **Done**. What it does: it adds the ScrewShop certificate to the phone. It does not manage, track or control the phone.

**Step 8. Turn on trust. This is the step people miss.** In the iPhone **Settings** app go to **General** → **About**. Scroll all the way to the bottom and tap **Certificate Trust Settings**. Under **"Enable full trust for root certificates"**, turn on the switch for **ScrewShop Private Local CA**. Tap **Continue**. Why: Apple installs certificates switched off on purpose. Without this switch, Safari says "This connection is not private" and won't open ScrewShop.

## Part 3: open the studio and pair (about 1 minute)

**Step 9. Scan QR code 2.** Point the Camera at QR code **2 · Open the studio & pair**. Tap the yellow link and open it in **Safari**. Or type the "2. studio" address. It starts with **https** and ends with **:5443/barwork**.

**Step 10. Pair.** The iPhone shows the ScrewShop screen: *"Private studio. Ask the ScrewShop computer for a one-time pairing code."* (Screenshot 02.) Type your name in the first box, for example **Travis iPhone**. In the second box type the **pairing code** that's showing on the computer right now. Tap **CONNECT TO COMPUTER**.

- If it says **"Incorrect or already-used pairing code"** (screenshot 03), the code was typed wrong or was already used. Look at the computer: the code there is the current one. Each code works for one phone only, and **NEW CODE** makes a fresh one.

When it works, the full studio opens on the phone with the tabs **SONGS, NOTEPAD, STUDIO, SCREW, M-AUDIO / SAMPLER** (screenshot 04). On the computer, DEVICES & FRIENDS now lists **Travis iPhone** with when it was paired (screenshot 05), and the pairing code has changed. Why the code works only once: so a code someone overhears or sees later is already useless.

**Step 11. Add it to the Home Screen.** Pair in Safari first, then tap Safari's **Share** button (the square with an arrow pointing up) → **Add to Home Screen** → **Add**. Now ScrewShop has its own icon and opens full screen, already signed in, because iPhone copies Safari's sign-in to the icon when you add it. If the icon ever shows the pairing screen, get a fresh code from the computer and pair again inside it.

**Step 12. First recording.** The first time you record, iPhone asks to use the **microphone**. Tap **Allow**.

## Part 4: if something goes wrong

| What you see | What to do |
|---|---|
| Safari "can't open the page", or it spins and times out | Check the phone is on the **same Wi-Fi** as the computer (not Guest, not cellular) and any VPN is off. On the computer run **Fix Phone Network.cmd** once, then **Phone Check.cmd** and follow its VERDICT. Make sure ScrewShop is running on the computer. |
| "This connection is not private" | Step 8: turn on the trust switch for **ScrewShop Private Local CA**. If it's not listed, remove the profile and install it again (steps 5–7). |
| No **Profile Downloaded** in Settings | It expired after 8 minutes, or another download replaced it. Scan QR code 1 again and install right away. |
| The profile link downloads nothing | It opened in Chrome or another app. Open the link in **Safari**. |
| "Incorrect or already-used pairing code" | Type the code shown on the computer now. Press **NEW CODE** if needed. |
| It worked yesterday, not today | Your router may have given the computer a new address. Open Settings on the computer and scan QR code 2 again. ScrewShop notices the new address by itself within about 30 seconds. To stop it happening, reserve the computer's address in your router app ("DHCP reservation"). |
| A link with the computer's name instead of numbers | iPhones can't use the computer's name. Always use the number address the QR code gives. |

## Safety, in plain words

- Only devices you pair can get in, and you can remove any of them from the computer at any time (**REMOVE** next to the device, or **UNPAIR ALL DEVICES**).
- The certificate can only vouch for your home network and your own computer. It can't be used to fake a bank or any real website.
- ScrewShop only opens on networks you marked as your home network. Nothing is opened on your router, and nothing goes to the cloud.
- Away from home, or a friend's phone? That uses a different, free tool called Tailscale and doesn't need the profile. That's a separate video.

## Screenshot guide

- **01-computer-settings-pairing-code-and-qr.png**: the computer's Settings → DEVICES & FRIENDS: one-time pairing code, NEW CODE button, the two QR codes with their steps, and the two written-out addresses. (Test copy: example code and test port numbers.)
- **02-iphone-pairing-screen.png**: the iPhone after scanning QR code 2: the ScrewShop pairing screen with "your name" and "pairing code" boxes and the CONNECT TO COMPUTER button.
- **03-iphone-wrong-code.png**: what a wrong or already-used code looks like: "Incorrect or already-used pairing code".
- **04-iphone-paired-studio-open.png**: success: the studio open on the iPhone with SAVED ON DISK and all five tabs.
- **05-computer-shows-paired-iphone.png**: back on the computer: the paired phone listed by name under DEVICES & FRIENDS.
