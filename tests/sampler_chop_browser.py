"""Full song -> waveform snip -> audible pad, with isolated storage."""
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
from song_source_helpers import upload_song, open_song_chop

with tempfile.TemporaryDirectory(prefix='screwshop-chop-') as temp:
    audio = Path(temp) / 'Three minute song.wav'
    second = b''.join(struct.pack('<h', int(12000 * math.sin(i * 2 * math.pi * 220 / 44100))) for i in range(44100))
    with wave.open(str(audio), 'wb') as output:
        output.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
        output.writeframes(b''.join(second[i:i+2] * 2 for i in range(0, len(second), 2)) * 180)
    server = make_server(Path(temp) / 'store', port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            chrome = os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            browser = p.chromium.launch(executable_path=chrome, headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width': 1366, 'height': 900})
            errors = []
            transcripts = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('request', lambda r: transcripts.append(r.url) if '/api/transcript' in r.url else None)
            def capture():
                page.wait_for_function('!!window.StudioWorkspace')
                page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
                page.wait_for_function('window.sampler?.ready')
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            capture()
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            upload_song(page, audio, 'Three minute song')
            open_song_chop(page, 'Three minute song')
            page.wait_for_function('sampler.clipDuration() === 180')
            canvas = page.locator('#sp-clip canvas')
            box = canvas.bounding_box()
            y = box['y'] + box['height'] / 2
            page.mouse.move(box['x'] + box['width'] * .30, y)
            page.mouse.down()
            page.mouse.move(box['x'] + box['width'] * .32, y, steps=8)
            page.mouse.up()
            page.wait_for_function('sampler.clip.has && sampler.clipPlays > 0')
            start, end = page.evaluate('[sampler.clip.start,sampler.clip.end]')
            assert 53 < start < 55 and 56 < end < 59, (start, end)
            page.locator('[data-clip-pad="0"]').click()
            page.wait_for_function('sampler.slots[0] && sampler.clip.saved === 0')
            page.evaluate('sampler.saving')
            assert page.evaluate('sampler.slots[0].end-sampler.slots[0].start') < 5
            # Render the actual saved assignment and verify sound and silence after the snip.
            result = page.evaluate('''async () => {
                const audio=await sampler.renderAudio([{beats:16,events:[{lane:0,note:60,at:0,len:.25,velocity:100}]}],82);
                const data=audio.getChannelData(0);let peak=0,tail=0;
                for(let i=0;i<data.length;i++){if(i<audio.sampleRate*3)peak=Math.max(peak,Math.abs(data[i]));if(i>audio.sampleRate*5)tail=Math.max(tail,Math.abs(data[i]));}
                return {peak,tail};}''')
            assert result['peak'] > .05 and result['tail'] < .001, result
            assert not transcripts, 'Waveform chopping must not launch speech recognition'
            # Delayed words from a closed window cannot overwrite a newer window.
            page.evaluate('() => {sampler.transcript=()=>new Promise(resolve=>window.finishWords=resolve)}')
            page.locator('[data-clip=words]').click()
            page.wait_for_function('!!window.finishWords')
            page.locator('[data-clip=close]').click()
            open_song_chop(page, 'Three minute song')
            page.wait_for_function('sampler.clipDuration() === 180 && !sampler.clip.closed')
            page.evaluate('finishWords([{word:"old",start:0,end:1}])')
            assert page.evaluate('sampler.clip.words === null && !sampler.clip.loadingWords')
            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(250)
            assert page.evaluate('document.querySelector("#sp-clip").scrollWidth <= document.querySelector("#sp-clip").clientWidth + 1')
            page.locator('[data-clip=close]').click()
            page.reload()
            capture()
            saved = page.evaluate('sampler.slots[0]')
            assert abs(saved['start']-start) < .001 and abs(saved['end']-end) < .001
            page.wait_for_function('sampler.buffers.get(sampler.slots[0].url)?.duration === 180')
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
print('PASS: full-song upload, waveform selection, audible trimmed pad, original preserved, reload, optional words, stale completion, mobile layout')
