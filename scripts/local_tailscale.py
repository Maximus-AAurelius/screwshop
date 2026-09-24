"""Optional Tailscale support: lets invited friends reach this computer privately.

If Tailscale is installed and signed in, we learn this computer's Tailscale name
and addresses, and ask Tailscale for a real HTTPS certificate for that name
(needs "HTTPS Certificates" turned on in the Tailscale admin console). Nothing
here opens router ports or talks to the internet directly.
"""
import json
import shutil
import subprocess
from pathlib import Path

CANDIDATES = [r"C:\Program Files\Tailscale\tailscale.exe", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def cli():
    found = shutil.which("tailscale")
    if found:
        return found
    return next((c for c in CANDIDATES if Path(c).is_file()), None)


def info():
    """Return {'name': 'pc.tailnet.ts.net', 'ips': [...]} or None if Tailscale isn't running."""
    exe = cli()
    if not exe:
        return None
    try:
        run = subprocess.run([exe, "status", "--json"], capture_output=True, timeout=15, creationflags=NO_WINDOW)
        if run.returncode:
            return None
        status = json.loads(run.stdout.decode("utf-8", "replace"))
        me = status.get("Self") or {}
        if not me.get("Online", True) or status.get("BackendState") not in (None, "Running"):
            return None
        name = (me.get("DNSName") or "").rstrip(".").lower()
        ips = [ip for ip in me.get("TailscaleIPs") or [] if ":" not in ip]
        return {"name": name or None, "ips": ips}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def certificate(name, folder):
    """Fetch/renew the Let's Encrypt certificate Tailscale issues for this computer's name."""
    exe = cli()
    if not exe or not name or not name.endswith(".ts.net"):
        return None
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    cert, key = folder / "tailscale.crt", folder / "tailscale.key"
    try:
        run = subprocess.run([exe, "cert", "--cert-file", str(cert), "--key-file", str(key), name], capture_output=True, timeout=90, creationflags=NO_WINDOW)
        if run.returncode == 0 and cert.is_file() and key.is_file():
            return cert, key
    except (OSError, subprocess.SubprocessError):
        pass
    return None
