"""Long split stems on pads: auto 4-bar window, bar-length buttons, and pads that cut their own last hit.

Reproduces the report: a full-split stem (minutes long) dropped on a pad played its whole length, so every
new hit or sequencer loop stacked another copy on top ("keeps playing over and over").
"""
import os, sys, tempfile, threading, wave, math, struct
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


def write_wav(path, seconds, silence, sr=8000):
    with wave.open(str(path), 'wb') as w:
        w.setparams((1, 2, sr, 0, 'NONE', 'not compressed'))
        w.writeframes(b''.join(struct.pack('<h', 0 if i < silence * sr else int(12000 * math.sin(i * 2 * math.pi * 110 / sr))) for i in range(int(seconds * sr))))


with tempfile.TemporaryDirectory() as temp:
    stem = Path(temp) / 'vocals stem.wav'
    write_wav(stem, 40, 5)          # 40 s "stem" whose sound starts at 5 s
    short = Path(temp) / 'short hit.wav'
    write_wav(short, 1, 0)
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
            assert page.evaluate('sampler.project.bpm') == 82
            bar = 4 * 60 / 82  # 2.927 s

            upload_song(page, stem, 'vocals stem')
            upload_song(page, short, 'short hit')

            # 1. A long stem lands as a 4-bar window starting where the sound starts, not at 0:00.
            load_song_pad(page, 'vocals stem', 4)
            page.wait_for_function('sampler.slots[4]?.end')
            slot = page.evaluate('sampler.slots[4]')
            assert abs(slot['start'] - 5) < 0.05, slot['start']
            assert abs((slot['end'] - slot['start']) - 4 * bar) < 0.01, slot
            assert 'first 4 bars' in page.locator('body').inner_text()
            assert '4.00 bars at 82 BPM' in page.locator('[data-length-readout]').inner_text()

            # 2. A short sound is left whole.
            load_song_pad(page, 'short hit', 0)
            page.wait_for_function('sampler.slots[0]?.end')
            s0 = page.evaluate('sampler.slots[0]')
            assert s0['start'] == 0 and abs(s0['end'] - 1) < 0.01, s0

            # 3. Bar buttons set exact lengths; with pitch down 12 the source window halves so playback stays 1 bar.
            page.locator('.ox-pad[data-pad="4"]').click()
            page.locator('.sp-editor [data-bars="1"]').click()
            s4 = page.evaluate('sampler.slots[4]')
            assert abs((s4['end'] - s4['start']) - bar) < 0.01, s4
            page.locator('.sp-editor [data-sample="pitch"]').fill('-12')
            page.locator('.sp-editor [data-sample="pitch"]').dispatch_event('change')
            page.locator('.sp-editor [data-bars="1"]').click()
            s4 = page.evaluate('sampler.slots[4]')
            assert abs((s4['end'] - s4['start']) - bar / 2) < 0.01, s4
            assert '1.00 bars' in page.locator('[data-length-readout]').inner_text()
            page.locator('.sp-editor [data-bars="whole"]').click()
            s4 = page.evaluate('sampler.slots[4]')
            assert s4['start'] == 0 and abs(s4['end'] - 40) < 0.01
            page.locator('.sp-editor [data-sample="pitch"]').fill('0')
            page.locator('.sp-editor [data-sample="pitch"]').dispatch_event('change')

            # 4. Hitting the pad again cuts the previous hit: never more than one live copy per pad.
            for _ in range(4):
                page.evaluate('sampler.press(4,60,100,"t"+Math.random())')
                page.wait_for_timeout(120)
            page.wait_for_timeout(200)
            live = page.evaluate('[...sampler.voices].filter(v=>v.lane===4&&(v.stopTime==null||v.stopTime>v.ctx.currentTime)).length')
            assert live == 1, live
            # With "Cut itself" off, hits overlap again (for sounds you want to layer).
            page.locator('.sp-editor [data-sample="mono"]').uncheck()
            page.evaluate('sampler.panic()')
            for _ in range(3):
                page.evaluate('sampler.press(4,60,100,"u"+Math.random())')
                page.wait_for_timeout(120)
            live = page.evaluate('[...sampler.voices].filter(v=>v.lane===4&&(v.stopTime==null||v.stopTime>v.ctx.currentTime)).length')
            assert live == 3, live
            page.locator('.sp-editor [data-sample="mono"]').check()
            page.evaluate('sampler.panic()')

            # 5. The sequencer looping a 40 s sound every beat keeps one copy, and Stop silences it.
            page.evaluate('''()=>{const p=sampler.pattern;p.events=[0,1,2,3].map(a=>({id:crypto.randomUUID(),lane:4,note:60,at:a,len:.25,velocity:100}));sampler.project.countIn=false;sampler.project.bpm=240;sampler.changed();}''')
            page.evaluate('sampler.action("play")')
            page.wait_for_timeout(2600)
            live = page.evaluate('[...sampler.voices].filter(v=>v.lane===4&&(v.stopTime==null||v.stopTime>v.ctx.currentTime)).length')
            assert live == 1, live
            page.evaluate('sampler.action("stop")')
            page.wait_for_timeout(100)
            assert page.evaluate('[...sampler.voices].filter(v=>v.lane===4&&(v.stopTime==null||v.stopTime>v.ctx.currentTime)).length') == 0

            # 6. The window and the setting survive a reload.
            page.wait_for_timeout(1500)
            page.reload()
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            assert page.evaluate('sampler.slots[4].mono') is True

            out = ROOT / 'test-results'
            out.mkdir(exist_ok=True)
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('.ox-pad[data-pad="4"]').click()
            page.locator('.sp-editor [data-bars="4"]').click()
            page.locator('#ss-sampler .sp-editor').screenshot(path=str(out / 'sampler-length.png'))
            assert not errors, errors
            print('PASS: long stems land as 4 bars from first sound, bar buttons (pitch-aware), pads cut their own last hit, sequencer never stacks copies, settings persist')
    finally:
        server.shutdown()
