"""Deleted Files: move removed library items out of the way without erasing anything.

The browser waits 10 seconds (the UNDO window) before calling this. Each delete gets
its own folder, "Deleted Files/<date time> - <name>/", holding:
  - item.json: every removed record, so it can be restored by hand;
  - the audio files that nothing else still uses;
  - <title>.md for notepad songs.
A file that a Studio session, sampler pad, kit or another library row still points at
stays where it is, so nothing that is still in use goes silent.
"""
import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, unquote

from local_store import BUCKETS, now

# Rows that may be deleted from the app, and which settings rows count as library items.
DELETABLE = {"library", "takes", "stems", "settings", "songs"}
SETTINGS_ITEMS = ({"folder_type": "pack"}, {"folder_type": "split"}, {"kind": "sampler-beat"}, {"kind": "sampler-kit"})
# Bookkeeping rows that point at audio but never play it; they do not keep a file alive.
NOT_USERS = {"beats", "split_jobs", "polish_jobs", "exports"}
MAX_ITEMS = 200


def _safe_name(text):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", str(text or "")).strip(" .")
    return (text or "Deleted item")[:80]


def _audio_refs(value, found):
    """Collect (bucket, storage_path) pairs from a record and anything nested inside it."""
    if isinstance(value, dict):
        path, bucket = value.get("storage_path"), value.get("bucket")
        if isinstance(path, str) and path:
            found.add((bucket if bucket in BUCKETS else None, path))
        url = value.get("url")
        if isinstance(url, str) and url.startswith("/audio/") and "/" in url[7:]:
            b, name = unquote(url[7:]).split("/", 1)
            if b in BUCKETS:
                found.add((b, name))
        for item in value.values():
            _audio_refs(item, found)
    elif isinstance(value, list):
        for item in value:
            _audio_refs(item, found)
    return found


def _default_bucket(kind):
    return {"takes": "takes", "stems": "stems"}.get(kind, "beats")


def _deletable(kind, row):
    if kind not in DELETABLE:
        return False
    if kind == "settings":
        return any(all(row.get(k) == v for k, v in rule.items()) for rule in SETTINGS_ITEMS)
    return True


