"""Per-device logins for phones and friends.

Each paired device gets its own random key. Only a SHA-256 hash of the key is
stored (data/devices.json), so reading that file does not let anyone log in.
Pairing codes work once and are replaced after every successful pairing.
Devices are listed, renamed and removed only from the computer itself.
"""
import hashlib
import json
import secrets
import threading
import time
from pathlib import Path

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
CODE_LENGTH = 8


def _hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_code(code):
    return "".join(ch for ch in str(code).upper() if ch in CODE_ALPHABET)


def pretty_code(code):
    return code[:4] + "-" + code[4:]


class Devices:
    def __init__(self, root):
        self.root = Path(root)
        self.path = self.root / "devices.json"
        self.code_path = self.root / "phone-pairing-code.txt"
        self.lock = threading.RLock()
        self.devices = []
        self.dirty_seen = 0.0
        with self.lock:
            if self.path.exists():
                self.devices = json.loads(self.path.read_text(encoding="utf-8")).get("devices", [])
            else:
                # Phones paired before this update shared one secret; keep them working as one entry until removed.
                legacy = self.root / "device-session-secret.txt"
                if legacy.exists():
                    token = legacy.read_text(encoding="utf-8").strip()
                    if token:
                        self.devices.append({"id": secrets.token_hex(6), "name": "Paired before update", "token_hash": _hash(token), "created": time.time(), "last_seen": None, "legacy": True})
                self._save()
            code = normalize_code(self.code_path.read_text(encoding="utf-8")) if self.code_path.exists() else ""
            if len(code) != CODE_LENGTH:
                self.new_code()

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"devices": self.devices}, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    @property
    def code(self):
        return normalize_code(self.code_path.read_text(encoding="utf-8"))

    def new_code(self):
        with self.lock:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            self.code_path.write_text(pretty_code(code), encoding="utf-8")
            return pretty_code(code)

    def check_code(self, supplied):
        return secrets.compare_digest(normalize_code(supplied), self.code)

    def pair(self, name):
        name = " ".join(str(name or "").split())[:40] or "Unnamed device"
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.devices.append({"id": secrets.token_hex(6), "name": name, "token_hash": _hash(token), "created": time.time(), "last_seen": time.time()})
            self._save()
            self.new_code()  # one-time codes
        return token

    def find(self, token):
        if not token:
            return None
        digest = _hash(token)
        with self.lock:
            for device in self.devices:
                if secrets.compare_digest(device["token_hash"], digest):
                    now = time.time()
                    if not device.get("last_seen") or now - device["last_seen"] > 300:
                        device["last_seen"] = now
                        self._save()
                    return device
        return None

    def listing(self):
        with self.lock:
            return [{k: d.get(k) for k in ("id", "name", "created", "last_seen", "legacy")} for d in self.devices]

    def remove(self, device_id):
        with self.lock:
            before = len(self.devices)
            self.devices = [d for d in self.devices if d["id"] != device_id]
            self._save()
            return before != len(self.devices)

    def remove_all(self):
        with self.lock:
            self.devices = []
            self._save()
            legacy = self.root / "device-session-secret.txt"
            if legacy.exists():
                legacy.write_text(secrets.token_urlsafe(32), encoding="utf-8")  # retire the old shared key
            self.new_code()
