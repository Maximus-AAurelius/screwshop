"""Private, measured song finishing. Every result is a new file; sources are untouched.

This conditions a finished mix, rather than separating or remixing its instruments.
Filter semantics: https://ffmpeg.org/ffmpeg-filters.html (loudnorm, acompressor,
highpass, equalizer, deesser). True peak / programme loudness measurement follows
FFmpeg's EBU R128 implementation. -14 LUFS is this app's listening target, not
EBU R128's broadcast target. Gain is reduced when peaks or noise headroom require
it, so reaching a loudness number never requires flattening the song.
"""
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from local_store import now

MAX_BYTES = 300 * 1024 * 1024
MAX_SECONDS = 1800
PROCESS_TIMEOUT = 600
TARGET_LUFS = -14.0
TRUE_PEAK = -1.0
# A little margin for output resampling and 24-bit quantisation.
RENDER_PEAK = -1.3
PRESETS = {"balanced", "vocal", "warm", "engineer"}
SPLIT_TIMEOUT = 7200
ROOT = Path(__file__).resolve().parent.parent
STRENGTHS = {"gentle", "standard"}


def capabilities():
    missing = [name for name in ("numpy", "soundfile", "imageio_ffmpeg")
               if importlib.util.find_spec(name) is None]
    return {"ready": not missing, "missing": missing,
            "message": "Song polish ready" if not missing else "Song polish needs the local audio setup on the computer."}


def audio_url(bucket, path):
    return "/audio/" + bucket + "/" + quote(path, safe="/")


def source_path(store, bucket, storage_path):
    if bucket not in {"beats", "takes", "stems"}:
        raise ValueError("Choose an audio file from Songs")
    # Store.asset rejects URLs, absolute paths, traversal and escaping symlinks.
    source = store.asset(bucket, storage_path)
    if not source.is_file():
        raise ValueError("That song's audio file is missing. Upload it again.")
    if source.stat().st_size > MAX_BYTES:
        raise ValueError("Polish files up to 300 MB. Trim or export this song first.")
    if not source.stat().st_size:
        raise ValueError("Choose a song containing audio")
    return source


def jobs(store):
    return store.query({"table": "polish_jobs", "order": ["created_at", False], "limit": 100})


def _update(store, job_id, **values):
    return store.query({"table": "polish_jobs", "action": "update",
                        "filters": [["id", job_id]], "values": values, "single": "required"})


def enqueue(store, request):
    if not isinstance(request, dict):
        raise ValueError("Choose a song and polish settings")
    if not capabilities()["ready"]:
        raise ValueError(capabilities()["message"])
    with store.lock:
        if request.get("action") == "retry":
            job = store.query({"table": "polish_jobs", "filters": [["id", request.get("job_id")]], "single": "required"})
            if job["status"] != "error":
                raise ValueError("Only an unsuccessful polish needs retrying")
            source_path(store, job["bucket"], job["storage_path"])
            return _update(store, job["id"], status="pending", progress=0, stage="Queued",
                           error_message=None, report=None, result_library_id=None, result_url=None)
        if request.get("action") not in (None, "create"):
            raise ValueError("Unknown song polish action")
        bucket, path = request.get("bucket"), request.get("storage_path")
        source_path(store, bucket, path)
        preset, strength = request.get("preset", "balanced"), request.get("strength", "gentle")
        if preset not in PRESETS or strength not in STRENGTHS:
            raise ValueError("Choose Engineer mix, Balanced, Vocal clarity or Warm, with Gentle or Standard strength")
        if preset == "engineer" and any(importlib.util.find_spec(n) is None for n in ("demucs", "torch")):
            raise ValueError("Engineer mix needs the stem splitter installed on the computer (run Setup ScrewShop).")
        name = request.get("name") or Path(path).stem
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError("Use a song name up to 200 characters")
        source_id = request.get("source_id")
        if source_id is not None and (not isinstance(source_id, str) or len(source_id) > 100):
            raise ValueError("Invalid source song")
        active = store.query({"table": "polish_jobs", "filters": [["bucket", bucket], ["storage_path", path],
                                                                      ["preset", preset], ["strength", strength]]})
        for job in active:
            if job.get("status") in {"pending", "running"}:
                return job
        if sum(job["status"] in {"pending", "running"} for job in jobs(store)) >= 20:
            raise ValueError("The polish queue is full. Wait for a song to finish.")
        record = {"id": str(uuid.uuid4()), "name": name.strip(), "bucket": bucket, "storage_path": path,
                  "source_url": audio_url(bucket, path), "source_id": source_id, "preset": preset,
                  "strength": strength, "status": "pending", "progress": 0, "stage": "Queued",
                  "error_message": None, "result_library_id": None, "result_url": None, "report": None}
        return store.query({"table": "polish_jobs", "action": "insert", "values": record, "single": "required"})


