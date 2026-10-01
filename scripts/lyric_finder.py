"""Find typed lyrics inside a sound so they can be trimmed or chopped onto pads.

Whisper (faster-whisper) runs on this computer. Each sound is transcribed once and the
word timings are cached in data/transcripts, so later searches are instant.
"""
import hashlib
import importlib.util
import json
import re
import threading
from difflib import SequenceMatcher

MODEL = "small.en"
_model = None
_lock = threading.Lock()


def available():
    return importlib.util.find_spec("faster_whisper") is not None


def words_of(text):
    """Lowercase words without punctuation, so "Ya talkin'" matches "ya talkin"."""
    return [w for w in (re.sub(r"[^a-z0-9]", "", raw.lower()) for raw in text.split()) if w]


def transcribe(store, path):
    """Return [{word, start, end}] for an audio file, using the cache when possible."""
    stat = path.stat()
    key = hashlib.sha1(f"{path}|{stat.st_size}|{stat.st_mtime_ns}|{MODEL}".encode()).hexdigest()
    cache = store.root / "transcripts" / (key + ".json")
    if cache.is_file():
        return json.loads(cache.read_text("utf-8"))
    if not available():
        raise ValueError("Lyric finder is not installed. Run Setup ScrewShop.cmd on the computer.")
    global _model
    with _lock:  # one transcription at a time keeps memory use predictable
        if cache.is_file():
            return json.loads(cache.read_text("utf-8"))
        if _model is None:
            from faster_whisper import WhisperModel
            # First use downloads the model (~480 MB) into data/models/whisper.
            _model = WhisperModel(MODEL, device="cpu", compute_type="int8", download_root=str(store.root / "models" / "whisper"))
        segments, _ = _model.transcribe(str(path), word_timestamps=True, vad_filter=False, condition_on_previous_text=False)
        words = [{"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)} for s in segments for w in (s.words or [])]
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(words), "utf-8")
        return words


def _best_window(heard, target, lo, hi):
    """Best (score, first, last) window of heard words in [lo, hi) for the target words."""
    n, best = len(target), (0.0, -1, -1)
    firsts = range(lo, hi)
    if n > 6 and hi - lo > n * 3:
        # Coarse pass on word stems ("strapped" ~ "strap") finds likely spots in a whole song;
        # the precise letter-by-letter pass below then only checks around those spots.
        coarse = SequenceMatcher(None, autojunk=False)
        coarse.set_seq2([w[:4] for w in target])
        stems = [w[:4] for w in heard]
        spots = []
        for first in range(lo, max(lo + 1, hi - n + 1)):
            coarse.set_seq1(stems[first:first + n])
            spots.append((coarse.ratio(), first))
        spots = sorted(spots, reverse=True)[:6]
        firsts = sorted({f for _, s in spots for f in range(max(lo, s - 4), min(hi, s + 5))})
    matcher = SequenceMatcher(None, autojunk=False)
    matcher.set_seq2(" ".join(target))  # the matcher caches the typed side
    for first in firsts:
        for size in range(max(1, n - max(2, n // 3)), n + max(3, n // 3) + 1):
            last = first + size - 1
            if last >= hi:
                break
            matcher.set_seq1(" ".join(heard[first:last + 1]))
            # Cheap upper bounds first; only score windows that could win.
            if matcher.real_quick_ratio() > best[0] and matcher.quick_ratio() > best[0]:
                score = matcher.ratio()
                if score > best[0]:
                    best = (score, first, last)
    return best


def find(words, text, limit=3, minimum=0.65):
    """Match typed lines against transcript words.

    Returns up to `limit` non-overlapping matches, best first. Each match has the whole
    phrase's start/end plus one start/end per typed line (for chopping lines onto pads).
    """
    lines = [words_of(line) for line in text.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        raise ValueError("Type or paste the lyrics you want to sample.")
    heard = [re.sub(r"[^a-z0-9]", "", w["word"].lower()) for w in words]
    whole = [w for line in lines for w in line]
    matches, taken = [], []
    while len(matches) < limit:
        candidates = []
        start = 0
        for a, b in sorted(taken) + [(len(heard), len(heard))]:
            if a > start:
                candidates.append(_best_window(heard, whole, start, a))
            start = max(start, b + 1)
        score, first, last = max(candidates, default=(0, -1, -1))
        if first < 0 or score < minimum:
            break
        taken.append((first, last))
        # Place each typed line inside the matched phrase, in order.
        parts, cursor = [], first
        for i, line in enumerate(lines):
            if i == len(lines) - 1:
                a, b = cursor, last
            else:
                _, a, b = _best_window(heard, line, cursor, min(last + 1, cursor + len(line) * 2 + 3))
                if a < 0:
                    a, b = cursor, min(last, cursor + len(line) - 1)
            a, b = min(a, last), min(max(a, b), last)
            parts.append({"start": words[a]["start"], "end": words[b]["end"], "heard": " ".join(w["word"] for w in words[a:b + 1])})
            cursor = min(b + 1, last)
        matches.append({"score": round(score, 2), "start": words[first]["start"], "end": words[last]["end"], "lines": parts, "heard": " ".join(w["word"] for w in words[first:last + 1])})
    if not matches:
        raise ValueError("Couldn't find those words in this sound. Try the vocals stem, or type a shorter piece of the line.")
    return matches
