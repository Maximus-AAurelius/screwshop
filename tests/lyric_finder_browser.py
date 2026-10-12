"""Find lyric: type the lines you want, and the sampler trims a pad or chops each line onto its own pad.

Uses Windows text-to-speech for a vocal with known words, and the real Whisper model
(reused from data/models/whisper so the test does not download it again).
"""
import os, subprocess, sys, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server
import lyric_finder
from song_source_helpers import upload_song, load_song_pad, song_row, open_song_chop


def chrome_path():
    if os.environ.get('SS_CHROME'):
        return os.environ['SS_CHROME']
    return str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])


SPOKEN = "Yeah, this is the intro, we riding slow down south. I know you strapped, but you still a punk. You talking bumpkin cause I know you ain't nothing. Hold up, pass the cup, we keep it trill."
TYPED = "I know you strapped, but you still a punk\nYa talkin' bumpkin cause I know you ain't nothing"

with tempfile.TemporaryDirectory() as temp:
    vocal = Path(temp) / 'ugk vocals.wav'
    subprocess.run(['powershell', '-NoProfile', '-Command', f"Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.SetOutputToWaveFile('{vocal}');$s.Speak('{SPOKEN.replace(chr(39), chr(39) * 2)}');$s.Dispose()"], check=True)
    from faster_whisper import WhisperModel
    lyric_finder._model = WhisperModel(lyric_finder.MODEL, device='cpu', compute_type='int8', download_root=str(ROOT / 'data/models/whisper'))
    server = make_server(Path(temp) / 'data', port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path(), headless=True)
            page = browser.new_page(viewport={'width': 1600, 'height': 1000})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()
            upload_song(page, vocal, 'ugk vocals')
            load_song_pad(page, 'ugk vocals', 0)
            page.wait_for_function('sampler.slots[0]?.end')
            page.locator('.ox-pad[data-pad="0"]').click()
            page.get_by_role('button', name='SONGS', exact=True).click()
            row = song_row(page, 'ugk vocals')

            # 1. Library: an open ⋮ menu survives the 5-second background refresh and a redraw.
            row.locator('[data-row-menu]').click()
            page.evaluate('sampler.refreshLibrary()')
            page.wait_for_timeout(300)
            page.evaluate("sampler.app.songLibrary.signature='';sampler.app.songLibrary.refresh()")
            assert page.locator('.im-menu [data-action="chop"]').is_visible(), 'Actions menu closed after a redraw'
            page.keyboard.press('Escape')
            assert page.locator('.im-menu').count() == 0

            # 2. Clip words -> pad, from the library menu: tap the first and last word, hear it, save it.
            before = page.evaluate('sampler.slots[0]')
            open_song_chop(page, 'ugk vocals')
            page.locator('#sp-clip [data-clip=words]').click()
            page.wait_for_function('sampler.clip?.words?.length', timeout=180000)
            words = page.evaluate('sampler.clip.words.map(w => w.word.toLowerCase().replace(/[^a-z]/g, ""))')
            first, last = words.index('still'), words.index('punk')
            page.locator(f'#sp-clip [data-word="{first}"]').click()
            page.locator(f'#sp-clip [data-word="{last}"]').click()
            page.wait_for_function('sampler.clipPlays >= 1')
            clip = page.evaluate('({a: sampler.clip.a, b: sampler.clip.b, start: sampler.clip.start, end: sampler.clip.end, target: sampler.clip.target})')
            assert (clip['a'], clip['b']) == (first, last) and clip['target'] == 1, clip  # pad 1 holds the song, so pad 2 is offered
            heard = page.evaluate('sampler.clip.words')
            assert heard[first - 1]['end'] - 0.001 <= clip['start'] <= heard[first]['start'], (clip, heard[first - 1:first + 1])
            assert heard[last]['end'] <= clip['end'] <= heard[last]['end'] + 0.121, clip
            page.locator('#sp-clip [data-nudge="end:1"]').click()
            assert abs(page.evaluate('sampler.clip.end') - clip['end'] - 0.03) < 0.001
            page.locator('#sp-clip [data-clip=save]').click()
            page.wait_for_function('sampler.slots[1]?.lyric && /Saved/.test(sampler.clip.status)')
            pad = page.evaluate('sampler.slots[1]')
            assert pad['lyric'].lower().startswith('still') and 'punk' in pad['lyric'].lower(), pad
            assert pad['url'] == page.evaluate('sampler.slots[0].url') and pad['end'] - pad['start'] < 2, pad
            assert page.evaluate('sampler.slots[0]') == before, 'the source pad must stay untouched'
            assert page.evaluate('sampler.clip.target') == 2, 'the next empty pad is offered after saving'
            page.locator('#sp-clip [data-clip=test]').click()  # Hit Pad 2 plays the saved clip
            page.wait_for_timeout(100)

            # 3. Typed lines -> each line on its own pad (reuses the cached transcript).
            page.locator('#sp-clip [data-clip-find]').fill(TYPED)
            page.locator('#sp-clip [data-clip=find]').click()
            page.wait_for_function('/Found/.test(sampler.clip.status)', timeout=20000)
            page.locator('#sp-clip [data-clip=lines]').click()
            page.wait_for_function('sampler.slots[3]?.lyric', timeout=10000)
            s2, s3 = page.evaluate('[sampler.slots[2], sampler.slots[3]]')
            total = page.evaluate('sampler.buffers.get(sampler.slots[0].url).duration')
            assert 2 < s2['start'] < s2['end'] <= s3['start'] + 0.3 < s3['end'] < total - 1.5, (s2, s3, total)
            assert s3['lyric'].lower().startswith('you talking'), s3

            # 4. Words that are not in the sound give a clear message, not a crash.
            page.locator('#sp-clip [data-clip-find]').fill('diamonds and wood candy paint')
            page.locator('#sp-clip [data-clip=find]').click()
            page.wait_for_function('/Couldn.t find those words/.test(sampler.clip.status)', timeout=10000)
            assert page.locator('#sp-clip [data-clip-status].error').count() == 1

            # 4b. Waveform track: drag to highlight, tap a pad, drag the highlight onto a pad, zoom.
            wave = page.locator('#sp-clip .sp-wave-scroll canvas')
            box = wave.bounding_box()
            duration = page.evaluate('sampler.clipDuration()')
            y = box['y'] + box['height'] / 2
            page.mouse.move(box['x'] + box['width'] * 0.25, y)
            page.mouse.down()
            page.mouse.move(box['x'] + box['width'] * 0.32, y, steps=4)
            page.mouse.move(box['x'] + box['width'] * 0.40, y, steps=4)
            page.mouse.up()
            page.wait_for_function('sampler.clip.has && /Highlighted/.test(sampler.clip.status)')
            start, end = page.evaluate('[sampler.clip.start, sampler.clip.end]')
            assert abs(start - duration * 0.25) < 0.1 and abs(end - duration * 0.40) < 0.1, (start, end, duration)
            plays = page.evaluate('sampler.clipPlays')
            page.locator('#sp-clip [data-clip-pad="5"]').click()
            page.wait_for_function('sampler.slots[5] && /Pad 6/.test(sampler.clip.status)')
            assert abs(page.evaluate('sampler.slots[5].start') - start) < 0.001 and abs(page.evaluate('sampler.slots[5].end') - end) < 0.001
            # Drag a yellow edge to make the highlight shorter, then drop the highlight chip on pad 8.
            edge_x = box['x'] + box['width'] * 0.40
            page.mouse.move(edge_x, y); page.mouse.down(); page.mouse.move(edge_x - box['width'] * 0.05, y, steps=5); page.mouse.up()
            page.wait_for_function(f'sampler.clip.end < {end - 0.1}')
            assert abs(page.evaluate('sampler.clip.start') - start) < 0.001, 'dragging the end edge keeps the start'
            page.locator('#sp-clip [data-clip-chip]').drag_to(page.locator('#sp-clip [data-clip-pad="7"]'))
            page.wait_for_function('sampler.slots[7] && Math.abs(sampler.slots[7].end - sampler.clip.end) < 0.001')
            # Clicking without dragging listens from that point; the highlight stays.
            page.mouse.click(box['x'] + box['width'] * 0.8, y)
            page.wait_for_function(f'sampler.clipPlays > {plays + 1}')
            assert page.evaluate('sampler.clip.has')
            # Zoom: + doubles, Ctrl+wheel zooms at the mouse, Fit returns to the whole sound.
            fit = page.evaluate('sampler.fitZoom()')
            page.locator('#sp-clip [data-clip=zoom-in]').click()
            assert abs(page.evaluate('sampler.clip.zoom') - fit * 2) < 0.01
            page.mouse.move(box['x'] + box['width'] * 0.5, y)
            page.keyboard.down('Control'); page.mouse.wheel(0, -300); page.keyboard.up('Control')
            assert page.evaluate('sampler.clip.zoom') > fit * 2.5
            page.locator('#sp-clip [data-clip=zoom-sel]').click()
            assert page.evaluate('sampler.clip.zoom') > fit * 4
            page.locator('#sp-clip [data-clip=fit]').click()
            assert page.evaluate('sampler.clip.zoom') == 0
            assert page.evaluate("document.querySelector('#sp-clip canvas').width") > 0

            # 5. Phone width: the clip window and its words fit without sideways scrolling.
            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(300)
            box = page.locator('#sp-clip').bounding_box()
            assert box and box['x'] >= 0 and box['x'] + box['width'] <= 390, box
            assert page.evaluate("document.querySelector('#sp-clip').scrollWidth <= document.querySelector('#sp-clip').clientWidth + 1")
            if os.environ.get('SS_SHOTS'):
                page.locator('#sp-clip').screenshot(path=os.path.join(os.environ['SS_SHOTS'], 'clip-words-phone.png'))
            page.locator('#sp-clip [data-clip=close]').click()
            page.set_viewport_size({'width': 1600, 'height': 1000})

            # 6. The pad editor button opens the same window for the selected pad's sound.
            page.evaluate('sampler.selected = 0; sampler.drawEditor()')
            page.locator('.sp-editor [data-action=lyric-clip]').click()
            page.wait_for_function('sampler.clip?.words?.length && document.querySelector("#sp-clip").open')
            assert page.evaluate('sampler.clip.target') == 4, 'pads 2-4 hold clips, so pad 5 is offered'
            page.keyboard.press('Escape')
            open_song_chop(page, 'ugk vocals')
            page.wait_for_function('document.querySelector("#sp-clip").open && sampler.clip.words?.length')
            page.keyboard.press('Escape')
            page.locator('[data-action=jump-editor]').click()
            page.wait_for_timeout(700)
            ed, view = page.locator('.sp-editor').bounding_box(), page.locator('.sp-playing').bounding_box()
            assert view['y'] - 2 <= ed['y'] <= view['y'] + view['height'] - 40, (ed, view)
            assert 'Pad 1' in page.locator('[data-action=jump-editor]').text_content()

            # 7. Saved clips survive a reload.
            page.wait_for_function('sampler.status === "Saved locally"')
            page.reload()
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            assert 'punk' in page.evaluate('sampler.slots[1].lyric').lower()
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
print('PASS: library menu survives refresh, waveform chop (drag, edges, pad tap, drop, zoom), clip words -> pad (tap, hear, nudge, save, hit), lines -> pads, not found, phone width, reload')
