"""SONGS is the shared source: Studio mix, sampler loading and real local polish."""
import base64
import hashlib
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
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server


def capture(page):
    page.wait_for_function('!!window.SongLibrary')
    page.evaluate('''() => {
      const refresh=SongLibrary.prototype.refresh;
      SongLibrary.prototype.refresh=function(){window.libraryUI=this;return refresh.call(this)};
    }''')
    page.wait_for_function('window.libraryUI?.app.workspace.ready && !libraryUI.app.studio.loading')


def row(page, name):
    return page.locator('.ss-library-row').filter(has=page.locator('[data-name][value=' + json.dumps(name) + ']'))


with tempfile.TemporaryDirectory() as temp:
    fixture = Path(temp) / 'Phone demo.wav'
    rate = 44100
    with wave.open(str(fixture), 'wb') as audio:
        audio.setparams((2, 2, rate, 0, 'NONE', 'not compressed'))
        frames = []
        for i in range(rate * 5):
            t = i / rate
            fade = min(1, t * 20, (5 - t) * 20)
            value = .11 * math.sin(t * math.tau * 180) + .035 * math.sin(t * math.tau * 1900)
            frames.append(struct.pack('<hh', int(32767 * value * fade), int(32767 * value * fade * .91)))
        audio.writeframes(b''.join(frames))
    server = make_server(temp, port=0)
    original = server.store.asset('beats', 'local/source.wav')
    original.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fixture, original)
    original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
    server.store.query({'table':'library','action':'insert','values':{'id':'source','name':'Source song','storage_path':'local/source.wav','bucket':'beats'}})
    server.store.query({'table':'settings','action':'upsert','values':{'id':'test-split','folder_type':'split','name':'Source split','files':[{'name':'Vocal stem','url':'/audio/beats/local/source.wav','bucket':'beats','storage_path':'local/source.wav'}]}})
    server.store.query({'table':'settings','action':'upsert','values':{'id':'sampler-project','project':{'id':'test-sampler','name':'Test beat','slots':[None]*18,'patterns':[{'id':'pattern','name':'Pattern 1','beats':4,'events':[]}],'pattern':0},'chops':[{'id':'chop','name':'Saved vocal chop','url':'/audio/beats/local/source.wav','bucket':'beats','storage_path':'local/source.wav','start':.7,'end':1.2}]}})
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            chrome = os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            browser = p.chromium.launch(executable_path=chrome, headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width':1440,'height':1024}, accept_downloads=True)
            errors, external, polish_posts = [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda req: external.append(req.url) if not req.url.startswith((base,'blob:','data:')) else None)
            page.on('request', lambda req: polish_posts.append(req) if req.url.endswith('/api/polish') and req.method == 'POST' else None)
            page.goto(base + '/barwork')
            page.get_by_role('button', name='SONGS', exact=True).click()
            capture(page)
            row(page, 'Source song').wait_for()
            page.wait_for_function('document.querySelector("[data-category=Chops] small").textContent==="1"')
            assert page.locator('[data-category="Chops"] small').inner_text() == '1', page.evaluate('({chops:libraryUI.app.workspace.chops,items:libraryUI.collect(),ready:libraryUI.app.workspace.ready})')
            assert page.locator('[data-category="Split packs"] small').inner_text() == '1'
            # Typed save names survive library polling.
            mix_name = page.get_by_role('textbox', name='Studio mix name', exact=True)
            mix_name.fill('Evening Studio mix'); mix_name.focus()
            page.evaluate('libraryUI.signature="";libraryUI.refresh()')
            assert mix_name.input_value() == 'Evening Studio mix'
            assert mix_name.evaluate('(el)=>document.activeElement===el')
            row(page, 'Source song').get_by_role('button', name='Add to Studio', exact=True).click()
            page.wait_for_function('libraryUI.app.studio.tracks.some(t=>t.clips.some(c=>c.name==="Source song"))')
            page.get_by_role('button', name='SONGS', exact=True).click()
            page.get_by_role('button', name='SAVE STUDIO MIX TO SONGS', exact=True).click()
            row(page, 'Evening Studio mix').wait_for()
            assert page.locator('[data-category="Studio mixes"] small').inner_text() == '1'
            saved = page.evaluate('libraryUI.app.state.library.find(x=>x.source_kind==="studio-mix")')
            assert saved['duration'] >= 5 and saved['bucket'] == 'beats', saved
            assert page.request.get(base + saved['url']).ok
            # A trimmed saved chop can be assigned deliberately without losing its trim.
            page.locator('[data-category="Chops"]').click()
            chop = page.locator('.ss-library-row').filter(has_text='Saved vocal chop')
            chop.locator('[data-row-menu]').click()
            page.locator('.im-menu [data-action="sampler-pad"]').click()
            assert page.locator('[data-confirm-pad]').is_disabled()
            assert page.locator('[data-song-pad] option').count() == 19
            page.locator('[data-song-pad]').select_option('2')
            page.locator('[data-confirm-pad]').click()
            page.wait_for_function('libraryUI.app.state.tab==="packs" && libraryUI.app.workspace.slots[2]?.name==="Saved vocal chop"')
            assert page.evaluate('({start:libraryUI.app.workspace.slots[2].start,end:libraryUI.app.workspace.slots[2].end})') == {'start':.7,'end':1.2}
            assert page.locator('.sp-library').count() == 0
            # Returning through the compact sampler action opens the one shared collection.
            page.get_by_role('button', name='Load from Songs', exact=True).click()
            page.locator('[data-category="All"]').click()
            source_row = row(page, 'Source song')
            source_row.locator('[data-row-menu]').click()
            page.locator('.im-menu [data-action="sampler-pad"]').click()
            page.locator('[data-song-pad]').select_option('2')
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('[data-confirm-pad]').click()
            assert page.evaluate('libraryUI.app.workspace.slots[2].name') == 'Saved vocal chop'
            page.locator('.ss-pad-dialog button[value="cancel"]').click()
            # Drop actually saves an original, then queues processing of that saved file.
            encoded = base64.b64encode(fixture.read_bytes()).decode()
            page.locator('.ss-polish-drop').dispatch_event('drop', page.evaluate_handle('''(encoded)=>{
              const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
              const transfer=new DataTransfer();transfer.items.add(new File([bytes],'Dropped phone song.wav',{type:'audio/wav'}));
              return {dataTransfer:transfer};
            }''', encoded))
            page.locator('[data-polish-selected]').get_by_text('Dropped phone song', exact=True).wait_for()
            page.locator('[data-polish-preset]').select_option('vocal')
            version_name = page.get_by_role('textbox', name='Polished version name', exact=True)
            version_name.fill('Phone clarity'); version_name.focus()
            page.evaluate('libraryUI.signature="";libraryUI.refresh()')
            assert version_name.input_value() == 'Phone clarity'
            assert version_name.evaluate('(el)=>document.activeElement===el')
            page.get_by_role('button', name='CREATE POLISHED VERSION', exact=True).click()
            page.locator('[data-polish-job]').filter(has_text='Phone clarity').wait_for()
            # Leave/reload while work is queued; its completion remains visible.
            page.reload(); page.get_by_role('button', name='SONGS', exact=True).click(); capture(page)
            page.locator('[data-polish-job]').filter(has_text='Phone clarity').locator('[data-state="done"]').wait_for(timeout=120000)
            page.locator('[data-category="Polished"]').click()
            row(page, 'Phone clarity').wait_for()
            assert hashlib.sha256(original.read_bytes()).hexdigest() == original_hash
            job = page.evaluate('libraryUI.polishJobs.find(j=>j.name==="Phone clarity")')
            assert job['preset'] == 'vocal' and job['strength'] == 'gentle'
            assert job['report']['before']['integrated_lufs'] is not None
            assert page.request.get(base + job['result_url']).ok
            card = page.locator('[data-polish-job]').filter(has_text='Phone clarity')
            assert card.locator('[data-match-loudness]').is_checked()
            card.get_by_text('Measured before & after', exact=True).click()
            assert card.locator('table').is_visible()
            # Compare real playback at matched loudness; the other player pauses.
            card.locator('audio').nth(0).evaluate('(audio)=>audio.play()')
            page.wait_for_function('document.querySelector(".ss-polish-comparison audio").currentTime>0')
            card.locator('audio').nth(1).evaluate('(audio)=>audio.play()')
            page.wait_for_function('document.querySelectorAll(".ss-polish-comparison audio")[1].currentTime>0')
            assert card.locator('audio').nth(0).evaluate('(audio)=>audio.paused')
            gains = card.locator('audio').evaluate_all('(items)=>items.map(audio=>audio.listenGain)')
            assert min(gains) < 1 and max(gains) == 1, gains
            card.locator('[data-match-loudness]').uncheck()
            assert card.locator('audio').evaluate_all('(items)=>items.map(audio=>audio.listenGain)') == [1,1]
            card.locator('audio').nth(1).evaluate('(audio)=>audio.pause()')
            # Leaving SONGS disconnects preview graphs so a detached player cannot keep sounding.
            card.locator('audio').nth(0).evaluate('(audio)=>{window.detachedComparison=audio;return audio.play()}')
            page.get_by_role('button', name='STUDIO', exact=True).click()
            page.wait_for_function('window.detachedComparison.paused')
            page.get_by_role('button', name='SONGS', exact=True).click()
            page.locator('[data-category="Polished"]').click()
            card = page.locator('[data-polish-job]').filter(has_text='Phone clarity')
            # Completion polling must preserve a playing preview's audio element.
            audio_identity = card.locator('audio').nth(0).evaluate('(audio)=>{audio.testIdentity="same";return true}')
            page.evaluate('libraryUI.lastPolishFetch=0;libraryUI.refresh()')
            page.wait_for_timeout(550)
            assert card.locator('audio').nth(0).evaluate('(audio)=>audio.testIdentity') == 'same'
            # An actual failed audio job can be fixed and retried from its persistent card.
            broken = server.store.asset('beats', 'local/broken.wav')
            broken.write_bytes(b'RIFF invalid wave')
            server.store.query({'table':'library','action':'insert','values':{'id':'broken','name':'Needs retry','storage_path':'local/broken.wav','bucket':'beats'}})
            page.evaluate('libraryUI.app.loadLibrary()')
            page.locator('[data-category="All"]').click()
            broken_row = row(page, 'Needs retry'); broken_row.wait_for()
            broken_row.locator('[data-row-menu]').click()
            page.locator('.im-menu [data-action="polish"]').click()
            page.get_by_role('textbox', name='Polished version name', exact=True).fill('Recovered polish')
            page.get_by_role('button', name='CREATE POLISHED VERSION', exact=True).click()
            retry_card = page.locator('[data-polish-job]').filter(has_text='Recovered polish')
            retry_card.locator('[data-state="error"]').wait_for(timeout=60000)
            shutil.copyfile(fixture, broken)
            retry_card.get_by_role('button', name='RETRY PROCESSING', exact=True).click()
            retry_card.locator('[data-state="done"]').wait_for(timeout=120000)
            assert page.locator('.ss-polish-history').is_visible()
            assert not page.locator('.ss-polish-history').evaluate('(el)=>el.open')
            page.locator('.ss-polish-history>summary').click()
            card.locator('audio').nth(0).wait_for()
            assert polish_posts and all(req.headers.get('x-screwshop') == '1' for req in polish_posts)
            rejected = page.request.post(base + '/api/polish', data={'storage_path':'local/source.wav','bucket':'beats','name':'Unsafe request','preset':'balanced','strength':'gentle'})
            assert rejected.status == 403, rejected.status
            output = ROOT/'test-results'; output.mkdir(exist_ok=True)
            page.screenshot(path=str(output/'songs-polish-desktop.png'))
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(output/'songs-polish-phone.png'), full_page=True)
            # Phone-compatible file picker remains available and keeps original files.
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='CHOOSE AUDIO FILE', exact=True).click()
            chooser.value.set_files(str(fixture))
            page.locator('[data-polish-selected]').get_by_text('Phone demo', exact=True).wait_for()
            assert not errors, errors
            assert not external, external
            print('PASS: Studio mix persistence, shared Songs-to-sampler trims and deliberate assignment, drag/drop + phone picker, real polish queue reload, original preserved, reports, matched comparison, local auth and 390px layout', flush=True)
            browser.close()
    finally:
        server.shutdown(); thread.join(); server.server_close()
