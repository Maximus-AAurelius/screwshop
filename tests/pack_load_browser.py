"""Load onto Oxygen: preview a full split, tick up to 16 sounds, remove one, and fill the pads in one go.

Builds a fake full split (7 long stems + 13 short hits) in a temporary local store.
"""
import os, sys, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server


def chrome_path():
    if os.environ.get('SS_CHROME'):
        return os.environ['SS_CHROME']
    return str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])


with tempfile.TemporaryDirectory() as temp:
    server = make_server(Path(temp) / 'data', port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path(), headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width': 1500, 'height': 950})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('dialog', lambda d: d.accept())  # the Remove confirmation
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()
            # A fake full split: long stems first in the record, short hits after (the window lists hits first).
            page.evaluate('''async () => {
              const wav = (secs, freq) => {const rate=22050,n=Math.floor(rate*secs),b=new ArrayBuffer(44+n*2),v=new DataView(b),s=(o,t)=>[...t].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
                s(0,'RIFF');v.setUint32(4,36+n*2,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,n*2,true);
                for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(i/rate*2*Math.PI*freq)*9000*(i>rate*.5||secs<2?1:0),true);return b;};
              const files=[];
              for(const [i,kind] of ['vocals','instrumental','drums','bass','guitar','piano','other'].entries()){const f=await sampler.app.studio.uploadFile(new File([wav(20,110+i*20)],kind+'.wav',{type:'audio/wav'}));files.push({...f,name:kind,kind});}
              for(let i=0;i<13;i++){const f=await sampler.app.studio.uploadFile(new File([wav(.4,300+i*40)],'hit'+i+'.wav',{type:'audio/wav'}));files.push({...f,name:'drums-hit-'+String(i+1).padStart(2,'0'),kind:'drums',sample:true,duration:.4});}
              await sampler.checked(sampler.app.sb.from('settings').upsert({id:'split-test',folder_type:'split',mode:'full',name:'Test Song',files}));
              await sampler.refreshLibrary();}''')
            # Pad 3 already holds something, to check "Only fill empty pads".
            page.evaluate('''async () => {const x=sampler.folders[0].files[0];await sampler.assign(2,sampler.item(x));sampler.slots[2].name='keep me';sampler.changed();sampler.draw();}''')
            load = page.locator('.sp-library [data-load-pack="split-test"]')
            load.wait_for()
            assert '(20)' in load.text_content()
            load.click()
            dialog = page.locator('#sp-pack')
            dialog.wait_for()
            # 1. Short hits are listed and ticked first; 16 ticked, the rest cannot be ticked.
            names = dialog.locator('.sp-pack-row b').all_text_contents()
            assert names[0] == 'drums-hit-01' and names[13] == 'vocals', names
            assert dialog.locator('[data-pack-count]').text_content() == '16 of 16 pads'
            assert dialog.locator('[data-pack-check]:checked').count() == 16
            assert dialog.locator('[data-pack-check]:disabled').count() == 4
            # 2. Preview plays and stops.
            first = dialog.locator('.sp-pack-row').filter(has_text='vocals')
            first.locator('[data-pack-play]').click()
            page.wait_for_function('sampler.packAudio && !sampler.packAudio.paused')
            assert first.locator('[data-pack-play]').text_content() == '■'
            first.locator('[data-pack-play]').click()
            page.wait_for_function('!sampler.packAudio')
            assert first.locator('[data-pack-play]').text_content() == '▶'
            # 3. Only empty pads: 15 pads available, so the count goes over and loading explains why.
            dialog.locator('[data-pack-empty]').check()
            assert dialog.locator('[data-pack-count]').text_content() == '16 of 15 pads'
            dialog.locator('[data-pack=first]').click()
            assert dialog.locator('[data-pack-count]').text_content() == '15 of 15 pads'
            # 4. Remove one sound from the pack (the audio file itself stays).
            removed_path = page.evaluate("sampler.folders[0].files.find(f=>f.name==='drums-hit-13').storage_path")
            dialog.locator('.sp-pack-row').filter(has_text='drums-hit-13').locator('[data-pack-remove]').click()
            page.wait_for_function("/Removed drums-hit-13/.test(sampler.pack.status)")
            assert page.evaluate('sampler.folders[0].files.length') == 19
            assert (Path(temp) / 'data' / 'audio' / 'stems' / removed_path).is_file() or any(Path(temp, 'data', 'audio').rglob(Path(removed_path).name)), 'audio file must stay on disk'
            # 5. Untick all, tick 3 hits + the vocals stem, keep empty pads only, load.
            dialog.locator('[data-pack=none]').click()
            dialog.locator('[data-pack-empty]').check()
            for name in ['drums-hit-01', 'drums-hit-02', 'drums-hit-03', 'vocals']:
                dialog.locator('.sp-pack-row').filter(has_text=name).locator('[data-pack-check]').check()
            assert 'Pad 4' in dialog.locator('.sp-pack-row').filter(has_text='drums-hit-03').text_content()  # pad 3 is skipped
            history = page.evaluate('sampler.history.length')
            page.evaluate("sampler.app.setState({notice: ''})")  # setup's own long-stem drop showed one
            dialog.locator('[data-pack=load]').click()
            page.wait_for_function("/Loaded 4 sounds/.test(sampler.pack.status)", timeout=20000)
            slots = page.evaluate('sampler.slots.slice(0,6).map(s=>s&&s.name)')
            assert slots == ['drums-hit-01', 'drums-hit-02', 'keep me', 'drums-hit-03', 'vocals', None], slots
            vocal = page.evaluate('sampler.slots[4]')
            assert vocal['start'] >= 0.45 and vocal['end'] - vocal['start'] <= 4 * 4 * 60 / 82 + 0.01, vocal  # 4 bars from first sound
            assert page.evaluate('sampler.history.length') == history + 1, 'one Undo step for the whole load'
            assert not page.evaluate('sampler.app.state.notice'), 'no popup per long stem'
            # 6. Undo puts every pad back in one step.
            dialog.locator('[data-pack=close]').click()
            page.evaluate('sampler.undo()')
            page.wait_for_function("sampler.slots.slice(0,6).filter(Boolean).length === 1")
            page.evaluate('sampler.undo(true)')
            page.wait_for_function("sampler.slots[4]?.name === 'vocals'")
            # 7. Phone width.
            page.locator('.sp-library [data-load-pack="split-test"]').click()
            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(300)
            box = page.locator('#sp-pack').bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= 390, box
            assert page.evaluate("document.querySelector('#sp-pack').scrollWidth <= document.querySelector('#sp-pack').clientWidth + 1")
            if os.environ.get('SS_SHOTS'):
                page.locator('#sp-pack').screenshot(path=os.path.join(os.environ['SS_SHOTS'], 'pack-load-phone.png'))
            page.keyboard.press('Escape')
            # 8. Survives reload.
            page.wait_for_function('sampler.status === "Saved locally"')
            page.reload()
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            assert page.evaluate('sampler.slots[4].name') == 'vocals'
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
print('PASS: load onto Oxygen (hits first, 16-pad limit, preview play/stop, only empty pads, remove keeps audio, one-step undo, phone width, reload)')
