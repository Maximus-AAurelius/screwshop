"""Oxygen pad mapping: hardware pad N must light and play on-screen pad N.

Covers the bug seen on the real keyboard: the drawing had pads 1-4 on the top row (hardware has them
on the bottom), and the pad notes were old guesses, so e.g. hardware pad 7 lit on-screen pad 5.
Uses simulated MIDI (no hardware needed) and an isolated temporary store.
"""
import os, sys, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server

# Old guesses that were saved in the real project, and a plausible hardware layout that disagrees with them.
OLD_MAP = [36, 38, 42, 46, 49, 45, 41, 39]
HARDWARE_BANK1 = [36, 38, 42, 46, 43, 47, 49, 51]
HARDWARE_BANK2 = [44, 45, 48, 50, 52, 53, 55, 57]


def chrome_path():
    if os.environ.get('SS_CHROME'):
        return os.environ['SS_CHROME']
    return str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])


with tempfile.TemporaryDirectory() as temp:
    server = make_server(temp, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path(), headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width': 1600, 'height': 1000})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()

            def box(lane):
                return page.locator(f'#ss-sampler .ox-pad[data-pad="{lane}"]').bounding_box()

            def hit(note, channel=9):
                """Press and hold a pad; return the on-screen pad numbers (1-based) that light."""
                page.evaluate(f'sampler.midi([{0x90 + channel},{note},100])')
                page.wait_for_timeout(120)
                lit = page.evaluate('[...document.querySelectorAll("#ss-sampler .ox-pad.hit")].map(e=>+e.dataset.pad+1)')
                readout = page.locator('[data-readout]').inner_text()
                page.evaluate(f'sampler.midi([{0x80 + channel},{note},0])')
                page.wait_for_timeout(40)
                return lit, readout

            # 1. Layout matches the hardware: 1-4 bottom row, 5-8 top row, left to right.
            b = [box(i) for i in range(8)]
            assert all(b[i]['y'] > b[i + 4]['y'] + 10 for i in range(4)), 'pads 1-4 must be below pads 5-8'
            assert all(abs(b[i]['x'] - b[i + 4]['x']) < 2 for i in range(4)), 'pad N and N+4 share a column'
            assert all(b[i + 1]['x'] > b[i]['x'] for i in (0, 1, 2, 4, 5, 6)), 'numbers run left to right'

            # 2. Reproduce the reported symptom with the old saved guesses.
            page.evaluate(f'''() => {{sampler.project.maps={{}};{OLD_MAP}.forEach((n,i)=>sampler.project.maps['pad:'+i]={{type:144,channel:9,number:n}});sampler.draw();}}''')
            lit, readout = hit(HARDWARE_BANK1[6])  # hardware pad 7
            assert lit == [5], lit
            assert 'note 49' in readout and 'Pad 5' in readout, readout
            lit, readout = hit(HARDWARE_BANK1[4])  # hardware pad 5 sends a note nobody learned
            assert lit == [] and 'not learned' in readout, readout

            # 3. LEARN ALL 8 PADS fixes it: hit hardware pads 1..8 in order.
            page.get_by_role('button', name='Learn all 8 pads').click()
            assert 'ox-learn' in page.locator('.ox-pad[data-pad="0"]').get_attribute('class')
            assert 'hit PAD 1' in page.locator('[data-readout]').inner_text()
            for i, note in enumerate(HARDWARE_BANK1):
                if i == 3:  # an accidental double hit on the previous pad is ignored, not mapped to pad 4
                    page.evaluate(f'sampler.midi([0x99,{HARDWARE_BANK1[2]},100])')
                    assert 'already learned' in page.locator('[data-readout]').inner_text()
                    assert page.evaluate('sampler.padWalk.index') == 3
                page.evaluate(f'sampler.midi([0x99,{note},100])')
            assert page.evaluate('sampler.padWalk') is None
            maps = page.evaluate('sampler.project.maps')
            assert [maps[f'pad:{i}']['number'] for i in range(8)] == HARDWARE_BANK1, maps
            assert len({(m['channel'], m['number']) for m in maps.values()}) == len(maps), 'no duplicate notes'
            for i, note in enumerate(HARDWARE_BANK1):
                lit, readout = hit(note)
                assert lit == [i + 1], (i + 1, lit)
                assert f'Pad {i + 1}' in readout, readout
                # The lit pad is in the right place: bottom row for 1-4, top row for 5-8.
                row = 'bottom' if box(i)['y'] > box((i + 4) % 8)['y'] else 'top'
                assert row == ('bottom' if i < 4 else 'top'), (i + 1, row)

            # 4. Single MIDI Learn steals the note from the old pad instead of leaving a duplicate.
            page.locator('.ox-pad[data-pad="2"]').click()
            page.get_by_role('button', name='MIDI Learn selected').click()
            page.evaluate(f'sampler.midi([0x99,{HARDWARE_BANK1[0]},100])')
            maps = page.evaluate('sampler.project.maps')
            assert maps['pad:2']['number'] == HARDWARE_BANK1[0] and 'pad:0' not in maps, maps
            assert hit(HARDWARE_BANK1[0])[0] == [3]

            # 5. Bank 2: learn pads 9-16; a bank-2 hit flips the drawing to bank 2 and lights the right pad.
            page.get_by_role('button', name='BANK 2 · PADS 9–16').click()
            page.get_by_role('button', name='Learn all 8 pads').click()
            assert 'ox-learn' in page.locator('.ox-pad[data-pad="8"]').get_attribute('class')
            for note in HARDWARE_BANK2:
                page.evaluate(f'sampler.midi([0x99,{note},100])')
            page.get_by_role('button', name='BANK 1 · PADS 1–8').click()
            lit, readout = hit(HARDWARE_BANK2[5])
            assert page.evaluate('sampler.ui.bank') == 1 and lit == [14], lit

            # 6. The learned map is saved with the project.
            page.wait_for_timeout(1500)
            page.reload()
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            saved = page.evaluate('sampler.project.maps')
            assert saved['pad:13']['number'] == HARDWARE_BANK2[5] and saved['pad:6']['number'] == HARDWARE_BANK1[6], saved

            out = ROOT / 'test-results'
            out.mkdir(exist_ok=True)
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()
            page.get_by_role('button', name='BANK 1 · PADS 1–8').click()
            page.evaluate(f'sampler.midi([0x99,{HARDWARE_BANK1[1]},100])')
            page.wait_for_timeout(150)
            page.locator('#ss-sampler .sp-oxygen').screenshot(path=str(out / 'oxygen-pad-mapping.png'))
            assert not errors, errors
            print('PASS: pad rows match hardware, readout shows notes, Learn all 8 pads maps both banks with no duplicates, map persists')
    finally:
        server.shutdown()
