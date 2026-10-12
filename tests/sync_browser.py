"""Deck clocks, both-deck transport, MATCH and run-it-back between two copies (Windows)."""
import os, sys, tempfile, threading, wave, math, struct, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'test-results'
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server
with tempfile.TemporaryDirectory() as temp:
    audio=Path(temp)/'Test record.wav'
    with wave.open(str(audio),'wb') as w:
        w.setparams((1,2,22050,0,'NONE','not compressed'))
        w.writeframes(b''.join(struct.pack('<h',int(6000*math.sin(i*2*math.pi*220/22050))) for i in range(22050*60)))
    server=make_server(temp,port=0); t=threading.Thread(target=server.serve_forever,daemon=True); t.start()
    try:
        with sync_playwright() as p:
            chrome=sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1]
            b=p.chromium.launch(executable_path=str(chrome),headless=True,args=['--autoplay-policy=no-user-gesture-required'])
            page=b.new_page(viewport={'width':1440,'height':1300})
            errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
            page.add_init_script("""Object.defineProperty(window,'ScrewRoom',{configurable:true,set(C){Object.defineProperty(window,'ScrewRoom',{value:class extends C {constructor(a){super(a);window.testRoom=this;}},writable:true});}});""")
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.get_by_role('button',name='SCREW',exact=True).click()
            for deck in ['A','B']:
                with page.expect_file_chooser() as fc: page.get_by_label('Load deck '+deck,exact=True).click()
                fc.value.set_files(str(audio))
                page.locator('#turntable-'+deck+' .deck-heading span').get_by_text('Test record.wav',exact=True).wait_for()
            # hook: read deck positions through the rendered clocks' source numbers
            page.get_by_label('Deck A playback',exact=True).click(); page.wait_for_timeout(1500)
            page.get_by_label('Deck A playback',exact=True).click(); page.wait_for_timeout(800)
            page.screenshot(path=str(OUT/'sync-1-paused.png'),clip={'x':0,'y':300,'width':1440,'height':700})
            page.get_by_label('Deck A playback',exact=True).click(); page.wait_for_timeout(900)
            page.get_by_role('button',name='MATCH B → A',exact=True).click(); page.wait_for_timeout(600)
            page.get_by_label('Deck B playback',exact=True).get_by_text('PAUSE',exact=True).wait_for()
            page.screenshot(path=str(OUT/'sync-2-matched.png'),clip={'x':0,'y':300,'width':1440,'height':700})
            page.get_by_role('button',name='↺ 1 BEAT',exact=True).click(); page.wait_for_timeout(400)
            gap,bpm=page.evaluate('[testRoom.app.deckPosition("A")-testRoom.app.deckPosition("B"),testRoom.bpm("A")]')
            assert abs(gap-60/bpm)<.08, ('run it back should leave table B one beat behind A', gap, bpm)
            page.screenshot(path=str(OUT/'sync-3-runback.png'))
            page.get_by_role('button',name='❚❚ PAUSE BOTH',exact=True).click()
            page.get_by_label('Deck A playback',exact=True).get_by_text('PLAY',exact=True).wait_for()
            page.get_by_label('Deck B playback',exact=True).get_by_text('PLAY',exact=True).wait_for()
            page.get_by_role('button',name='▶ PLAY BOTH',exact=True).click()
            page.get_by_label('Deck B playback',exact=True).get_by_text('PAUSE',exact=True).wait_for()
            page.wait_for_timeout(700)
            page.get_by_role('button',name='■ STOP BOTH',exact=True).click(); page.wait_for_timeout(300)
            page.screenshot(path=str(OUT/'sync-4-stopped.png'),clip={'x':0,'y':300,'width':1440,'height':700})
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(OUT/'sync-6-phone.png'),full_page=True)
            assert not errors, errors
            print('PASS')
            b.close()
    finally:
        server.shutdown(); t.join(); server.server_close()
