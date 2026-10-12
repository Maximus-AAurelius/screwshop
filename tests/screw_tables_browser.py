"""SCREW turntable layer: scrolling waveforms, per-table SLOW (drag / wind-down, 0.02-4 s), flick, lag,
run-back with two different records, TAPE (live + rendered), phone width and page errors."""
import math, os, sys, tempfile, threading, wave, json
import numpy as np
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server

def write(path, sig):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100); w.writeframes((sig * 9000).astype('<i2').tobytes())

with tempfile.TemporaryDirectory() as temp:
    server = make_server(temp, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        t = np.arange(44100 * 40) / 44100; b = t * 1.5; ph = b % 1
        beat = Path(temp) / 'beat90.wav'
        write(beat, 0.6 * np.exp(-ph * 30) * np.sin(2 * np.pi * 1000 * t) + 0.25 * np.sin(2 * np.pi * 220 * (1 + (np.floor(b / 4) % 4) * .25) * t))
        other = Path(temp) / 'other.wav'
        write(other, 0.5 * np.sin(2 * np.pi * 330 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 2 * t)))
        shots = ROOT / 'test-results'; shots.mkdir(exist_ok=True)
        with sync_playwright() as p:
            browsers = sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))
            browser = p.chromium.launch(executable_path=str(browsers[-1]), headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script("""Object.defineProperty(window,'ScrewRoom',{configurable:true,set(C){Object.defineProperty(window,'ScrewRoom',{value:class extends C {constructor(a){super(a);window.testRoom=this;}},writable:true});}});""")
            page.add_init_script("try{localStorage.removeItem('screwshop.tables.v1')}catch(e){}")
            base = f'http://127.0.0.1:{server.server_port}'
            page.goto(base + '/barwork'); page.get_by_role('button', name='SCREW', exact=True).click()
            page.wait_for_function('window.testRoom?.app.sb && !window.testRoom.stems.restoring')
            with page.expect_file_chooser() as fc: page.get_by_role('button', name='LOAD SONG FILE', exact=True).click()
            fc.value.set_files(str(beat))
            page.wait_for_function('!testRoom.loading && testRoom.app._deckB.buffer===testRoom.app._deckA.buffer')

            # 1) Turntable layout is there.
            assert page.locator('.tt-waves canvas').count() == 1 and page.locator('.tt-ctrl').count() == 2 and page.locator('.tt-cut').count() == 1
            page.get_by_role('button', name='▶ PLAY / PAUSE').click()
            page.wait_for_function('testRoom.app.state.deckA.playing')
            page.wait_for_timeout(500)
            lit = page.evaluate("""()=>{const c=document.querySelector('.tt-waves canvas'),x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<x.length;i+=4)if(x[i]+x[i+1]+x[i+2]>200)n++;return n;}""")
            assert lit > 2000, lit

            # 2) SLOW TIME runs 0.02 s .. 4 s.
            page.get_by_label('Table A slow time').fill('0'); assert page.evaluate('testRoom.tables.settings.A.time') == 0.02
            page.get_by_label('Table A slow time').fill('1'); assert page.evaluate('testRoom.tables.settings.A.time') == 4
            assert '4.00 s' in page.locator('#turntable-A .tt-ctrl').inner_text()

            # 3) DRAG on A only: hold Q, A slows by the depth over the slow time, B keeps going; release returns.
            page.get_by_label('Table A slow time').fill('0.565')
            page.get_by_label('Table A drag depth').fill('50')
            page.keyboard.down('q'); page.wait_for_timeout(250)
            mid = page.evaluate('testRoom.app._deckA.rate'); assert .5 < mid < .99, mid
            page.wait_for_timeout(400)
            r = page.evaluate('[testRoom.app._deckA.rate,testRoom.app._deckB.rate,testRoom.app.state.deckB.playing]')
            assert abs(r[0] - .5) < .01 and r[1] == 1, r
            page.keyboard.up('q'); page.wait_for_timeout(600)
            assert abs(page.evaluate('testRoom.app._deckA.rate') - 1) < 1e-6
            print('Per-table DRAG slows one side over the slow time and comes back')

            # 4) Flick and lag: hold F to hear B, release returns to A; G puts B a beat behind.
            page.keyboard.press('g'); page.wait_for_timeout(300)
            gap = page.evaluate('(testRoom.app.deckPosition("A")-testRoom.app.deckPosition("B"))/(60/testRoom.app._deckA.bpm)')
            assert abs(gap - 1) < .03, gap
            assert '1.00 beat behind' in page.locator('[data-tt-lagread]').inner_text()
            assert page.evaluate('testRoom.app.state.crossfade') == -1
            page.keyboard.down('f'); page.wait_for_timeout(80); assert page.evaluate('testRoom.app.state.crossfade') == 1
            page.keyboard.up('f'); page.wait_for_timeout(80); assert page.evaluate('testRoom.app.state.crossfade') == -1
            page.locator('[data-tt-cut=B]').click(); assert page.evaluate('testRoom.live()') == 'B'
            page.locator('[data-tt-cut=A]').click()
            print('Lag, flick and cut pads chop between the tables')

            # 5) STOP on B at the shortest time: B winds down and pauses, A keeps playing, B's speed is restored.
            page.locator('#turntable-B [data-tt-mode=stop]').click()
            page.get_by_label('Table B slow time').fill('0')
            page.keyboard.press('p'); page.wait_for_timeout(250)
            s = page.evaluate('[testRoom.app.state.deckB.playing,testRoom.app.state.deckA.playing,testRoom.app._deckB.rate]')
            assert s == [False, True, 1], s
            # STOP at 4 s is still winding after 1 s, at a lower speed.
            page.get_by_role('button', name='Deck B playback').click(); page.wait_for_function('testRoom.app.state.deckB.playing')
            page.get_by_label('Table B slow time').fill('1'); page.keyboard.press('p'); page.wait_for_timeout(1000)
            s = page.evaluate('[testRoom.app.state.deckB.playing,testRoom.app._deckB.rate]')
            assert s[0] and .6 < s[1] < .85, s
            page.get_by_role('button', name='■ STOP', exact=True).click()
            assert page.evaluate('testRoom.app._deckB.rate') == 1
            print('STOP winds a table down from 0.02 s to 4 s')

            # 6) TAPE: live chain follows the knob; a rendered version with tape has sound and keeps the length.
            page.get_by_label('Table A tape').fill('60')
            assert abs(page.evaluate('testRoom.app._deckA.tape.value') - .6) < 1e-9
            page.get_by_label('Record speed', exact=True).fill('0.75')
            page.wait_for_function('Math.abs(testRoom.app._deckA.rate-.75)<1e-6')
            page.locator('[name=ss-style][value=slowed]').check()
            page.get_by_role('button', name='BUILD VERSION').click()
            page.wait_for_function('testRoom.version', timeout=60000)
            v = page.evaluate('(()=>{const b=testRoom.version.buffer,d=b.getChannelData(0);let p=0;for(let i=44100;i<88200;i++)p=Math.max(p,Math.abs(d[i]));return [b.duration,p];})()')
            assert abs(v[0] - (40 / .75 + .25)) < .1 and v[1] > .05, v
            print('TAPE runs live and in rendered versions:', v)

            # 6b) Pads: B defaults to SLOW steps (−0.01 …), A to CHOP. Steps add up exactly; 1.00× resets.
            page.get_by_label('Deck B speed').fill('1'); page.wait_for_function('testRoom.app._deckB.rate===1')
            for label in ('−0.01', '−0.01', '−0.03'):
                page.get_by_label('Table B pad ' + label, exact=True).click()
            page.wait_for_function('Math.abs(testRoom.app._deckB.rate-.95)<1e-9 && Math.abs(testRoom.app._deckA.rate-.75)<1e-9')
            page.get_by_label('Table B pad −0.08', exact=True).click(); page.wait_for_function('Math.abs(testRoom.app._deckB.rate-.87)<1e-9')
            page.get_by_label('Table B back to 1.00×').click(); page.wait_for_function('testRoom.app._deckB.rate===1')
            assert page.locator('#turntable-A .tt-pad-grid button').first.inner_text() == '½ BEAT'
            page.locator('#turntable-A [data-pad-mode=slow]').click()
            assert page.locator('#turntable-A .tt-pad-grid button').first.inner_text() == '−0.01'
            page.locator('#turntable-A [data-pad-mode=chop]').click()
            page.get_by_role('button', name='▶ PLAY / PAUSE').click(); page.wait_for_function('testRoom.app.state.deckA.playing')
            page.wait_for_timeout(2500)
            page.get_by_label('Table A pad 1 BEAT', exact=True).click(); page.wait_for_timeout(100)
            assert page.evaluate('testRoom.live()') == 'B'
            print('Speed pads step B by 0.01s and reset; chop pads run it back')

            # 6c) Jog wheel: grab the top, turn it backwards and forwards; the record follows and makes sound;
            # holding still stops it; letting go drops it back in at speed.
            page.evaluate("""()=>{const a=testRoom.app,ctx=a._Tone.getContext().rawContext;window.jogMeter=ctx.createAnalyser();window.jogMeter.fftSize=2048;}""")
            page.locator('#turntable-A').scroll_into_view_if_needed()
            box = page.locator('#vinyl-A').bounding_box(); cx, cy, R = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2, box['width'] / 2 * .55
            page.mouse.move(cx, cy - R); page.mouse.down()
            page.wait_for_function('!!testRoom.app._deckA.scratch?.win')
            page.evaluate('testRoom.app._deckA.scratchNode.connect(window.jogMeter)')
            start = page.evaluate('testRoom.app._deckA.scratch.pos')
            peak = 0
            for i in range(1, 25):  # a quarter turn counter-clockwise = record pulled back ~0.45 s
                ang = -math.pi / 2 - i * (math.pi / 2) / 24
                page.mouse.move(cx + R * math.cos(ang), cy + R * math.sin(ang)); page.wait_for_timeout(12)
                peak = max(peak, page.evaluate('(()=>{const d=new Float32Array(2048);jogMeter.getFloatTimeDomainData(d);return d.reduce((m,x)=>Math.max(m,Math.abs(x)),0);})()'))
            back = page.evaluate('testRoom.app._deckA.scratch.pos')
            assert abs((start - back) - .45) < .03 and not page.evaluate('testRoom.app.state.deckA.playing'), (start, back)
            assert peak > .02, peak
            page.mouse.up(); page.wait_for_function('!testRoom.app._deckA.scratch && testRoom.app.state.deckA.playing')
            page.evaluate('testRoom.app._deckA.scratchNode.disconnect(window.jogMeter)')
            page.get_by_role('button', name='■ STOP', exact=True).click()
            print('Jog wheel scratches backwards with sound, then drops back in:', round(start - back, 3), 's back, peak', round(peak, 3))

            # 7) Different records on A and B: run-back jumps the live table itself; flick goes between songs.
            with page.expect_file_chooser() as fc: page.get_by_role('button', name='Load deck B').click()
            fc.value.set_files(str(other)); page.wait_for_function('testRoom.app.state.deckB.fileName==="other.wav" && testRoom.app._deckB.buffer!==testRoom.app._deckA.buffer')
            page.locator('[data-tt-cut=A]').click(); page.get_by_role('button', name='▶ PLAY / PAUSE').click(); page.wait_for_function('testRoom.app.state.deckA.playing')
            page.wait_for_timeout(3000)
            before = page.evaluate('testRoom.app.deckPosition("A")')
            page.keyboard.press('x'); page.wait_for_timeout(50)
            after = page.evaluate('testRoom.app.deckPosition("A")')
            assert before - after > .5, (before, after)
            page.keyboard.down('f'); page.wait_for_timeout(50); assert page.evaluate('testRoom.app.state.crossfade') == 1; page.keyboard.up('f')
            page.evaluate("document.querySelector('.tt-waves').scrollIntoView()"); page.wait_for_timeout(300)
            page.screenshot(path=str(shots / 'screw-tables-desktop.png'))
            page.get_by_role('button', name='■ STOP', exact=True).click()
            print('Two different records: run-back and flick work')

            page.set_viewport_size({'width': 390, 'height': 900}); page.wait_for_timeout(300)
            page.evaluate("document.querySelector('#turntable-A').scrollIntoView()"); page.wait_for_timeout(200)
            assert page.evaluate('document.documentElement.scrollWidth') <= 391, page.evaluate('document.documentElement.scrollWidth')
            page.screenshot(path=str(shots / 'screw-tables-phone.png'), full_page=False)
            assert not errors, errors
            print('Phone width and browser errors passed')
            browser.close()
    finally:
        server.shutdown()
