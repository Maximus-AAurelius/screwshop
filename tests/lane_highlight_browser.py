"""Hitting a pad lights its row name in the sequencer (and scrolls it into view), so you can see which lane it is."""
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
            page = browser.new_page(viewport={'width': 1400, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.StudioWorkspace')
            page.evaluate('''() => {const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready')
            page.get_by_role('button', name='M-AUDIO / SAMPLER', exact=True).click()
            page.locator('#ss-sampler .ox-body').wait_for()
            page.evaluate('''async () => {const rate=22050,n=rate,b=new ArrayBuffer(44+n*2),v=new DataView(b),s=(o,t)=>[...t].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
              s(0,'RIFF');v.setUint32(4,36+n*2,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,n*2,true);
              for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(i/10)*8000,true);
              const f=await sampler.app.studio.uploadFile(new File([b],'piano.wav',{type:'audio/wav'}));
              await sampler.assign(14,sampler.item(f));await sampler.assign(0,sampler.item(f));sampler.slots[0].name='kick';sampler.selected=0;sampler.draw();}''')
            seq = page.locator('.sp-sequence')
            seq.evaluate('el => el.scrollTop = 0')
            row = page.locator('.sp-lane-label [data-lane-select="14"]')
            # 1. Hit pad 15 on bank 2 of the drawn Oxygen: its row lights, is outlined and scrolls into view.
            page.locator('[data-ox="bank1"]').click()
            page.locator('.ox-pad[data-pad="14"]').click()
            page.wait_for_function('document.querySelector(\'.sp-lane-label [data-lane-select="14"]\').classList.contains("lane-hit")')
            assert 'sel' in row.get_attribute('class')
            s_box, r_box = seq.bounding_box(), row.bounding_box()
            assert s_box['y'] <= r_box['y'] and r_box['y'] + r_box['height'] <= s_box['y'] + s_box['height'] + 1, (s_box, r_box)
            assert page.locator('.sp-lane-label [data-lane-select].sel').count() == 1
            page.wait_for_timeout(600)
            assert 'lane-hit' not in row.get_attribute('class'), 'the flash fades'
            assert 'sel' in row.get_attribute('class'), 'the outline stays'
            # 2. Computer key "1" hits pad 1: the outline moves to its row.
            page.locator('body').click(position={'x': 5, 'y': 5})
            page.keyboard.down('1'); page.keyboard.up('1')
            page.wait_for_function('document.querySelector(\'.sp-lane-label [data-lane-select="0"]\').classList.contains("sel")')
            assert 'sel' not in row.get_attribute('class')
            # 3. Sequencer playback lights a row without scrolling the list.
            seq.evaluate('el => el.scrollTop = 0')
            page.evaluate('sampler.pattern.events=[{id:"e1",lane:14,note:60,at:0,len:.25,velocity:100}];sampler.drawSequence();sampler.start()')
            page.wait_for_function('document.querySelector(\'.sp-lane-label [data-lane-select="14"]\').classList.contains("lane-hit")', timeout=5000)
            assert seq.evaluate('el => el.scrollTop') == 0
            page.evaluate('sampler.stop()')
            # 4. Clicking a row name selects it and outlines it.
            page.locator('.sp-lane-label [data-lane-select="14"]').click()
            assert 'sel' in row.get_attribute('class') and page.evaluate('sampler.selected') == 14
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
print('PASS: pad hits light their sequencer row (drawn pads, computer keys, playback), reveal it, outline stays, row click selects')
