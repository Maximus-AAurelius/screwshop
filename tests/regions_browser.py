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
            # Double-click exactly three seconds into the region, then use scissors.
            cb=page.locator('[data-clip]').first.bounding_box()
            pps=26/(60/82)
            page.mouse.dblclick(cb['x']+3*pps,cb['y']+42,delay=80)
            page.get_by_role('button',name='Drag scissors down to split',exact=True).wait_for()
            page.screenshot(path=str(OUT/'studio-scissors.png'))
            assert page.locator('.im-menu').get_by_role('menuitem',name='Delete clip').is_visible()
            assert page.locator('.im-menu').get_by_role('menuitem',name='Duplicate after itself').is_visible()
            assert page.locator('.im-menu [data-action="split-here"]').get_attribute('aria-disabled') is None, 'double-click point is inside the clip'
            # Move the marker by its white triangle, and move it back to three seconds.
            handle=page.get_by_role('button',name='Drag playhead').bounding_box()
            page.mouse.move(handle['x']+15,handle['y']+8); page.mouse.down()
            page.mouse.move(handle['x']+15+pps,handle['y']+8,steps=5); page.mouse.up()
            page.wait_for_timeout(150)
            marker=page.locator('.gb-scissors').bounding_box()
            assert abs(marker['x']-cb['x']-4*pps)<2
            handle=page.get_by_role('button',name='Drag playhead').bounding_box()
            page.mouse.move(handle['x']+15,handle['y']+8); page.mouse.down()
            page.mouse.move(cb['x']+3*pps,handle['y']+8,steps=5); page.mouse.up()
            page.wait_for_timeout(150)
            scissors=page.get_by_role('button',name='Drag scissors down to split',exact=True)
            # A click or short drag must not cut.
            scissors.click(); page.wait_for_timeout(100)
            assert page.locator('[data-clip]').count()==1
            sb=scissors.bounding_box()
            page.mouse.move(sb['x']+19,sb['y']+14); page.mouse.down()
            page.mouse.move(sb['x']+19,sb['y']+34,steps=4); page.mouse.up()
            page.wait_for_timeout(100)
            assert page.locator('[data-clip]').count()==1
            sb=scissors.bounding_box()
            page.mouse.move(sb['x']+19,sb['y']+14); page.mouse.down()
            page.mouse.move(sb['x']+19,sb['y']+76,steps=8); page.mouse.up()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length===2')
            page.wait_for_timeout(300)
            clips=session()['tracks'][0]['clips']
            assert abs(clips[1]['sourceOffset']-3)<0.04, clips
            assert abs(clips[0]['length']+clips[1]['length']-12)<0.001
            assert len(session()['tracks'])==1
            right=page.locator('[data-clip]').nth(1)
            right.dblclick(position={'x':55,'y':42})
            page.locator('.im-menu [data-action="delete"]').click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length===1')
            page.get_by_role('button',name='\u21b6 UNDO',exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length===2')
            page.get_by_role('button',name='\u21b7 REDO',exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length===1')
            page.get_by_role('button',name='\u21b6 UNDO',exact=True).click()
            page.wait_for_timeout(300)
            page.reload(); page.get_by_role('button',name='STUDIO',exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length===2')
            assert abs(session()['tracks'][0]['clips'][1]['sourceOffset']-3)<0.04
            # Right-click a clip: Esc closes, copy + paste, delete with the UNDO toast.
            count = lambda n: page.wait_for_function(f'document.querySelectorAll("[data-clip]").length==={n}')
            first=page.locator('[data-clip]').first
            first.click(button='right',position={'x':40,'y':42})
            assert page.locator('.im-menu [data-action="paste"]').get_attribute('aria-disabled')=='true', 'nothing copied yet'
            page.keyboard.press('Escape'); assert page.locator('.im-menu').count()==0
            first.click(button='right',position={'x':40,'y':42}); page.locator('.im-menu [data-action="copy"]').click()
            page.locator('[data-clip]').first.click(button='right',position={'x':40,'y':42}); page.locator('.im-menu [data-action="paste"]').click()
            count(3)
            page.locator('[data-clip]').last.click(button='right',position={'x':20,'y':42})
            page.locator('.im-menu [data-action="delete"]').click(); count(2)
            page.locator('.im-toast .im-undo').last.click(); count(3)
            page.locator('[data-clip]').last.click(button='right',position={'x':20,'y':42})
            page.locator('.im-menu [data-action="delete"]').click(); count(2)
            page.wait_for_timeout(300)
            # A cancelled pointer gesture (e.g. an interrupted touch) must not move audio.
            original_regions=json.dumps(session()['tracks'],sort_keys=True)
            cb=page.locator('[data-clip]').first.bounding_box()
            page.mouse.move(cb['x']+20,cb['y']+42); page.mouse.down()
            page.mouse.move(cb['x']+130,cb['y']+42,steps=5)
            page.evaluate("window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))")
            page.mouse.up(); page.wait_for_timeout(300)
            assert json.dumps(session()['tracks'],sort_keys=True)==original_regions, 'cancelled drag changed stored audio regions'
            assert abs(page.locator('[data-clip]').first.bounding_box()['x']-cb['x'])<2, 'cancelled drag left stale visual position'
            page.get_by_role('button',name='Play',exact=True).click()
            page.wait_for_function('window.levels().some(v=>v>0.01)')
            page.get_by_role('button',name='Pause',exact=True).click()
            page.set_viewport_size({'width':390,'height':844})
            page.wait_for_timeout(300)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(OUT/'studio-region-phone.png'))
            assert not errors, errors
            print('PASS: edit menu, draggable playhead, scissors, cancelled gestures, split offsets, delete, undo/redo, persistence, playback, mobile layout')
            b.close()
    finally:
        server.shutdown(); t.join(); server.server_close()
