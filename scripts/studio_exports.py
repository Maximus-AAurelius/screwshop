"""Reusable WAVs and complete, aligned DAW stem packs. Original audio is preserved."""
import json
import re
import shutil
import tempfile
import uuid
import wave
import zipfile
import subprocess
from functools import lru_cache
from pathlib import Path

FULL_STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other", "instrumental")


def slug(value):
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value)).strip("-_")[:70] or "Track"


def safe_export_path(store, relative):
    if not isinstance(relative, str) or "\\" in relative or ":" in relative:
        raise ValueError("Invalid export path")
    path = (store.beats_root / relative).resolve()
    if not path.is_relative_to(store.beats_root) or path.suffix.lower() not in {".wav", ".zip", ".mp3"}:
        raise ValueError("Invalid export path")
    return path


@lru_cache(maxsize=1)
def mp3_available():
    try:
        import imageio_ffmpeg
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-encoders'],
                                capture_output=True, text=True, timeout=15,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return result.returncode == 0 and 'libmp3lame' in result.stdout
    except (ImportError, OSError, RuntimeError, subprocess.SubprocessError):
        return False


def save_mp3(store, storage_path, name):
    """Encode a local PCM WAV; never let FFmpeg resolve user-supplied URLs/playlists."""
    source = store.asset('beats', storage_path)
    if source.suffix.lower() != '.wav' or not source.is_file():
        raise ValueError('Choose a saved WAV render to encode')
    try:
        with wave.open(str(source), 'rb') as audio:
            if audio.getnframes() / audio.getframerate() > 1800:
                raise ValueError('Export up to 30 minutes at a time')
    except (wave.Error, EOFError) as exc:
        raise ValueError('MP3 export requires a valid PCM WAV render') from exc
    if not mp3_available():
        raise ValueError('MP3 encoder unavailable on this computer. Use WAV export.')
    import imageio_ffmpeg
    key = 'mp3-' + uuid.uuid4().hex
    relative = 'exports/' + key + '.mp3'
    destination = safe_export_path(store, relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error',
                        '-protocol_whitelist', 'file,pipe', '-i', str(source),
                        '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', str(destination)],
                       capture_output=True, check=True, timeout=300,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError) as exc:
        destination.unlink(missing_ok=True)
        raise ValueError('MP3 encoding failed. Your WAV render is preserved; retry or export WAV.') from exc
    return record_export(store, key, relative, slug(name) + '.mp3')


def _unique(folder, stem, suffix):
    candidate = folder / (stem + suffix)
    n = 2
    while candidate.exists():
        candidate = folder / f"{stem} ({n}){suffix}"
        n += 1
    return candidate


def save_song_mp3(store, storage_path, name, finish=True):
    """Studio EXPORT MP3: finish loudness (-14 LUFS / -1 dBTP), encode 320 kbps, then
    1) add it to SONGS exactly like an imported song, and 2) save a copy in ScrewShop/mp3s.
    The uploaded WAV render is kept; nothing existing is overwritten."""
    import audio_polish
    source = store.asset('beats', storage_path)
    if source.suffix.lower() != '.wav' or not source.is_file():
        raise ValueError('Choose a saved WAV render to encode')
    try:
        with wave.open(str(source), 'rb') as audio:
            if audio.getnframes() / audio.getframerate() > 1800:
                raise ValueError('Export up to 30 minutes at a time')
    except (wave.Error, EOFError) as exc:
        raise ValueError('MP3 export requires a valid PCM WAV render') from exc
    if not mp3_available():
        raise ValueError('MP3 encoder unavailable on this computer. Use WAV export.')
    title = str(name or 'ScrewShop mix').strip()[:160] or 'ScrewShop mix'
    file_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', ' ', title).strip(' .') or 'ScrewShop mix'
    import imageio_ffmpeg
    relative = f"local/mp3/{slug(title)}-{uuid.uuid4().hex[:8]}.mp3"
    destination = store.asset('beats', relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    report = None
    with tempfile.TemporaryDirectory(prefix='mp3-', dir=destination.parent) as temp:
        encode_from = source
        if finish:
            encode_from = Path(temp) / 'finished.wav'
            report = audio_polish.finish_loudness(source, encode_from, sample_rate=44100)
        try:
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y',
                            '-protocol_whitelist', 'file,pipe', '-i', str(encode_from),
                            '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '320k',
                            '-metadata', 'title=' + title, '-metadata', 'encoded_by=ScrewShop', str(destination)],
                           capture_output=True, check=True, timeout=300,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except (OSError, subprocess.SubprocessError) as exc:
            destination.unlink(missing_ok=True)
            raise ValueError('MP3 encoding failed. Your WAV render is preserved; retry or export WAV.') from exc
    folder = store.mp3_root
    folder.mkdir(parents=True, exist_ok=True)
    copy = _unique(folder, file_stem, '.mp3')
    shutil.copyfile(destination, copy)
    row = store.query({"table": "library", "action": "insert", "values": {
        "user_id": "local", "name": title, "storage_path": relative, "bucket": "beats", "source_kind": "imported",
        "mime_type": "audio/mpeg", "exported_from": "studio", "mp3_file": copy.name, "loudness": report}, "single": "required"})
    return {"library": row, "saved_to": "mp3s/" + copy.name, "report": report}


def record_export(store, key, relative, name):
    result = store.query({"table": "exports", "action": "upsert", "values": {"id": key, "relative_path": relative, "download_name": name}, "single": "required"})
    return {"id": result["id"], "saved_to": "Beats/" + relative, "download_url": "/downloads/" + result["id"]}


