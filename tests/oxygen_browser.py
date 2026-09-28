"""Historical Oxygen drawer regression; current interface coverage is sampler_browser.py.

Kept as reference for the retired model-specific drawer; not part of the active suite.
"""
import os, sys, tempfile, threading, wave, math, struct, json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'test-results'; OUT.mkdir(exist_ok=True)
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server
CHROME=os.environ.get('SS_CHROME')
def tone(path, secs, freq):
    with wave.open(str(path),'wb') as w:
        w.setparams((1,2,22050,0,'NONE','not compressed'))
        w.writeframes(b''.join(struct.pack('<h',int(7000*math.sin(i*2*math.pi*freq/22050)*(1 if (i//5512)%2==0 else .3))) for i in range(int(22050*secs))))
with tempfile.TemporaryDirectory() as temp:
    beat=Path(temp)/'Test beat.wav'; tone(beat,12,110)
    loop=Path(temp)/'Drum loop.wav'; tone(loop,2,440)
    server=make_server(temp,port=0); t=threading.Thread(target=server.serve_forever,daemon=True); t.start()
    session=lambda: next((r for r in server.store.query({'table':'settings'}) if r['id']=='recording-session'),None)
    try:
        with sync_playwright() as p:
            if not CHROME:
                CHROME=str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            b=p.chromium.launch(executable_path=CHROME,headless=True,args=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
            page=b.new_page(viewport={'width':1440,'height':1000})
            errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
            page.add_init_script('''window.mixOutputs=[]; const connect=AudioNode.prototype.connect; AudioNode.prototype.connect=function(target,...args){if(target instanceof AudioDestinationNode){const m=this.context.createAnalyser();connect.call(this,m);window.mixOutputs.push(m);}return connect.call(this,target,...args)}; window.levels=()=>window.mixOutputs.map(m=>{let a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length)});''')
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.get_by_role('button',name='STUDIO',exact=True).click()
            with page.expect_file_chooser() as fc: page.get_by_role('button',name='IMPORT AUDIO',exact=True).click()
            fc.value.set_files(str(beat))
            page.locator('[data-clip]').first.wait_for(timeout=15000)
            page.wait_for_timeout(500)
            assert page.get_by_role('button',name='BEATS',exact=True).count()==0
            page.get_by_role('button',name='OXYGEN 25',exact=True).click()
            page.get_by_role('button',name='Pad 1',exact=True).wait_for()
            source=page.locator('.sl-file').filter(has_text='Test beat.wav').first
            source.drag_to(page.get_by_role('button',name='Pad 1',exact=True))
            page.wait_for_function('document.getElementsByClassName("ox-pad")[0].textContent.includes("Test beat")')
            settings=lambda:next(x for x in server.store.query({'table':'settings'}) if x['id']=='oxygen-workspace')
            page.wait_for_timeout(300)
            assert settings()['slots'][0]['url'].startswith('/audio/beats/')
            # Trim to one hit and save it as its own reusable WAV.
            page.locator('[data-trim="end"]').fill('0.2'); page.locator('[data-trim="end"]').press('Tab')
            page.once('dialog',lambda d:d.accept('My one kick'))
            page.get_by_role('button',name='SAVE ONE-SHOT',exact=True).click()
            page.wait_for_function('document.getElementsByClassName("ox-pad")[0].textContent.includes("My one kick")')
            page.get_by_role('button',name='Pad 1',exact=True).click()
            page.wait_for_function('window.levels().some(v=>v>0.01)')
            page.wait_for_timeout(350)
            assert all(v<.001 for v in page.evaluate('window.levels()'))
            page.get_by_role('button',name='1234 COUNT-IN',exact=True).click()
            page.get_by_role('button',name='RECORD MIDI AUDIO',exact=True).click()
            page.get_by_role('button',name='STOP TAKE',exact=True).wait_for()
            page.get_by_role('button',name='Pad 1',exact=True).click()
            page.wait_for_timeout(400)
            page.get_by_role('button',name='Pad 1',exact=True).click()
            page.wait_for_timeout(350)
            page.get_by_role('button',name='STOP TAKE',exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length===2')
            page.wait_for_timeout(400)
            takes=server.store.query({'table':'takes'}); assert len(takes)==1 and takes[0]['label'].startswith('Oxygen performance'),takes
            url='/audio/takes/'+takes[0]['storage_path']
            peak=page.evaluate("""async url=>{const b=await(new AudioContext()).decodeAudioData(await(await fetch(url)).arrayBuffer());return Math.max(...b.getChannelData(0).filter((_,i)=>i%10===0));}""",url)
            assert peak>.01,peak
            # Drop a sample on the keyboard and use native note-on/off through a mock MIDI port.
            source=page.locator('.sl-file').filter(has_text='Test beat.wav').first
            page.evaluate("()=>{window.dropLog=[];document.addEventListener('drop',e=>window.dropLog.push([e.target.outerHTML,e.dataTransfer.getData('application/x-screwshop-loop')]),true)}")
            page.screenshot(path=str(OUT/'oxygen-before-key.png'))
            source.drag_to(page.locator('[data-key="60"]'),source_position={'x':80,'y':15},target_position={'x':10,'y':80})
            print('drop',page.evaluate('window.dropLog'),flush=True)
            page.wait_for_timeout(500)
            page.evaluate("""()=>{window.testPort={name:'Oxygen 25 test port'};navigator.requestMIDIAccess=async()=>({inputs:new Map([['test',window.testPort]])});}""")
            page.get_by_role('button',name='CONNECT MIDI',exact=True).click()
            page.wait_for_timeout(200)
            print('key assignment',settings().get('keySample'),flush=True)
            page.evaluate("()=>{const old=StudioWorkspace.prototype.midi;StudioWorkspace.prototype.midi=function(data){window.testWorkspace=this;return old.call(this,data)}}")
            page.evaluate('window.testPort.onmidimessage({data:[144,60,100]})')
            page.wait_for_timeout(400)
            print(page.evaluate('({key:window.testWorkspace.keySample,active:window.testWorkspace.active.size,tab:window.testWorkspace.app.state.tab,notice:window.testWorkspace.app.state.notice})'),flush=True)
            page.wait_for_function('window.levels().some(v=>v>0.01)')
            page.evaluate('window.testPort.onmidimessage({data:[128,60,0]})')
            page.wait_for_timeout(300)
            assert all(v<.001 for v in page.evaluate('window.levels()'))
            page.get_by_role('button',name='TRILL GUIDE',exact=True).click()
            assert page.locator('.ox-guide').inner_text().find('does not store audio files')>=0
            page.locator('.ox-guide [data-done]').click()
            page.screenshot(path=str(OUT/'oxygen-desktop.png'))
            page.wait_for_timeout(400);page.reload();page.get_by_role('button',name='STUDIO',exact=True).click()
            page.get_by_role('button',name='OXYGEN 25',exact=True).click()
            page.wait_for_function('document.getElementsByClassName("ox-pad")[0]?.textContent.includes("My one kick")')
            assert settings()['keySample'] and settings()['rootNote']==60
            page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(400)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(OUT/'oxygen-phone.png'))
            assert not errors,errors
            print('PASS: library to pads/keys, one-shot WAV, MIDI audio recording, MIDI note off, mapping persistence, Trill, mobile layout')
            b.close()
    finally:
        server.shutdown(); t.join(); server.server_close()