def claim_job(store):
    with store.lock, store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        rows = [json.loads(row[0]) for row in db.execute("SELECT body FROM records WHERE kind='polish_jobs'")]
        pending = sorted((row for row in rows if row.get("status") == "pending"), key=lambda row: row["created_at"])
        if not pending:
            return None
        job = pending[0]
        job.update(status="running", progress=3, stage="Opening song", updated_at=now())
        db.execute("UPDATE records SET body=? WHERE kind='polish_jobs' AND id=?", (json.dumps(job), job["id"]))
        return job


def _ffmpeg(arguments, stop=None, timeout=PROCESS_TIMEOUT, measurement=False):
    import imageio_ffmpeg
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-nostats", "-y",
               "-v", "info" if measurement else "error", "-threads", "2", *arguments]
    # Keep decoder metadata out of memory and never expose FFmpeg's private paths.
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=log,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if stop is not None and stop.wait(.15):
                    raise InterruptedError("Song polish stopped. Tap Retry when the computer is ready.")
                if stop is None:
                    time.sleep(.15)
                if time.monotonic() >= deadline:
                    raise ValueError("This song took too long to process. Trim it and try again.")
            if process.returncode:
                raise ValueError("This audio could not be decoded or processed. Try exporting it as WAV or MP3.")
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 65536))
            return log.read().decode("utf-8", errors="replace")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def _input(path):
    # No network protocols or playlist / concat demuxers, including disguised files.
    return ["-protocol_whitelist", "file", "-format_whitelist", "wav,mp3,mov,ogg,flac,aac,aiff,matroska,webm",
            "-i", str(path), "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1"]


def _number(value):
    result = float(value)
    return result if math.isfinite(result) else None


def measure(path, stop=None):
    log = _ffmpeg([*_input(path), "-af", "loudnorm=I=-14:TP=-1:LRA=50:print_format=json",
                   "-f", "null", "-"], stop, measurement=True)
    matches = re.findall(r'\{\s*"input_i".*?\}', log, re.S)
    if not matches:
        raise ValueError("Could not measure this audio. Try exporting the song as WAV.")
    raw = json.loads(matches[-1])
    return {"integrated_lufs": _number(raw["input_i"]), "true_peak_db": _number(raw["input_tp"]),
            "loudness_range_lu": _number(raw["input_lra"]), "threshold_lufs": _number(raw["input_thresh"])}


MAX_LIMITING_DB = 6.0  # never squash more than this to chase the loudness number


def _linear_finish(source, destination, measured, stop=None, sample_rate=48000):
    """Two-pass linear gain toward -14 LUFS that never raises the true peak above the ceiling."""
    gain = min(TARGET_LUFS - measured["integrated_lufs"], RENDER_PEAK - measured["true_peak_db"] - .05, 12.0)
    target = measured["integrated_lufs"] + gain
    normalization = (f"loudnorm=I={max(-70, target):.3f}:TP={RENDER_PEAK}:LRA=50:linear=true:"
                     f"measured_I={measured['integrated_lufs']}:measured_TP={measured['true_peak_db']}:"
                     f"measured_LRA={measured['loudness_range_lu']}:measured_thresh={measured['threshold_lufs']}:offset=0")
    _ffmpeg([*_input(source), "-af", normalization, "-ar", str(sample_rate), "-c:a", "pcm_s24le", str(destination)], stop)
    return gain


