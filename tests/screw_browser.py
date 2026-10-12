"""SCREW integration: tempo, run-it-back chops, Screw/Watts versions, stems vocal pitch, persistence and gestures."""
import math, os, sys, tempfile, threading, wave, struct, json
import numpy as np
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server

with tempfile.TemporaryDirectory() as temp:
    server=make_server(temp,port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        fixture=Path(temp)/'tone.wav'
        with wave.open(str(fixture),'wb') as w:
            w.setnchannels(1);w.setsampwidth(2);w.setframerate(44100)
            w.writeframes(b''.join(struct.pack('<h',int(9000*math.sin(2*math.pi*440*i/44100))) for i in range(44100*3)))
        # 90 BPM record: a click on every beat and a different tone each bar, so chops are measurable.
        beat=Path(temp)/'beat90.wav'
        t=np.arange(44100*48)/44100;b=t*1.5;ph=b%1
        sig=0.6*np.exp(-ph*30)*np.sin(2*np.pi*1000*t)+0.25*np.sin(2*np.pi*220*(1+(np.floor(b/4)%4)*0.25)*t)
        with wave.open(str(beat),'wb') as w:
            w.setnchannels(1);w.setsampwidth(2);w.setframerate(44100);w.writeframes((sig*9000).astype('<i2').tobytes())
        decode="""async(name)=>{const item=testRoom.app.state.library.find(x=>x.name===name);const b=await testRoom.app._Tone.getContext().rawContext.decodeAudioData(await(await fetch(item.url)).arrayBuffer());const d=b.getChannelData(0);let peak=0;for(let i=44100;i<88200;i++)peak=Math.max(peak,Math.abs(d[i]));return {duration:b.duration,peak,samples:Array.from(d.slice(44100,88200))};}"""
        with sync_playwright() as p:
            browsers=sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))
            browser=p.chromium.launch(executable_path=str(browsers[-1]),headless=True,args=['--autoplay-policy=no-user-gesture-required'])
            page=browser.new_page(viewport={'width':1440,'height':1000})
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.add_init_script("""Object.defineProperty(window,'ScrewRoom',{configurable:true,set(C){Object.defineProperty(window,'ScrewRoom',{value:class extends C {constructor(a){super(a);window.testRoom=this;}},writable:true});}});""")
            base=f'http://127.0.0.1:{server.server_port}'
            page.goto(base+'/barwork');page.get_by_role('button',name='SCREW',exact=True).click()
            page.wait_for_function('window.testRoom?.app.sb && !window.testRoom.stems.restoring')
            def load(path):
                with page.expect_file_chooser() as fc:page.get_by_role('button',name='LOAD SONG FILE',exact=True).click()
                fc.value.set_files(str(path));page.wait_for_function('!testRoom.loading && testRoom.app._deckA.buffer && testRoom.app._deckB.buffer===testRoom.app._deckA.buffer && testRoom.app.state.deckA.fileName==='+json.dumps(path.name))
            # 1) Slowed only: the pitch fader slows both tables; extra pitch shifts without changing length.
            load(fixture)
            page.get_by_label('Record speed',exact=True).fill('0.75')
            page.wait_for_function('Math.abs(testRoom.app._deckA.rate-.75)<1e-6 && Math.abs(testRoom.app._deckB.rate-.75)<1e-6 && testRoom.app.state.deckB.rate===.75')
            page.get_by_label('Extra pitch',exact=True).fill('-12')
            page.get_by_label('Slowed only',exact=True).check()
            page.get_by_label('New version name',exact=True).fill('Deck version')
            page.get_by_role('button',name='BUILD VERSION',exact=True).click()
            page.get_by_role('button',name='SAVE TO SONGS',exact=True).wait_for(timeout=60000)
            page.get_by_role('button',name='SAVE TO SONGS',exact=True).click()
            page.wait_for_function("testRoom.app.state.library.some(x=>x.name==='Deck version')",timeout=60000)
            output=page.evaluate(decode,'Deck version')
            samples=output.pop('samples'); spectrum=np.abs(np.fft.rfft(np.array(samples)*np.hanning(len(samples))));output['hz']=int(np.argmax(spectrum))
            assert abs(output['duration']-4.25)<.01,output
            assert output['peak']>.02 and 145<output['hz']<185,output
            print('Slowed version: speed + independent pitch rendered offline:',output,flush=True)
            # 2) Tempo, and running a line back between two copies of the record.
            load(beat)
            bpm=page.evaluate("testRoom.bpm('A')")
            assert abs(bpm-90)<1,bpm
            shown=page.locator('[data-bpm]').text_content();assert abs(float(shown.split()[0])-90)<1,shown
            page.get_by_role('button',name='▶ PLAY / PAUSE',exact=True).click()
            page.wait_for_function('testRoom.app.state.deckA.playing');page.wait_for_timeout(3000)
            page.get_by_role('button',name='↺ 1 BAR',exact=True).click();page.wait_for_timeout(250)
            gap=page.evaluate('testRoom.app.deckPosition("A")-testRoom.app.deckPosition("B")')
            assert abs(gap-4*60/bpm)<.06,('table B should sit one bar behind A',gap)
            assert page.evaluate('testRoom.app.state.crossfade===1 && testRoom.app.state.deckB.playing && testRoom.live()==="B"')
            # Repeat ×2: table A loops the last 2 beats twice, then the song drops back in.
            page.wait_for_timeout(1500)
            page.get_by_label('Repeat times',exact=True).select_option('2')
            page.get_by_role('button',name='↺ 2 BEATS',exact=True).click();page.wait_for_timeout(100)
            dbg=page.evaluate('({loop:testRoom.app._deckA.player.loop,x:testRoom.app.state.crossfade,notice:testRoom.app.state.notice,times:testRoom.host.querySelector("[data-times]").value,live:testRoom.live()})');assert dbg['loop'] and dbg['x']==-1,dbg
            page.wait_for_function('!testRoom.app._deckA.player.loop',timeout=5000)
            assert page.evaluate('testRoom.app._deckA.loopStart===null && testRoom.app._deckA.chopMarks===null')
            page.wait_for_timeout(600)
            assert page.evaluate('testRoom.app.state.deckA.playing')
            # Hook marks, double up and the hand on the platter.
            page.get_by_role('button',name='HOOK IN',exact=True).click();page.wait_for_timeout(1400)
            page.get_by_role('button',name='HOOK OUT',exact=True).click()
            assert page.evaluate('testRoom.hook && testRoom.hook.end-testRoom.hook.start>1')
            page.get_by_role('button',name='PLAY HOOK → DROP IN (H)',exact=True).click();page.wait_for_timeout(150)
            assert page.evaluate('testRoom.app.state.crossfade===1 && testRoom.app._deckB.player.loop')
            page.get_by_role('button',name='DOUBLE UP',exact=True).click()
            assert page.evaluate('testRoom.app.state.crossfade===0 && testRoom.doubled')
            page.get_by_role('button',name='DOUBLE UP',exact=True).click()
            page.get_by_label('Hold to drag the live record',exact=True).scroll_into_view_if_needed()
            hold=page.get_by_label('Hold to drag the live record',exact=True).bounding_box()
            page.mouse.move(hold['x']+5,hold['y']+5);page.mouse.down();page.wait_for_timeout(400)
            dbg=page.evaluate('({a:testRoom.app._deckA.rate,b:testRoom.app._deckB.rate,live:testRoom.live(),held:testRoom.held,x:testRoom.app.state.crossfade,notice:testRoom.app.state.notice})');assert dbg['b']<.85 and dbg['a']==1,dbg
            page.mouse.up();page.wait_for_timeout(500)
            assert page.evaluate('Math.abs(testRoom.app._deckB.rate-1)<1e-6')
            page.get_by_role('button',name='■ STOP',exact=True).click()
            print('Tempo, run it back, repeat + drop in, hook, double up and hand drag passed',flush=True)
            # 3) A DJ Screw style version: auto speed, planned chops, rendered and saved.
            page.get_by_label('DJ Screw',exact=True).check()
            page.get_by_label('New version name',exact=True).fill('Screw version')
            page.get_by_role('button',name='BUILD VERSION',exact=True).click()
            page.get_by_role('button',name='SAVE TO SONGS',exact=True).wait_for(timeout=60000)
            plan=page.evaluate('({rate:testRoom.version.plan.rate,notes:testRoom.version.plan.notes.length,out:testRoom.version.plan.outDuration,segs:testRoom.version.plan.segments.length})')
            assert .6<=plan['rate']<=.85 and plan['notes']>=1 and plan['segs']>=3,plan
            assert page.locator('[data-plan] li').count()==plan['notes']
            page.get_by_role('button',name='▶ PREVIEW',exact=True).click();page.wait_for_function('testRoom.previewing')
            page.get_by_role('button',name='■ STOP PREVIEW',exact=True).click()
            page.get_by_role('button',name='SAVE TO SONGS',exact=True).click()
            page.wait_for_function("testRoom.app.state.library.some(x=>x.name==='Screw version')",timeout=60000)
            screw=page.evaluate(decode,'Screw version');screw.pop('samples')
            assert abs(screw['duration']-(plan['out']+.25))<.05 and screw['peak']>.02,(screw,plan)
            print('DJ Screw style version planned, rendered and saved:',plan,flush=True)
            page.locator('#turntable-A').scroll_into_view_if_needed()
            page.evaluate('testRoom.app.cueDeck("A"); testRoom.app.toggleDeckPlay("A")')
            page.wait_for_function('testRoom.app.state.deckA.playing')
            box=page.locator('#vinyl-A').bounding_box()
            page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.down()
            page.mouse.move(box['x']+box['width']/2-45,box['y']+box['height']/2,steps=5)
            page.wait_for_function('!!testRoom.app._deckA.scratch && !!testRoom.app._deckA.scratchNode && !!testRoom.app._deckA.scratch.win')
            page.mouse.up();page.wait_for_function('!testRoom.app._deckA.scratch && testRoom.app.state.deckA.playing')
            page.evaluate('testRoom.app.pauseBothDecks()')
            print('Mouse scratching runs the jog-wheel scratch engine and resumes playback',flush=True)
            page.get_by_role('button',name='RECORD LIVE MIX',exact=True).click()
            page.wait_for_function('testRoom.recording')
            page.evaluate('testRoom.app.setCrossfade(-1); testRoom.app.cueDeck("A"); testRoom.app.toggleDeckPlay("A")')
            page.wait_for_timeout(600)
            page.get_by_role('button',name='STOP & SAVE MIX',exact=True).click()
            page.wait_for_function('!testRoom.recording && !testRoom.saving')
            assert page.evaluate("testRoom.app.state.library.filter(x=>x.storage_path.endsWith('.webm')).length")==1
            live=page.evaluate("""async()=>{const item=testRoom.app.state.library.find(x=>x.storage_path.endsWith('.webm'));const b=await testRoom.app._Tone.getContext().rawContext.decodeAudioData(await(await fetch(item.url)).arrayBuffer());return Array.from(b.getChannelData(0)).some(x=>Math.abs(x)>.01);}""")
            assert live,'Recorded live mix is silent' 
            page.evaluate('testRoom.app.pauseBothDecks()')
            page.get_by_role('button',name='VOCALS + INSTRUMENTAL',exact=True).click()
            for label in ['Load instrumental file','Load vocals file']:
                with page.expect_file_chooser() as fc:page.get_by_role('button',name=label,exact=True).click()
                fc.value.set_files(str(fixture));page.wait_for_function('!testRoom.stems.loading')
            page.wait_for_function('testRoom.stems.tracks.every(t=>t.buffer)')
            page.locator('[data-stem-wave="1"]').dblclick()
            page.get_by_label('Vocals Pitch (semitones)',exact=True).fill('-5')
            page.get_by_label('Vocals Pitch (semitones)',exact=True).dispatch_event('input')
            page.get_by_label('Vocals Pitch (semitones)',exact=True).dispatch_event('change')
            page.get_by_role('button',name='▶ PLAY STEMS',exact=True).click()
            page.wait_for_function('testRoom.stems.playing')
            assert page.evaluate('testRoom.stems.tracks[1].nodes.pitch.pitch')==-5
            assert page.evaluate('testRoom.stems.tracks[0].nodes.pitch.pitch')==0
            page.get_by_role('button',name='Stop all audio',exact=True).click()
            assert not page.evaluate('testRoom.stems.playing')
            page.get_by_label('Stem mix version name',exact=True).fill('Stem version')
            page.get_by_role('button',name='SAVE STEM MIX AS WAV',exact=True).click()
            page.wait_for_function("testRoom.app.state.library.some(x=>x.name==='Stem version')",timeout=60000)
            stem_audio=page.evaluate("""async()=>{const item=testRoom.app.state.library.find(x=>x.name==='Stem version');const b=await testRoom.app._Tone.getContext().rawContext.decodeAudioData(await(await fetch(item.url)).arrayBuffer());return {duration:b.duration,energy:Array.from(b.getChannelData(0)).reduce((a,x)=>a+x*x,0)};}""")
            assert abs(stem_audio['duration']-4)<.01 and stem_audio['energy']>1,stem_audio
            page.evaluate('testRoom.stems.saveChain')
            page.reload();page.get_by_role('button',name='SCREW',exact=True).click()
            page.wait_for_function('testRoom.stems.tracks.every(t=>t.buffer)')
            assert page.evaluate('testRoom.stems.tracks[1].pitch')==-5
            assert page.evaluate('testRoom.stems.rate')==.75
            page.get_by_role('button',name='VOCALS + INSTRUMENTAL',exact=True).click()
            print('Two stems, independent effects, WAV save and session restore passed',flush=True)
            # Stems onto the tables: vocals get their own pitch while chopping.
            page.get_by_role('button',name='SCREW THESE ON THE TABLES →',exact=True).click()
            page.wait_for_function('testRoom.app._deckA.stems && testRoom.app._deckB.stems && testRoom.mode==="decks"')
            assert page.evaluate('testRoom.app._deckA.vocalPitch.pitch')==-5
            page.get_by_label('Vocal pitch',exact=True).fill('-7')
            assert page.evaluate('[testRoom.app._deckA.vocalPitch.pitch,testRoom.app._deckB.vocalPitch.pitch,testRoom.app._deckA.pitch.pitch]')==[-7,-7,0]
            page.get_by_role('button',name='▶ PLAY / PAUSE',exact=True).click();page.wait_for_function('testRoom.app.state.deckA.playing')
            page.get_by_role('button',name='■ STOP',exact=True).click()
            page.get_by_role('button',name='VOCALS + INSTRUMENTAL',exact=True).click()
            print('Stems on the tables with separate vocal pitch passed',flush=True)
            # A completed split pair is selectable directly, with matching source alignment.
            page.evaluate("""async()=>{const a=testRoom.app,ts=testRoom.stems.tracks;await a.sb.from('beats').insert({id:'pair-test',label:'Split pair'});for(let i=0;i<2;i++){const r=await fetch(ts[i].url),blob=await r.blob(),path='local/pair/'+i+'.wav';await a.sb.storage.from('stems').upload(path,blob);await a.sb.from('stems').insert({beat_id:'pair-test',kind:i?'vocals':'instrumental',storage_path:path});}await a.loadAllStems();}""")
            page.get_by_label('Completed splits',exact=True).select_option('pair-test')
            page.get_by_role('button',name='LOAD SPLIT PAIR',exact=True).click()
            page.wait_for_function("testRoom.stems.tracks.every(t=>t.name.startsWith('Split pair'))")
            assert page.evaluate('testRoom.stems.position')==0
            # Simulate a failed audio write: original and rendered version remain available for retry.
            page.route('**/api/audio/beats/**',lambda route:route.fulfill(status=503,content_type='application/json',body='{"error":{"message":"Test offline"}}'))
            page.get_by_label('Stem mix version name',exact=True).fill('Retry version')
            page.get_by_role('button',name='SAVE STEM MIX AS WAV',exact=True).click()
            page.wait_for_function('testRoom.pending && !testRoom.saving && !testRoom.stems.exporting')
            page.unroute('**/api/audio/beats/**')
            page.get_by_role('button',name='RETRY AUDIO SAVE',exact=True).click()
            page.wait_for_function("testRoom.app.state.library.some(x=>x.name==='Retry version')")
            print('Completed split loading, audible live recording, shared Stop, and failed-save retry passed',flush=True)
            page.evaluate("document.querySelector('.dj-scroll').scrollTop=0")
            page.set_viewport_size({'width':390,'height':844})
            page.wait_for_timeout(300)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Mobile overflow'
            out=ROOT/'test-results';out.mkdir(exist_ok=True)
            page.screenshot(path=str(out/'screw-mobile.png'),full_page=True)
            page.set_viewport_size({'width':1440,'height':1000});page.screenshot(path=str(out/'screw-desktop.png'),full_page=True)
            assert not errors,errors
            print('Mobile width and browser errors passed',flush=True)
            browser.close()
    finally:
        server.shutdown();thread.join();server.server_close()
