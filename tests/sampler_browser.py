"""Real browser/audio integration, isolated local store; no user data or hardware required."""
import os, sys, tempfile, threading, wave, math, struct
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server
from song_source_helpers import upload_song, load_song_pad, drop_song_on_key

with tempfile.TemporaryDirectory() as temp:
    audio=Path(temp)/'Sampler tone.wav'
    with wave.open(str(audio),'wb') as w:
        w.setparams((1,2,22050,0,'NONE','not compressed'))
        w.writeframes(b''.join(struct.pack('<h',int(14000*math.sin(i*2*math.pi*220/22050))) for i in range(22050)))
    server=make_server(temp,port=0)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as p:
            chrome=os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            browser=p.chromium.launch(executable_path=chrome,headless=True,args=['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
            page=browser.new_page(viewport={'width':1366,'height':900},accept_downloads=True)
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.StudioWorkspace')
            # Capture the existing instance through a normal lifecycle method.
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            page.get_by_role('button',name='M-AUDIO / SAMPLER',exact=True).click()
            upload_song(page, audio, 'Sampler tone')
            load_song_pad(page, 'Sampler tone', 0)
            page.wait_for_function('sampler.slots[0]?.name.includes("Sampler tone")')
            page.locator('[data-pad="0"]').click()
            page.wait_for_function('sampler.voices.size>0')
            assert page.evaluate('sampler.buffers.size')==1
            # Non-destructive trim/reverse/pan are honored by the actual audio renderer.
            rendered=page.evaluate('''async()=>{
              const previous=sampler.snapshot();
              Object.assign(sampler.slots[0],{start:.2,end:.3,reverse:true,gate:true,loop:false,pan:-1});
              sampler.pattern.events=[{id:'trim-test',lane:0,note:60,at:0,len:2,velocity:100}];
              const audio=await sampler.renderAudio([sampler.pattern],82);
              const left=audio.getChannelData(0),right=audio.getChannelData(1);
              const peak=a=>a.reduce((m,v)=>Math.max(m,Math.abs(v)),0);
              const result={left:peak(left),right:peak(right),tail:peak(left.slice(5000)),original:sampler.buffers.values().next().value.duration};
              await sampler.restore(previous);return result;
            }''')
            assert rendered['left']>.1 and rendered['right']<.001 and rendered['tail']<.001,rendered
            assert rendered['original']==1
            # A failed replacement preserves the old playable assignment.
            assert page.evaluate('''async()=>{const url=sampler.slots[0].url;try{await sampler.assign(0,{url:'/audio/beats/missing.wav',name:'Missing'})}catch(_){}return sampler.slots[0].url===url}''')
            # Move and copy assignment, then undo deletion.
            page.locator('[data-pad="0"]').drag_to(page.locator('[data-pad="1"]'))
            page.wait_for_function('!sampler.slots[0] && sampler.slots[1]')
            page.locator('[data-action=undo]').click()
            page.wait_for_function('sampler.slots[0] && !sampler.slots[1]')
            page.locator('[data-pad="0"]').click()
            page.locator('[data-action=clear]').click()
            page.wait_for_function('!sampler.slots[0]')
            page.locator('[data-action=undo]').click()
            page.wait_for_function('sampler.slots[0]')
            # Drum mode keys accept independent assignments; instrument mode repitches one sound.
            drop_song_on_key(page, 'Sampler tone', '[data-note="49"]')
            page.wait_for_function('sampler.slots[1]')
            page.locator('[data-mode]').select_option('16')
            drop_song_on_key(page, 'Sampler tone', '[data-note="60"]')
            page.wait_for_function('sampler.slots[16]')
            # Actual MIDI callback, learn distinct keys, reconnect, sustain and note off.
            page.evaluate('''() => {window.port={name:'Test Oxygen',state:'connected'};navigator.requestMIDIAccess=async()=>({inputs:new Map([['test',port]])});}''')
            page.locator('[data-action=midi]').click()
            page.wait_for_function('!!window.port.onmidimessage')
            page.evaluate('port.onmidimessage({data:[144,60,90]})')
            page.wait_for_function('sampler.held.size>0')
            page.evaluate('port.onmidimessage({data:[176,64,127]});port.onmidimessage({data:[128,60,0]})')
            assert page.evaluate('sampler.held.size')==1
            page.evaluate('port.onmidimessage({data:[176,64,0]})')
            page.wait_for_function('sampler.held.size===0')
            page.evaluate('sampler.selected=0;sampler.learning="pad:0";port.onmidimessage({data:[144,70,90]})')
            assert page.evaluate('sampler.project.maps["pad:0"].number')==70
            page.evaluate('port.onmidimessage({data:[144,70,100]})')
            page.wait_for_function('sampler.held.get("midi:0:70")?.lane===0')
            page.evaluate('port.onmidimessage({data:[128,70,0]})')
            # Click steps and record a live second pass; previews must add no notes.
            page.locator('[data-cell="0:60:0"]').click()
            page.locator('[data-cell="0:60:4"]').click()
            assert page.evaluate('sampler.pattern.events.length')==2
            # A touch-accessible edit mode changes both note length and velocity.
            page.locator('[data-action=edit-events]').click()
            page.locator('[data-cell="0:60:0"]').click()
            page.locator('[data-event=velocity]').fill('77');page.locator('[data-event=velocity]').press('Tab')
            page.locator('[data-cell="0:60:0"]').click()
            page.locator('[data-event=len]').fill('0.5');page.locator('[data-event=len]').press('Tab')
            assert page.evaluate('sampler.pattern.events[0].velocity===77 && sampler.pattern.events[0].len===.5')
            page.locator('[data-action=edit-events]').click()
            page.locator('[data-project=countIn]').uncheck()
            page.locator('[data-action=record]').click()
            page.wait_for_timeout(250)
            page.locator('[data-pad="0"]').click()
            page.wait_for_timeout(150)
            page.locator('[data-action=play]').click()
            assert page.evaluate('sampler.pattern.events.length')>=3
            before=page.evaluate('sampler.pattern.events.length')
            page.get_by_role('button',name='SONGS',exact=True).click()
            page.get_by_role('button',name='Preview Sampler tone',exact=True).click()
            assert page.evaluate('sampler.pattern.events.length')==before
            page.get_by_role('button',name='M-AUDIO / SAMPLER',exact=True).click()
            # Pitched part, editable note lengths, offline WAV with audible samples.
            page.evaluate('''() => {sampler.checkpoint();sampler.pattern.events.push({id:'melody-test',lane:16,note:64,at:2,len:.5,velocity:80});sampler.changed();sampler.drawSequence()}''')
            page.once('dialog',lambda d:d.accept('Integration Kit'))
            page.locator('[data-action=kit]').click()
            page.wait_for_function('sampler.kits.length===1')
            page.once('dialog',lambda d:d.accept('Integration Beat'))
            page.locator('[data-action=beat]').click()
            page.wait_for_function('sampler.beats.length===1')
            page.locator('.sp-tools summary').click()
            with page.expect_download() as d:page.locator('[data-action=export]').click()
            output=Path(temp)/'export.wav';d.value.save_as(output)
            with wave.open(str(output)) as w:
                assert w.getnchannels()==2 and w.getnframes()>40000
                data=struct.unpack('<'+'h'*(w.getnframes()*2),w.readframes(w.getnframes()))
                assert max(abs(x) for x in data)>1000
            if page.evaluate('sampler.mp3Available'):
                with page.expect_download() as d:page.locator('[data-action=export-mp3]').click()
                mp3=Path(temp)/'share.mp3';d.value.save_as(mp3)
                assert mp3.stat().st_size>1000
                # Decode the actual downloaded MP3, not just its file extension.
                import base64
                encoded=base64.b64encode(mp3.read_bytes()).decode()
                assert page.evaluate('''async encoded=>{const b=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const audio=await sampler.context().decodeAudioData(b.buffer);return audio.duration>1}''',encoded)
            page.locator('[data-action=send]').click()
            page.wait_for_function('sampler.app.studio.tracks.some(t=>t.clips.some(c=>c.samplerSource))')
            page.wait_for_function('!sampler.transferring')
            tracks=page.evaluate('sampler.app.studio.tracks.length')
            page.locator('[data-action=send]').click()
            page.wait_for_timeout(150)
            assert page.evaluate('sampler.app.studio.tracks.length')==tracks
            page.evaluate('''() => {const c=sampler.app.studio.tracks.find(t=>t.clips.some(c=>c.samplerSource)).clips[0];c.start=3;c.length=6;window.oldRender=c.url;sampler.app.studio.save()}''')
            page.locator('[data-action=update]').click()
            page.wait_for_function('!sampler.transferring && sampler.app.studio.tracks.some(t=>t.clips.some(c=>c.samplerSource && c.url!==window.oldRender))')
            assert page.evaluate('sampler.app.studio.tracks.flatMap(t=>t.clips).find(c=>c.samplerSource).start')==3
            assert page.evaluate('sampler.app.studio.tracks.flatMap(t=>t.clips).find(c=>c.samplerSource).length')==6
            # Multiple patterns render in order, on separate drum/instrument tracks.
            page.once('dialog',lambda d:d.accept('Hook'))
            page.locator('[data-action=duplicate-pattern]').click()
            page.wait_for_function('sampler.project.patterns.length===2')
            page.locator('[data-transfer]').select_option('beat')
            page.locator('[data-separate]').check()
            page.locator('[data-action=send]').click()
            page.wait_for_function('!sampler.transferring && sampler.app.studio.tracks.length==='+str(tracks+2))
            tracks+=2
            assert page.evaluate('sampler.app.studio.tracks.slice(-2).every(t=>Math.abs(t.clips[0].dur-8*60/82)<.001)')
            page.evaluate('sampler.save()')
            page.reload()
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready && sampler.slots[0] && sampler.slots[16]')
            assert page.evaluate('sampler.pattern.events.length')==before+1
            assert page.evaluate('sampler.project.maps["pad:0"].number')==70
            page.get_by_role('button',name='STUDIO',exact=True).click()
            page.locator('[data-clip]').first.wait_for()
            # Existing Studio microphone path still creates a separate audio track.
            page.evaluate('sampler.app.studio.countIn=false;sampler.app.studio.cursor=0;sampler.app.studio.record()')
            page.wait_for_function('sampler.app.studio.recording')
            page.wait_for_timeout(450)
            page.evaluate('sampler.app.studio.stopRecord()')
            page.wait_for_function('sampler.app.studio.tracks.length>'+str(tracks),timeout=15000)
            with page.expect_download() as d:page.get_by_role('button',name='EXPORT MIX WAV',exact=True).click()
            d.value.save_as(Path(temp)/'mix.wav')
            with wave.open(str(Path(temp)/'mix.wav')) as w:assert w.getnframes()>10000
            # Narrow touch alternative, editor scrolling, mobile sequence.
            page.set_viewport_size({'width':390,'height':844})
            page.get_by_role('button',name='M-AUDIO / SAMPLER',exact=True).first.click()
            page.get_by_role('button',name='Load from Songs',exact=True).click()
            load_song_pad(page, 'Sampler tone', 3)
            page.wait_for_function('sampler.slots[3]')
            page.locator('[data-action=view-sequence]').click()
            page.locator('[data-cell="3:60:0"]').click()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            out=ROOT/'test-results';out.mkdir(exist_ok=True)
            page.screenshot(path=str(out/'sampler-mobile.png'))
            page.set_viewport_size({'width':1366,'height':900})
            page.screenshot(path=str(out/'sampler-desktop.png'))
            assert not errors,errors
            print('PASS: drag/move/undo, melodic and mapped MIDI, sustain, editable recording, WAV audio, persistence, deduplicated Studio handoff/update, vocal track, Studio mix export, narrow touch workflow')
            browser.close()
    finally:
        server.shutdown();thread.join();server.server_close()
