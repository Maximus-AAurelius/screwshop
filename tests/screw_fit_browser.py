"""SCREW fits one laptop screen (no page scrolling while mixing) and SHOW ME can always be stopped.

Uses an isolated temporary server and the walkthrough's built-in demo record.
"""
import os, sys, tempfile, threading
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server

HOOK = """Object.defineProperty(window,'ScrewGuide',{configurable:true,set(C){Object.defineProperty(window,'ScrewGuide',{value:class extends C {constructor(a){super(a);window.testGuide=this;window.testApp=a;}},writable:true});}});"""
FITS = """() => { const s = document.querySelector('.dj-scroll'), r = sel => document.querySelector(sel).getBoundingClientRect();
  const view = s.getBoundingClientRect();
  return { overflow: s.scrollHeight - s.clientHeight, decksBottom: Math.max(r('.dj-console').bottom, r('.dj-sync').bottom) - view.bottom,
           wavesTop: r('.tt-waves').top - view.top, station: getComputedStyle(document.querySelector('.screw-box')).overflowY }; }"""

with tempfile.TemporaryDirectory() as temp:
    server = make_server(Path(temp) / 'data', port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            chrome = os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            browser = p.chromium.launch(executable_path=chrome, headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width': 1366, 'height': 768})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script(HOOK)
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('window.testApp?.sb && window.testApp.workspace?.ready')
            page.get_by_role('button', name='SCREW', exact=True).click()
            page.wait_for_function('window.testApp.screwRoom && document.querySelector(".screw-box") && document.querySelector(".tt-waves")')
            page.evaluate('testApp.screwRoom.loadBoth(testGuide.demoSong(1))')
            page.wait_for_function('testApp._deckA?.buffer && testApp._deckB?.buffer', timeout=30000)
            # The demo record is 90 BPM; double time (180) would make the "slow it down" step wrong.
            bpm = page.evaluate("testApp.screwRoom.bpm('A')")
            assert 88 < bpm < 92, bpm

            # 1) Everything you mix with is on screen at common laptop and desktop sizes.
            for size in ({'width': 1366, 'height': 768}, {'width': 1440, 'height': 900}, {'width': 1920, 'height': 1080}):
                page.set_viewport_size(size); page.wait_for_timeout(300)
                fit = page.evaluate(FITS)
                assert fit['overflow'] <= 2 and fit['decksBottom'] <= 1 and fit['wavesTop'] >= 0, (size, fit)
                assert fit['station'] == 'auto', fit   # SCREW STATION scrolls inside its own column
            page.set_viewport_size({'width': 1366, 'height': 768}); page.wait_for_timeout(200)

            # 2) SHOW ME turns into STOP, and STOP really ends the action (no more flicks happen).
            page.locator('[data-sg-start="screw-mix"]').click()
            card = page.locator('.sg-card'); card.wait_for()
            page.evaluate("testGuide.go(testGuide.tour.steps.findIndex(s => s.id === 'flick'))")
            scroll_before = page.evaluate("[scrollY, document.querySelector('.dj-scroll').scrollTop]")
            card.get_by_role('button', name='SHOW ME').click()
            stop = card.get_by_role('button', name='■ STOP'); expect(stop).to_be_visible()
            page.wait_for_function("testApp.screwRoom.stats.flick >= 1")
            stop.click()
            expect(card.get_by_role('button', name='SHOW ME')).to_be_visible()
            flicks = page.evaluate('testApp.screwRoom.stats.flick || 0')
            page.wait_for_timeout(1500)
            assert page.evaluate('testApp.screwRoom.stats.flick || 0') == flicks, 'SHOW ME kept going after STOP'
            assert page.locator('.sg-cursor').is_hidden()
            assert page.evaluate("[scrollY, document.querySelector('.dj-scroll').scrollTop]") == scroll_before, 'SHOW ME scrolled the page'

            # 3) Stopping mid-scratch lets go of the record, and Esc stops SHOW ME without closing the card.
            page.evaluate("testGuide.go(testGuide.tour.steps.findIndex(s => s.id === 'scratch'))")
            card.get_by_role('button', name='SHOW ME').click()
            page.wait_for_function("testGuide.cursor && testGuide.cursor.classList.contains('down')")
            page.keyboard.press('Escape')
            expect(card.get_by_role('button', name='SHOW ME')).to_be_visible()
            assert page.evaluate('!!testGuide.tour'), 'Esc during SHOW ME closed the walkthrough'
            page.wait_for_timeout(300)
            assert page.evaluate("!testApp.deckStore('A').scratch && !testApp.deckStore('B').scratch"), 'Record still held after stopping the scratch'

            # 4) AUTO-PLAY can be paused, and pausing stops the step it was doing.
            page.evaluate("testGuide.go(testGuide.tour.steps.findIndex(s => s.id === 'flick'))")
            card.get_by_role('button', name='▶ AUTO-PLAY ALL').click()
            page.wait_for_function('testGuide.busy')
            card.get_by_role('button', name='❚❚ PAUSE AUTO-PLAY').click()
            page.wait_for_function('!testGuide.busy && !testGuide.auto')
            at = page.evaluate('testGuide.index'); page.wait_for_timeout(2500)
            assert page.evaluate('testGuide.index') == at, 'AUTO-PLAY moved on after pause'

            # 5) Esc with nothing running closes the walkthrough; the ring only pulses twice.
            assert page.evaluate("getComputedStyle(document.querySelector('.sg-ring')).animationIterationCount") == '2'
            page.keyboard.press('Escape')
            page.wait_for_function('!testGuide.tour')
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
print('PASS: SCREW fits 1366x768 / 1440x900 / 1920x1080 without scrolling; SHOW ME and AUTO-PLAY stop cleanly; demo tempo 90 BPM')
