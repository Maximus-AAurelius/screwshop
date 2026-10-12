/* ScrewShop mix engine — the channel strip and master bus shared by Studio playback and
   Studio export, so what you hear while mixing is exactly what gets rendered.

   Channel strip (signal order, like a console):
     input → high-pass → low shelf → mid bell → high shelf → compressor → de-esser
           → saturation → fader (volume / mute / solo) → pan → mix bus
                                                    └→ reverb send, delay send (post-fader)
   Master bus: mix bus + reverb return + delay return → glue compressor → output gain → limiter.

   Every node exists on every track whether a section is "on" or not; turning a section off
   sets neutral values instead of rewiring, so the graph stays glitch-free while you move knobs.
   Dynamics use ScrewShop's own processors (mix-worklet.js) rather than DynamicsCompressorNode,
   which adds hidden automatic makeup gain and 6 ms look-ahead per instance. Call
   `await ScrewMix.ready(ctx)` before building strips on a context. */
(function () {
  const clamp = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const dbToGain = db => Math.pow(10, db / 20);

  // Neutral defaults: a session mixed before the mixer existed sounds exactly the same.
  const TRACK = {
    pan: 0, hpf: 20,
    low: { gain: 0, freq: 100 }, mid: { gain: 0, freq: 1000, q: 1 }, high: { gain: 0, freq: 8000 },
    comp: { on: false, threshold: -18, ratio: 3, attack: 10, release: 120, makeup: 0 },
    deess: { on: false, freq: 6500, amount: 6 },
    drive: 0, reverb: 0, delay: 0,
  };
  const MASTER = {
    reverb: { decay: 2.2, predelay: 20, tone: 6000 },
    delay: { division: 0.5, feedback: 0.3, tone: 4000 },
    glue: { on: false, threshold: -14, ratio: 2, attack: 30, release: 200 },
    gain: 0, limiter: { on: true, ceiling: -1 },
  };

  function merge(base, value) {
    const out = {};
    for (const k of Object.keys(base)) {
      const b = base[k], v = value && value[k];
      out[k] = b && typeof b === 'object' ? merge(b, v) : (v === undefined || v === null ? b : v);
    }
    return out;
  }
  // Clean, range-checked settings. Unknown keys from old sessions are dropped.
  function trackSettings(m) {
    m = merge(TRACK, m);
    return {
      pan: clamp(m.pan, -1, 1, 0), hpf: clamp(m.hpf, 20, 400, 20),
      low: { gain: clamp(m.low.gain, -15, 15, 0), freq: clamp(m.low.freq, 40, 400, 100) },
      mid: { gain: clamp(m.mid.gain, -15, 15, 0), freq: clamp(m.mid.freq, 200, 8000, 1000), q: clamp(m.mid.q, 0.3, 6, 1) },
      high: { gain: clamp(m.high.gain, -15, 15, 0), freq: clamp(m.high.freq, 2000, 16000, 8000) },
      comp: { on: !!m.comp.on, threshold: clamp(m.comp.threshold, -60, 0, -18), ratio: clamp(m.comp.ratio, 1, 20, 3),
        attack: clamp(m.comp.attack, 0.5, 200, 10), release: clamp(m.comp.release, 20, 1000, 120), makeup: clamp(m.comp.makeup, 0, 24, 0) },
      deess: { on: !!m.deess.on, freq: clamp(m.deess.freq, 3000, 10000, 6500), amount: clamp(m.deess.amount, 0, 12, 6) },
      drive: clamp(m.drive, 0, 1, 0), reverb: clamp(m.reverb, 0, 1, 0), delay: clamp(m.delay, 0, 1, 0),
    };
  }
  function masterSettings(m) {
    m = merge(MASTER, m);
    return {
      reverb: { decay: clamp(m.reverb.decay, 0.3, 6, 2.2), predelay: clamp(m.reverb.predelay, 0, 120, 20), tone: clamp(m.reverb.tone, 1500, 16000, 6000) },
      delay: { division: [0.25, 0.5, 0.75, 1, 1.5, 2].includes(+m.delay.division) ? +m.delay.division : 0.5,
        feedback: clamp(m.delay.feedback, 0, 0.85, 0.3), tone: clamp(m.delay.tone, 1000, 12000, 4000) },
      glue: { on: !!m.glue.on, threshold: clamp(m.glue.threshold, -40, 0, -14), ratio: clamp(m.glue.ratio, 1, 10, 2),
        attack: clamp(m.glue.attack, 1, 100, 30), release: clamp(m.glue.release, 50, 1000, 200) },
      gain: clamp(m.gain, -24, 12, 0), limiter: { on: m.limiter.on !== false, ceiling: clamp(m.limiter.ceiling, -6, 0, -1) },
    };
  }

  const set = (param, value, ctx) => { if (ctx.state === 'running' && !(ctx instanceof OfflineAudioContext)) param.setTargetAtTime(value, ctx.currentTime, 0.015); else param.value = value; };

  // Soft saturation. The shaper sees the signal at 1/4 level and its curve is scaled back up,
  // so loud peaks up to +12 dBFS pass without hard clipping; drive 0 is an exact straight line.
  const curves = new Map();
  function shaperCurve(drive) {
    const key = Math.round(drive * 100); if (curves.has(key)) return curves.get(key);
    const n = 4097, c = new Float32Array(n), k = 1 + key / 100 * 7;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, y = x * 4; c[i] = (key === 0 ? y : Math.tanh(k * y) / k) / 4; }
    curves.set(key, c); return c;
  }

  const loaded = new WeakMap();
  function ready(ctx) {
    if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule('/mix-worklet.js'));
    return loaded.get(ctx);
  }
  const stereo = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
  const param = (node, name) => node.parameters.get(name);
  function compressor(ctx, knee = 6) { const c = new AudioWorkletNode(ctx, 'ss-comp', stereo); param(c, 'knee').value = knee; return c; }
  function setComp(node, on, threshold, ratio, attackMs, releaseMs, ctx, makeupDb = 0) {
    set(param(node, 'threshold'), on ? threshold : 0, ctx); set(param(node, 'ratio'), on ? ratio : 1, ctx);
    set(param(node, 'attack'), attackMs / 1000, ctx); set(param(node, 'release'), releaseMs / 1000, ctx);
    set(param(node, 'makeup'), on ? makeupDb : 0, ctx);
  }
  // Web Audio lowpass/highpass Q is in dB: Butterworth (Q = 0.7071) is -3.01 dB.
  const BUTTERWORTH_DB = 20 * Math.log10(Math.SQRT1_2);
  function crossover(ctx, type) { // 4th-order Linkwitz-Riley half: two Butterworth sections; LP + HP sum flat
    const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter();
    a.type = b.type = type; a.Q.value = b.Q.value = BUTTERWORTH_DB; a.connect(b); return { input: a, output: b, filters: [a, b] };
  }

  // One track's channel strip. `bus` = { input, reverbIn, delayIn } from master().
  function track(ctx, mix, bus) {
    const n = {
      input: ctx.createGain(), hpf: ctx.createBiquadFilter(), low: ctx.createBiquadFilter(), mid: ctx.createBiquadFilter(), high: ctx.createBiquadFilter(),
      comp: compressor(ctx),
      lo: crossover(ctx, 'lowpass'), hi: crossover(ctx, 'highpass'), deess: compressor(ctx, 3), deessSum: ctx.createGain(),
      pre: ctx.createGain(), shaper: ctx.createWaveShaper(), post: ctx.createGain(),
      fader: ctx.createGain(), pan: ctx.createStereoPanner(), reverb: ctx.createGain(), delay: ctx.createGain(),
      // Wet/dry pairs: a filter, crossover or oversampler set to "neutral" still shifts phase and can overshoot
      // on sudden starts, so an OFF section is skipped entirely via its dry path (crossfaded, never rewired).
      hpfWet: ctx.createGain(), hpfDry: ctx.createGain(), dsWet: ctx.createGain(), dsDry: ctx.createGain(),
      satWet: ctx.createGain(), satDry: ctx.createGain(), afterHpf: ctx.createGain(), afterDs: ctx.createGain(),
    };
    n.hpf.type = 'highpass'; n.hpf.Q.value = BUTTERWORTH_DB; n.low.type = 'lowshelf'; n.mid.type = 'peaking'; n.high.type = 'highshelf';
    n.pre.gain.value = 0.25; n.post.gain.value = 4; n.shaper.oversample = '4x';
    n.input.connect(n.hpf); n.hpf.connect(n.hpfWet); n.hpfWet.connect(n.afterHpf); n.input.connect(n.hpfDry); n.hpfDry.connect(n.afterHpf);
    n.afterHpf.connect(n.low); n.low.connect(n.mid); n.mid.connect(n.high); n.high.connect(n.comp);
    n.comp.connect(n.lo.input); n.comp.connect(n.hi.input);
    n.lo.output.connect(n.deessSum); n.hi.output.connect(n.deess); n.deess.connect(n.deessSum);
    n.deessSum.connect(n.dsWet); n.dsWet.connect(n.afterDs); n.comp.connect(n.dsDry); n.dsDry.connect(n.afterDs);
    n.afterDs.connect(n.pre); n.pre.connect(n.shaper); n.shaper.connect(n.post); n.post.connect(n.satWet); n.satWet.connect(n.fader);
    n.afterDs.connect(n.satDry); n.satDry.connect(n.fader);
    n.fader.connect(n.pan); n.pan.connect(bus.input);
    n.pan.connect(n.reverb); n.reverb.connect(bus.reverbIn); n.pan.connect(n.delay); n.delay.connect(bus.delayIn);
    const strip = {
      input: n.input, fader: n.fader, nodes: n,
      update(m) {
        m = trackSettings(m);
        const hpfOn = m.hpf > 20, dsOn = m.deess.on && m.deess.amount > 0, satOn = m.drive > 0;
        set(n.hpf.frequency, hpfOn ? m.hpf : 20, ctx); set(n.hpfWet.gain, hpfOn ? 1 : 0, ctx); set(n.hpfDry.gain, hpfOn ? 0 : 1, ctx);
        set(n.dsWet.gain, dsOn ? 1 : 0, ctx); set(n.dsDry.gain, dsOn ? 0 : 1, ctx);
        set(n.satWet.gain, satOn ? 1 : 0, ctx); set(n.satDry.gain, satOn ? 0 : 1, ctx);
        set(n.low.frequency, m.low.freq, ctx); set(n.low.gain, m.low.gain, ctx);
        set(n.mid.frequency, m.mid.freq, ctx); set(n.mid.gain, m.mid.gain, ctx); set(n.mid.Q, m.mid.q, ctx);
        set(n.high.frequency, m.high.freq, ctx); set(n.high.gain, m.high.gain, ctx);
        setComp(n.comp, m.comp.on, m.comp.threshold, m.comp.ratio, m.comp.attack, m.comp.release, ctx, m.comp.makeup);
        for (const f of [...n.lo.filters, ...n.hi.filters]) set(f.frequency, m.deess.freq, ctx);
        // De-esser: a fast compressor on the band above the crossover; "amount" is the most it can pull down.
        setComp(n.deess, dsOn, -12 - m.deess.amount * 2, 1 + m.deess.amount, 1, 60, ctx);
        n.shaper.curve = shaperCurve(m.drive);
        set(n.pan.pan, m.pan, ctx); set(n.reverb.gain, m.reverb, ctx); set(n.delay.gain, m.delay, ctx);
      },
      dispose() { for (const node of Object.values(n)) for (const x of node.filters ? node.filters : [node]) { try { x.disconnect(); } catch (_) {} } },
    };
    strip.update(mix);
    return strip;
  }

  // Seeded noise so live playback and the exported file use the same reverb tail.
  function impulse(ctx, decay, predelayMs, tone) {
    const rate = ctx.sampleRate, pre = Math.floor(predelayMs / 1000 * rate), len = pre + Math.floor(decay * rate);
    const buffer = ctx.createBuffer(2, Math.max(1, len), rate);
    let seed = 1234567;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    const damp = Math.exp(-2 * Math.PI * tone / rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buffer.getChannelData(ch); let lp = 0;
      for (let i = pre; i < len; i++) { const t = (i - pre) / rate; lp = (1 - damp) * rnd() + damp * lp; d[i] = lp * Math.pow(10, -3 * t / decay); }
    }
    return buffer;
  }

  // Master bus. `beatSeconds` is the beat length you hear (after slowdown) for the tempo-synced delay.
  function master(ctx, settings, destination, beatSeconds) {
    const n = {
      input: ctx.createGain(), reverbIn: ctx.createGain(), delayIn: ctx.createGain(),
      verb: ctx.createConvolver(), verbOut: ctx.createGain(),
      dly: ctx.createDelay(4), dlyFb: ctx.createGain(), dlyTone: ctx.createBiquadFilter(), dlyOut: ctx.createGain(),
      sum: ctx.createGain(), glue: compressor(ctx), out: ctx.createGain(), limiter: new AudioWorkletNode(ctx, 'ss-limiter', stereo), trim: ctx.createGain(),
    };
    let verbKey = '';
    n.reverbIn.connect(n.verb); n.verb.connect(n.verbOut); n.verbOut.connect(n.sum);
    n.dlyTone.type = 'lowpass';
    n.delayIn.connect(n.dly); n.dly.connect(n.dlyTone); n.dlyTone.connect(n.dlyFb); n.dlyFb.connect(n.dly); n.dlyTone.connect(n.dlyOut); n.dlyOut.connect(n.sum);
    n.input.connect(n.sum); n.sum.connect(n.glue); n.glue.connect(n.out); n.out.connect(n.limiter); n.limiter.connect(n.trim); n.trim.connect(destination);

    const bus = {
      input: n.input, reverbIn: n.reverbIn, delayIn: n.delayIn, nodes: n,
      update(m, beat = beatSeconds) {
        m = masterSettings(m);
        const key = [m.reverb.decay, m.reverb.predelay, m.reverb.tone].join();
        if (key !== verbKey) { verbKey = key; n.verb.buffer = impulse(ctx, m.reverb.decay, m.reverb.predelay, m.reverb.tone); }
        set(n.dly.delayTime, Math.min(3.9, (beat || 0.5) * m.delay.division), ctx); // division in beats: 0.5 = 1/8 note, 0.75 = dotted 1/8
        set(n.dlyFb.gain, m.delay.feedback, ctx); set(n.dlyTone.frequency, m.delay.tone, ctx);
        setComp(n.glue, m.glue.on, m.glue.threshold, m.glue.ratio, m.glue.attack, m.glue.release, ctx);
        set(n.out.gain, dbToGain(m.gain), ctx);
        set(param(n.limiter, 'ceiling'), m.limiter.ceiling, ctx); set(param(n.limiter, 'active'), m.limiter.on ? 1 : 0, ctx);
      },
      dispose() { for (const x of Object.values(n)) { try { x.disconnect(); } catch (_) {} } },
    };
    bus.update(settings);
    return bus;
  }

  // 16-bit PCM WAV with TPDF dither (the standard way to drop float audio to 16 bits without distortion).
  function wav(buffer) {
    const channels = buffer.numberOfChannels, frames = buffer.length, bytes = new ArrayBuffer(44 + frames * channels * 2), v = new DataView(bytes);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + frames * channels * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, buffer.sampleRate, true);
    v.setUint32(28, buffer.sampleRate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, frames * channels * 2, true);
    const data = []; for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
      const s = data[c][i] * 32767 + (Math.random() - Math.random());
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s))), true); o += 2;
    }
    return new Blob([bytes], { type: 'audio/wav' });
  }

  // The master limiter looks 1.5 ms ahead (mix-worklet.js); recordings and exports compensate for it.
  const LATENCY = 0.0015;

  window.ScrewMix = { TRACK, MASTER, LATENCY, ready, trackSettings, masterSettings, track, master, wav, dbToGain };
})();
