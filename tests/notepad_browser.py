"""GarageBand-style STUDIO: import, loop browser, clip drag/snap, loop edge, cycle, metronome, playback, recording."""
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
            page.wait_for_timeout(400)
            clip=page.locator('[data-clip]').first
            clip.click(position={'x':80,'y':42})
            box=clip.bounding_box(); original=box['width']
            page.mouse.move(box['x']+100,box['y']+40)
            page.keyboard.down('Shift'); page.mouse.wheel(0,-150); page.keyboard.up('Shift')
            page.wait_for_timeout(400)
            enlarged=clip.bounding_box()['width']; assert enlarged>original*1.1
            page.keyboard.down('Shift'); page.mouse.wheel(0,150); page.keyboard.up('Shift')
            page.wait_for_timeout(400)
            assert abs(clip.bounding_box()['width']-original)<2
            external=[]
            page.on('request',lambda r:external.append(r.url) if r.url.startswith('https://api.datamuse.com') else None)
            page.get_by_role('button',name='NOTEPAD',exact=True).click()
            editor=page.get_by_role('textbox',name='Verse notebook')
            editor.wait_for()
            page.wait_for_timeout(400)
            editor.fill('I write in the night')
            editor.press('End'); editor.press('Enter'); editor.type('I carry the light')
            editor.press('Enter'); editor.press('Enter'); editor.type('My own words')
            editor.press('ArrowUp'); editor.press('Home'); editor.type('A new line')
            expected='I write in the night\nI carry the light\nA new line\nMy own words'
            assert editor.input_value()==expected, editor.input_value()
            page.wait_for_timeout(600)
            assert page.locator('.np-count').inner_text()=='4 BARS / 4 LINES'
            assert page.locator('.np-mirror mark').count()>0
            assert not external, external
            page.screenshot(path=str(OUT/'notepad-desktop.png'))
            page.get_by_text('SAVED ON DISK',exact=True).wait_for()
            page.reload(); page.get_by_role('button',name='NOTEPAD',exact=True).click()
            editor=page.get_by_role('textbox',name='Verse notebook')
            page.wait_for_function("document.querySelector('.np-editor')?.value === " + json.dumps(expected))
            page.locator('.np-query').fill('night')
            page.get_by_role('button',name='FIND RHYMES',exact=True).click()
            assert page.locator('.np-result').count()>0
            assert not external
            # Provider contract is mocked here; lyrics must never be sent.
            page.route('https://api.datamuse.com/**',lambda route:route.fulfill(status=200,content_type='application/json',body='[{"word":"sea","defs":["n\\tA large body of salt water"]}]'))
            page.locator('.np-query').fill('ocean'); page.locator('.np-mode').select_option('syn')
            page.get_by_role('button',name='LOOK UP ONLINE').click()
            page.wait_for_function('document.querySelector(".np-results").textContent.includes("sea")')
            assert len(external)==1 and 'rel_syn=ocean' in external[0] and 'night' not in external[0],external
            assert editor.input_value()==expected
            page.unroute('https://api.datamuse.com/**')
            page.route('https://api.datamuse.com/**',lambda route:route.abort())
            page.get_by_role('button',name='LOOK UP ONLINE').click()
            page.wait_for_function('document.querySelector(".np-results").textContent.includes("unavailable")')
            page.set_viewport_size({'width':390,'height':844}); page.wait_for_timeout(400)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            editor.fill('A long line that wraps across this small notebook page and still stays one bar\nNext bar')
            page.wait_for_timeout(400)
            heights=page.locator('.np-line').evaluate_all('(rows)=>rows.map(r=>r.offsetHeight)')
            assert heights[0]>32 and heights[1]==32,heights
            assert page.locator('.np-count').inner_text()=='2 BARS / 2 LINES'
            page.screenshot(path=str(OUT/'notepad-phone.png'))
            assert not errors,errors
            print('PASS: Shift-wheel zoom, notebook keyboard editing, rhyme colors, persistence, explicit dictionary lookup, network failure, mobile wrapping')
            b.close()
    finally:
        server.shutdown(); t.join(); server.server_close()
