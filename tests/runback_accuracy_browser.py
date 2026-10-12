"""Run-it-back accuracy: capture the real table output while slowed and measure every jump in source time.

The test record is 90 BPM with a click on every beat and a tone whose pitch identifies the beat number.
From the captured audio we find each click, identify its beat, and compute how far the record jumped:
    jump = (output gap between clicks) * rate - (source gap between those beats)
"""
import os, sys, json, tempfile, threading, wave
import numpy as np
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server

SR, BPM = 44100, 90.0
BEAT = 60 / BPM
TOL = 0.004  # seconds of source time


def make_record(path, seconds=60, bpm=BPM, jitter=0.0):
    beat = 60 / bpm
    t = np.arange(int(SR * seconds)) / SR
    k = np.floor(t / beat).astype(int)
    ph = t - k * beat
    tone = 0.3 * np.sin(2 * np.pi * (220 + 30 * (k % 16)) * t) * ((ph > 0.02) & (ph < beat - 0.02))
    click = 0.8 * np.sin(2 * np.pi * 3000 * t) * (ph < 0.003)
    # A little "drums" texture so tempo detection has more than clicks to chew on.
    snare = 0.25 * np.random.default_rng(1).standard_normal(len(t)) * np.exp(-ph * 40) * (k % 2 == 1)
    sig = tone + click + snare
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(sig, -1, 1) * 30000).astype('<i2').tobytes())


def clicks(sig, sr, rate):
    hp = np.diff(sig, 2, prepend=[0, 0])
    env = np.abs(hp)
    thr = env.max() * 0.25
    out, i, gap = [], 0, int(sr * 0.12 / 1)
    idx = np.where(env > thr)[0]
    last = -10 ** 9
    for j in idx:
        if j - last > gap:
            out.append(j)
        last = j if j - last > gap else last
    res = []
    for j in out:
        a, b = j + int(0.03 * sr / rate * 0 + 0.04 * sr), j + int(0.04 * sr) + int(0.15 * sr)
        seg = sig[a:b]
        if len(seg) < 100 or np.sqrt(np.mean(seg ** 2)) < 0.03: continue  # a stop transient, not a beat
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 1 << 16))
        f = np.argmax(spec[: int(1500 * (1 << 16) / sr)]) * sr / (1 << 16)
        k = round((f / rate - 220) / 30) % 16
        res.append((j / sr, k))
    return res


def jumps(events, rate, BEAT):
    """Every place where the beat sequence goes backwards, with the measured jump in source seconds."""
    found = []
    for (t1, k1), (t2, k2) in zip(events, events[1:]):
        step = (k2 - k1) % 16
        if step == 1 and abs((t2 - t1) * rate - BEAT) < 0.004:
            continue
        # Source gap between the two clicks is (step or step-16) beats; pick the one that makes the jump sensible.
        for n in (step - 16, step, step - 32):
            j = (t2 - t1) * rate - n * BEAT
            if 0.05 < j < 8 * BEAT + 0.5:
                found.append((round(t1, 3), round(j, 4))); break
    return found


