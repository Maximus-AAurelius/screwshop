"""Exercise real deck audio routing and the visible mixer in an isolated studio."""
import re, os, sys, tempfile, threading, wave, math, struct
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server
with tempfile.TemporaryDirectory() as temp:
    audio=Path(temp)/'Test record.wav'
    with wave.open(str(audio),'wb') as w:
        w.setparams((1,2,22050,0,'NONE','not compressed'))
        w.writeframes(b''.join(struct.pack('<h',int(6000*math.sin(i*2*math.pi*220/22050))) for i in range(22050*60)))
    server=make_server(temp,port=0)
    t=threading.Thread(target=server.serve_forever,daemon=True); t.start()
    try:
        with sync_playwright() as p:
            chrome=sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1]
            browser=p.chromium.launch(executable_path=str(chrome),headless=True)
            page=browser.new_page(viewport={'width':1440,'height':1080})
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.add_init_script('''window.mixOutputs=[]; const connect=AudioNode.prototype.connect; AudioNode.prototype.connect=function(target,...args){if(target instanceof AudioDestinationNode){const meter=this.context.createAnalyser();connect.call(this,meter);window.mixOutputs.push(meter);}return connect.call(this,target,...args)}; window.levels=()=>window.mixOutputs.map(m=>{let a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length)});''')
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.get_by_role('button',name='SCREW',exact=True).click()
            for deck in ['A','B']:
                with page.expect_file_chooser() as fc: page.get_by_label('Load deck '+deck,exact=True).click()
                fc.value.set_files(str(audio))
                page.locator('#turntable-'+deck+' .deck-heading span').get_by_text('Test record.wav',exact=True).wait_for()
            page.get_by_label('Deck A playback',exact=True).click()
            page.get_by_label('Deck A playback',exact=True).get_by_text('PAUSE',exact=True).wait_for()
            page.wait_for_function('window.levels().some(v=>v>0.01)')
            angle=page.locator('#vinyl-A').get_attribute('style')
            page.wait_for_timeout(200)
            assert page.locator('#vinyl-A').get_attribute('style') != angle
            page.get_by_label('Deck A speed',exact=True).fill('0.65')
            page.locator('#turntable-A .deck-speed b').get_by_text(re.compile(r'^0\.65×')).wait_for()
            page.get_by_label('Deck A bass',exact=True).fill('-12')
            page.get_by_label('Deck A treble',exact=True).fill('6')
            page.get_by_label('Deck crossfader',exact=True).fill('1')
            page.wait_for_function('window.levels().every(v=>v<0.00001)')
            page.get_by_label('Deck B playback',exact=True).click()
            page.wait_for_function('window.levels().some(v=>v>0.01)')
            page.get_by_label('Deck B level',exact=True).fill('0')
            page.wait_for_function('window.levels().every(v=>v<0.00001)')
            page.get_by_label('Deck B level',exact=True).fill('0.8')
            page.get_by_role('button',name='CENTER MIX',exact=True).click()
            page.wait_for_function('window.levels().some(v=>v>0.01)')
            page.get_by_label('Cue deck A',exact=True).click()
            page.get_by_label('Deck A playback',exact=True).get_by_text('PLAY',exact=True).wait_for()
            page.get_by_role('button',name='SONGS',exact=True).click()
            page.get_by_label('Pause audio',exact=True).click()
            page.wait_for_function('window.levels().every(v=>v<0.00001)')
            page.get_by_label('Play audio',exact=True).click()
            page.wait_for_function('window.levels().some(v=>v>0.01)')
            page.get_by_label('Stop all audio',exact=True).click()
            page.wait_for_function('window.levels().every(v=>v<0.00001)')
            page.get_by_role('button',name='SCREW',exact=True).click()
            page.screenshot(path=str(ROOT/'test-results/turntables-desktop.png'))
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(ROOT/'test-results/turntables-phone.png'))
            assert not errors, errors
            print('PASS: deck loading, real output, rotating artwork, speed, EQ controls, crossfader silence, channel mute, cue, global pause/resume/stop, mobile width; no JS errors.')
            browser.close()
    finally:
        server.shutdown();t.join();server.server_close()
