"""Media import (server only; the SONGS page no longer shows VIDEO TO MP3): a video file becomes an MP3 song;
unsafe or non-media links are refused clearly."""
import os, sys, json, subprocess, tempfile, threading, urllib.request, urllib.parse, urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server
import media_import
import imageio_ffmpeg

# Link checks without a browser.
for bad, why in (('ftp://example.com/a.mp4', 'http'), ('http://127.0.0.1/a.mp4', 'home network'), ('http://192.168.1.20/a.mp4', 'home network'),
                 ('http://localhost:8000/x.mp4', 'home network'), ('http://user:pw@example.com/a.mp4', 'username')):
    try:
        media_import.check_url(bad); raise AssertionError('accepted ' + bad)
    except ValueError as exc:
        assert why in str(exc), (bad, exc)
print('Unsafe links refused (local, private, non-http, credentials)')

with tempfile.TemporaryDirectory() as temp:
    clip = Path(temp) / 'Houston clip.mp4'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
                    '-t', '3', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-y', str(clip)], check=True)
    silent = Path(temp) / 'no sound.mp4'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '2', '-c:v', 'mpeg4', '-y', str(silent)], check=True)
    server = make_server(temp, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'

    def post_file(path):
        req = urllib.request.Request(base + '/api/import-media', data=path.read_bytes(), method='POST', headers={
            'X-ScrewShop': '1', 'Content-Type': 'application/octet-stream', 'X-File-Name': urllib.parse.quote(path.name)})
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
        except urllib.error.HTTPError as e: return json.load(e)
    try:
        # The SONGS page no longer offers VIDEO TO MP3.
        with sync_playwright() as p:
            chrome = sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1]
            browser = p.chromium.launch(executable_path=str(chrome), headless=True)
            page = browser.new_page(viewport={'width': 1300, 'height': 1000})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(base + '/barwork')
            page.get_by_role('button', name='SONGS', exact=True).click()
            page.locator('.ss-studio-save').first.wait_for()
            assert page.get_by_role('region', name='Video to MP3').count() == 0 and 'VIDEO TO MP3' not in page.inner_text('body')
            assert not errors, errors
            browser.close()
        print('SONGS page has no VIDEO TO MP3 section')

        # The server converter still turns a local video file into an MP3 song.
        result = post_file(clip)
        row = next(x for x in server.store.query({'table': 'library'}) if x.get('name') == 'Houston clip')
        assert result.get('data') and row['storage_path'].endswith('.mp3'), result
        mp3 = Path(temp) / 'audio' / 'beats' / row['storage_path']
        probe = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-i', str(mp3), '-f', 'null', '-'], capture_output=True, text=True)
        assert mp3.read_bytes()[:3] in (b'ID3', b'\xff\xfb', b'\xff\xf3') and probe.returncode == 0 and mp3.stat().st_size > 20000, mp3.stat().st_size
        print('Video file converted to a playable MP3 in SONGS:', mp3.stat().st_size, 'bytes')
        assert 'no audio track' in post_file(silent)['error']['message']
        print('Silent video gives a clear message')
    finally:
        server.shutdown()

# A web page (HTML) is refused with the "not a video file" message, using a stubbed response.
class Fake:
    def __init__(self, kind): self.headers = type('H', (), {'get_content_type': lambda s: kind, 'get': lambda s, k, d=None: None})()
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def read(self, n): return b''
real_open, real_check = media_import.urllib.request.OpenerDirector.open, media_import.check_url
media_import.urllib.request.OpenerDirector.open = lambda self, req, timeout=None: Fake('text/html')
media_import.check_url = lambda url: url
try:
    media_import.download('https://www.youtube.com/watch?v=x', Path(tempfile.gettempdir()) / 'x.media'); raise AssertionError('html accepted')
except ValueError as exc:
    assert 'web page' in str(exc), exc
finally:
    media_import.urllib.request.OpenerDirector.open, media_import.check_url = real_open, real_check
print('PASS: no VIDEO TO MP3 on SONGS; server converter and link checks still work')
