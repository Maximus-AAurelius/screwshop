# Let a friend use ScrewShop (free, private, from anywhere)

**Plain English:** Tailscale builds a private road from your friend's phone or laptop to your computer. Nobody else can drive on it, no router ports get opened, and your music never leaves your computer. Your friend opens the same studio you use. Your computer has to be on.

Cost: $0. Tailscale's free Personal plan covers up to 6 users, and sharing one computer with outside friends is included.

## One-time setup on your computer

1. Install Tailscale for Windows from https://tailscale.com/download and sign in (use your own Google account, or a dedicated one you control).
2. In the Tailscale admin console (https://login.tailscale.com/admin):
   - **DNS page** → make sure **MagicDNS** is on → under **HTTPS Certificates** click **Enable HTTPS**.
     Heads-up: Tailscale says machine names become public in certificate logs. Name the computer something plain (Machines → your PC → Edit machine name, e.g. `studio-pc`), not your full name.
   - **Access controls page** → limit friends to ScrewShop only. Replace the `"grants"` section with:

     ```json
     "grants": [
       // You and your own devices: full access, like before.
       {"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
       // Friends you share with: only ScrewShop's secure port.
       {"src": ["autogroup:shared"], "dst": ["*"], "ip": ["5443"]}
     ]
     ```
3. Restart ScrewShop (close it, then open the desktop shortcut). Open **Settings → DEVICES & FRIENDS**. You should see a **FRIENDS ANYWHERE** link like `https://studio-pc.your-tailnet.ts.net:5443/barwork` with "Real HTTPS certificate active".
4. Windows Firewall: if friends can't connect, allow ScrewShop's Python for **Private** networks (Windows Security → Firewall & network protection → Allow an app). Tailscale's connection counts as its own network; don't open anything on Public networks.

## Adding a friend

1. Admin console → **Machines** → your computer → **⋯ → Share** → send the invite link to your friend.
2. Friend installs Tailscale (phone or computer), signs in with **their own** account, and accepts the invite.
3. Friend opens the FRIENDS ANYWHERE link from your Settings panel. No certificate profile needed; it's a real HTTPS certificate.
4. On your computer, Settings → DEVICES & FRIENDS shows a one-time code (like `BNCN-QPY5`). Text it to that one friend. They type their name and the code. The code changes right after they connect.
5. Their device now shows in your list with their name. **REMOVE** locks them out instantly. **UNPAIR ALL DEVICES** locks everyone out.

To cut off a friend completely, also remove the share in Tailscale (Machines → your PC → Share → remove).

## What friends can and can't do

- They use the whole studio: songs, write, studio, screw, beats, packs. Changes save on your computer.
- They cannot see or manage devices, pairing codes, or anything else on your computer or network.
- Two people editing the same STUDIO session at the same moment: the last save wins. Take turns on a session, or each make your own tracks.

## Why not a shared Gmail / Google Drive?

- One shared login means everyone has the same password: no way to tell who did what, and no way to remove one person.
- Never put the `data` folder in Google Drive or OneDrive. Sync tools copying the database while two people save can corrupt it. Drive is fine for passing exported WAVs and sound-pack ZIPs back and forth.
