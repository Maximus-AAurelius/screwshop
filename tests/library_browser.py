"""Organized local library, safe removal, browser focus, and actual slowed mix output."""
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import threading
import wave
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from local_server import make_server
from song_source_helpers import load_song_pad


def capture(page):
    page.wait_for_function('!!window.SongLibrary')
    page.evaluate('''() => {
      const refresh=SongLibrary.prototype.refresh;
      SongLibrary.prototype.refresh=function(){window.libraryUI=this;return refresh.call(this)};
    }''')
    page.wait_for_function('window.libraryUI?.app.workspace.ready')


with tempfile.TemporaryDirectory() as temp:
    server = make_server(temp, port=0)
    tone = Path(temp) / 'Gamma upload.wav'
    with wave.open(str(tone), 'wb') as audio:
        audio.setparams((1, 2, 22050, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(12000 * math.sin(i * 2 * math.pi * 220 / 22050))) for i in range(44100)))
    fixtures = [('beats', 'local/alpha.wav'), ('beats', 'local/11111111-1111-4111-8111-111111111111.wav'), ('stems', 'local/vocals.wav'), ('takes', 'local/take.wav')]
    for bucket, name in fixtures:
        path = server.store.asset(bucket, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(tone, path)
    for row in [
        {'id':'alpha', 'name':'Alpha original', 'storage_path':fixtures[0][1], 'created_at':'2026-01-01T12:00:00Z'},
        {'id':'beta', 'name':'Beta screwed', 'source_kind':'screw-version', 'storage_path':fixtures[1][1], 'created_at':'2026-02-01T12:00:00Z'},
    ]:
        server.store.query({'table':'library', 'action':'insert', 'values':row})
    server.store.query({'table':'beats', 'action':'insert', 'values':{'id':'alpha-beat','label':'Alpha original','storage_path':fixtures[0][1]}})
    server.store.query({'table':'stems', 'action':'insert', 'values':{'id':'alpha-vocals','beat_id':'alpha-beat','kind':'vocals','storage_path':fixtures[2][1]}})
    server.store.query({'table':'takes', 'action':'insert', 'values':{'id':'first-take','label':'Vocal take','storage_path':fixtures[3][1]}})
    server.store.query({'table':'settings', 'action':'upsert', 'values':{'id':'organized-pack','folder_type':'pack','name':'My drum pack','files':[{'name':'Drum tone','url':'/audio/beats/local/alpha.wav','storage_path':fixtures[0][1],'bucket':'beats'}]}})
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            chrome = os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            browser = p.chromium.launch(executable_path=chrome, headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width':1440,'height':1024}, accept_downloads=True)
            errors, external = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda req: external.append(req.url) if not req.url.startswith((base,'blob:','data:')) else None)
            page.goto(base + '/barwork')
            page.get_by_role('button', name='SONGS', exact=True).click()
            capture(page)
            page.locator('[data-name][value="Alpha original"]').wait_for()
            assert page.locator('[data-category="Imported"] small').inner_text() == '1'
            assert page.locator('[data-category="Saved versions"] small').inner_text() == '1'
            assert page.locator('[data-category="Stems"] small').inner_text() == '1'
            assert page.locator('[data-category="Recordings"] small').inner_text() == '1'
            assert page.locator('[data-category="Packs"] small').inner_text() == '1'
            page.locator('[data-category="Saved versions"]').click()
            assert page.locator('.ss-library-row').count() == 1
            assert page.locator('[data-name]').input_value() == 'Beta screwed'
            page.locator('[data-category="All"]').click()
            search = page.get_by_role('searchbox', name='Search songs and sounds')
            search.fill('vocals')
            assert page.locator('.ss-library-row').count() == 1
            search.fill('no matching sound')
            page.get_by_text('No matching sounds', exact=True).wait_for()
            search.fill('')
            page.locator('[data-sort]').select_option('name')
            assert page.locator('.ss-library-row').first.locator('[data-name]').input_value() == 'Alpha original'
            # A background update preserves active search and a manually closed group.
            page.locator('[data-library-group="Original audio"] > summary').click()
            search.fill('Alpha')
            search.focus()
            page.evaluate('libraryUI.app.setState({notice:"Background test"});libraryUI.signature="";libraryUI.refresh()')
            assert search.evaluate('(el)=>document.activeElement===el')
            search.fill('')
            assert not page.locator('[data-library-group="Original audio"]').evaluate('(el)=>el.open')
            page.locator('[data-library-group="Original audio"] > summary').click()
            # Preview uses the actual audio file and does not add arrangement clips.
            page.get_by_role('button', name='Preview Alpha original', exact=True).click()
            page.wait_for_function('document.querySelector(".ss-library-preview audio").currentTime>0')
            page.get_by_role('button', name='Stop audio preview', exact=True).click()
            assert page.locator('.ss-library-preview').is_hidden()
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='+ UPLOAD FILE', exact=True).click()
            chooser.value.set_files(str(tone))
            page.locator('[data-name][value="Gamma upload"]').wait_for()
            name = page.locator('[data-name][value="Gamma upload"]')
            name.fill('Gamma renamed'); name.press('Tab')
            page.wait_for_function('libraryUI.app.state.library.some(x=>x.name==="Gamma renamed")')
            page.reload()
            page.get_by_role('button', name='SONGS', exact=True).click()
            capture(page)
            page.locator('[data-name][value="Gamma renamed"]').wait_for()
            # Add the original to Studio, then export at .5 speed and inspect the rendered WAV.
            row = page.locator('.ss-library-row').filter(has=page.locator('[data-name][value="Alpha original"]'))
            row.get_by_role('button', name='Add to Studio', exact=True).click()
            page.wait_for_function('libraryUI.app.state.tab==="studio" && libraryUI.app.studio.tracks.some(t=>t.clips.some(c=>c.name==="Alpha original"))')
            output = page.evaluate('''async()=>{
              const sampler=libraryUI.app.workspace,studio=libraryUI.app.studio;
              const finish=sampler.finishExport;let output;
              try{
                studio.rate=.5;studio.tracks.forEach(t=>{t.volume=1;t.muted=false;t.solo=false;t.clips.forEach(c=>c.start=1)});
                sampler.finishExport=async(blob)=>{
                  const buffer=await studio.context().decodeAudioData(await blob.arrayBuffer()),data=buffer.getChannelData(0);
                  let crossings=0;const start=Math.floor(2.2*buffer.sampleRate),end=Math.floor(3.2*buffer.sampleRate);
                  for(let i=start;i<end;i++)if(data[i]<=0&&data[i+1]>0)crossings++;
                  output={duration:buffer.duration,frequency:crossings,leadingPeak:data.slice(0,Math.floor(1.9*buffer.sampleRate)).reduce((m,x)=>Math.max(m,Math.abs(x)),0),peak:data.reduce((m,x)=>Math.max(m,Math.abs(x)),0)};
                };
                await sampler.exportStudio();return output;
              }finally{sampler.finishExport=finish;studio.rate=1;}
            }''')
            assert abs(output['duration']-6) < .01, output
            assert 109 <= output['frequency'] <= 111, output
            assert output['leadingPeak'] < .001 and output['peak'] > .1, output
            print('PASS: slowed Studio export duration, offset, pitch and audible samples', json.dumps(output), flush=True)
            # Save real WAV mixes as distinct versions; preserve source trims, loop length,
            # solo/mute balance, track level and the original editable session.
            saved = page.evaluate('''async()=>{
              const workspace=libraryUI.app.workspace,studio=libraryUI.app.studio;
              const original=studio.tracks,rate=studio.rate;
              const source=original.flatMap(t=>t.clips).find(c=>c.name==='Alpha original');
              try{
                studio.rate=.5;
                studio.tracks=[
                  {id:'mix-audible',volume:.25,solo:true,clips:[{...source,start:.5,sourceOffset:.25,length:2.5}]},
                  {id:'mix-muted',volume:1,solo:true,muted:true,clips:[{id:'missing',name:'Muted unavailable',url:'/audio/beats/missing.wav',start:0,length:1}]},
                  {id:'mix-excluded',volume:1,clips:[{...source,start:0,length:2.5}]}
                ];
                const before=JSON.stringify(studio.tracks),samplerBefore=JSON.stringify(workspace.snapshot());
                const first=await workspace.saveStudioToSongs('Evening clarity draft');
                const second=await workspace.saveStudioToSongs('Evening clarity draft');
                const decoded=await studio.context().decodeAudioData(await (await fetch(first.url)).arrayBuffer()),data=decoded.getChannelData(0);
                let crossings=0;for(let i=decoded.sampleRate*1.2;i<decoded.sampleRate*2.2;i++)if(data[Math.floor(i)]<=0&&data[Math.floor(i)+1]>0)crossings++;
                const result={first,second,duration:decoded.duration,frequency:crossings,peak:data.reduce((m,x)=>Math.max(m,Math.abs(x)),0),leadingPeak:data.slice(0,Math.floor(.99*decoded.sampleRate)).reduce((m,x)=>Math.max(m,Math.abs(x)),0),unchanged:before===JSON.stringify(studio.tracks)&&samplerBefore===JSON.stringify(workspace.snapshot())};
                const errors=[];
                for(const change of [()=>studio.tracks=[],()=>{studio.tracks=[{volume:0,clips:[{...source,start:0,length:1}]}]},()=>{studio.tracks=[{volume:1,clips:[{...source,start:0,length:1799}]}];studio.rate=1},()=>studio.rate=0]){
                  change();try{await workspace.saveStudioToSongs('Rejected save');errors.push('no error')}catch(error){errors.push(error.message)}
                }
                studio.rate=1;studio.tracks=[0,1].map(index=>({id:'loud-'+index,volume:2,clips:[{...source,start:0,length:2}]}));
                const masterBefore=studio.mixMaster;
                const limited=await workspace.renderStudio(),ls=limited.getChannelData(0);
                result.limited={...limited.studioMixStats,peak:ls.reduce((m,x)=>Math.max(m,Math.abs(x)),0)};
                studio.mixMaster={limiter:{on:false}};
                const safe=await workspace.renderStudio(),samples=safe.getChannelData(0);studio.mixMaster=masterBefore;
                result.headroom={...safe.studioMixStats,peak:samples.reduce((m,x)=>Math.max(m,Math.abs(x)),0),clipped:samples.some(x=>Math.abs(x)>=1)};
                result.errors=errors;return result;
              }finally{studio.tracks=original;studio.rate=rate;await studio.save();}
            }''')
            assert saved['first']['id'] != saved['second']['id']
            assert saved['first']['storage_path'] != saved['second']['storage_path']
            assert saved['first']['source_kind'] == 'studio-mix' and saved['first']['source_session_id'] == 'recording-session'
            assert abs(saved['duration'] - 6) < .01 and 109 <= saved['frequency'] <= 111, saved
            assert .090 < saved['peak'] < .093 and saved['leadingPeak'] < .001 and saved['unchanged'], saved
            assert all('no error' != message for message in saved['errors']), saved
            assert 'no clips' in saved['errors'][0] and 'audible' in saved['errors'][1] and '300 MB' in saved['errors'][2] and 'speed' in saved['errors'][3], saved
            assert server.store.asset('beats', saved['first']['storage_path']).is_file()
            # Master limiter (default on, -1 dBFS ceiling) holds summed overs below the ceiling without turning the mix down.
            assert saved['limited']['peak'] <= 10 ** (-1 / 20) + 1e-6 and saved['limited']['headroom_gain'] == 1, saved['limited']
            # With the limiter off, the export still scales an over-full mix down instead of clipping.
            assert saved['headroom']['input_peak'] > 1 and saved['headroom']['headroom_gain'] < 1
            assert abs(saved['headroom']['peak']-.98) < .00001 and not saved['headroom']['clipped'], saved['headroom']
            assert saved['first']['headroom_gain'] == 1, 'Quiet mixes must retain their gain'
            print('PASS: distinct persisted Studio mixes preserve trim/loop/solo/mute/level/speed, editable sources and render limits', flush=True)
            # Sound browser filtering does not erase the Studio search box during updates.
            studio_search = page.get_by_role('textbox', name='Search sound library')
            studio_search.fill('Alpha'); studio_search.focus()
            page.evaluate('libraryUI.app.workspace.renderLibrary()')
            assert studio_search.evaluate('(el)=>document.activeElement===el')
            page.get_by_role('combobox', name='Filter Studio sounds').select_option('Versions')
            assert page.locator('.sl-file').count() == 0
            studio_search.fill('')
            assert page.locator('.sl-file').count() == 3
            # The sampler opens SONGS as its single sound source and loads an explicit pad.
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).first.click()
            assert page.locator('.sp-library').count() == 0
            page.get_by_role('button', name='Load from Songs', exact=True).click()
            page.locator('#ss-song-library').wait_for()
            page.evaluate('window.sampler=libraryUI.app.workspace')
            load_song_pad(page, 'Alpha original', 4)
            page.evaluate('window.keptSlot=sampler.slots[4]')
            trim=page.evaluate('''async()=>{
              const item=libraryUI.app.state.library.find(x=>x.id==='alpha');
              const other=await sampler.loadSongToPad({...item,start:.2,end:.7},9);
              return {start:other.start,end:other.end,kept:JSON.stringify(sampler.slots[4])===JSON.stringify(window.keptSlot)};
            }''')
            assert trim == {'start':.2,'end':.7,'kept':True}, trim
            # Delete: gone at once, UNDO brings it back; once committed, audio still used in Studio stays playable.
            page.get_by_role('button', name='SONGS', exact=True).click()
            row = page.locator('.ss-library-row').filter(has=page.locator('[data-name][value="Alpha original"]'))
            row.click(button='right', position={'x':60,'y':12})
            page.locator('.im-menu [data-action="delete"]').click()
            page.locator('.im-ask').get_by_role('button', name='DELETE', exact=True).click()  # it has a stem: keep it
            page.locator('[data-name][value="Alpha original"]').wait_for(state='detached')
            page.locator('.im-toast .im-undo').click()
            page.locator('[data-name][value="Alpha original"]').wait_for()
            assert page.locator('.im-toast').filter(has_text='Restored').count() == 1
            row.locator('[data-row-menu]').click()
            page.locator('.im-menu [data-action="delete"]').click()
            page.locator('.im-ask').get_by_role('button', name='DELETE', exact=True).click()
            page.locator('.im-toast .im-dismiss').last.click()  # skip the 10-second wait
            page.wait_for_function('!libraryUI.app.state.library.some(x=>x.id==="alpha")')
            page.locator('[data-name][value="Alpha original"]').wait_for(state='detached')
            assert page.locator('[data-entry="Stems:alpha-vocals"]').count() == 1, 'stems kept when not ticked'
            assert server.store.asset('beats', fixtures[0][1]).is_file(), 'audio used by Studio must stay in place'
            trash = Path(temp) / 'Deleted Files'
            assert len(list(trash.iterdir())) == 1 and (next(trash.iterdir()) / 'item.json').is_file()
            # A recording nothing else uses really moves to Deleted Files.
            page.locator('[data-category="Recordings"]').click()
            take = page.locator('.ss-library-row').filter(has=page.locator('[data-name][value="Vocal take"]'))
            take.locator('[data-row-menu]').click()
            page.locator('.im-menu [data-action="delete"]').click()
            page.locator('.im-toast .im-dismiss').last.click()
            page.wait_for_function('!libraryUI.app.workspace.takes.some(x=>x.id==="first-take")')
            assert not server.store.asset('takes', fixtures[3][1]).exists()
            assert list(trash.glob('*Vocal take*/takes/take.wav'))
            page.locator('.ss-library-empty').wait_for()  # an empty category says so
            page.locator('.ss-library-categories [data-category="All"]').click()
            assert page.request.get(base+'/audio/beats/'+fixtures[0][1]).ok
            assert page.evaluate('libraryUI.app.studio.tracks.some(t=>t.clips.some(c=>c.name==="Alpha original"))')
            out = ROOT/'test-results'; out.mkdir(exist_ok=True)
            page.screenshot(path=str(out/'library-desktop.png'))
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(out/'library-phone.png'))
            # On a phone, the same picker can load a keyboard instrument and its source persists.
            load_song_pad(page, 'Gamma renamed', 16)
            assert page.locator('[data-mode]').input_value() == '16'
            assert page.locator('.ox-key').count() == 25
            assert page.locator('.sp-body').get_attribute('data-view') == 'pads'
            page.locator('.ox-key[data-note="60"]').scroll_into_view_if_needed()
            assert page.locator('.ox-key[data-note="60"]').is_visible()
            assert page.get_by_role('button', name='Load from Songs', exact=True).is_visible()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(out/'library-sampler-instrument-phone.png'))
            page.reload()
            page.get_by_role('button', name='SONGS', exact=True).click()
            capture(page)
            assert page.evaluate('libraryUI.app.state.library.filter(x=>x.source_kind==="studio-mix").length') == 2
            assert page.evaluate('libraryUI.app.workspace.slots[9].start===.2 && libraryUI.app.workspace.slots[9].end===.7 && libraryUI.app.workspace.slots[16].name==="Gamma renamed"')
            assert page.evaluate('libraryUI.app.studio.tracks.some(t=>t.clips.some(c=>c.name==="Alpha original"))')
            assert not errors, errors
            assert not external, external
            print('PASS: category/search/sort, rename/import persistence, preview, browser focus/groups, safe listing removal, mobile layout and local-only requests', flush=True)
            browser.close()
    finally:
        server.shutdown(); thread.join(); server.server_close()
