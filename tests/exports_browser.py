"""Historical PACKS layout regression. Current exports are covered by sampler_browser.py
and test_exports.py; this script is retained as reference for the retired interface.
"""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server
from test_exports import seed_pack

with tempfile.TemporaryDirectory() as tmp:
    server = make_server(tmp,port=0)
    seed_pack(server.store)
    thread = threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            chrome = sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1]
            browser = p.chromium.launch(executable_path=str(chrome),headless=True)
            page = browser.new_page(viewport={'width':1366,'height':1000},accept_downloads=True)
            errors = []
            page.on('pageerror',lambda e: errors.append(str(e)))
            page.add_init_script('window.__audioPlayers=[]; const NativeAudio=window.Audio; window.Audio=class extends NativeAudio { constructor(...args){super(...args); window.__audioPlayers.push(this);} };')
            page.goto(base+'/barwork')
            page.get_by_role('button',name='PACKS',exact=True).click()
            stem = page.locator('[data-stem-kind="instrumental"]')
            stem.get_by_role('button',name='▶ PLAY',exact=True).click()
            page.get_by_role('button',name='Pause audio',exact=True).wait_for()
            page.get_by_role('button',name='WRITE',exact=True).click()
            assert page.locator('#studio-transport').is_visible()
            page.get_by_role('button',name='Pause audio',exact=True).click()
            assert page.evaluate('window.__audioPlayers.every(a=>a.paused)')
            page.get_by_label('Source BPM',exact=True).fill('100')
            page.get_by_label('Playback BPM',exact=True).fill('80')
            assert page.evaluate('window.__audioPlayers[0].playbackRate') == 0.8
            page.get_by_role('button',name='Play audio',exact=True).click()
            page.get_by_role('button',name='Stop all audio',exact=True).click()
            assert page.evaluate('window.__audioPlayers.every(a=>a.paused && a.currentTime===0)')
            print('Global transport controls stem preview across tabs; BPM changes playback rate.',flush=True)
            page.get_by_role('button',name='PACKS',exact=True).click()
            with page.expect_download() as downloaded:
                stem.get_by_role('button',name='SAVE WAV',exact=True).click()
            assert downloaded.value.suggested_filename.endswith('instrumental.wav')
            assert downloaded.value.failure() is None
            with page.expect_download() as downloaded:
                page.get_by_role('button',name='SAVE SOUND PACK ZIP',exact=True).click()
            assert downloaded.value.suggested_filename.endswith('.zip')
            assert downloaded.value.failure() is None
            stem.get_by_role('button',name='USE AS NEW TRACK',exact=True).click()
            page.locator('input[value="Test track — instrumental"]').wait_for()
            print('WAV/ZIP downloads and independent instrumental library copy passed.',flush=True)
            page.get_by_role('button',name='Open the Trill walkthrough',exact=True).click()
            page.get_by_text('YOUR STUDIO GUIDE',exact=False).wait_for()
            page.screenshot(path=str(ROOT/'test-results/guide.png'))
            page.get_by_role('button',name='NEXT →',exact=True).click()
            page.reload()
            page.get_by_role('button',name='PACKS',exact=True).click()
            page.screenshot(path=str(ROOT/'test-results/exports-desktop.png'))
            page.set_viewport_size({'width':390,'height':844})
            page.screenshot(path=str(ROOT/'test-results/exports-phone.png'))
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert not errors,errors
            print(json.dumps({'page_errors':errors,'mobile_overflow':False}),flush=True)
            browser.close()
    finally:
        server.shutdown(); thread.join(); server.server_close()
