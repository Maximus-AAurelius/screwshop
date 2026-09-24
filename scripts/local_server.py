"""ScrewShop local service: private disk storage, audio and an integrated split worker."""
import argparse
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import mimetypes
import os
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from local_store import Store, USER_ID
from local_devices import Devices
import local_tailscale
from studio_exports import save_stem, save_pack, reuse_stem, safe_export_path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "docs"
MAX_AUDIO = 300 * 1024 * 1024


def capabilities():
    missing = [n for n in ("demucs", "torch", "torchaudio", "soundfile", "numpy", "imageio_ffmpeg") if importlib.util.find_spec(n) is None]
    return {"ready": not missing, "missing": missing, "message": "Split processor ready" if not missing else "Split setup is incomplete. Run Setup ScrewShop.cmd on the computer."}


def separate(store, job):
    import numpy as np
    import soundfile as sf
    import imageio_ffmpeg
    beat = store.query({"table": "beats", "filters": [["id", job["beat_id"]]], "single": "required"})
    source = store.asset("beats", beat["storage_path"])
    model = "htdemucs" if job["mode"] == "quick" else "htdemucs_6s"
    with tempfile.TemporaryDirectory(prefix="screwshop-") as tmp:
        # Decode once with our bundled FFmpeg; Demucs then reads a predictable WAV.
        wav = Path(tmp) / "source.wav"
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-i", str(source), "-t", "1801", "-ar", "44100", "-ac", "2", str(wav)], check=True, capture_output=True, timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if sf.info(wav).duration > 1800:
            raise ValueError("Split tracks up to 30 minutes. Trim this recording before splitting.")
        args = [sys.executable, str(ROOT / "scripts/separate_audio.py"), "--model", model, "--output", tmp]
        environment = {**os.environ, "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "TORCH_HOME": str(store.root / "models")}
        logs = store.root / "logs"
        logs.mkdir(exist_ok=True)
        with (logs / (job["id"] + ".log")).open("wb") as log:
            run = subprocess.run(args + [str(wav)], stdout=log, stderr=subprocess.STDOUT, env=environment, timeout=7200, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if run.returncode:
            raise RuntimeError("Audio separation failed. The job log is saved in ScrewShop/data/logs; check model download and available memory.")
        output = Path(tmp) / model / "source"
        names = ["vocals", "no_vocals"] if job["mode"] == "quick" else ["vocals", "drums", "bass", "guitar", "piano", "other"]
        if any(not (output / (name + ".wav")).is_file() for name in names):
            raise RuntimeError("Split did not produce all expected audio files")
        if job["mode"] == "full":
            instrumental = None
            for name in names[1:]:
                audio, rate = sf.read(output / (name + ".wav"), dtype="float32", always_2d=True)
                instrumental = audio if instrumental is None else instrumental + audio
            instrumental /= max(1.0, float(np.max(np.abs(instrumental))))
            sf.write(output / "instrumental.wav", instrumental, rate)
            names.append("instrumental")
        for name in names:
            kind = "instrumental" if name == "no_vocals" else name
            relative = f"local/{job['beat_id']}/{job['id']}/{kind}.wav"
            dest = store.asset("stems", relative)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(output / (name + ".wav"), dest)
            store.query({"table": "stems", "action": "upsert", "values": {"beat_id": job["beat_id"], "kind": kind, "storage_path": relative}})
        if job["mode"] == "full":
            save_pack(store, job=job)


def worker(store, stop):
    # Interrupted jobs are made visible and retryable, never silently left processing.
    for job in store.query({"table": "split_jobs", "filters": [["status", "processing"]]}):
        store.query({"table": "split_jobs", "action": "update", "filters": [["id", job["id"]]], "values": {"status": "error", "error_message": "Computer or processor restarted. Tap split again to retry."}})
    while not stop.is_set():
        job = store.claim_job() if capabilities()["ready"] else None
        if job:
            try:
                separate(store, job)
                values = {"status": "done", "error_message": None}
            except Exception as exc:
                values = {"status": "error", "error_message": str(exc)[:500]}
            store.query({"table": "split_jobs", "action": "update", "filters": [["id", job["id"]]], "values": values})
        else:
            stop.wait(2)


class Handler(BaseHTTPRequestHandler):
    server_version = "ScrewShop"

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
        super().end_headers()

    def json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def valid_host(self):
        host = self.headers.get("Host", "")
        return host in self.server.allowed_hosts

    def is_local(self):
        return ipaddress.ip_address(self.client_address[0]).is_loopback

    def is_secure(self):
        return isinstance(self.connection, ssl.SSLSocket)

    def device(self):
        """The paired device making this request (phones/friends only ever over HTTPS)."""
        if not self.is_secure():
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            # "screwshop" is the shared cookie phones got before per-device logins; it maps to the migrated legacy entry.
            name = "screwshop_device" if "screwshop_device" in cookie else "screwshop"
            token = cookie[name].value if name in cookie else ""
        except Exception:
            return None
        return self.server.devices.find(token)

    def authenticated(self):
        return self.is_local() or self.device() is not None

    def https_redirect(self):
        host = self.headers.get("Host", "").rsplit(":", 1)[0]
        port = self.server.https_port
        if not port:
            return self.json({"error": {"message": "Phone access needs the secure https address"}}, 403)
        self.send_response(308)
        self.send_header("Location", f"https://{host}:{port}{self.path}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self, cap):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > cap:
            raise ValueError("File too large (maximum 300 MB for audio)")
        self.connection.settimeout(120)
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("Incomplete upload")
        return data

    def do_POST(self):
        if not self.valid_host():
            return self.json({"error": {"message": "Invalid host"}}, 403)
        origin = self.headers.get("Origin")
        expected = ("https://" if isinstance(self.connection, ssl.SSLSocket) else "http://") + self.headers["Host"]
        if origin and origin != expected:
            return self.json({"error": {"message": "Cross-origin write denied"}}, 403)
        if self.headers.get("X-ScrewShop") != "1":
            return self.json({"error": {"message": "Missing request header"}}, 403)
        if not self.is_local() and not self.is_secure():
            return self.json({"error": {"message": "Use the secure https address for phones and friends"}}, 403)
        path = urlsplit(self.path).path
        devices = self.server.devices
        try:
            if path == "/api/pair":
                req = json.loads(self.read_body(1024))
                address, now = self.client_address[0], time.monotonic()
                with devices.lock:
                    attempts, last = devices.attempts.get(address, (0, 0))
                    if now - last > 300:
                        attempts = 0
                    devices.failures = [t for t in devices.failures if now - t < 600]
                    if attempts >= 10 or len(devices.failures) >= 30:
                        return self.json({"error": {"message": "Too many tries. Wait a few minutes, then make a NEW CODE on the computer."}}, 429)
                    if not devices.check_code(req.get("code", "")):
                        devices.attempts[address] = (attempts + 1, now)
                        devices.failures.append(now)
                        return self.json({"error": {"message": "Incorrect or already-used pairing code"}}, 401)
                    devices.attempts.pop(address, None)
                    token = devices.pair(req.get("name"))
                self.send_response(200)
                self.send_header("Set-Cookie", f"screwshop_device={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000; Secure")
                self.send_header("Content-Length", "2")
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")
                return
            if path == "/api/devices":
                if not self.is_local():
                    return self.json({"error": {"message": "Manage devices from the computer running ScrewShop"}}, 403)
                req = json.loads(self.read_body(4096))
                action = req.get("action")
                if action == "remove":
                    devices.remove(str(req.get("id", "")))
                elif action == "remove_all":
                    devices.remove_all()
                elif action == "new_code":
                    devices.new_code()
                else:
                    raise ValueError("Unknown device action")
                return self.json({"data": self.device_overview(), "error": None})
            if not self.authenticated():
                return self.json({"error": {"message": "Pair this phone with the computer first"}}, 401)
            if path == "/api/export":
                req = json.loads(self.read_body(4096))
                if req.get("kind") == "stem":
                    result = save_stem(self.server.store, req.get("stem_id"))
                elif req.get("kind") == "pack":
                    result = save_pack(self.server.store, beat_id=req.get("beat_id"))
                elif req.get("kind") == "reuse":
                    result = reuse_stem(self.server.store, req.get("stem_id"))
                else:
                    raise ValueError("Choose a WAV, full sound pack, or library copy")
                return self.json({"data": result, "error": None})
            if path == "/api/query":
                query = json.loads(self.read_body(2 * 1024 * 1024))
                if query.get("table") == "exports" and query.get("action", "select") != "select":
                    raise ValueError("Export records are managed by the studio")
                if query.get("table") == "split_jobs" and query.get("action") in {"insert", "upsert"} and not capabilities()["ready"]:
                    raise ValueError(capabilities()["message"])
                if query.get("table") == "split_jobs" and query.get("action") in {"update", "delete"}:
                    raise ValueError("Only the processor can change job status")
                return self.json({"data": self.server.store.query(query), "error": None})
            if path.startswith("/api/audio/"):
                bucket, name = unquote(path[len("/api/audio/"):]).split("/", 1)
                dest = self.server.store.asset(bucket, name)
                audio = self.read_body(MAX_AUDIO)
                dest.parent.mkdir(parents=True, exist_ok=True)
                fd, temp = tempfile.mkstemp(dir=dest.parent, suffix=".upload")
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(audio)
                    os.replace(temp, dest)
                finally:
                    if os.path.exists(temp):
                        os.unlink(temp)
                return self.json({"data": {"path": name}, "error": None})
            if path == "/api/audio-remove":
                # Keep audio files as recoverable originals. Removing a library row never erases a source used by another tab.
                self.read_body(65536)
                return self.json({"data": [], "error": None})
            return self.json({"error": {"message": "Unknown endpoint"}}, 404)
        except (ValueError, KeyError, TypeError) as exc:
            self.json({"error": {"message": str(exc)}}, 400)
        except Exception:
            self.json({"error": {"message": "Local save failed. Check disk space and the server log."}}, 500)

    def device_overview(self):
        devices, server = self.server.devices, self.server
        hosts = sorted({h.rsplit(":", 1)[0] for h in server.allowed_hosts} - {"localhost", "127.0.0.1"})
        port = server.https_port
        lan = [h for h in hosts if not h.endswith(".ts.net") and not h.startswith("100.") and h[0].isdigit()]
        return {
            "code": devices.code[:4] + "-" + devices.code[4:],
            "devices": devices.listing(),
            "phone_links": [f"https://{h}:{port}/barwork" for h in lan] if port else [],
            "profile_links": [f"http://{h}:{server.server_port}/ScrewShop.mobileconfig" for h in lan],
            "tailscale_link": f"https://{server.tailscale_name}:{port}/barwork" if port and server.tailscale_name else None,
            "tailscale_cert": bool(server.tailscale_cert),
        }

    def do_GET(self):
        if not self.valid_host():
            return self.json({"error": {"message": "Invalid host"}}, 403)
        path = unquote(urlsplit(self.path).path)
        if path == "/ScrewShop.mobileconfig":
            return self.file(self.server.store.root / "tls/ScrewShop.mobileconfig")
        if path == "/api/status":
            paired = self.authenticated()
            return self.json({"project": "ScrewShop", "paired": paired, "local": self.is_local(), "secure": self.is_secure() or self.is_local(), "storage": "local", "worker": capabilities() if paired else None})
        if not self.is_local() and not self.is_secure():
            # Plain Wi-Fi HTTP only hands out the iPhone certificate profile; everything else moves to HTTPS.
            return self.https_redirect()
        if path == "/api/devices":
            if not self.is_local():
                return self.json({"error": {"message": "Manage devices from the computer running ScrewShop"}}, 403)
            return self.json({"data": self.device_overview(), "error": None})
        if path.startswith("/downloads/"):
            if not self.authenticated():
                return self.json({"error": {"message": "Pair this device first"}}, 401)
            try:
                saved = self.server.store.query({"table": "exports", "filters": [["id", path[len('/downloads/'):]]], "single": "required"})
                return self.file(safe_export_path(self.server.store, saved["relative_path"]), download_name=saved["download_name"])
            except (ValueError, KeyError):
                return self.json({"error": {"message": "Export not found"}}, 404)
        if path.startswith("/api/"):
            return self.json({"error": {"message": "Unknown endpoint"}}, 404)
        if path.startswith("/audio/"):
            if not self.authenticated():
                return self.json({"error": {"message": "Pair this device first"}}, 401)
            try:
                bucket, name = path[len("/audio/"):].split("/", 1)
                return self.file(self.server.store.asset(bucket, name))
            except ValueError:
                return self.json({"error": {"message": "Invalid path"}}, 400)
        if path in {"/", "/barwork", "/screwshop", "/index.html", "/barwork.html"}:
            target = WEB / "barwork.html"
        else:
            target = (WEB / path.lstrip("/")).resolve()
        if not target.is_relative_to(WEB.resolve()) or any(part.startswith(".") for part in target.relative_to(WEB).parts) or target.suffix.lower() not in {".html", ".js", ".css", ".json", ".webmanifest", ".png", ".jpg", ".svg", ".woff2", ".ico"}:
            return self.json({"error": {"message": "Not found"}}, 404)
        self.file(target)

    def file(self, path, download_name=None):
        if not path.is_file():
            return self.json({"error": {"message": "Not found"}}, 404)
        size = path.stat().st_size
        start, end, partial = 0, size - 1, False
        range_header = self.headers.get("Range")
        if range_header:
            try:
                unit, span = range_header.split("=")
                a, b = span.split("-")
                if unit != "bytes":
                    raise ValueError()
                if not a:
                    start = max(0, size - int(b))
                else:
                    start = int(a)
                    end = min(size - 1, int(b)) if b else size - 1
                if start < 0 or start > end:
                    raise ValueError()
                partial = True
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(206 if partial else 200)
        if download_name:
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(download_name, safe=""))
        self.send_header("Content-Type", {".js": "text/javascript", ".webmanifest": "application/manifest+json", ".mobileconfig": "application/x-apple-aspen-config"}.get(path.suffix, mimetypes.guess_type(path.name)[0] or "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with path.open("rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        # Do not log filenames, query strings or pairing credentials.
        if len(args) > 1 and str(args[1]).startswith("5"):
            print("Local request failed", flush=True)


def make_server(data, port=5050, lan=False, store=None, devices=None, tailscale=None, https_port=None):
    store = store or Store(data, beats_root=ROOT / "Beats" if Path(data).resolve() == (ROOT / "data").resolve() else None)
    (store.beats_root / "sound packs").mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.store = store
    if devices is None:
        devices = Devices(store.root)
    if not hasattr(devices, "attempts"):
        devices.attempts, devices.failures = {}, []
    server.devices = devices
    port = server.server_port
    hosts = {"localhost", "127.0.0.1"}
    if lan:
        hosts.add(socket.gethostname())
        hosts.update(socket.gethostbyname_ex(socket.gethostname())[2])
        if tailscale:
            hosts.update(tailscale.get("ips") or [])
            if tailscale.get("name"):
                hosts.add(tailscale["name"])
    server.allowed_hosts = {f"{host}:{port}" for host in hosts}
    server.tailscale_name = (tailscale or {}).get("name")
    server.tailscale_cert = None
    server.https_port = https_port
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5050)
    parser.add_argument("--lan", action="store_true", help="Enable paired devices on trusted home Wi-Fi")
    parser.add_argument("--https-port", type=int, help="Also serve HTTPS for iPhone recording")
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    tailscale = local_tailscale.info() if args.lan else None
    server = make_server(args.data, args.port, args.lan, tailscale=tailscale, https_port=args.https_port)
    secure_server = None
    if args.https_port:
        from local_tls import prepare
        tls = prepare(server.store.root, extra_names=[tailscale["name"]] if tailscale and tailscale.get("name") else [], extra_ips=(tailscale or {}).get("ips") or [])
        secure_server = make_server(args.data, args.https_port, args.lan, store=server.store, devices=server.devices, tailscale=tailscale, https_port=args.https_port)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(tls / 'server.pem', tls / 'server-key.pem')

        def load_tailscale_cert():
            # A real, publicly trusted certificate for friends on Tailscale (no profile to install).
            pair = local_tailscale.certificate(tailscale["name"], tls) if tailscale and tailscale.get("name") else None
            if pair:
                ts_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ts_context.minimum_version = ssl.TLSVersion.TLSv1_2
                ts_context.load_cert_chain(pair[0], pair[1])
                server.tailscale_cert = secure_server.tailscale_cert = ts_context

        def pick_certificate(sock, name, _context):
            if name and secure_server.tailscale_cert and name.lower() == (tailscale or {}).get("name"):
                sock.context = secure_server.tailscale_cert

        def renew_forever():
            while True:
                try:
                    load_tailscale_cert()
                except Exception:
                    pass
                time.sleep(12 * 3600)

        context.sni_callback = pick_certificate
        if tailscale:
            threading.Thread(target=renew_forever, daemon=True).start()
        secure_server.socket = context.wrap_socket(secure_server.socket, server_side=True)
        threading.Thread(target=secure_server.serve_forever, daemon=True).start()
        print(f"Private HTTPS: https://localhost:{args.https_port}/barwork", flush=True)
        if tailscale and tailscale.get("name"):
            print(f"Friends on Tailscale: https://{tailscale['name']}:{args.https_port}/barwork", flush=True)
    stop = threading.Event()
    threading.Thread(target=worker, args=(server.store, stop), daemon=True).start()
    print(f"ScrewShop: http://localhost:{args.port}/barwork", flush=True)
    print(f"Local files: {server.store.root}", flush=True)
    print(capabilities()["message"], flush=True)
    if args.lan:
        print("Phone addresses: " + ", ".join("http://" + h + "/barwork" for h in sorted(server.allowed_hosts) if not h.startswith(("localhost", "127."))), flush=True)
        print("Pair phones and friends from Settings > DEVICES & FRIENDS on this computer.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        if secure_server:
            secure_server.shutdown()
            secure_server.server_close()


if __name__ == "__main__":
    main()
