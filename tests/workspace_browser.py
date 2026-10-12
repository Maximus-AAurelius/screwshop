"""Five-tab shell integration and desktop/phone visual review in an isolated store."""
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import wave
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server

with tempfile.TemporaryDirectory() as temp:
    fixture = Path(temp) / 'Evening instrumental.wav'
    with wave.open(str(fixture), 'wb') as audio:
        audio.setparams((1, 2, 22050, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(6000 * math.sin(i * 2 * math.pi * 220 / 22050)
            * (.5 + .5 * math.sin(i * math.pi / 5500) ** 2))) for i in range(22050 * 12)))
    server = make_server(temp, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            chrome = sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1]
            browser = p.chromium.launch(executable_path=str(chrome), headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script("""Object.defineProperty(window,'ScrewRoom',{configurable:true,set(C){Object.defineProperty(window,'ScrewRoom',{value:class extends C {constructor(a){super(a);window.auditApp=a;}},writable:true});}});""")
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('window.auditApp?.sb && !auditApp.studio.loading')
            page.get_by_label('Verse notebook', exact=True).fill('Evening light across the lane\nTurn the record, feel the rain\n\nTake my time and find the sound\nLet the whole world slow right down')
            page.get_by_role('button', name='SONGS', exact=True).click()
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='+ UPLOAD FILE', exact=True).click()
            chooser.value.set_files(str(fixture))
            page.locator('input[value="Evening instrumental"]').wait_for()
            page.evaluate("""async()=>{
                const a=auditApp,item=a.state.library[0];
                for(const [id,name,kind] of [['demo-v','Evening · screwed version','screw-version'],['demo-t','Evening · vocal take','recording']])
                    await a.sb.from('library').insert({id,user_id:'local',name,source_kind:kind,storage_path:item.storage_path});
                await a.loadLibrary();
                await a.studio.addClip(null,{name:'Instrumental',url:item.url},0);
                await a.studio.addClip(null,{name:'Vocals',url:item.url},1.5);
            }""")
            page.get_by_role('button', name='SCREW', exact=True).click()
            page.wait_for_function('document.querySelector(".screw-box") && !auditApp.screwRoom.stems.restoring')
            page.evaluate("""async()=>{
                const a=auditApp,s=a.screwRoom.stems,item=a.state.library[0];
                for(let i=0;i<2;i++){s.tracks[i].url=item.url;s.tracks[i].name=i?'Evening vocals':'Evening instrumental';s.tracks[i].buffer=await s.decode(item.url);}
                s.draw();await a.loadDeckFromLibrary('A',item);
            }""")
            page.get_by_role('button', name='DISMISS', exact=True).click()
            output = ROOT / 'test-results'
            output.mkdir(exist_ok=True)
            tabs = [('SONGS', '#ss-song-library'), ('NOTEPAD', '.np-editor'), ('STUDIO', '.gb-arrange'),
                    ('SCREW', '.dj-scroll'), ('M-AUDIO / SAMPLER', '#ss-sampler')]
            for width, height, suffix in [(1440, 1000, 'desktop'), (390, 844, 'phone')]:
                page.set_viewport_size({'width': width, 'height': height})
                for label, host in tabs:
                    button = page.get_by_role('button', name=label, exact=True)
                    button.click()
                    page.locator(host).wait_for(state='visible')
                    page.wait_for_timeout(450)
                    assert button.get_attribute('aria-current') == 'page', label
                    assert page.locator('.studio-tabs > button').count() == 5
                    for tab in page.locator('.studio-tabs > button').all():
                        assert tab.is_visible()
                        box = tab.bounding_box()
                        assert box['y'] >= 0 and box['y'] + box['height'] <= height, (label, box)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), label
                    assert page.locator('.studio-brand > img').evaluate('(img)=>img.complete && img.naturalWidth>0')
                    page.screenshot(path=str(output / f'workspace-{label.split()[0].lower()}-{suffix}.png'))
                    if label == 'SCREW':
                        assert page.evaluate('auditApp.state.transportSource') == 'decks'
                        page.get_by_role('button', name='VOCALS + INSTRUMENTAL', exact=True).click()
                        page.wait_for_timeout(250)
                        assert page.get_by_label('Audio position', exact=True).is_enabled()
                        page.get_by_label('Audio position', exact=True).fill('4')
                        page.wait_for_function('Math.abs(auditApp.screwRoom.stems.position-4)<.01')
                        page.screenshot(path=str(output / f'workspace-stems-{suffix}.png'))
                        page.get_by_role('button', name='SCREW A SONG · TABLES', exact=True).click()
                        page.wait_for_function('auditApp.state.transportSource==="decks"')
            page.get_by_role('button', name='NOTEPAD', exact=True).click()
            assert 'feel the rain' in page.get_by_label('Verse notebook', exact=True).input_value()
            assert page.evaluate('auditApp.studio.tracks.filter(t=>t.clips.length).length') == 2
            page.get_by_role('button', name='Open settings', exact=True).click()
            page.get_by_text('DEVICES & FRIENDS', exact=True).wait_for()
            assert not errors, errors
            print('PASS: all five tabs, images, active navigation, stem transport seeking, retained work and settings; 1440px + 390px snapshots')
            browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