def save_stem(store, stem_id):
    with store.lock:
        stem = store.query({"table": "stems", "filters": [["id", stem_id]], "single": "required"})
        beat = store.query({"table": "beats", "filters": [["id", stem["beat_id"]]], "single": "required"})
        source = store.asset("stems", stem["storage_path"])
        if not source.is_file():
            raise ValueError("The split audio is missing. Split the source track again.")
        # Each split revision gets a separate destination; existing saved versions stay intact.
        job_id = Path(stem["storage_path"]).parent.name
        key = slug(stem_id + "-" + job_id)
        name = slug(beat.get("label", "Track")) + "-" + slug(stem["kind"]) + ".wav"
        relative = name[:-4] + "-" + slug(job_id) + ".wav"
        dest = safe_export_path(store, relative)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            with tempfile.NamedTemporaryFile(dir=dest.parent, suffix=".tmp", delete=False) as tmp:
                tmp_path = Path(tmp.name)
            try:
                shutil.copyfile(source, tmp_path)
                tmp_path.replace(dest)
            finally:
                tmp_path.unlink(missing_ok=True)
        return record_export(store, key, relative, name)


def save_pack(store, beat_id=None, job=None):
    with store.lock:
        if job is None:
            jobs = store.query({"table": "split_jobs", "filters": [["beat_id", beat_id], ["mode", "full"], ["status", "done"]], "order": ["created_at", False]})
            if not jobs:
                raise ValueError("Run FULL SPLIT first to create a complete sound pack.")
            job = jobs[0]
        if job.get("mode") != "full":
            raise ValueError("Sound packs require a full split")
        beat = store.query({"table": "beats", "filters": [["id", job["beat_id"]]], "single": "required"})
        title = str(beat.get("label") or "Track")
        key = slug("pack-" + job["id"])
        folder_name = slug(title) + "-" + slug(job["id"])
        parent = store.beats_root / "sound packs"
        parent.mkdir(parents=True, exist_ok=True)
        folder = parent / folder_name
        archive = parent / (folder_name + ".zip")
        sources = {kind: store.asset("stems", f"local/{job['beat_id']}/{job['id']}/{kind}.wav") for kind in FULL_STEMS}
        if any(not p.is_file() for p in sources.values()):
            raise ValueError("This full split is incomplete. Run FULL SPLIT again before exporting.")
        info = {}
        for kind, source in sources.items():
            with wave.open(str(source), "rb") as audio:
                info[kind] = {"sample_rate": audio.getframerate(), "channels": audio.getnchannels(), "frames": audio.getnframes(), "bit_depth": audio.getsampwidth() * 8}
        if len({(v["sample_rate"], v["frames"]) for v in info.values()}) != 1:
            raise ValueError("Stem lengths or sample rates do not match; cannot export an aligned pack.")
        if not folder.exists():
            with tempfile.TemporaryDirectory(dir=parent, prefix=".packing-") as temp:
                staging = Path(temp) / folder_name
                staging.mkdir()
                for kind, source in sources.items():
                    shutil.copyfile(source, staging / (kind + ".wav"))
                (staging / "manifest.json").write_text(json.dumps({"title": title, "job_id": job["id"], "source_beat_id": job["beat_id"], "files": info, "alignment": "All files start at source time zero."}, indent=2), encoding="utf-8")
                (staging / "README.txt").write_text("ScrewShop sound pack: " + title + "\n\nImport the WAV files onto separate audio tracks in your DAW.\nAlign every file at the same starting point; no silence has been trimmed.\nNo tempo is embedded or guessed.\n\nUse the six individual stems OR vocals.wav + instrumental.wav.\nDo not layer instrumental.wav over its component stems (it contains them).\n", encoding="utf-8")
                staging.replace(folder)
        if not archive.exists():
            with tempfile.NamedTemporaryFile(dir=parent, suffix=".zip.tmp", delete=False) as tmp:
                tmp_path = Path(tmp.name)
            try:
                with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zipped:
                    for name in [*(kind + ".wav" for kind in FULL_STEMS), "manifest.json", "README.txt"]:
                        zipped.write(folder / name, folder_name + "/" + name)
                tmp_path.replace(archive)
            finally:
                tmp_path.unlink(missing_ok=True)
        result = record_export(store, key, str(archive.relative_to(store.beats_root)).replace("\\", "/"), title + "-sound-pack.zip")
        result["folder"] = "Beats/sound packs/" + folder_name
        return result


def reuse_stem(store, stem_id):
    """Make an independent library copy; deleting/re-splitting the source cannot replace it."""
    with store.lock:
        stem = store.query({"table": "stems", "filters": [["id", stem_id]], "single": "required"})
        beat = store.query({"table": "beats", "filters": [["id", stem["beat_id"]]], "single": "required"})
        revision = stem["storage_path"]
        previous = store.query({"table": "library", "filters": [["source_stem_revision", revision]]})
        if previous:
            return previous[0]
        saved = save_stem(store, stem_id)
        source = store.asset("stems", revision)
        relative = f"local/reused/{uuid.uuid4()}/{slug(stem['kind'])}.wav"
        target = store.asset("beats", relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return store.query({"table": "library", "action": "insert", "values": {"name": str(beat.get("label") or "Track") + " — " + stem["kind"], "storage_path": relative, "source_stem_revision": revision}, "single": "required"})
