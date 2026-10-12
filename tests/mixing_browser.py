"""STUDIO speed (screwed slowdown), recording while slowed, the MIXER channel strips, the master
limiter, and EXPORT MP3 -> SONGS + mp3s folder. Synthetic audio, isolated temporary library."""
import os, sys, tempfile, threading, wave, math, struct, json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]; OUT = ROOT / 'test-results'; OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server
CHROME = os.environ.get('SS_CHROME')


def tone(path, secs, freq, amp=7000):
    with wave.open(str(path), 'wb') as w:
        w.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
        w.writeframes(b''.join(struct.pack('<h', int(amp * math.sin(i * 2 * math.pi * freq / 44100))) for i in range(int(44100 * secs))))


with tempfile.TemporaryDirectory() as temp:
    beat = Path(temp) / 'Slow beat.wav'; tone(beat, 8, 220)
    server = make_server(temp, port=0); t = threading.Thread(target=server.serve_forever, daemon=True); t.start()
    session = lambda: next((r for r in server.store.query({'table': 'settings'}) if r['id'] == 'recording-session'), None)
    try:
        with sync_playwright() as p:
            if not CHROME:
                CHROME = str(sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            b = p.chromium.launch(executable_path=CHROME, headless=True, args=['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
            page = b.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.wait_for_function('!!window.SongLibrary')
            page.evaluate('''() => { const refresh=SongLibrary.prototype.refresh;
              SongLibrary.prototype.refresh=function(){window.libraryUI=this;return refresh.call(this)}; }''')
            page.get_by_role('button', name='SONGS', exact=True).click()
            page.wait_for_function('window.libraryUI?.app.workspace.ready', timeout=15000)
            page.get_by_role('button', name='STUDIO', exact=True).click()
            with page.expect_file_chooser() as fc: page.get_by_role('button', name='IMPORT AUDIO', exact=True).click()
            fc.value.set_files(str(beat))
            page.locator('[data-clip]').first.wait_for(timeout=15000)

            # ---- Speed: one clear control, works before pressing Play, persists ----
            page.get_by_label('Song BPM (original tempo)').fill('80'); page.get_by_label('Song BPM (original tempo)').press('Enter')
            page.get_by_label('Play at BPM').fill('64'); page.get_by_label('Play at BPM').press('Enter')
            page.wait_for_function('window.ScrewShop && document.querySelector("[data-studio-speed]")?.textContent.includes("80% speed")', timeout=5000)
            page.wait_for_function('''async()=>{const r=await ScrewShop.client.from('settings').select('*').eq('id','recording-session').maybeSingle();return Math.abs((r.data?.rate||1)-0.8)<1e-6&&r.data.bpm===80}''', timeout=8000)
            print('PLAY AT 64 with SONG BPM 80 -> 0.80x, label shows pitch drop, saved', flush=True)
            page.get_by_role('button', name='-30%', exact=True).click()
            page.wait_for_function('document.querySelector("[data-studio-speed]").textContent.startsWith("70% speed")', timeout=5000)
            # The bottom transport TEMPO slider drives Studio on the Studio tab even before Play.
            page.get_by_label('Tempo speed').evaluate('(el)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"0.8");el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}))}')
            page.wait_for_function('document.querySelector("[data-studio-speed]").textContent.startsWith("80% speed")', timeout=5000)
            print('-30% preset and transport TEMPO slider both drive Studio speed', flush=True)

            # ---- Recording while slowed keeps the speed and conforms the take ----
            page.get_by_role('button', name='1234 COUNT-IN').click()  # off: faster test
            page.get_by_role('button', name='RECORD', exact=True).click()
            page.get_by_role('button', name='STOP', exact=True).wait_for(timeout=8000)
            page.wait_for_timeout(2000)
            page.get_by_role('button', name='STOP', exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length==2', timeout=15000)
            s = session(); clip = s['tracks'][1]['clips'][0]
            assert abs(s['rate'] - 0.8) < 1e-6, 'recording reset the speed'
            assert clip['url'].endswith('-conformed.wav') and abs(clip['recordedAtRate'] - 0.8) < 1e-6 and clip.get('rawUrl'), clip
            take = server.store.asset('takes', clip['url'].split('/audio/takes/', 1)[1])
            with wave.open(str(take)) as w: conformed_secs = w.getnframes() / w.getframerate()
            assert 1.0 < conformed_secs < 2.6, conformed_secs  # ~2 s sung at 0.8x = ~1.6 s of session time
            print(f'recorded at 0.8x: speed kept, take conformed ({conformed_secs:.2f}s session time), raw take preserved', flush=True)

            # ---- Mixer drawer: strips, live settings, persistence ----
            page.get_by_role('button', name='MIXER', exact=True).click()
            page.locator('#ss-mixer .mx-strip').nth(2).wait_for()
            assert page.locator('#ss-mixer .mx-strip').count() == 3  # 2 tracks + master
            strip = page.locator('#ss-mixer .mx-strip').first
            strip.locator('button[data-toggle="comp.on"]').click()
            strip.locator('input[data-path="comp.threshold"]').evaluate('(el)=>{el.value="-30";el.dispatchEvent(new Event("input",{bubbles:true}))}')
            strip.locator('input[data-path="mid.gain"]').evaluate('(el)=>{el.value="3";el.dispatchEvent(new Event("input",{bubbles:true}))}')
            page.wait_for_function('''async()=>{const r=await ScrewShop.client.from('settings').select('*').eq('id','recording-session').maybeSingle();const m=r.data?.tracks?.[0]?.mix;return m&&m.comp.on&&m.comp.threshold===-30&&m.mid.gain===3}''', timeout=8000)
            assert strip.locator('input[data-path="mid.gain"] ~ output').inner_text() == '+3.0 dB'
            page.screenshot(path=str(OUT / 'mixer-desktop.png'))
            print('MIXER: 2 channel strips + master; compressor/EQ changes apply and persist', flush=True)

            # ---- Engine checks on real renders: compressor reduces level, limiter holds ceiling ----
            engine = page.evaluate('''async()=>{
              const studio=libraryUI.app.studio,ws=libraryUI.app.workspace,orig=JSON.stringify(studio.tracks),om=studio.mixMaster,or=studio.rate;
              const peak=b=>{let p=0;for(let c=0;c<b.numberOfChannels;c++){const d=b.getChannelData(c);for(let i=0;i<d.length;i++)p=Math.max(p,Math.abs(d[i]));}return p};
              try{
                const beatClip=JSON.parse(orig)[0].clips[0];studio.rate=1;
                studio.tracks=[{id:'a',volume:1,clips:[{...beatClip,start:0,length:2}],mix:{}}];studio.mixMaster={limiter:{on:false}};
                const dry=peak(await ws.renderStudio());
                studio.tracks[0].mix={comp:{on:true,threshold:-30,ratio:4,attack:1,release:50,makeup:0}};
                const comp=peak(await ws.renderStudio());
                studio.tracks=[0,1,2].map(i=>({id:'l'+i,volume:1.5,clips:[{...beatClip,start:0,length:2}],mix:{}}));studio.mixMaster={limiter:{on:true,ceiling:-1}};
                const limited=peak(await ws.renderStudio());
                return {dry,comp,limited};
              }finally{studio.tracks=JSON.parse(orig);studio.mixMaster=om;studio.rate=or;}
            }''')
            assert engine['comp'] < engine['dry'] * 0.6, engine
            assert engine['limited'] <= 10 ** (-1 / 20) + 1e-6, engine
            print('compressor reduces peaks', round(engine['dry'], 3), '->', round(engine['comp'], 3), '; limiter holds -1 dBFS:', round(engine['limited'], 4), flush=True)

            # ---- EXPORT MP3 -> SONGS (Imported) + mp3s folder, finished to -14 LUFS ----
            page.get_by_role('button', name='CLOSE', exact=True).click()
            page.once('dialog', lambda d: d.accept('Night Ride'))
            page.get_by_role('button', name='EXPORT MP3 → SONGS').click()
            page.wait_for_function('document.querySelector(".ss-library, #ss-songs, [class*=song]") && libraryUI.app.state.tab==="songs"', timeout=60000)
            rows = [r for r in server.store.query({'table': 'library'}) if r.get('name') == 'Night Ride']
            assert len(rows) == 1 and rows[0]['source_kind'] == 'imported' and rows[0]['storage_path'].endswith('.mp3'), rows
            mp3 = server.store.mp3_root / 'Night Ride.mp3'
            assert mp3.is_file() and mp3.stat().st_size > 10000, mp3
            assert server.store.asset('beats', rows[0]['storage_path']).is_file()
            after = rows[0]['loudness']['after']
            assert after['true_peak_db'] <= -0.99 and after['integrated_lufs'] <= -13.5, after
            page.locator('text=Night Ride').first.wait_for(timeout=10000)
            print(f"EXPORT MP3: in SONGS as Imported, saved to mp3s/{mp3.name}, {after['integrated_lufs']} LUFS / {after['true_peak_db']} dBTP", flush=True)

            # ---- Phone width ----
            page.get_by_role('button', name='STUDIO', exact=True).click()
            page.set_viewport_size({'width': 390, 'height': 844}); page.wait_for_timeout(500)
            page.get_by_role('button', name='MIXER', exact=True).click()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(OUT / 'mixer-phone.png'))
            assert not errors, errors
            print('PASS: screwed speed, slowed recording, mixer, dynamics, MP3 to SONGS + mp3s', flush=True)
            b.close()
    finally:
        server.shutdown(); t.join(); server.server_close()
