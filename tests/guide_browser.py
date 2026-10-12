"""Walkthroughs: the SCREW mix and the sequencer beat run start to finish on AUTO-PLAY with an empty
library (demo audio), doing every step for real; the split-beat walkthrough follows a user from
upload to pads to a saved beat (the split itself is faked; Demucs is covered elsewhere)."""
import os, sys, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server

FAKE_SPLIT = '''async (song) => {
  const ws = testApp.workspace, wav = (secs, freq) => {const rate=22050,n=Math.floor(rate*secs),b=new ArrayBuffer(44+n*2),v=new DataView(b),s=(o,t)=>[...t].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
    s(0,'RIFF');v.setUint32(4,36+n*2,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,n*2,true);
    for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(i/rate*2*Math.PI*freq)*9000*Math.exp(-i/rate*6),true);return b;};
  const files=[];
  for(let i=0;i<6;i++){const f=await testApp.studio.uploadFile(new File([wav(.4,90+i*60)],'hit'+i+'.wav',{type:'audio/wav'}));files.push({...f,name:'drums-hit-'+(i+1),kind:'drums',sample:true,duration:.4});}
  await ws.checked(testApp.sb.from('settings').upsert({id:'split-guide',folder_type:'split',mode:'full',name:song,files}));
  await ws.refreshLibrary();
  const item = testApp.state.library.find(x => x.name === song);
  testApp.setState(prev => ({ splitJobs: { ...prev.splitJobs, [item.id]: { status: 'done' } } }));
}'''