def finish_loudness(source, destination, stop=None, sample_rate=48000):
    """Master a finished mix to streaming level: -14 LUFS integrated, -1 dBTP.
    Most mixes have peaks that stop plain gain short of -14 LUFS. Like a mastering engineer, we first
    run a 4x-oversampled look-ahead limiter on only the excess (at most 6 dB of peak reduction), then
    apply measured linear gain. No EQ or compression: tone and balance are untouched."""
    before = measure(source, stop)
    if before["integrated_lufs"] is None or before["true_peak_db"] is None or before["threshold_lufs"] is None:
        raise ValueError("This mix is too quiet to measure. Raise the track volumes and export again.")
    headroom_gain = RENDER_PEAK - before["true_peak_db"] - .05
    shortfall = TARGET_LUFS - before["integrated_lufs"] - headroom_gain
    limiting = min(max(0.0, shortfall + .7), MAX_LIMITING_DB) if shortfall > .3 else 0.0
    stage, staged = source, None
    if limiting:
        staged = Path(destination).with_name(Path(destination).stem + ".limited.wav")
        ceiling = 10 ** ((RENDER_PEAK - .4) / 20)
        chain = (f"volume={headroom_gain + limiting:.3f}dB,aresample=192000,"
                 f"alimiter=limit={ceiling:.6f}:attack=5:release=80:level=disabled:asc=1:latency=1,aresample={sample_rate}")
        _ffmpeg([*_input(source), "-af", chain, "-c:a", "pcm_f32le", str(staged)], stop)
        stage = staged
    try:
        measured = measure(stage, stop) if staged else before
        gain = _linear_finish(stage, destination, measured, stop, sample_rate)
    finally:
        if staged:
            Path(staged).unlink(missing_ok=True)
    after = measure(destination, stop)
    if after["true_peak_db"] is None or after["true_peak_db"] > TRUE_PEAK + .01:
        raise ValueError("The finished song did not pass its peak check. Lower the master gain and export again.")
    notes = []
    if after["integrated_lufs"] is not None and after["integrated_lufs"] < TARGET_LUFS - .5:
        notes.append(f"Finished at {after['integrated_lufs']:.1f} LUFS: reaching -14 would need more than "
                     f"{MAX_LIMITING_DB:.0f} dB of limiting, which would flatten the song's punch.")
    return {"before": before, "after": after, "target_lufs": TARGET_LUFS, "target_true_peak_db": TRUE_PEAK,
            "limiting_db": round(limiting, 2), "applied_gain_db": round(headroom_gain + limiting + gain if limiting else gain, 2),
            "notes": notes}


def filter_chain(preset, strength, before):
    strong = strength == "standard"
    amount = 1.0 if strong else .5
    chain = ["highpass=f=25:p=2", f"equalizer=f=250:t=q:w=0.8:g={-0.7 * amount:.3f}"]
    descriptions = ["Remove subsonic rumble below 25 Hz", "Gentle broad low-mid cleanup"]
    if preset == "vocal":
        chain.append(f"equalizer=f=3000:t=q:w=0.7:g={0.9 * amount:.3f}")
        chain.append(f"deesser=i={0.12 * amount:.3f}:m=0.2:f=0.8:s=o")
        descriptions += ["Small vocal-presence lift", "Light sibilance control across the mix"]
    elif preset == "warm":
        chain += [f"bass=f=120:t=q:w=0.7:g={0.5 * amount:.3f}",
                  f"treble=f=7000:t=q:w=0.7:g={-0.7 * amount:.3f}"]
        descriptions.append("Subtle warmth with restrained upper treble")
    else:
        chain.append(f"equalizer=f=3000:t=q:w=0.7:g={0.3 * amount:.3f}")
        descriptions.append("Subtle broad presence balance")
    threshold_db = min(-8, max(-24, before["integrated_lufs"] + 7))
    threshold = 10 ** (threshold_db / 20)
    chain.append(f"acompressor=threshold={threshold:.6f}:ratio={1.6 if strong else 1.3}:"
                 "attack=30:release=180:makeup=1:knee=2.8:link=maximum:detection=rms")
    descriptions.append("Soft-knee, linked gentle compression with 30 ms attack and 180 ms release")
    return ",".join(chain), descriptions


def _db_to_lin(db):
    return 10 ** (db / 20)


def _threshold(lufs, above):
    """acompressor takes a linear threshold; anchor it to the material's measured loudness."""
    return min(1.0, max(0.000977, _db_to_lin(lufs + above)))


