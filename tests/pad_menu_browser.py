"""Right-click a sampler pad: menu, EDIT SOUND window (trim, octave, semitone, fine tune, volume), copy/paste, clear + UNDO."""
import math
import os
import struct
import sys
import tempfile
import threading
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server
from song_source_helpers import upload_song, load_song_pad


def chrome_path():
    if os.environ.get('SS_CHROME'):
        return os.environ['SS_CHROME']
    return str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])


with tempfile.TemporaryDirectory() as temp:
    hit = Path(temp) / 'pad hit.wav'
    with wave.open(str(hit), 'wb') as w:
        w.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
        w.writeframes(b''.join(struct.pack('<h', int(12000 * math.sin(i * 2 * math.pi * 220 / 8000))) for i in range(16000)))
    server = make_server(temp, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path(), headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('dialog', lambda d: d.accept('Snare 2') if d.type == 'prompt' else d.accept())
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()
            upload_song(page, hit, 'pad hit')
            load_song_pad(page, 'pad hit', 2)
            page.wait_for_function('sampler.slots[2]?.end')
            pad = page.locator('.ox-pad[data-pad="2"]')

            # Empty pad: only load/paste make sense; editing says why it's off.
            page.locator('.ox-pad[data-pad="5"]').click(button='right')
            assert page.locator('.im-menu [data-action="edit"]').get_attribute('aria-disabled') == 'true'
            assert page.locator('.im-menu [data-action="load"]').is_visible()
            page.keyboard.press('Escape')

            # Right-click doesn't play the pad, it opens the menu; Edit sound opens the window.
            pad.click(button='right')
            assert page.locator('.im-menu .im-title').inner_text().startswith('PAD 3')
            page.locator('.im-menu [data-action="edit"]').click()
            window = page.locator('#sp-sound')
            window.wait_for()
            assert 'Pad 3' in window.locator('h3').inner_text()
            window.get_by_role('button', name='+ Octave').click()
            page.wait_for_function('sampler.slots[2].pitch === 12')
            window.get_by_role('button', name='− Semitone').click()
            page.wait_for_function('sampler.slots[2].pitch === 11')
            window.locator('[data-fine]').fill('25')
            page.wait_for_function('Math.abs(sampler.slots[2].pitch - 11.25) < 1e-9')
            assert window.locator('[data-pitch-readout]').inner_text() == '+11 st'
            # Trim and volume through the same editor the sampler uses.
            window.locator('[data-sample="start"]').fill('0.5'); window.locator('[data-sample="start"]').dispatch_event('change')
            window.locator('[data-sample="volume"]').fill('0.6'); window.locator('[data-sample="volume"]').dispatch_event('change')
            page.wait_for_function('sampler.slots[2].start === 0.5 && sampler.slots[2].volume === 0.6')
            window.locator('[data-sample="reverse"]').check()
            page.wait_for_function('sampler.slots[2].reverse === true')
            window.get_by_role('button', name='▶ AUDITION').click()
            page.wait_for_timeout(200)
            # Reset puts the sound back exactly as it was when the window opened.
            window.get_by_role('button', name='Reset all changes').click()
            page.wait_for_function('!sampler.slots[2].pitch && sampler.slots[2].start === 0 && !sampler.slots[2].reverse')
            window.get_by_role('button', name='+ Semitone').click()
            page.wait_for_function('sampler.slots[2].pitch === 1')
            page.keyboard.press('Escape')
            window.wait_for(state='detached')
            assert page.evaluate('sampler.slots[2].pitch') == 1, 'changes stay after closing'

            # Rename, copy → paste onto another pad.
            pad.click(button='right'); page.locator('.im-menu [data-action="rename"]').click()
            page.wait_for_function('sampler.slots[2].name === "Snare 2"')
            pad.click(button='right'); page.locator('.im-menu [data-action="copy"]').click()
            page.locator('.ox-pad[data-pad="6"]').click(button='right'); page.locator('.im-menu [data-action="paste"]').click()
            page.wait_for_function('sampler.slots[6]?.name === "Snare 2" && sampler.slots[6].pitch === 1')

            # Clear with UNDO.
            pad.click(button='right'); page.locator('.im-menu [data-action="clear"]').click()
            page.wait_for_function('!sampler.slots[2]')
            page.locator('.im-toast .im-undo').last.click()
            page.wait_for_function('sampler.slots[2]?.name === "Snare 2" && sampler.slots[2].pitch === 1')

            out = ROOT / 'test-results'; out.mkdir(exist_ok=True)
            pad.click(button='right'); page.locator('.im-menu [data-action="edit"]').click()
            page.locator('#sp-sound').wait_for(); page.screenshot(path=str(out / 'pad-edit-sound.png'))
            page.set_viewport_size({'width': 390, 'height': 844}); page.wait_for_timeout(200)
            box = page.locator('#sp-sound').bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= 390, box
            page.screenshot(path=str(out / 'pad-edit-sound-phone.png'))
            page.locator('#sp-sound').get_by_role('button', name='DONE').click()
            assert not errors, errors
            print('PASS: pad right-click menu, edit sound window (octave/semitone/fine/trim/volume/reverse/reset), rename, copy/paste, clear + undo, phone width', flush=True)
            browser.close()
    finally:
        server.shutdown()
