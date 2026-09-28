"""Historical Oxygen MKV drawer guide regression; the sampler no longer assumes this model.

Kept as reference for the retired drawer; not part of the active suite.
"""
import os, sys, tempfile, threading, wave, math, struct
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'test-results'; OUT.mkdir(exist_ok=True)
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server
CHROME=os.environ.get('SS_CHROME')
def tone(path, secs, freq):
    with wave.open(str(path),'wb') as w:
        w.setparams((1,2,22050,0,'NONE','not compressed'))
        w.writeframes(b''.join(struct.pack('<h',int(7000*math.sin(i*2*math.pi*freq/22050))) for i in range(int(22050*secs))))
with tempfile.TemporaryDirectory() as temp:
    beat=Path(temp)/'Test beat.wav'; tone(beat,4,110)
    server=make_server(temp,port=0); t=threading.Thread(target=server.serve_forever,daemon=True); t.start()
    try:
        with sync_playwright() as p:
            if not CHROME:
                CHROME=str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            b=p.chromium.launch(executable_path=CHROME,headless=True,args=['--autoplay-policy=no-user-gesture-required'])
            page=b.new_page(viewport={'width':1440,'height':1000})
            errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.get_by_role('button',name='STUDIO',exact=True).click()
            with page.expect_file_chooser() as fc: page.get_by_role('button',name='IMPORT AUDIO',exact=True).click()
            fc.value.set_files(str(beat))
            page.locator('[data-clip]').first.wait_for(timeout=15000)
            page.get_by_role('button',name='OXYGEN 25',exact=True).click()
            page.get_by_role('button',name='Pad 1',exact=True).wait_for()
            ws='document.querySelector(".ox-body")'
            # The whole drawn keyboard fits inside the drawer on desktop.
            fit=page.evaluate('(()=>{const d=document.querySelector(".oxygen-drawer").getBoundingClientRect(),k=document.querySelector(".ox-body").getBoundingClientRect();return {drawer:d.bottom,body:k.bottom,w:k.width}})()')
            assert fit['body']<=fit['drawer']+1 and fit['w']>=600,fit
            page.screenshot(path=str(OUT/'oxygen-mkv-desktop.png'))
            # Every hardware control and key label is explained by Trill.
            for label in ['Shift','Tempo','Note repeat','Fader button','Previous','Next','DAW or preset mode','Octave down','Octave up','Loop','Stop','Play','Record','Pitch wheel','Mod wheel']:
                assert page.locator('.ox-body').get_by_label(label,exact=True).count()>=1,label
            assert page.locator('.ox-body [data-knob]').count()==8 and page.locator('.ox-body .ox-pad').count()==8 and page.locator('.ox-body [data-key]').count()==25
            assert page.locator('.ox-keylabel').count()==45
            page.get_by_role('button',name='TRILL GUIDE',exact=True).click()
            total=int(page.locator('.ox-guide small').inner_text().split(' OF ')[1])
            titles=[]
            for i in range(total):
                titles.append(page.locator('.ox-guide h4').inner_text())
                step=page.evaluate('(()=>{const w=document.querySelector(".ox-guide");return w.querySelector("small").textContent})()')
                assert step.endswith(f'{i+1} OF {total}'),step
                if i==total-1: break
                page.locator('.ox-guide [data-next]').click()
            print('guide steps:',len(titles),flush=True)
            for needed in ['LED display','SHIFT','TEMPO / SYNC','NOTE REPEAT / LATCH','Fader','Fader button','Knobs 1-8','Loop','Stop / PANIC','Play','Record','Pads 1-8','PAD BANK 1 / 2','DAW KNOB CONTROL','< > / MODE SELECT','DAW / PRESET','OCTAVE - / + (TRANSPOSE)','PITCH wheel','MOD wheel','25 keys','ARP CTRL: UP to CHORD','GATE','SWING','OCT 0 / 1 / 2','TIME DIV','KEY: C to B','VOICING','TYPE','CHANNEL','VELOCITY','Back panel']:
                assert needed in titles,needed
            # Every step that names a control lights it up on the drawing.
            ids=page.locator('.ox-guide [data-jump] option').count()
            assert ids==total
            for i in range(total):
                page.locator('.ox-guide [data-jump]').select_option(str(i))
                lit=page.locator('.ox-body .ox-lit').count(); h=page.locator('.ox-guide h4').inner_text()
                assert lit>0 or h in ('Your Oxygen 25 (MKV)','Back panel','Build and layer','Your local sound folders'),h
            page.locator('.ox-guide [data-jump]').select_option('9')
            page.screenshot(path=str(OUT/'oxygen-mkv-guide.png'))
            page.locator('.ox-guide [data-done]').click()
            assert page.locator('.ox-body .ox-lit').count()==0
            # WHAT'S THIS? explains instead of playing.
            page.get_by_role('button',name="WHAT'S THIS?",exact=True).click()
            page.locator('[data-knob="2"]').click()
            assert page.locator('.ox-guide h4').inner_text()=='Knob 3' and 'track 3' in page.locator('.ox-guide p').inner_text()
            page.locator('[data-item="label:lbl-voicing:3,5,1"]').click()
            assert '1st inversion' in page.locator('.ox-guide p').inner_text()
            page.locator('[data-item="label:lbl-arp:RANDOM"]').click()
            assert 'random order' in page.locator('.ox-guide p').inner_text()
            page.locator('[data-pad="4"]').click()
            assert 'VOLUME' in page.locator('.ox-guide p').inner_text()
            page.locator('[data-key="48"]').click()
            body=page.locator('.ox-guide p').inner_text(); assert page.locator('.ox-guide h4').inner_text()=='Key C3' and 'UP' in body and 'home key' in body,body
            page.locator('[data-help="dawpreset"]').click()
            assert 'Mackie/HUI' in page.locator('.ox-guide p').inner_text()
            page.get_by_role('button',name="WHAT'S THIS?",exact=True).click()
            page.locator('.ox-guide [data-done]').click()
            # SHIFT + key explains its programming function; SHIFT + OCTAVE transposes.
            page.locator('[data-shift]').click()
            page.locator('[data-key="61"]').dispatch_event('pointerdown',{'button':0,'pointerId':1})
            assert 'TIME DIV 1/4T' in page.locator('.ox-guide p').inner_text()
            assert page.evaluate('!document.querySelector("[data-shift]").classList.contains("on")')
            page.locator('.ox-guide [data-done]').click()
            page.locator('[data-shift]').click(); page.locator('[data-octave="1"]').click()
            assert page.locator('.ox-display').inner_text()=='1'
            page.locator('[data-octave="1"]').click(); page.wait_for_timeout(400)
            assert page.locator('[data-key="48"]').count()==0 and page.locator('[data-key="84"]').count()==1
            page.locator('[data-octave="-1"]').click(); page.wait_for_timeout(400)
            # Knob 1 drag sets track 1 volume; tap tempo sets studio BPM.
            box=page.locator('[data-knob="0"]').bounding_box()
            page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2); page.mouse.down(); page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2+60,steps=5); page.mouse.up()
            assert int(page.locator('.ox-display').inner_text())<60,page.locator('.ox-display').inner_text()
            page.locator('[data-tempo]').click(); page.wait_for_timeout(500); page.locator('[data-tempo]').click(); page.wait_for_timeout(500); page.locator('[data-tempo]').click()
            bpm=int(page.locator('.ox-display').inner_text()); assert 100<=bpm<=140,bpm
            page.locator('[data-arrow="1"]').click(); assert int(page.locator('.ox-display').inner_text())==bpm+1
            page.locator('[data-repeat]').click(); assert page.evaluate('document.querySelector("[data-led=\\"repeat\\"]").classList.contains("on")')
            page.locator('[data-repeat]').click()
            page.locator('[data-faderbtn]').click(); assert page.locator('.ox-display').inner_text()=='OFF'
            page.locator('[data-faderbtn]').click()
            page.set_viewport_size({'width':390,'height':844}); page.wait_for_timeout(400)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.locator('.oxygen-drawer').scroll_into_view_if_needed()
            page.screenshot(path=str(OUT/'oxygen-mkv-phone.png'))
            assert not errors,errors
            print('PASS: MKV drawing fits drawer, Trill covers every control, WHATS THIS, SHIFT, transpose, octave, knob, tap tempo, note repeat, mute, phone width')
            b.close()
    finally:
        server.shutdown(); t.join(); server.server_close()
