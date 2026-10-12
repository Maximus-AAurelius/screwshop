"""Rapid MIDI regression through the browser's actual registered input callback.

Uses synthetic MIDIAccess and an isolated local store; never opens the owner's
hardware MIDI port or reads/writes data/. Run with .venv/Scripts/python.exe.
"""
import math
import os
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
from song_source_helpers import upload_song, load_song_pad


def run():
    failures = []

    def check(name, condition, result):
        print(f"{'PASS' if condition else 'FAIL'}: {name}: {result}", flush=True)
        if not condition:
            failures.append(name)

    with tempfile.TemporaryDirectory(prefix="screwshop-midi-") as temp:
        audio = Path(temp) / "MIDI repeat tone.wav"
        with wave.open(str(audio), "wb") as output:
            output.setparams((1, 2, 44100, 0, "NONE", "not compressed"))
            output.writeframes(b"".join(
                struct.pack("<h", int(18000 * math.sin(i * 2 * math.pi * 220 / 44100)))
                for i in range(22050)
            ))
        server = make_server(temp, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                chrome = os.environ.get("SS_CHROME") or str(sorted(
                    (Path(os.environ["LOCALAPPDATA"]) / "ms-playwright").glob(
                        "chromium-*/chrome-win64/chrome.exe"
                    )
                )[-1])
                browser = playwright.chromium.launch(
                    executable_path=chrome, headless=True,
                    args=["--autoplay-policy=no-user-gesture-required"],
                )
                page = browser.new_page(viewport={"width": 1366, "height": 900})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.add_init_script("""(() => {
                    window.testMidiPort = {id:'regression', name:'Synthetic Oxygen', state:'connected', type:'input'};
                    window.testMidiAccess = {inputs:new Map([['regression', testMidiPort]])};
                    navigator.requestMIDIAccess = async () => testMidiAccess;
                })()""")
                page.goto(f"http://127.0.0.1:{server.server_port}/barwork")
                page.wait_for_function("!!window.StudioWorkspace")
                page.evaluate("""() => {
                    const tick = StudioWorkspace.prototype.tick;
                    StudioWorkspace.prototype.tick = function() {window.sampler = this;return tick.call(this)};
                }""")
                page.wait_for_function("window.sampler?.ready")
                page.get_by_role("button", name="M-AUDIO / SAMPLER", exact=True).click()
                upload_song(page, audio, 'MIDI repeat tone')
                load_song_pad(page, 'MIDI repeat tone', 0)
                page.wait_for_function('sampler.slots[0]?.name.includes("MIDI repeat tone")')
                page.locator('[data-action="midi"]').click()
                page.wait_for_function("!!window.testMidiPort.onmidimessage")
                page.evaluate("""async () => {
                    window.ctx = sampler.context(); await ctx.resume();
                    sampler.stop();
                    sampler.project.maps = {'pad:0':{type:144, channel:0, number:48}};
                    sampler.project.mode = 'pads'; sampler.project.quantize = false;
                    sampler.project.countIn = false; sampler.project.metro = false;
                    sampler.ui.roll = false;
                    Object.assign(sampler.slots[0], {start:.04, end:.4, pitch:0, gate:false, loop:false,
                        mono:false, choke:0, attack:.001, release:.005, pan:0});
                    sampler.slots[1] = {...sampler.slots[0]}; sampler.syncLegacy();
                    window.midiSend = (status, note, value=100) => testMidiPort.onmidimessage({
                        data:new Uint8Array([status,note,value]), receivedTime:performance.now(), timeStamp:performance.now()
                    });
                    window.pause = ms => new Promise(resolve => setTimeout(resolve, ms));
                    window.livePeak = async () => {
                        const samples=new Float32Array(sampler.meter.fftSize),until=performance.now()+180;
                        let peak=0;
                        do {sampler.meter.getFloatTimeDomainData(samples);peak=Math.max(peak,...samples.map(Math.abs));
                            if(peak>.05)return peak;await pause(10);
                        } while(performance.now()<until);
                        return peak;
                    };
                    window.starts = []; window.ends = [];
                    const create = ctx.createBufferSource.bind(ctx);
                    ctx.createBufferSource = () => {
                        const source = create(), start = source.start.bind(source);
                        source.start = (...args) => {
                            starts.push({source, when:args[0], offset:args[1], duration:args[2], rate:source.playbackRate.value,
                                buffer:source.buffer, at:ctx.currentTime});
                            return start(...args);
                        };
                        return source;
                    };
                    const voice = sampler.voice;
                    sampler.voice = function(...args) {
                        const result = voice.apply(this, args);
                        if (result) ends.push(result);
                        return result;
                    };
                    window.reset = async () => {
                        sampler.stop(); await pause(30); starts.length = 0; ends.length = 0;
                        sampler.project.maps = {'pad:0':{type:144,channel:0,number:48}};
                        sampler.project.mode='pads'; sampler.pattern.events=[]; sampler.recordHeld=new Map();
                        sampler.project.quantize=false; sampler.project.latency=0;
                        Object.assign(sampler.slots[0], {gate:false,loop:false,mono:false,choke:0});
                        sampler.slots[1]={...sampler.slots[0]};
                    };
                }""")

                result = page.evaluate("""async () => {
                    await reset();
                    midiSend(144,48); midiSend(128,48,0); midiSend(144,48); midiSend(128,48,0);
                    const immediate = starts.length; await pause(25);
                    return {immediate, starts:starts.length, held:sampler.held.size,
                        same:starts.length===2 && starts.every(s => s.buffer===starts[0].buffer && s.rate===1 && Math.abs(s.offset-.04)<.0001),
                        peak:await livePeak()};
                }""")
                check("same-task on/off/on/off starts both identical one-shots immediately",
                      result["immediate"] == 2 and result["starts"] == 2 and result["same"]
                      and result["held"] == 0 and result["peak"] > .05, result)

                result = page.evaluate("""async () => {
                    await reset();
                    const gaps=[5,10,20,5,10,20],velocities=[70,115,84,127,90,80];
                    for (const [i,gap] of gaps.entries()) {
                        midiSend(144,48,velocities[i]); await pause(gap); midiSend(144,48,0); await pause(gap);
                    }
                    await pause(10);
                    return {starts:starts.length, held:sampler.held.size,
                        same:starts.every(s => s.buffer===starts[0].buffer && s.rate===1 && Math.abs(s.offset-.04)<.0001),
                        gaps:starts.slice(1).map((s,i)=>+(1000*(s.when-starts[i].when)).toFixed(2))};
                }""")
                check("5–20 ms repeats preserve sample, pitch, onset and clear note state",
                      result["starts"] == 6 and result["held"] == 0 and result["same"]
                      and all(gap > 0 for gap in result["gaps"]), result)

                result = page.evaluate("""async () => {
                    await reset();sampler.slots[0].mono=true;
                    for(let i=0;i<100;i++) {midiSend(144,48,64+i%64);midiSend(128,48,0)}
                    const immediate=starts.length;await pause(30);
                    return {immediate,starts:starts.length,held:sampler.held.size,voices:sampler.voices.size,
                        same:starts.every(s=>s.buffer===starts[0].buffer && s.rate===1 && Math.abs(s.offset-.04)<.0001)};
                }""")
                check("100 same-note MIDI hits lose no Note Ons and retain sample/pitch/trim",
                      result["immediate"] == 100 and result["starts"] == 100 and result["held"] == 0
                      and result["voices"] <= 1 and result["same"], result)

                result = page.evaluate("""async () => {
                    await reset();sampler.selected=0;sampler.drawEditor();
                    const input=sampler.host.querySelector('[data-sample="start"]');
                    input.focus();input.value='.047';
                    for (let i=0;i<4;i++) {midiSend(144,48);midiSend(128,48,0);await pause(8)}
                    await pause(30);
                    return {starts:starts.length,sameElement:input===sampler.host.querySelector('[data-sample="start"]'),
                        focused:document.activeElement===input,value:input.value};
                }""")
                check("repeated MIDI hits preserve the focused sample editor and unfinished input",
                      result == {"starts": 4, "sameElement": True, "focused": True, "value": ".047"}, result)

                result = page.evaluate("""async () => {
                    await reset();sampler.project.mode='16';sampler.slots[16]={...sampler.slots[0],gate:true,root:60};
                    midiSend(144,60);midiSend(128,60,0);midiSend(144,60);midiSend(144,60,0);
                    midiSend(144,64);await pause(20);midiSend(128,64,0);await pause(30);
                    return {starts:starts.length,held:sampler.held.size,
                        rates:starts.map(s=>s.rate),same:starts.every(s=>s.buffer===starts[0].buffer && Math.abs(s.offset-.04)<.0001)};
                }""")
                check("instrument keys retrigger the same pitch; neighboring keys repitch correctly",
                      result["starts"] == 3 and result["held"] == 0 and result["same"]
                      and result["rates"][:2] == [1, 1] and abs(result["rates"][2] - 2 ** (4 / 12)) < .00001, result)

                result = page.evaluate("""async () => {
                    await reset(); sampler.slots[0].gate=true;
                    midiSend(144,48); await pause(30); midiSend(128,48,0);
                    midiSend(144,48); await pause(20); midiSend(144,48,0);
                    await pause(50);
                    const samples = new Float32Array(sampler.meter.fftSize);
                    sampler.meter.getFloatTimeDomainData(samples);
                    return {starts:starts.length, held:sampler.held.size, voices:sampler.voices.size,
                        lengths:ends.map(v=>+(v.stopTime-v.when).toFixed(4)), peak:Math.max(...samples.map(Math.abs))};
                }""")
                check("gated repeat releases each new voice, including zero-velocity note-off",
                      result["starts"] == 2 and result["held"] == 0 and result["voices"] == 0
                      and all(.005 < length < .2 for length in result["lengths"])
                      and result["peak"] < .001, result)

                result = page.evaluate("""async () => {
                    await reset(); sampler.slots[0].gate=true;
                    sampler.project.maps['pad:1']={type:144,channel:1,number:48};
                    midiSend(144,48); midiSend(145,48); await pause(15);
                    midiSend(176,64,127); midiSend(128,48,0); midiSend(129,48,0); await pause(10);
                    const held = [...sampler.held.keys()].map(key=>key.split(':').slice(-2).join(':'));
                    midiSend(177,64,0); const afterOtherPedal = [...sampler.held.keys()].map(key=>key.split(':').slice(-2).join(':'));
                    midiSend(176,64,0); await pause(40);
                    return {held, afterOtherPedal, released:sampler.held.size===0, starts:starts.length};
                }""")
                check("sustain and note-off stay on the originating MIDI channel",
                      result["starts"] == 2 and result["held"] == ["0:48"]
                      and result["afterOtherPedal"] == ["0:48"] and result["released"], result)

                result = page.evaluate("""async () => {
                    await reset(); sampler.slots[0].gate=true;
                    const other={id:'second',name:'Synthetic second controller',state:'connected',type:'input'};
                    testMidiAccess.inputs.set(other.id,other);testMidiAccess.onstatechange({port:other});
                    const sendOther=(status,note,value=100)=>other.onmidimessage({data:new Uint8Array([status,note,value]),receivedTime:performance.now()});
                    midiSend(144,48);sendOther(144,48);await pause(15);
                    const both=sampler.held.size;
                    midiSend(176,64,127);midiSend(128,48,0);sendOther(128,48,0);await pause(15);
                    const heldByFirstPedal=sampler.held.size;
                    sendOther(176,64,0);const heldAfterOtherPedal=sampler.held.size;
                    midiSend(176,64,0);await pause(15);
                    midiSend(144,48);sendOther(144,48);await pause(15);
                    midiSend(176,123,0);await pause(15);
                    const afterFirstAllNotesOff=sampler.held.size;
                    sendOther(176,123,0);await pause(40);
                    const cleanup={held:sampler.held.size,voices:sampler.voices.size};
                    testMidiAccess.inputs.delete(other.id);testMidiAccess.onstatechange({port:{...other,state:'disconnected'}});
                    return {both,heldByFirstPedal,heldAfterOtherPedal,afterFirstAllNotesOff,cleanup};
                }""")
                check("two MIDI ports sharing a channel/note have independent sustain and All Notes Off",
                      result["both"] == 2 and result["heldByFirstPedal"] == 1
                      and result["heldAfterOtherPedal"] == 1 and result["afterFirstAllNotesOff"] == 1
                      and result["cleanup"] == {"held": 0, "voices": 0}, result)

                result = page.evaluate("""async () => {
                    await reset(); sampler.slots[0].mono=true;
                    midiSend(144,48); await pause(15); midiSend(144,48); await pause(25);
                    const mono={starts:starts.length,voices:sampler.voices.size,
                        oldEnded:ends.length===2 && Math.abs(ends[0].stopTime-ends[1].when)<.003};
                    sampler.panic(); await pause(25); starts.length=0;ends.length=0;
                    sampler.slots[0].mono=false; sampler.slots[0].choke=2;
                    sampler.slots[1].choke=2; sampler.project.maps['pad:1']={type:144,channel:0,number:49};
                    midiSend(144,48); await pause(15); midiSend(144,49); await pause(25);
                    const choke={starts:starts.length,voices:sampler.voices.size,
                        oldEnded:ends.length===2 && Math.abs(ends[0].stopTime-ends[1].when)<.003};
                    midiSend(176,120,0); await pause(25);
                    return {mono,choke,panic:{held:sampler.held.size,voices:sampler.voices.size}};
                }""")
                check("mono retrigger/choke stop old sound; MIDI All Sound Off clears all voices",
                      all(result[mode]["starts"] == 2 and result[mode]["voices"] == 1
                          and result[mode]["oldEnded"] for mode in ("mono", "choke"))
                      and result["panic"] == {"held": 0, "voices": 0}, result)

                result = page.evaluate("""async () => {
                    await reset(); sampler.slots[0].gate=true;
                    await sampler.start(true); await pause(100);
                    const inputs=[];
                    for (const duration of [24,40,28]) {
                        inputs.push({at:ctx.currentTime});
                        midiSend(144,48); await pause(duration);
                        inputs[inputs.length-1].len=ctx.currentTime-inputs[inputs.length-1].at;
                        midiSend(128,48,0); await pause(12);
                    }
                    sampler.stop(); await pause(30);
                    const events=sampler.pattern.events.map(e=>({...e}));
                    const bpm=sampler.project.bpm,origin=sampler.origin;
                    const rendered=await sampler.renderAudio([sampler.pattern],bpm);
                    const data=rendered.getChannelData(0),rate=rendered.sampleRate;
                    const peaks=events.map(e => {
                        const begin=Math.floor(e.at*60/bpm*rate)+Math.floor(.006*rate);
                        return Math.max(...data.slice(begin,begin+Math.floor(.01*rate)).map(Math.abs));
                    });
                    const gapStart=events.length?Math.floor((events[events.length-1].at+events[events.length-1].len)*60/bpm*rate+.05*rate):0;
                    let tail=0; for (const value of data.slice(gapStart)) tail=Math.max(tail,Math.abs(value));
                    return {events:events.map(e=>({at:e.at*60/bpm,len:e.len*60/bpm,absolute:'absolute' in e})),
                        inputs:inputs.map(e=>({...e,at:e.at-origin})),held:sampler.recordHeld.size,peaks,tail};
                }""")
                event_times_match = len(result["events"]) == 3 and all(
                    abs(event["at"] - sent["at"]) < .012 and event["len"] > .005
                    and abs(event["len"] - sent["len"]) < .012
                    and not event["absolute"]
                    for event, sent in zip(result["events"], result["inputs"])
                )
                check("recorded repeats keep onset/length and render three audible gated notes",
                      event_times_match and result["held"] == 0 and len(result["peaks"]) == 3
                      and all(peak > .05 for peak in result["peaks"]) and result["tail"] < .001, result)

                result = page.evaluate("""async () => {
                    await reset();sampler.slots[0].gate=true;
                    await sampler.start(true);await pause(160);
                    const now=performance.now(),audioNow=ctx.currentTime;
                    const send=(status,receivedTime)=>testMidiPort.onmidimessage({data:new Uint8Array([status,48,status===144?100:0]),receivedTime});
                    send(144,now-50);send(128,now-35);send(144,now-25);send(128,now-10);
                    sampler.stop();
                    return {starts:starts.length,held:sampler.held.size,
                        events:sampler.pattern.events.map(e=>({at:e.at*60/sampler.project.bpm,len:e.len*60/sampler.project.bpm})),
                        expected:audioNow-sampler.origin-.05};
                }""")
                check("batched MIDI callbacks record original input timestamps and short note lengths",
                      result["starts"] == 2 and result["held"] == 0 and len(result["events"]) == 2
                      and abs(result["events"][0]["at"] - result["expected"]) < .012
                      and abs(result["events"][1]["at"] - result["events"][0]["at"] - .025) < .012
                      and all(abs(event["len"] - .015) < .012 for event in result["events"]), result)

                result = page.evaluate("""async () => {
                    await reset();sampler.slots[0].gate=true;
                    await sampler.start(true);await pause(130);
                    midiSend(176,64,127);const on=ctx.currentTime;midiSend(144,48);await pause(30);
                    const keyOff=ctx.currentTime;midiSend(128,48,0);const heldCapture=sampler.recordHeld.size;
                    await pause(65);const pedalOff=ctx.currentTime;midiSend(176,64,0);sampler.stop();
                    const event=sampler.pattern.events[0],bpm=sampler.project.bpm;
                    const rendered=await sampler.renderAudio([sampler.pattern],bpm),data=rendered.getChannelData(0),rate=rendered.sampleRate;
                    const sampleAt=Math.floor((keyOff-sampler.origin+.025)*rate);
                    const sustainedPeak=Math.max(...data.slice(sampleAt,sampleAt+Math.floor(.01*rate)).map(Math.abs));
                    return {events:sampler.pattern.events.length,heldCapture,held:sampler.recordHeld.size,
                        length:event?.len*60/bpm,expected:pedalOff-on,physicalLength:keyOff-on,sustainedPeak};
                }""")
                check("recorded sustain reproduces the audible note through pedal release",
                      result["events"] == 1 and result["heldCapture"] == 1 and result["held"] == 0
                      and abs(result["length"] - result["expected"]) < .012
                      and result["length"] > result["physicalLength"] + .035
                      and result["sustainedPeak"] > .05, result)

                result = page.evaluate("""async () => {
                    await reset(); await ctx.suspend();
                    const nativeResume=ctx.resume.bind(ctx); let unblock;
                    const gate=new Promise(resolve=>unblock=resolve);
                    ctx.resume=()=>gate.then(()=>nativeResume());
                    try {
                        midiSend(144,48); midiSend(128,48,0); await pause(8);
                        midiSend(144,48); midiSend(128,48,0); await pause(12);
                        midiSend(144,48); midiSend(144,48,0);
                        unblock(); await sampler.resumeJob; await pause(60);
                        return {starts:starts.length,held:sampler.held.size,peak:await livePeak(),
                            same:starts.every(s=>s.buffer===starts[0].buffer && s.rate===1 && Math.abs(s.offset-.04)<.0001)};
                    } finally {ctx.resume=nativeResume;await ctx.resume();}
                }""")
                check("taps arriving while audio resumes all become audible one-shots without stuck notes",
                      result["starts"] == 3 and result["held"] == 0 and result["same"]
                      and result["peak"] > .05, result)

                result = page.evaluate("""async () => {
                    await reset();sampler.slots[0].gate=true;await ctx.suspend();
                    const nativeResume=ctx.resume.bind(ctx);let unblock;
                    const gate=new Promise(resolve=>unblock=resolve);ctx.resume=()=>gate.then(()=>nativeResume());
                    try {
                        const first=performance.now();midiSend(144,48);await pause(18);midiSend(128,48,0);await pause(8);
                        const second=performance.now();midiSend(144,48);await pause(12);midiSend(144,48,0);
                        unblock();await sampler.resumeJob;await pause(140);
                        return {starts:starts.length,held:sampler.held.size,voices:sampler.voices.size,
                            lengths:ends.map(v=>v.stopTime-v.when),
                            gap:starts.length===2?1000*(starts[1].when-starts[0].when):null,inputGap:second-first};
                    } finally {ctx.resume=nativeResume;await ctx.resume();}
                }""")
                check("released gated taps pending resume keep timing and finite audible lengths",
                      result["starts"] == 2 and result["held"] == 0 and result["voices"] == 0
                      and all(.005 < length < .15 for length in result["lengths"])
                      and abs(result["gap"] - result["inputGap"]) < 12, result)

                result = page.evaluate("""async () => {
                    const results=[];
                    for(const pedalBeforeResume of [true,false]) {
                        await reset();sampler.slots[0].gate=true;await ctx.suspend();
                        const nativeResume=ctx.resume.bind(ctx);let unblock;
                        const gate=new Promise(resolve=>unblock=resolve);ctx.resume=()=>gate.then(()=>nativeResume());
                        try {
                            midiSend(176,64,127);const on=performance.now();midiSend(144,48);
                            await pause(20);midiSend(128,48,0);await pause(25);
                            let expected=null;
                            if(pedalBeforeResume) {expected=(performance.now()-on)/1000;midiSend(176,64,0)}
                            unblock();await sampler.resumeJob;await pause(30);
                            const heldBeforePedalUp=sampler.held.size;
                            if(!pedalBeforeResume) midiSend(176,64,0);
                            await pause(110);
                            results.push({starts:starts.length,heldBeforePedalUp,held:sampler.held.size,voices:sampler.voices.size,
                                length:ends[0]?.stopTime-ends[0]?.when,expected});
                        } finally {ctx.resume=nativeResume;await ctx.resume();}
                    }
                    return results;
                }""")
                check("sustain survives pending resume and releases before or after audio wakes",
                      all(item["starts"] == 1 and item["held"] == 0 and item["voices"] == 0 for item in result)
                      and result[0]["heldBeforePedalUp"] == 0 and result[1]["heldBeforePedalUp"] == 1
                      and abs(result[0]["length"] - result[0]["expected"]) < .015, result)

                result = page.evaluate("""async () => {
                    await reset(); await ctx.suspend();
                    const nativeResume=ctx.resume.bind(ctx);let unblock;
                    const gate=new Promise(resolve=>unblock=resolve);ctx.resume=()=>gate.then(()=>nativeResume());
                    try {
                        midiSend(144,48); midiSend(128,48,0); midiSend(144,48);
                        sampler.panic();unblock();await sampler.resumeJob;await pause(60);
                        return {starts:starts.length,held:sampler.held.size,voices:sampler.voices.size};
                    } finally {ctx.resume=nativeResume;await ctx.resume();}
                }""")
                check("panic during pending audio resume prevents late replay/stuck notes",
                      result == {"starts": 0, "held": 0, "voices": 0}, result)

                result = page.evaluate("""async () => {
                    await reset();await ctx.suspend();
                    const nativeResume=ctx.resume.bind(ctx);let unblock;
                    const gate=new Promise(resolve=>unblock=resolve);ctx.resume=()=>gate.then(()=>nativeResume());
                    try {
                        midiSend(144,48);sampler.panic();
                        midiSend(144,48);midiSend(128,48,0);unblock();await sampler.resumeJob;await pause(60);
                        return {starts:starts.length,held:sampler.held.size,pending:sampler.pendingPresses?.size||0};
                    } finally {ctx.resume=nativeResume;await ctx.resume();}
                }""")
                check("a fresh note after panic still starts when the outstanding audio resume completes",
                      result == {"starts": 1, "held": 0, "pending": 0}, result)

                result = page.evaluate("""async () => {
                    await reset(); midiSend(144,48); await pause(10);
                    testMidiPort.state='disconnected';testMidiAccess.onstatechange({port:testMidiPort});await pause(30);
                    const disconnected={held:sampler.held.size,voices:sampler.voices.size};
                    testMidiPort.state='connected';testMidiAccess.onstatechange({port:testMidiPort});
                    midiSend(144,48);await pause(10);midiSend(128,48,0);
                    const connected={starts:starts.length,held:sampler.held.size};
                    sampler.panic();return {disconnected,connected};
                }""")
                check("disconnect stops voices; reconnect restores the same input callback",
                      result["disconnected"] == {"held": 0, "voices": 0}
                      and result["connected"] == {"starts": 2, "held": 0}, result)

                check("no browser errors", not errors, errors)
                browser.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
    assert not failures, "MIDI regression failures: " + ", ".join(failures)
    print("PASS: synthetic MIDI callback, fast retriggers, sample consistency, actual audio, recording, resume, sustain, panic and reconnect")


if __name__ == "__main__":
    run()
