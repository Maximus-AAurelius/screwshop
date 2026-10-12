"""Turn a video or audio link, or an uploaded video file, into an MP3 in SONGS.

Links must point straight at a media file (for example https://example.com/clip.mp4). Web pages
such as YouTube or Instagram posts are refused with a clear message: they serve HTML, not media.
Only public internet addresses are fetched (never this computer or the home network), redirects
are re-checked, size is capped, and FFmpeg only ever reads the downloaded local file.
"""
import ipaddress
import socket
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

from local_store import USER_ID

MAX_BYTES = 300 * 1024 * 1024
MAX_SECONDS = 1800
NOT_MEDIA = ("That link opens a web page, not a video or audio file. Use a direct link to the file "
             "(it usually ends in .mp4, .mov, .m4a or .mp3). Page links from YouTube, Instagram or TikTok aren't supported.")


def check_url(url):
    """Allow only http(s) links to public internet hosts."""
    parts = urlsplit(str(url).strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("Paste a link that starts with http:// or https://")
    if parts.username or parts.password:
        raise ValueError("Links with a username or password aren't supported")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        raise ValueError("Couldn't find that website. Check the link.")
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global:
            raise ValueError("Links to this computer or your home network can't be imported")
    return parts.geturl()


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, dest):
    opener = urllib.request.build_opener(_CheckedRedirects())
    request = urllib.request.Request(check_url(url), headers={"User-Agent": "ScrewShop/1.0 (local media import)"})
    try:
        with opener.open(request, timeout=30) as response:
            kind = (response.headers.get_content_type() or "").lower()
            if kind.startswith("text/") or kind in ("application/xhtml+xml", "application/json"):
                raise ValueError(NOT_MEDIA)
            length = response.headers.get("Content-Length")
            if length and length.isdigit() and int(length) > MAX_BYTES:
                raise ValueError("That file is over 300 MB")
            total = 0
            with open(dest, "wb") as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise ValueError("That file is over 300 MB")
                    out.write(chunk)
    except urllib.error.HTTPError as exc:
        raise ValueError(f"The website refused the download (HTTP {exc.code})")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ValueError("Couldn't download that link: " + str(getattr(exc, "reason", exc))[:160])
    if total == 0:
        raise ValueError("The link returned an empty file")


def to_mp3(source, dest):
    import imageio_ffmpeg
    run = subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-protocol_whitelist", "file",
         "-i", str(source), "-map", "0:a:0", "-vn", "-t", str(MAX_SECONDS), "-c:a", "libmp3lame", "-b:a", "320k", "-y", str(dest)],
        capture_output=True, text=True, timeout=600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if run.returncode or not dest.is_file() or dest.stat().st_size == 0:
        if dest.exists():
            dest.unlink()
        detail = run.stderr.lower()
        if "matches no streams" in detail or "does not contain any stream" in detail:
            raise ValueError("That file has no audio track")
        if "invalid data" in detail:
            raise ValueError("That file isn't a video or audio file ScrewShop can read")
        raise ValueError("Couldn't convert that file to MP3")


def clean_name(value, fallback="Imported audio"):
    name = " ".join(str(value or "").replace("_", " ").split())[:160]
    return name or fallback


def import_media(store, url=None, data=None, filename=None, name=None):
    """Download or take the uploaded bytes, convert to a 320 kbps MP3, and add it to SONGS."""
    from studio_exports import mp3_available
    if not mp3_available():
        raise ValueError("The MP3 encoder isn't available on this computer. Run Setup ScrewShop.cmd.")
    with tempfile.TemporaryDirectory(prefix="screwshop-import-") as tmp:
        source = Path(tmp) / "source.media"
        if url:
            download(url, source)
            fallback = Path(unquote(urlsplit(url).path)).stem
        else:
            if not data:
                raise ValueError("Choose a video or audio file")
            source.write_bytes(data)
            fallback = Path(str(filename or "")).stem
        relative = f"local/library/{uuid.uuid4().hex}.mp3"
        dest = store.asset("beats", relative)
        dest.parent.mkdir(parents=True, exist_ok=True)
        to_mp3(source, dest)
    return store.query({"table": "library", "action": "insert", "single": True, "values": {
        "user_id": USER_ID, "name": clean_name(name or fallback), "storage_path": relative, "bucket": "beats", "source_kind": "imported"}})