with tempfile.TemporaryDirectory() as temp:
    server = make_server(temp, port=0)
    th = threading.Thread(target=server.serve_forever, daemon=True); th.start()
    try:
        with sync_playwright() as p:
            chrome = sorted((Path(os.environ['LOCALAPPDATA']) / 'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1]
            br = p.chromium.launch(executable_path=str(chrome), headless=True, args=['--autoplay-policy=no-user-gesture-required'])
            page = br.new_page(viewport={'width': 1440, 'height': 1600})
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script("""Object.defineProperty(window,'ScrewRoom',{configurable:true,set(C){Object.defineProperty(window,'ScrewRoom',{value:class extends C {constructor(a){super(a);window.testRoom=this;}},writable:true});}});""")
            worklet = "registerProcessor('cap',class extends AudioWorkletProcessor{constructor(){super();this.buf=[];this.start=null}process(i){const c=i[0]&&i[0][0];if(c){if(this.start===null)this.start=currentFrame;this.buf.push(...c);if(this.buf.length>=4096){this.port.postMessage([this.start,this.buf]);this.buf=[];this.start=null}}return true}})"
            page.route('**/test-capture-worklet.js', lambda route: route.fulfill(status=200, content_type='text/javascript', body=worklet))
            def no_csp(route):  # test-only: Tone loads worklets via blob: URLs, which the app CSP (correctly) forbids
                r = route.fetch(); h = {k: v for k, v in r.headers.items() if k.lower() != 'content-security-policy'}
                route.fulfill(response=r, headers=h)
            page.route('**/barwork', no_csp)
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.get_by_role('button', name='SCREW', exact=True).click()
            page.wait_for_function('window.testRoom?.app.sb && !window.testRoom.stems.restoring')
            results = {}
            for bpm_true, rate in ((90.0, 0.72), (90.0, 1.0), (83.7, 0.8)):
                beat = 60 / bpm_true
                rec = Path(temp) / f'click{bpm_true}.wav'
                if not rec.exists(): make_record(rec, bpm=bpm_true)
                with page.expect_file_chooser() as fc: page.get_by_role('button', name='LOAD SONG FILE', exact=True).click()
                fc.value.set_files(str(rec))
                page.wait_for_function('!testRoom.loading && testRoom.app._deckB.buffer===testRoom.app._deckA.buffer && testRoom.app._deckA.bpm && testRoom.app.state.deckA.fileName==='+json.dumps(rec.name))
                bpm = page.evaluate("testRoom.bpm('A')")
                page.get_by_label('Record speed', exact=True).fill(f'{rate:g}')
                page.wait_for_function(f'Math.abs(testRoom.app._deckA.rate-{rate})<1e-9 && Math.abs(testRoom.app._deckB.rate-{rate})<1e-9')
                page.evaluate("""async()=>{const a=testRoom.app,ctx=a._Tone.getContext();window.cap={chunks:[]};
                  if(!window.capLoaded){await ctx.rawContext.audioWorklet.addModule(URL.createObjectURL(new Blob(["""+json.dumps(worklet)+"""],{type:'text/javascript'})));window.capLoaded=true;}
                  const node=ctx.createAudioWorkletNode('cap',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});node.port.onmessage=e=>cap.chunks.push(e.data);
                  const sum=new a._Tone.Gain(1);a._deckA.gain.connect(sum);a._deckB.gain.connect(sum);sum.connect(node);node.connect(ctx.rawContext.destination);cap.sum=sum;cap.node=node;}""")
                page.get_by_role('button', name='▶ PLAY / PAUSE', exact=True).click()
                pressed = []
                plan = [(8500, '↺ 2 BARS', 8), (2600, '↺ 2 BEATS', 2), (2300, '↺ ½ BEAT', .5), (2300, '↺ 1 BAR', 4), (2900, '↺ 1 BEAT', 1), (2600, '↺ 2 BEATS', 2)]
                for wait, label, beats in plan:
                    page.wait_for_timeout(wait)
                    # Press early in a beat so the replayed stretch contains a click; otherwise a short run-back
                    # is correct but inaudible to the click detector (nothing to hear twice).
                    page.wait_for_function(f"(()=>{{const w=testRoom.live(),p=testRoom.app.deckPosition(w)/{beat};return p%1>.15&&p%1<.35;}})()", polling=5)
                    page.get_by_role('button', name=label, exact=True).click(); pressed.append(beats)
                page.wait_for_timeout(2500)
                page.get_by_role('button', name='■ STOP', exact=True).click()
                page.wait_for_timeout(300)
                data = page.evaluate("""()=>{const a=testRoom.app;a._deckA.gain.disconnect(cap.sum);a._deckB.gain.disconnect(cap.sum);cap.node.disconnect();cap.sum.dispose();const sr=a._Tone.getContext().rawContext.sampleRate;return {sr,chunks:cap.chunks};}""")
                sr = data['sr']; f0 = data['chunks'][0][0]
                sig = np.zeros(data['chunks'][-1][0] - f0 + 8192)
                for f, c in data['chunks']:
                    sig[f - f0:f - f0 + len(c)] = c
                found = jumps(clicks(sig, sr, rate), rate, beat)
                expected = [b * beat for b in pressed]
                errs = [abs(j - e) for (_, j), e in zip(found, expected)]
                key = f'{bpm_true} BPM at {rate}x'
                results[key] = {'detected_bpm': bpm, 'expected': [round(e, 4) for e in expected], 'measured': [float(j) for _, j in found], 'max_err_ms': round(1000 * max(errs), 2) if errs else None}
                print(key, results[key], flush=True)
                assert len(found) == len(pressed), ('every press should make exactly one jump', found, pressed)
                assert max(errs) < TOL, ('run-back landed off the beat', results[key])
            # Running it back while your hand is on the record: the new table plays at full speed.
            page.get_by_role('button', name='▶ PLAY / PAUSE', exact=True).click(); page.wait_for_timeout(4000)
            live = page.evaluate('testRoom.live()')
            page.get_by_label('Hold to drag the live record', exact=True).scroll_into_view_if_needed()
            box = page.get_by_label('Hold to drag the live record', exact=True).bounding_box()
            page.mouse.move(box['x'] + 5, box['y'] + 5); page.mouse.down(); page.wait_for_timeout(350)
            page.keyboard.press('x'); page.wait_for_timeout(100)
            page.mouse.up(); page.wait_for_timeout(500)
            rates = page.evaluate('[testRoom.app._deckA.rate,testRoom.app._deckB.rate,testRoom.live()]')
            assert abs(rates[0] - .8) < 1e-6 and abs(rates[1] - .8) < 1e-6 and rates[2] != live, ('drag + run back should leave both tables at full speed', rates)
            page.get_by_role('button', name='■ STOP', exact=True).click()
            assert not errors, errors
            br.close()
        print('PASS: every run-back lands within 4 ms of exact beats (slowed, normal, odd tempo); drag + run back keeps speed')
    finally:
        server.shutdown(); th.join(); server.server_close()