def move_to_trash(store, items, label=""):
    """items: [{"table", "id", "with_stems"?}] or [{"note": {...}}] for list-only entries (chops, pads)."""
    if not isinstance(items, list) or not items or len(items) > MAX_ITEMS:
        raise ValueError("Choose something to delete")
    trash_root = Path(getattr(store, "trash_root", store.root / "Deleted Files"))
    removed, notes = [], []
    with store.lock, store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        rows = {}
        for kind, body in db.execute("SELECT kind, body FROM records"):
            record = json.loads(body)
            rows[(kind, record.get("id"))] = record
        targets, pruned_files = {}, {}
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("Invalid delete request")
            if "note" in item:
                if isinstance(item["note"], dict):
                    notes.append(item["note"])
                continue
            kind, rid = item.get("table"), item.get("id")
            row = rows.get((kind, rid))
            if row is None:
                continue  # already gone (another device, or a double click)
            if not _deletable(kind, row):
                raise ValueError("That item can't be deleted from here")
            if kind == "settings" and item.get("file"):
                # One sound out of a pack or split folder: the folder itself stays.
                file = next((f for f in row.get("files") or [] if isinstance(f, dict) and f.get("storage_path") == item["file"]), None)
                if file:
                    pruned_files.setdefault(rid, set()).add(item["file"])
                    targets[("file", rid + ":" + item["file"])] = {**file, "bucket": file.get("bucket") or "stems", "from_folder": row.get("name")}
                continue
            targets[(kind, rid)] = row
            if item.get("with_stems") and kind in {"library", "settings"}:
                # A split song (or its split pack): also remove its stems, split packs, split jobs and source link.
                if kind == "library":
                    beats = {r["id"] for (k, _), r in rows.items() if k == "beats" and r.get("storage_path") == row.get("storage_path")}
                else:
                    beats = {row.get("beat_id")} - {None}
                for (k, other_id), other in rows.items():
                    if (kind == "library" and k in {"beats", "split_jobs"} and (other_id in beats or other.get("beat_id") in beats)) \
                            or (k == "stems" and other.get("beat_id") in beats) \
                            or (k == "settings" and other.get("folder_type") == "split" and other.get("beat_id") in beats):
                        targets[(k, other_id)] = other
        # A deleted stem also leaves the split folders that list it.
        for (kind, _), row in list(targets.items()):
            if kind == "stems":
                for (k, folder_id), folder in rows.items():
                    if k == "settings" and folder.get("folder_type") in {"split", "pack"} and (k, folder_id) not in targets \
                            and any(isinstance(f, dict) and f.get("storage_path") == row.get("storage_path") for f in folder.get("files") or []):
                        pruned_files.setdefault(folder_id, set()).add(row.get("storage_path"))
        for folder_id, paths in pruned_files.items():
            folder = rows[("settings", folder_id)]
            folder["files"] = [f for f in folder.get("files") or [] if not (isinstance(f, dict) and f.get("storage_path") in paths)]
            folder["updated_at"] = now()
            db.execute("UPDATE records SET body=? WHERE kind='settings' AND id=?", (json.dumps(folder), folder_id))
        for kind, rid in targets:
            if kind != "file":
                db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, rid))
        # What still points at audio once these rows are gone.
        remaining = [json.dumps(r) for key, r in rows.items() if key not in targets and key[0] not in NOT_USERS]
        candidates = set()
        for (kind, _), row in targets.items():
            for bucket, path in _audio_refs(row, set()):
                own = row.get("bucket") if row.get("bucket") in BUCKETS else _default_bucket(kind)
                candidates.add((bucket or own, path))
        removed = [{"table": "pack file" if k == "file" else k, "record": r} for (k, _), r in targets.items()]

    if not removed and not notes:
        return {"folder": None, "moved": [], "kept": [], "removed": 0}
    first = (removed[0]["record"] if removed else notes[0])
    name = label or first.get("name") or first.get("title") or first.get("label") or "Deleted item"
    folder = trash_root / f"{datetime.now():%Y-%m-%d %H%M%S} - {_safe_name(name)}"
    n = 2
    while folder.exists():
        folder = folder.with_name(f"{folder.name} ({n})")
        n += 1
    folder.mkdir(parents=True)
    moved, kept = [], []
    for bucket, path in sorted(candidates, key=lambda c: (str(c[0]), c[1])):
        try:
            source = store.asset(bucket, path)
        except ValueError:
            continue
        if not source.is_file():
            continue
        encoded = "/".join(quote(p) for p in path.split("/"))
        if any(path in body or encoded in body for body in remaining):
            kept.append(source.name)
            continue
        dest = folder / bucket / source.name
        k = 2
        while dest.exists():
            dest = dest.with_name(f"{source.stem} ({k}){source.suffix}")
            k += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(dest))
        moved.append({"bucket": bucket, "storage_path": path, "saved_as": str(dest.relative_to(folder))})
    for entry in removed:
        if entry["table"] != "songs":
            continue
        song = entry["record"]
        export = store.root / "Obsidian" / "Songs" / (str(song.get("id")) + ".md")
        try:
            lines = json.loads(song.get("meta") or "{}").get("lines", [])
        except ValueError:
            lines = []
        text = "# " + str(song.get("title", "Untitled")) + "\n\n" + "\n\n".join(l for l in lines if isinstance(l, str)) + "\n"
        (folder / (_safe_name(song.get("title")) + ".md")).write_text(text, encoding="utf-8")
        if export.is_file():
            export.unlink()
    manifest = {"deleted_at": datetime.now().isoformat(timespec="seconds"), "name": name,
                "records": removed, "list_items": notes, "moved_files": moved, "kept_in_use": kept,
                "restore": "Copy the files in this folder back into data/audio/<bucket>/ at their storage_path to restore them."}
    (folder / "item.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {"folder": folder.name, "moved": [m["saved_as"] for m in moved], "kept": kept, "removed": len(removed)}