def _stem_chain(name, lufs, amount):
    """Engineer starting points per stem. `amount` 0.6 (gentle) or 1.0 (standard). The source was already
    mixed once, so these are corrective moves, not a rebuild: clean low end, carve space, control dynamics."""
    a = amount
    if name == "vocals":
        return ([f"highpass=f=90:p=2", f"equalizer=f=280:t=q:w=1.2:g={-2.5 * a:.2f}",
                 f"equalizer=f=3200:t=q:w=1:g={2 * a:.2f}", f"treble=f=10000:t=q:w=0.7:g={1.5 * a:.2f}",
                 f"acompressor=threshold={_threshold(lufs, 8):.6f}:ratio={2.5 + 1.5 * a:.2f}:attack=5:release=90:knee=4:detection=peak:link=maximum",
                 f"deesser=i={0.1 + 0.25 * a:.2f}:m=0.5:f=0.5:s=o"],
                "Vocals: 90 Hz high-pass, mud cut at 280 Hz, presence at 3.2 kHz, air at 10 kHz, "
                f"{2.5 + 1.5 * a:.1f}:1 compression (5 ms / 90 ms), de-essing")
    if name == "drums":
        return ([f"highpass=f=28:p=2", f"equalizer=f=60:t=q:w=1:g={1.5 * a:.2f}", f"equalizer=f=420:t=q:w=1.4:g={-2 * a:.2f}",
                 f"equalizer=f=5000:t=q:w=1:g={1.2 * a:.2f}",
                 f"acompressor=threshold={_threshold(lufs, 6):.6f}:ratio=4:attack=12:release=120:knee=3:link=maximum:mix={0.35 + 0.25 * a:.2f}"],
                "Drums: kick weight at 60 Hz, boxiness cut at 420 Hz, snap at 5 kHz, parallel 4:1 compression")
    if name == "bass":
        return ([f"highpass=f=30:p=2", "lowpass=f=7000", f"equalizer=f=250:t=q:w=1:g={-1.5 * a:.2f}",
                 f"acompressor=threshold={_threshold(lufs, 6):.6f}:ratio={3 + a:.2f}:attack=20:release=160:knee=4:link=maximum",
                 "extrastereo=m=0"],
                f"Bass: 30 Hz high-pass, low-mid cleanup, {3 + a:.0f}:1 compression for even notes, centered in mono")
    return ([f"highpass=f=35:p=2", f"equalizer=f=350:t=q:w=1:g={-1 * a:.2f}", f"equalizer=f=3000:t=q:w=1.2:g={-1.5 * a:.2f}",
             f"acompressor=threshold={_threshold(lufs, 8):.6f}:ratio=1.6:attack=25:release=200:knee=4:link=maximum"],
            "Music: low-mid cleanup and a 3 kHz pocket so the vocal sits in front, gentle 1.6:1 control")


def _run_split(store, job, decoded, output, stop):
    import sys
    logs = store.root / "logs"
    logs.mkdir(exist_ok=True)
    env = {**os.environ, "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "TORCH_HOME": str(store.root / "models")}
    with (logs / ("engineer-" + job["id"] + ".log")).open("wb") as log:
        process = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "separate_audio.py"), "--model", "htdemucs",
                                    "--all", "--output", str(output), str(decoded)], stdout=log, stderr=subprocess.STDOUT,
                                   env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline, started = time.monotonic() + SPLIT_TIMEOUT, time.monotonic()
        try:
            while process.poll() is None:
                if stop is not None and stop.wait(1):
                    raise InterruptedError("Engineer mix stopped. Tap Retry when the computer is ready.")
                if stop is None:
                    time.sleep(1)
                if time.monotonic() >= deadline:
                    raise ValueError("Stem splitting took too long. Try a shorter song.")
                # Splitting is the long step; creep the bar so it visibly moves.
                elapsed = time.monotonic() - started
                _update(store, job["id"], progress=min(54, 12 + int(elapsed / 8)), stage="Separating vocals, drums, bass and music")
            if process.returncode:
                raise ValueError("Stem splitting failed. The log is in ScrewShop/data/logs; check free memory and retry.")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    return output / "htdemucs" / Path(decoded).stem