with tempfile.TemporaryDirectory() as temp:
    server = make_server(Path(temp) / 'data', port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            chrome = sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1]
            browser = p.chromium.launch(executable_path=str(chrome), headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script("""Object.defineProperty(window,'ScrewGuide',{configurable:true,set(C){Object.defineProperty(window,'ScrewGuide',{value:class extends C {constructor(a){super(a);window.testGuide=this;window.testApp=a;}},writable:true});}});""")
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('window.testApp?.sb && window.testApp.workspace?.ready')
            notice = lambda: page.evaluate('testApp.state.notice || ""')

            # 1) SCREW mix on AUTO-PLAY.
            page.get_by_role('button', name='SCREW', exact=True).click()
            page.locator('.sg-launch').wait_for()
            page.locator('[data-sg-auto="screw-mix"]').click()
            page.locator('.sg-card').wait_for()
            page.wait_for_function('!window.testGuide.tour', timeout=240000)
            assert 'Walkthrough finished: SCREW MIX' in notice(), notice()
            st = page.evaluate('testApp.screwRoom.stats')
            assert st.get('runBack', 0) >= 2 and st.get('flick', 0) >= 3 and st.get('lag') and st.get('slow') and st.get('scratch') and st.get('record'), st
            mix = page.evaluate('[!!testApp._deckB.buffer, testApp._deckA.buffer!==testApp._deckB.buffer, testApp.state.crossfade, testApp.state.deckB.playing, testApp.screwRoom.recording]')
            assert mix[0] and mix[1] and mix[2] > .5 and mix[3] and not mix[4], mix
            page.wait_for_function("testApp.state.library.some(x=>/screwed|Live screw mix/i.test(x.name))", timeout=30000)
            assert page.evaluate("JSON.parse(localStorage.getItem('screwshop.guides.v1'))['screw-mix'].finished")
            page.evaluate('testApp.pauseBothDecks()')
            print('SCREW mix walkthrough auto-played every step: loaded, slowed, taped, recorded, chopped, scratched, blended, saved', st)

            # 2) Sequencer beat on AUTO-PLAY (no pads loaded: it loads a demo kit).
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()
            page.locator('[data-sg-auto="sequencer-beat"]').click()
            page.wait_for_function('!window.testGuide.tour', timeout=180000)
            assert 'Walkthrough finished: SEQUENCER BEAT' in notice(), notice()
            seq = page.evaluate('(()=>{const w=testApp.workspace,e=w.project.patterns[0].events;return {kick:e.filter(x=>x.lane===0).length,snare:e.filter(x=>x.lane===1).length,hats:e.filter(x=>x.lane===2).length,patterns:w.project.patterns.length,swing:w.project.swing,pads:w.slots.slice(0,4).filter(Boolean).length};})()')
            assert seq['kick'] >= 2 and seq['snare'] >= 2 and seq['hats'] >= 4 and seq['patterns'] >= 2 and seq['swing'] > 0 and seq['pads'] == 4, seq
            page.wait_for_function("fetch('/api/query',{method:'POST',headers:{'X-ScrewShop':'1','Content-Type':'application/json'},body:JSON.stringify({table:'settings'})}).then(r=>r.json()).then(j=>j.data.some(x=>x.kind==='sampler-beat'&&x.name==='My sequencer beat'))")
            if page.evaluate('testApp.workspace.playing'): page.locator('#ss-sampler [data-action="play"]').first.click()
            print('Sequencer walkthrough auto-played: demo kit, kick/snare/hats, swing, variation, saved beat', seq)

            # 3) Beat from a split, followed step by step with SHOW ME (split faked).
            page.locator('[data-sg-start="split-beat"]').click()
            card = page.locator('.sg-card')
            def step_title(): return card.locator('h4').inner_text()
            def show_and_wait(title):
                assert step_title() == title, (step_title(), title)
                card.get_by_role('button', name='SHOW ME').click()
                page.wait_for_function(f'(h => h && h.textContent !== {title!r})(document.querySelector(".sg-card h4"))', timeout=60000)
            card.get_by_role('button', name='NEXT').click()
            show_and_wait('Go to SONGS')
            show_and_wait('Upload your MP3')
            assert step_title() == 'Full split it', step_title()
            page.evaluate(FAKE_SPLIT, 'ScrewShop demo record')   # stands in for SHOW ME + the Demucs run
            page.wait_for_function('document.querySelector(".sg-card h4")?.textContent === "Open the split as a pack"', timeout=20000)
            show_and_wait('Open the split as a pack')
            page.wait_for_function('document.querySelector(".sg-card h4")?.textContent === "Choose your sounds"')
            assert card.evaluate('c => !!c.closest("dialog")'), 'card should sit inside the pack dialog'
            card.get_by_role('button', name='NEXT').click()
            show_and_wait('Load them onto the Oxygen')
            assert page.evaluate('testApp.workspace.slots.slice(0,16).filter(Boolean).length') >= 6
            card.get_by_role('button', name='NEXT').click()   # MIDI (optional)
            show_and_wait('Play the pads')
            card.get_by_role('button', name='NEXT').click()   # trim (info)
            show_and_wait('Set the tempo and click')
            show_and_wait('Record a beat')
            show_and_wait('Play it back and fix it')
            show_and_wait('Save the beat')
            assert step_title() == 'Take it further'
            card.get_by_role('button', name='FINISH').click()
            assert 'Walkthrough finished: BEAT FROM A SPLIT' in notice(), notice()
            print('Split-beat walkthrough: upload, split, open pack (card inside the dialog), load pads, play, tempo, record, play back, save')

            page.get_by_role('button', name='SCREW', exact=True).click()
            page.set_viewport_size({'width': 390, 'height': 860})
            page.locator('[data-sg-start="screw-mix"]').click(); page.wait_for_timeout(500)
            assert page.locator('[data-sg-start="split-beat"]').count() == 0, 'sampler launchers leaked onto SCREW'
            box = card.bounding_box(); assert box['x'] >= 0 and box['x'] + box['width'] <= 390, box
            page.screenshot(path=str(ROOT / 'test-results' / 'guide-phone.png'))
            page.keyboard.press('Escape')
            assert not errors, errors
            print('PASS: walkthroughs (phone layout, no page errors)')
            browser.close()
    finally:
        server.shutdown()
