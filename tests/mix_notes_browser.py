"""MIXER -> MIX NOTES: add notes (whole song / per track, pinned to the playhead), tick done,
jump to a note's time, delete, survive a reload, and fit a phone screen. Isolated temporary library."""
import os, sys, tempfile, threading, time, wave, math, struct
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]; OUT = ROOT / 'test-results'; OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server
CHROME = os.environ.get('SS_CHROME')


def tone(path, secs, freq, amp=7000):
    with wave.open(str(path), 'wb') as w:
        w.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
        w.writeframes(b''.join(struct.pack('<h', int(amp * math.sin(i * 2 * math.pi * freq / 44100))) for i in range(int(44100 * secs))))


def open_studio(page, port):
    page.goto(f'http://127.0.0.1:{port}/barwork')
    page.wait_for_function('!!window.SongLibrary')
    page.evaluate('''() => { const refresh=SongLibrary.prototype.refresh;
      SongLibrary.prototype.refresh=function(){window.libraryUI=this;return refresh.call(this)}; }''')
    page.get_by_role('button', name='SONGS', exact=True).click()
    page.wait_for_function('window.libraryUI?.app.workspace.ready', timeout=15000)
    page.get_by_role('button', name='STUDIO', exact=True).click()


with tempfile.TemporaryDirectory() as temp:
    beat = Path(temp) / 'Kick beat.wav'; tone(beat, 30, 110)
    server = make_server(temp, port=0); threading.Thread(target=server.serve_forever, daemon=True).start()
    session = lambda: next((r for r in server.store.query({'table': 'settings'}) if r['id'] == 'recording-session'), None)

    def wait_saved(check, secs=6):
        end = time.time() + secs
        while time.time() < end:
            notes = (session() or {}).get('mixNotes') or []
            if check(notes): return notes
            time.sleep(0.1)
        raise AssertionError(f'mix notes not saved as expected: {(session() or {}).get("mixNotes")}')
    try:
        with sync_playwright() as p:
            if not CHROME:
                CHROME = str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            b = p.chromium.launch(executable_path=CHROME, headless=True)
            page = b.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            open_studio(page, server.server_port)
            with page.expect_file_chooser() as fc: page.get_by_role('button', name='IMPORT AUDIO', exact=True).click()
            fc.value.set_files(str(beat))
            page.locator('[data-clip]').first.wait_for(timeout=15000)

            page.get_by_role('button', name='MIXER', exact=True).click()
            notes = page.locator('#ss-mixer .mx-notes')
            notes.wait_for()
            assert 'No notes yet' in notes.inner_text()

            # Note pinned to the playhead at 0:12 on the beat track.
            page.evaluate('libraryUI.app.studio.seek(12.4)')
            page.get_by_label('Mix note', exact=True).fill('Kick needs to hit harder')
            page.get_by_label('Which track').select_option(label='Kick beat')
            page.get_by_role('button', name='ADD NOTE').click()
            # Whole-song note with no time.
            page.get_by_label('Mix note', exact=True).fill('2nd verse vocals need to come down')
            page.get_by_label('Which track').select_option(label='Whole song')
            page.locator('[data-note-pin]').uncheck()
            page.get_by_label('Mix note', exact=True).press('Enter')
            page.wait_for_function('document.querySelectorAll("#ss-mixer .mx-note").length===2')
            assert page.get_by_label('Mix note', exact=True).input_value() == '', 'input not cleared'
            wait_saved(lambda n: len(n) == 2)
            saved = session()['mixNotes']
            kick = next(n for n in saved if n['text'].startswith('Kick'))
            verse = next(n for n in saved if n['text'].startswith('2nd'))
            assert abs(kick['time'] - 12.4) < 0.05 and kick['trackId'], kick
            assert verse['time'] is None and verse['trackId'] is None, verse
            assert '0:12' in notes.inner_text() and 'KICK BEAT' in notes.inner_text().upper()
            print('added a track note pinned at 0:12 and a whole-song note; both saved', flush=True)

            # Typing in the note box must not trigger Studio shortcuts (Space = play).
            page.get_by_label('Mix note', exact=True).fill('test space ')
            page.get_by_label('Mix note', exact=True).press('Space')
            assert not page.evaluate('libraryUI.app.studio.playing'), 'Space in note box started playback'
            page.get_by_label('Mix note', exact=True).fill('')

            # Jump to a note's time.
            page.evaluate('libraryUI.app.studio.seek(0)')
            page.locator('.mx-note-when', has_text='0:12').click()
            page.wait_for_function('Math.abs(libraryUI.app.studio.position()-12.4)<0.05', timeout=3000)
            print('clicking 0:12 moved the playhead to 12.4s', flush=True)

            # Done + reload persistence.
            page.locator('.mx-note', has_text='Kick').locator('[data-note-done]').check()
            wait_saved(lambda n: any(x['done'] for x in n))
            assert '1 to do' in notes.inner_text()
            open_studio(page, server.server_port)
            page.locator('[data-clip]').first.wait_for(timeout=15000)
            page.get_by_role('button', name='MIXER', exact=True).click()
            page.wait_for_function('document.querySelectorAll("#ss-mixer .mx-note").length===2', timeout=5000)
            assert page.locator('.mx-note.done', has_text='Kick').count() == 1
            print('notes and done state survive a reload', flush=True)

            # Delete.
            page.locator('.mx-note', has_text='Kick').locator('.mx-note-del').click()
            wait_saved(lambda n: len(n) == 1)
            print('delete removes the note from the saved session', flush=True)
            page.screenshot(path=str(OUT / 'mix-notes-desktop.png'))

            # Phone layout: no sideways scroll, controls reachable.
            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(300)
            wide = page.evaluate('''()=>{const m=document.querySelector('#ss-mixer .mx-notes');return [m.scrollWidth,m.clientWidth,document.documentElement.scrollWidth,innerWidth]}''')
            assert wide[0] <= wide[1] + 1 and wide[2] <= wide[3] + 1, wide
            assert page.get_by_role('button', name='ADD NOTE').is_visible()
            page.screenshot(path=str(OUT / 'mix-notes-phone.png'))
            print('phone width: notes panel fits, ADD NOTE visible', flush=True)
            assert not errors, errors
            print('MIX NOTES OK')
    finally:
        server.shutdown()
