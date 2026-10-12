"""Real-browser checks against an isolated local database; no user's songs are changed."""
import json
import os
import sys
import tempfile
import threading
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from local_server import make_server

out = ROOT / "test-results"
out.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory() as temp:
    server = make_server(temp, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as p:
            browsers = sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))
            browser = p.chromium.launch(executable_path=str(browsers[-1]), headless=True, args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
            page = browser.new_page(viewport={"width": 1366, "height": 900}, permissions=['microphone'])
            errors = []
            external = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('request', lambda req: external.append(req.url) if not req.url.startswith((base, 'blob:', 'data:')) else None)
            page.goto(base + '/barwork')
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).wait_for(timeout=20000)
            print('Loaded studio', flush=True)
            page.screenshot(path=str(out / 'desktop.png'))
            for name in ['SONGS', 'NOTEPAD', 'STUDIO', 'SCREW', 'M-AUDIO / SAMPLER']:
                page.get_by_role('button', name=name, exact=True).click()
            print('All five tabs opened', flush=True)
            page.get_by_role('button', name='NOTEPAD', exact=True).click()
            editor=page.get_by_role('textbox', name='Verse notebook')
            editor.fill('Local lyric persistence regression')
            page.get_by_text('SAVED ON DISK', exact=True).wait_for()
            page.reload()
            page.wait_for_function("document.querySelector('.np-editor')?.value === 'Local lyric persistence regression'")
            print('Edited lyrics survive reload', flush=True)
            page.get_by_role('button', name='STUDIO', exact=True).click()
            page.get_by_role('button', name='RECORD', exact=True).click()
            page.get_by_role('button', name='STOP', exact=True).wait_for()
            page.wait_for_timeout(1200)
            page.get_by_role('button', name='STOP', exact=True).click()
            page.wait_for_timeout(1000)
            assert len(server.store.query({'table':'takes'})) == 1
            print('Microphone take saved to disk (synthetic browser microphone)', flush=True)
            page.get_by_role('button', name='SONGS', exact=True).click()
            fixture = Path(temp) / 'browser-test.wav'
            with wave.open(str(fixture), 'wb') as wav:
                wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(44100)
                wav.writeframes(b'\0' * 44100 * 4)
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='+ UPLOAD FILE', exact=True).click()
            chooser.value.set_files(str(fixture))
            page.get_by_display_value('browser-test').wait_for(timeout=10000) if hasattr(page, 'get_by_display_value') else page.locator('input[value="browser-test"]').wait_for(timeout=10000)
            page.reload()
            page.get_by_role('button', name='SONGS', exact=True).click()
            page.locator('input[value="browser-test"]').wait_for(timeout=10000)
            print('Audio import survives reload', flush=True)
            page.get_by_role('button', name='SONGS', exact=True).click()
            page.locator('.ss-library-row').filter(has=page.locator('input[value="browser-test"]')).locator('[data-row-menu]').click()
            page.locator('.im-menu [data-action="quick-split"]').click()
            page.get_by_text('Queued for separation', exact=True).wait_for(timeout=10000)
            jobs = server.store.query({"table": "split_jobs"})
            assert len(jobs) == 1 and jobs[0]['status'] == 'pending'
            server.store.query({"table": "split_jobs", "action": "update", "filters": [["id", jobs[0]['id']]], "values": {"status": "error", "error_message": "Regression test: source cannot be decoded"}})
            page.get_by_text('Regression test: source cannot be decoded', exact=True).wait_for(timeout=10000)
            page.reload()
            page.get_by_role('button', name='SONGS', exact=True).click()
            page.get_by_text('Regression test: source cannot be decoded', exact=True).wait_for(timeout=10000)
            print('Job errors displayed and restored after reload', flush=True)
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path=str(out / 'phone.png'))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow on phone'
            assert not errors, errors
            assert not external, external
            print(json.dumps({"page_errors": errors, "external_requests": external, "phone_width": 390}))
            browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
