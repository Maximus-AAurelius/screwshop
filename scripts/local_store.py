"""Disk-backed single-owner studio. No cloud credentials or dependencies."""
import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

TABLES = {"songs", "beats", "takes", "stems", "library", "pads", "split_jobs", "polish_jobs", "settings", "exports"}
BUCKETS = {"beats", "takes", "stems"}
USER_ID = "local"


def now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, root, beats_root=None):
        self.root = Path(root).resolve()
        self.beats_root = Path(beats_root or self.root / "exports" / "Beats").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(kind,id))")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.root / "screwshop.sqlite3", timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def asset(self, bucket, name):
        if bucket not in BUCKETS or not isinstance(name, str) or not name:
            raise ValueError("Invalid audio path")
        if "\\" in name or ":" in name or any(p in ("", ".", "..") for p in name.split("/")):
            raise ValueError("Invalid audio path")
        base = (self.root / "audio" / bucket).resolve()
        path = (base / name).resolve()
        if not path.is_relative_to(base):
            raise ValueError("Invalid audio path")
        if path.suffix.lower() not in {".wav", ".mp3", ".m4a", ".webm", ".ogg", ".opus", ".flac", ".aac", ".mp4", ".aif", ".aiff"}:
            raise ValueError("Unsupported audio file type")
        return path

    def query(self, q):
        kind, action = q.get("table"), q.get("action", "select")
        if kind not in TABLES or action not in {"select", "insert", "upsert", "update", "delete"}:
            raise ValueError("Unsupported operation")
        filters = q.get("filters", [])
        if not isinstance(filters, list) or any(not isinstance(f, list) or len(f) != 2 for f in filters):
            raise ValueError("Invalid filters")
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = [json.loads(r[0]) for r in db.execute("SELECT body FROM records WHERE kind=?", (kind,))]
            found = [r for r in rows if all(r.get(k) == v for k, v in filters)]
            if action in {"insert", "upsert"}:
                values = q.get("values")
                values = values if isinstance(values, list) else [values]
                result = []
                for supplied in values:
                    if not isinstance(supplied, dict):
                        raise ValueError("Expected a record")
                    value = dict(supplied)
                    keys = {"pads": ["user_id", "pad_index"], "stems": ["beat_id", "kind"]}.get(kind, ["id"])
                    value["user_id"] = USER_ID
                    previous = next((r for r in rows if all(k in value and r.get(k) == value[k] for k in keys)), None)
                    if previous and action == "insert":
                        raise ValueError("Record already exists")
                    if kind == "split_jobs":
                        if value.get("mode") not in {"quick", "full"}:
                            raise ValueError("Choose quick or full split")
                        beat = db.execute("SELECT body FROM records WHERE kind='beats' AND id=?", (value.get("beat_id"),)).fetchone()
                        if not beat or not self.asset("beats", json.loads(beat[0]).get("storage_path", "")).is_file():
                            raise ValueError("Source audio is missing; import the track first")
                        active = next((r for r in rows if r.get("beat_id") == value["beat_id"] and r.get("status") in {"pending", "processing"}), None)
                        if active:
                            result.append(active)
                            continue
                        value.update(status="pending", error_message=None)
                    value = {**(previous or {}), **value}
                    value["id"] = previous["id"] if previous else str(value.get("id") or uuid.uuid4())
                    if len(value["id"]) > 100 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in value["id"]):
                        raise ValueError("Invalid record ID")
                    value.setdefault("created_at", now())
                    value["updated_at"] = now()
                    db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?)", (kind, value["id"], json.dumps(value)))
                    rows = [r for r in rows if r["id"] != value["id"]] + [value]
                    result.append(value)
            elif action == "update":
                if not filters or not isinstance(q.get("values"), dict):
                    raise ValueError("Updates require a filter and record")
                result = []
                for old in found:
                    value = {**old, **q["values"], "id": old["id"], "user_id": USER_ID, "updated_at": now()}
                    db.execute("UPDATE records SET body=? WHERE kind=? AND id=?", (json.dumps(value), kind, old["id"]))
                    result.append(value)
            elif action == "delete":
                if not filters:
                    raise ValueError("Deletion requires a filter")
                for old in found:
                    db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, old["id"]))
                result = found
            else:
                result = found
            order = q.get("order")
            if order:
                result.sort(key=lambda r: (r.get(order[0]) is None, r.get(order[0], "")), reverse=not order[1])
            if q.get("limit") is not None:
                result = result[:max(0, min(int(q["limit"]), 10000))]
        if kind == "songs" and action in {"insert", "upsert", "update"}:
            self.export_songs(result)
        if q.get("single"):
            if len(result) > 1 or (not result and q["single"] == "required"):
                raise ValueError("Expected one record")
            return result[0] if result else None
        return result

    def export_songs(self, songs):
        folder = self.root / "Obsidian" / "Songs"
        folder.mkdir(parents=True, exist_ok=True)
        for song in songs:
            try:
                lines = json.loads(song.get("meta", "{}" )).get("lines", [])
                if not isinstance(lines, list) or not all(isinstance(s, str) for s in lines):
                    continue
                path = folder / (song["id"] + ".md")
                temp = path.with_suffix(".tmp")
                with self.lock:
                    temp.write_text("# " + str(song.get("title", "Untitled")) + "\n\n" + "\n\n".join(lines) + "\n", encoding="utf-8")
                    temp.replace(path)
            except (ValueError, TypeError):
                continue

    def claim_job(self):
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = [json.loads(r[0]) for r in db.execute("SELECT body FROM records WHERE kind='split_jobs'")]
            pending = sorted((r for r in rows if r.get("status") == "pending"), key=lambda r: r["created_at"])
            if not pending:
                return None
            job = pending[0]
            job.update(status="processing", updated_at=now())
            db.execute("UPDATE records SET body=? WHERE kind='split_jobs' AND id=?", (json.dumps(job), job["id"]))
            return job
