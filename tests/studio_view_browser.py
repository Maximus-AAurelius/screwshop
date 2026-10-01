"""STUDIO view: loop (cycle) drawn in either direction, moved, resized, switched off; deep zoom to single
samples; and the view staying put while playing unless FOLLOW is on. Isolated local store."""
import os, sys, tempfile, threading, wave, math, struct
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]; OUT = ROOT / 'test-results'; OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server
CHROME = os.environ.get('SS_CHROME')


def tone(path, secs, freq, sr=22050):
    with wave.open(str(path), 'wb') as w:
        w.setparams((1, 2, sr, 0, 'NONE', 'not compressed'))
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(i * 2 * math.pi * freq / sr))) for i in range(int(sr * secs))))


with tempfile.TemporaryDirectory() as temp:
    song = Path(temp) / 'Long song.wav'; tone(song, 90, 220)
    server = make_server(temp, port=0); threading.Thread(target=server.serve_forever, daemon=True).start()
    session = lambda: next((r for r in server.store.query({'table': 'settings'}) if r['id'] == 'recording-session'), None)
    try:
        with sync_playwright() as p:
            if not CHROME:
                CHROME = str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            b = p.chromium.launch(executable_path=CHROME, headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = b.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script('''(()=>{const f=Object.getOwnPropertyDescriptor;const d=window.RecordingStudio;})()''')
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.get_by_role('button', name='STUDIO', exact=True).click()
            with page.expect_file_chooser() as fc: page.get_by_role('button', name='IMPORT AUDIO', exact=True).click()
            fc.value.set_files(str(song))
            page.locator('[data-clip]').first.wait_for(timeout=20000)
            page.wait_for_function('document.querySelector("#gb-arrange canvas[data-clip-wave]")')
            st = 'window.__studio'
            # reach the studio instance through the app for assertions
            page.evaluate('''()=>{const el=document.getElementById('gb-arrange');window.__studio=Object.values(window).find(v=>v&&v.cycle&&v.tracks&&v.pps)||null;}''')
            if not page.evaluate('!!window.__studio'):
                page.evaluate('''()=>{const R=window.RecordingStudio.prototype;const t=R.tick;R.tick=function(){window.__studio=this;return t.call(this)}}''')
                page.wait_for_function('!!window.__studio')
            host = page.locator('#gb-arrange')
            beat = 60 / page.evaluate(f'{st}.bpm')

            # 1. Draw a loop RIGHT-TO-LEFT anywhere in the loop strip.
            strip = page.locator('.gb-cycle-strip').bounding_box()
            pps = page.evaluate(f'{st}.pps()')
            y = strip['y'] + strip['height'] / 2
            x_from, x_to = strip['x'] + 400, strip['x'] + 170
            page.mouse.move(x_from, y); page.mouse.down(); page.mouse.move(x_to, y, steps=8); page.mouse.up()
            page.wait_for_timeout(300)
            c = session()['cycle']
            assert c['on'] and abs(c['start'] - 170 / pps) < 2 / pps and abs(c['end'] - 400 / pps) < 2 / pps, c
            print('loop drawn right-to-left', round(c['start'], 3), round(c['end'], 3), flush=True)

            # 2. Drag the right edge to resize, then the middle to move it.
            region = page.locator('.gb-cycle-region').bounding_box()
            page.mouse.move(region['x'] + region['width'] - 1, y); page.mouse.down(); page.mouse.move(region['x'] + region['width'] + 120, y, steps=6); page.mouse.up()
            page.wait_for_timeout(300)
            c2 = session()['cycle']
            assert abs(c2['end'] - (c['end'] + 120 / pps)) < 3 / pps and abs(c2['start'] - c['start']) < 1e-6, c2
            region = page.locator('.gb-cycle-region').bounding_box()
            mid = region['x'] + region['width'] / 3
            page.mouse.move(mid, y); page.mouse.down(); page.mouse.move(mid + 90, y, steps=6); page.mouse.up()
            page.wait_for_timeout(300)
            c3 = session()['cycle']
            assert abs((c3['end'] - c3['start']) - (c2['end'] - c2['start'])) < 1e-6 and abs(c3['start'] - (c2['start'] + 90 / pps)) < 3 / pps, c3
            print('loop resized and moved', flush=True)

            # 3. Turn it off with its × button, on again by double-click, off with C.
            page.locator('[data-cycle-off]').click()
            page.wait_for_timeout(200)
            assert session()['cycle']['on'] is False
            region = page.locator('.gb-cycle-region').bounding_box()
            page.mouse.dblclick(region['x'] + region['width'] / 2, y)
            page.wait_for_timeout(200)
            assert session()['cycle']['on'] is True
            page.keyboard.press('c'); page.wait_for_timeout(200)
            assert session()['cycle']['on'] is False
            # A plain click in the strip doesn't leave a tiny accidental loop behind.
            page.mouse.click(strip['x'] + 700, y); page.wait_for_timeout(200)
            assert abs(session()['cycle']['start'] - c3['start']) < 1e-6
            print('loop on/off: button, double-click, C key; stray click ignored', flush=True)

            # 4. Deep zoom with Ctrl + scroll at the mouse, down to single samples.
            box = host.bounding_box()
            mx = box['x'] + 600
            page.mouse.move(mx, box['y'] + 120)
            t_under = page.evaluate(f'''(mx)=>{{const h=document.getElementById('gb-arrange');return (h.scrollLeft+mx-h.getBoundingClientRect().left-{st}.headW)/{st}.pps()}}''', mx)
            for _ in range(60):
                page.keyboard.down('Control'); page.mouse.wheel(0, -120); page.keyboard.up('Control')
            page.wait_for_timeout(300)
            zoom = page.evaluate(f'{st}.zoom'); pps = page.evaluate(f'{st}.pps()')
            assert pps >= 22050 * 0.5, ('not at sample level', pps)
            t_after = page.evaluate(f'''(mx)=>{{const h=document.getElementById('gb-arrange');return (h.scrollLeft+mx-h.getBoundingClientRect().left-{st}.headW)/{st}.pps()}}''', mx)
            assert abs(t_after - t_under) < 0.02, ('zoom did not stay under the mouse', t_under, t_after)
            assert page.evaluate('document.querySelector("#gb-arrange .gb-inner").offsetWidth') <= 16.5e6
            page.locator('#gb-arrange').screenshot(path=str(OUT / 'studio-deep-zoom.png'))
            print('deep zoom', round(pps), 'px/s, anchored at the mouse', flush=True)

            # 5. Playing does NOT move the view by default.
            page.evaluate(f'{st}.seek(0)')
            left0 = page.evaluate('document.getElementById("gb-arrange").scrollLeft')
            assert left0 > 1000, left0  # we are zoomed in somewhere past the start
            page.keyboard.press('Space') if False else page.evaluate(f'{st}.play()')
            page.wait_for_timeout(1500)
            assert page.evaluate(f'{st}.playing')
            left1 = page.evaluate('document.getElementById("gb-arrange").scrollLeft')
            assert left1 == left0, ('view moved while playing', left0, left1)
            page.evaluate(f'{st}.halt ? {st}.halt() : {st}.stop()')
            print('view stays put while playing', flush=True)

            # 6. FOLLOW turns page-turning on; it is remembered.
            page.get_by_role('button', name='Follow playhead').click()
            assert page.evaluate(f'{st}.follow') is True
            page.get_by_role('button', name='Fit whole song').click(); page.wait_for_timeout(200)
            for _ in range(8):
                page.get_by_role('button', name='Zoom in', exact=True).click()
            page.evaluate('document.getElementById("gb-arrange").scrollLeft=0')
            page.evaluate(f'{st}.seek(6)'); page.evaluate(f'{st}.play()')
            page.wait_for_timeout(2500)
            left2 = page.evaluate('document.getElementById("gb-arrange").scrollLeft')
            page.evaluate(f'{st}.halt ? {st}.halt() : {st}.stop()')
            assert left2 > 0, 'FOLLOW on should turn the page'
            page.wait_for_timeout(500)
            assert session()['follow'] is True
            page.get_by_role('button', name='Follow playhead').click()
            page.wait_for_timeout(400)
            assert session()['follow'] is False
            print('FOLLOW toggles page-turning and persists', flush=True)

            # 7. FIT zooms back out to the whole song.
            page.get_by_role('button', name='Fit whole song').click(); page.wait_for_timeout(300)
            W = page.evaluate('document.querySelector("#gb-arrange .gb-inner").offsetWidth'); vw = page.evaluate('document.getElementById("gb-arrange").clientWidth')
            assert W <= vw * 1.3, (W, vw)
            page.locator('.gb-cycle-strip').screenshot(path=str(OUT / 'studio-loop-strip.png'))
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert not errors, errors
            print('PASS: loop both directions/move/resize/off, zoom to samples at the mouse, view stays put, FOLLOW, FIT')
    finally:
        server.shutdown()