def process_engineer(store, job, stop=None):
    """Engineer mix of a finished stereo song: split into stems, process each like a mix engineer,
    gain-match and rebalance with the vocal forward, glue on a mix bus, then master to -14 LUFS / -1 dBTP."""
    import soundfile as sf
    source = source_path(store, job["bucket"], job["storage_path"])
    hasher = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    strong = job["strength"] == "standard"
    amount = 1.0 if strong else 0.6
    lifts = {"vocals": 2.5 if strong else 1.5, "drums": 0.5, "bass": 0.0, "other": 0.0}
    relative = f"polished/{job['id']}.wav"
    destination = store.asset("beats", relative)
    temp_root = store.root / "processing"
    temp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="engineer-", dir=temp_root) as temporary:
        folder = Path(temporary)
        decoded = folder / "song.wav"
        _update(store, job["id"], progress=4, stage="Decoding audio")
        _ffmpeg([*_input(source), "-t", str(MAX_SECONDS + 1), "-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", str(decoded)], stop)
        duration = sf.info(decoded).duration
        if duration > MAX_SECONDS:
            raise ValueError("Engineer mix handles songs up to 30 minutes.")
        if duration < 2:
            raise ValueError("Choose at least two seconds of audio for an engineer mix")
        _update(store, job["id"], progress=8, stage="Measuring original")
        before = measure(decoded, stop)
        if before["integrated_lufs"] is None:
            raise ValueError("This file is silent or too quiet to mix. Choose a song containing sound.")
        stems_dir = _run_split(store, job, decoded, folder / "split", stop)
        names = ["vocals", "drums", "bass", "other"]
        if any(not (stems_dir / (n + ".wav")).is_file() for n in names):
            raise ValueError("Stem splitting did not produce all four stems. Retry the song.")
        processed, gains, descriptions, skipped = {}, {}, [], []
        for index, name in enumerate(names):
            _update(store, job["id"], progress=56 + index * 6, stage=f"Mixing {('music' if name == 'other' else name)}")
            stem = stems_dir / (name + ".wav")
            level = measure(stem, stop)
            if level["integrated_lufs"] is None or level["integrated_lufs"] < -55:
                processed[name], gains[name] = stem, 0.0  # e.g. no vocals on an instrumental: leave it alone
                skipped.append("music" if name == "other" else name)
                continue
            chain, description = _stem_chain(name, level["integrated_lufs"], amount)
            out = folder / (name + ".mixed.wav")
            _ffmpeg([*_input(stem), "-af", ",".join(chain), "-c:a", "pcm_f32le", str(out)], stop)
            after = measure(out, stop)
            # Gain-match: processing must not change the balance by itself; only the deliberate lift does.
            match = (level["integrated_lufs"] - after["integrated_lufs"]) if after["integrated_lufs"] is not None else 0.0
            processed[name], gains[name] = out, round(max(-12.0, min(12.0, match)) + lifts[name], 2)
            descriptions.append(description)
        _update(store, job["id"], progress=80, stage="Balancing and gluing the mix")
        mixed = folder / "mix.wav"
        inputs = []
        for name in names:  # _input() adds -map per file, which only works for single-input commands
            inputs += ["-protocol_whitelist", "file", "-f", "wav", "-i", str(processed[name])]
        graph = ";".join(f"[{i}:a]volume={gains[n]:.2f}dB[s{i}]" for i, n in enumerate(names))
        glue_threshold = _threshold(before["integrated_lufs"], 6)
        graph += (";" + "".join(f"[s{i}]" for i in range(len(names))) + f"amix=inputs={len(names)}:normalize=0,"
                  f"acompressor=threshold={glue_threshold:.6f}:ratio={2.0 if strong else 1.6}:attack=30:release=200:knee=4:"
                  "detection=rms:link=maximum[out]")
        _ffmpeg([*inputs, "-filter_complex", graph, "-map", "[out]", "-map_metadata", "-1", "-c:a", "pcm_f32le", str(mixed)], stop)
        _update(store, job["id"], progress=88, stage="Mastering to streaming level")
        rendered = folder / "finished.wav"
        finish = finish_loudness(mixed, rendered, stop, sample_rate=48000)
        if stop is not None and stop.is_set():
            raise InterruptedError("Engineer mix stopped. Tap Retry when the computer is ready.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(rendered, destination)
    lift_text = f"Vocal brought forward {lifts['vocals']:+.1f} dB, drums {lifts['drums']:+.1f} dB after level-matching each stem"
    notes = ["Stems are separated by AI; listen for small separation artifacts, especially on cymbals and reverb tails.",
             "For full control of every part, add the split stems to STUDIO and use the MIXER."]
    if skipped:
        notes.insert(0, "No " + " / ".join(skipped) + " detected, so that part was left as-is.")
    report = {"before": before, "after": finish["after"], "target_lufs": TARGET_LUFS, "target_true_peak_db": TRUE_PEAK,
              "processing": ["Split into vocals, drums, bass and music (Demucs htdemucs)"] + descriptions + [lift_text,
                             f"Mix-bus glue compression {2.0 if strong else 1.6}:1 (30 ms / 200 ms)",
                             f"Mastered to {TARGET_LUFS:.0f} LUFS / {TRUE_PEAK:.0f} dBTP"
                             + (f" with {finish['limiting_db']:.1f} dB of oversampled limiting" if finish["limiting_db"] else "")
                             + "; 24-bit / 48 kHz WAV"],
              "notes": finish["notes"] + notes, "stem_gains_db": gains, "duration_seconds": round(duration, 3)}
    library_id = "polished-" + job["id"]
    result = store.query({"table": "library", "action": "upsert", "values": {
        "id": library_id, "name": job["name"], "bucket": "beats", "storage_path": relative,
        "type": "audio", "source_kind": "polished-version", "source_id": job.get("source_id"),
        "source_bucket": job["bucket"], "source_storage_path": job["storage_path"],
        "polish_job_id": job["id"], "polish_preset": job["preset"], "polish_strength": job["strength"],
        "source_sha256": hasher.hexdigest(), "polish_report": report, "duration": duration,
        "mime_type": "audio/wav"}, "single": "required"})
    return {"report": report, "result_library_id": result["id"], "result_url": audio_url("beats", relative)}


def process_job(store, job, stop=None):
    if job.get("preset") == "engineer":
        return process_engineer(store, job, stop)
    import numpy as np
    import soundfile as sf
    source = source_path(store, job["bucket"], job["storage_path"])
    hasher = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    temp_root = store.root / "processing"
    temp_root.mkdir(exist_ok=True)
    relative = f"polished/{job['id']}.wav"
    destination = store.asset("beats", relative)
    library_id = "polished-" + job["id"]
    with tempfile.TemporaryDirectory(prefix="polish-", dir=temp_root) as temporary:
        folder = Path(temporary)
        decoded, conditioned, rendered = [folder / name for name in ("decoded.wav", "conditioned.wav", "finished.wav")]
        _update(store, job["id"], progress=6, stage="Decoding audio")
        _ffmpeg([*_input(source), "-t", str(MAX_SECONDS + 1), "-ar", "48000", "-ac", "2",
                 "-c:a", "pcm_f32le", str(decoded)], stop)
        info = sf.info(decoded)
        if info.duration > MAX_SECONDS:
            raise ValueError("Polish songs up to 30 minutes. Trim this recording and try again.")
        if info.duration < .4:
            raise ValueError("Choose at least half a second of audio for song polish")
        # Stream validation bounds memory, including files containing non-finite samples.
        peak = 0.0
        with sf.SoundFile(decoded) as handle:
            for block in handle.blocks(blocksize=65536, dtype="float32", always_2d=True):
                if not np.isfinite(block).all():
                    raise ValueError("This recording contains invalid audio samples. Export it again.")
                peak = max(peak, float(np.max(np.abs(block))))
        if peak < 1e-6:
            raise ValueError("This file is silent. Choose a song containing sound.")
        _update(store, job["id"], progress=22, stage="Measuring original")
        before = measure(decoded, stop)
        if before["integrated_lufs"] is None or before["true_peak_db"] is None:
            raise ValueError("This song is too quiet to measure reliably. Export a louder source and try again.")
        chain, descriptions = filter_chain(job["preset"], job["strength"], before)
        _update(store, job["id"], progress=40, stage="Balancing tone and dynamics")
        _ffmpeg([*_input(decoded), "-af", chain, "-ar", "48000", "-c:a", "pcm_f32le", str(conditioned)], stop)
        _update(store, job["id"], progress=62, stage="Measuring processed mix")
        processed = measure(conditioned, stop)
        if any(processed[key] is None for key in ("integrated_lufs", "true_peak_db", "threshold_lufs")):
            raise ValueError("This song is too quiet to finish reliably. Try another source recording.")
        wanted_gain = TARGET_LUFS - processed["integrated_lufs"]
        # Measurement values are rounded; keep another small margin so FFmpeg
        # does not switch to dynamic normalization at the exact peak boundary.
        gain = min(wanted_gain, RENDER_PEAK - processed["true_peak_db"] - .05, 12.0)
        effective_target = processed["integrated_lufs"] + gain
        # Two-pass linear loudnorm uses measured values. LRA=50 and a peak-constrained
        # target preserve dynamics; no dynamic mode fallback is needed to force -14.
        normalization = (f"loudnorm=I={max(-70, effective_target):.3f}:TP={RENDER_PEAK}:LRA=50:linear=true:"
                         f"measured_I={processed['integrated_lufs']}:measured_TP={processed['true_peak_db']}:"
                         f"measured_LRA={processed['loudness_range_lu']}:measured_thresh={processed['threshold_lufs']}:"
                         "offset=0")
        _update(store, job["id"], progress=76, stage="Finishing loudness")
        _ffmpeg([*_input(conditioned), "-af", normalization, "-ar", "48000", "-c:a", "pcm_s24le", str(rendered)], stop)
        _update(store, job["id"], progress=90, stage="Checking finished audio")
        after = measure(rendered, stop)
        # Check the actual written WAV, allowing no output above the advertised ceiling.
        if after["true_peak_db"] is None or after["true_peak_db"] > TRUE_PEAK + .01:
            raise ValueError("The finished song did not pass its peak check. Try Gentle strength.")
        notes = ["Finishes the whole mix; separate vocal and instrument balance stays controlled in Studio.",
                 "Processing cannot restore clipped detail or remove every recording problem."]
        if effective_target < TARGET_LUFS - .2:
            notes.insert(0, "Finished below -14 LUFS to protect peaks and preserve dynamics.")
        if info.duration < 60:
            notes.append("Loudness range on clips under a minute is only an approximate guide.")
        report = {"before": before, "after": after, "target_lufs": TARGET_LUFS,
                  "target_true_peak_db": TRUE_PEAK, "applied_gain_db": round(gain, 2),
                  "processing": descriptions + ["Measured two-pass loudness finishing; 24-bit / 48 kHz WAV"],
                  "notes": notes, "duration_seconds": round(info.duration, 3)}
        if stop is not None and stop.is_set():
            raise InterruptedError("Song polish stopped. Tap Retry when the computer is ready.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(rendered, destination)
        # Stable IDs make recovery safe if a computer stops between registration and completion.
        result = store.query({"table": "library", "action": "upsert", "values": {
            "id": library_id, "name": job["name"], "bucket": "beats", "storage_path": relative,
            "type": "audio", "source_kind": "polished-version", "source_id": job.get("source_id"),
            "source_bucket": job["bucket"], "source_storage_path": job["storage_path"],
            "polish_job_id": job["id"], "polish_preset": job["preset"], "polish_strength": job["strength"],
            "source_sha256": hasher.hexdigest(), "polish_report": report, "duration": info.duration,
            "mime_type": "audio/wav"}, "single": "required"})
        return {"report": report, "result_library_id": result["id"], "result_url": audio_url("beats", relative)}


class Processor:
    """One serial private queue shared by the HTTP and HTTPS listeners."""
    def __init__(self, store):
        self.store = store
        self.stop = threading.Event()
        self.references = 0
        self.thread = None

    def acquire(self):
        with self.store.lock:
            self.references += 1
            if self.thread is None or not self.thread.is_alive():
                self.stop.clear()
                # Interrupted work is visible and retryable rather than silently rerun.
                for job in self.store.query({"table": "polish_jobs", "filters": [["status", "running"]]}):
                    _update(self.store, job["id"], status="error", stage="Interrupted", progress=0,
                            error_message="Computer or processor restarted. Tap Retry to finish this song.")
                self.thread = threading.Thread(target=self.run, name="screwshop-song-polish", daemon=True)
                self.thread.start()

    def release(self):
        with self.store.lock:
            self.references = max(0, self.references - 1)
            should_stop = self.references == 0
            if should_stop:
                self.stop.set()
        if should_stop and self.thread:
            self.thread.join(timeout=6)

    def run(self):
        while not self.stop.is_set():
            job = claim_job(self.store) if capabilities()["ready"] else None
            if job:
                try:
                    result = process_job(self.store, job, self.stop)
                    _update(self.store, job["id"], **result, status="done", progress=100,
                            stage="Ready in Songs", error_message=None)
                except Exception as exc:
                    message = str(exc) if isinstance(exc, (ValueError, InterruptedError)) else "Song polish failed. Check free disk space, then tap Retry."
                    _update(self.store, job["id"], status="error", stage="Needs attention",
                            error_message=message[:500])
            else:
                self.stop.wait(.5)


def attach(store):
    with store.lock:
        processor = getattr(store, "_polish_processor", None)
        if processor is None:
            processor = store._polish_processor = Processor(store)
        processor.acquire()
        return processor
