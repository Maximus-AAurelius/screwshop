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
            # second file to library through SONGS so it shows in the loop browser
            page.get_by_role('button',name='SONGS',exact=True).click()
            with page.expect_file_chooser() as fc: page.get_by_role('button',name='+ UPLOAD FILE',exact=True).click()
            fc.value.set_files(str(loop))
            page.locator('input[value="Drum loop"]').wait_for(timeout=10000)
            page.get_by_role('button',name='STUDIO',exact=True).click()
            page.locator('#ss-sound-library').wait_for()
            src=page.locator('.sl-file[data-loop-name="Drum loop.wav"], .sl-file[data-loop-name="Drum loop"]').first
            src.wait_for()
            lane=page.locator('[data-lane="__new"]')
            box=lane.bounding_box()
            src.drag_to(lane,target_position={'x':300,'y':box['height']/2})
            page.wait_for_function('document.querySelectorAll("[data-clip]").length==2',timeout=10000)
            s=session(); assert len(s['tracks'])==2, s
            loopclip=s['tracks'][1]['clips'][0]; bpm=s['bpm']; beatlen=60/bpm
            assert abs(loopclip['start']/beatlen-round(loopclip['start']/beatlen))<1e-6, 'drop not snapped'
            print('drop from loop browser -> new track, snapped', flush=True)
            # drag the loop clip right by ~2 beats
            clip=page.locator('[data-clip]').nth(1); cb=clip.bounding_box()
            zoom=s.get('zoom',26)
            page.mouse.move(cb['x']+20,cb['y']+40); page.mouse.down(); page.mouse.move(cb['x']+20+zoom*2+5,cb['y']+40,steps=6); page.mouse.up()
            page.wait_for_timeout(500)
            s2=session(); st=s2['tracks'][1]['clips'][0]['start']
            assert abs(st-(loopclip['start']+2*beatlen))<1e-3, (st, loopclip['start'])
            print('clip moved 2 beats with snap', flush=True)
            # loop edge: stretch to ~4x length
            clip=page.locator('[data-clip]').nth(1); cb=clip.bounding_box()
            h=page.locator('[data-clip-loop]').nth(1).bounding_box()
            page.mouse.move(h['x']+6,h['y']+30); page.mouse.down(); page.mouse.move(h['x']+6+cb['width']*3,h['y']+30,steps=8); page.mouse.up()
            page.wait_for_timeout(500)
            c3=session()['tracks'][1]['clips'][0]; assert c3['length'] and c3['length']>3.5*c3['dur'], c3
            print('loop edge repeats the clip', round(c3['length']/c3['dur'],2),'x', flush=True)
            # cycle: drag in ruler strip, clear of the draggable playhead at zero
            strip=page.locator('.gb-cycle-strip').bounding_box(); bar=zoom*4
            page.mouse.move(strip['x']+20,strip['y']+6); page.mouse.down(); page.mouse.move(strip['x']+bar*2,strip['y']+6,steps=5); page.mouse.up()
            page.wait_for_timeout(400)
            cyc=session()['cycle']; assert cyc['on'] and abs(cyc['start']-20/(zoom/beatlen))<beatlen/48 and abs(cyc['end']-2*4*beatlen)<beatlen/48, cyc
            print('cycle region set', flush=True)
            page.get_by_role('button',name='♩ CLICK').click()
            page.get_by_role('button',name='Play',exact=True).click()
            page.wait_for_function('window.levels().some(v=>v>0.01)',timeout=5000)
            page.wait_for_timeout(int(2*4*beatlen*1000)+800)  # past one full cycle
            bars=page.locator('[data-gb-bars]').inner_text()
            assert bars.startswith('1.') or bars.startswith('2.'), bars
            print('playing, cycling back:', bars, flush=True)
            page.screenshot(path=str(OUT/'studio-desktop.png'))
            page.get_by_role('button',name='Pause',exact=True).click()
            page.get_by_role('button',name='⟲ CYCLE').click()
            page.get_by_role('button',name='♩ CLICK').click()
            page.get_by_role('button',name='RECORD',exact=True).click()
            page.get_by_role('button',name='STOP',exact=True).wait_for(timeout=8000)
            page.wait_for_timeout(1500)
            page.get_by_role('button',name='STOP',exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length==3',timeout=10000)
            assert len(server.store.query({'table':'takes'}))==1 and len(session()['tracks'])==3
            print('count-in + recording -> new vocal track', flush=True)
            page.reload(); page.get_by_role('button',name='STUDIO',exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length==3',timeout=10000)
            print('session survives reload', flush=True)
            page.set_viewport_size({'width':390,'height':844}); page.wait_for_timeout(500)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(OUT/'studio-phone.png'))
            assert not errors, errors
            print('PASS: GarageBand-style studio', flush=True)
            b.close()
    finally:
        server.shutdown(); t.join(); server.server_close()
