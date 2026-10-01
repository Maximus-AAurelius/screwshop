"""Drawn Oxygen 25 in the sampler: drop onto pads (both banks) and keys, readout, knobs, guide. Isolated local store."""
import os, sys, tempfile, threading, wave, math, struct
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server

with tempfile.TemporaryDirectory() as temp:
    audio=Path(temp)/'Oxygen tone.wav'
    with wave.open(str(audio),'wb') as w:
        w.setparams((1,2,22050,0,'NONE','not compressed'))
        w.writeframes(b''.join(struct.pack('<h',int(14000*math.sin(i*2*math.pi*220/22050))) for i in range(22050)))
    server=make_server(temp,port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as p:
            chrome=os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            browser=p.chromium.launch(executable_path=chrome,headless=True,args=['--autoplay-policy=no-user-gesture-required'])
            page=browser.new_page(viewport={'width':1600,'height':1000})
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            page.get_by_role('button',name='M-AUDIO / SAMPLER',exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()
            assert page.locator('.ox-body .ox-pad').count()==8 and page.locator('.ox-body .ox-key').count()==25
            with page.expect_file_chooser() as fc:page.locator('#ss-sampler [data-action=import]').click()
            fc.value.set_files(str(audio))
            source=page.locator('.sp-sound').filter(has_text='Oxygen tone').first
            source.wait_for(timeout=15000)
            # Bank 1 pad: the readout names the target while dragging, then the pad lights up.
            source.drag_to(page.locator('.ox-pad[data-pad="2"]'))
            page.wait_for_function('sampler.slots[2]?.name.includes("Oxygen tone")')
            assert 'ox-loaded' in page.locator('.ox-pad[data-pad="2"]').get_attribute('class')
            page.locator('.ox-pad[data-pad="2"]').hover()
            assert 'Pad 3 (bank 1' in page.locator('[data-readout]').inner_text()
            # Bank 2 shows pads 9-16 on the same 8 drawn pads.
            page.get_by_role('button',name='BANK 2 · PADS 9–16').click()
            page.locator('.ox-pad[data-pad="8"]').wait_for()
            source.drag_to(page.locator('.ox-pad[data-pad="12"]'))
            page.wait_for_function('sampler.slots[12]?.name.includes("Oxygen tone")')
            assert page.evaluate('sampler.ui.bank')==1
            # Keys play pads 1-16 in drum mode: key 3 (P3) is the same sound as pad 3.
            assert page.locator('.ox-key[data-note="50"]').inner_text()=='P3'
            page.locator('.ox-key[data-note="50"]').click()
            page.wait_for_function('sampler.voices.size>0')
            # Instrument mode: the key a sound is dropped on becomes its root pitch.
            page.locator('[data-mode]').select_option('16')
            source.drag_to(page.locator('.ox-key[data-note="55"]'))
            page.wait_for_function('sampler.slots[16]?.root===55')
            assert page.locator('.ox-key[data-note="55"]').inner_text()=='ROOT'
            # Octave + moves the keys; knob 1 in bank 2 sets pad 9's volume.
            page.locator('.ox-body [data-octave="1"]').click()
            page.locator('.ox-key[data-note="60"]').wait_for()
            assert page.evaluate('sampler.project.octave')==5
            page.locator('.ox-body [data-knob="0"]').hover();page.mouse.wheel(0,400)
            page.wait_for_timeout(600)
            assert page.evaluate('sampler.project.mix[8].volume')<.8
            # Transport on the drawing drives the sampler without duplicating toolbar hooks.
            assert page.locator('[data-action=play]').count()==1
            page.locator('.ox-body [data-ox-action=play]').click()
            page.wait_for_function('sampler.playing')
            page.locator('.ox-body [data-ox-action=stop]').click()
            page.wait_for_function('!sampler.playing')
            # WHAT'S THIS? explains a control instead of playing it.
            page.get_by_role('button',name="WHAT'S THIS?").click()
            page.locator('.ox-pad[data-pad="12"]').click()
            assert 'Pad 13' in page.locator('.ox-guide').inner_text()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            out=ROOT/'test-results';out.mkdir(exist_ok=True)
            page.screenshot(path=str(out/'sampler-oxygen.png'))
            assert not errors,errors
            print('PASS: drawn Oxygen pads (both banks) and keys accept drops, readout, root key, octave, knobs, transport, WHAT\'S THIS?')
    finally:
        server.shutdown()
