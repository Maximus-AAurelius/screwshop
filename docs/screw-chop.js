/* Screw engine: beat grid, phrase finder, DJ Screw / Michael Watts chop plans and offline render. No UI.
   All positions are in SOURCE seconds (the original record). Output time = source time / rate. */
(function () {
  const BAR = 4;

  // In-place radix-2 FFT. n must be a power of two.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  // Mono, half sample rate (plenty for rhythm and phrase shape).
  function mono(buffer, maxSeconds) {
    const sr = buffer.sampleRate, frames = Math.min(buffer.length, Math.floor((maxSeconds || Infinity) * sr));
    const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const out = new Float32Array(Math.floor(frames / 2));
    for (let i = 0; i < out.length; i++) { let s = 0; for (const ch of chans) s += ch[2 * i] + ch[2 * i + 1]; out[i] = s / (2 * chans.length); }
    return { x: out, sr: sr / 2 };
  }

  // Spectral flux (rhythm) and log band energies (phrase shape) per frame.
  function analyze(x, sr, bands = 16, n = 1024, hop = 512) {
    const frames = Math.max(0, Math.floor((x.length - n) / hop));
    const win = new Float32Array(n).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
    const edges = Array.from({ length: bands + 1 }, (_, b) => Math.round(Math.exp(Math.log(3) + (Math.log(n / 2) - Math.log(3)) * b / bands)));
    const flux = new Float32Array(frames), feats = new Float32Array(frames * bands), energy = new Float32Array(frames);
    const re = new Float64Array(n), im = new Float64Array(n);
    let prev = new Float32Array(n / 2), cur = new Float32Array(n / 2);
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < n; i++) { re[i] = x[f * hop + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let fl = 0, en = 0;
      for (let k = 1; k < n / 2; k++) { const m = Math.log1p(Math.hypot(re[k], im[k])); cur[k] = m; const d = m - prev[k]; if (d > 0) fl += d; en += m; }
      for (let b = 0; b < bands; b++) { let s = 0; for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) s += cur[k]; feats[f * bands + b] = s; }
      flux[f] = fl; energy[f] = en;
      [prev, cur] = [cur, prev];
    }
    return { flux, feats, energy, bands, fps: sr / hop };
  }

  const at = (a, pos) => { const i = Math.floor(pos), t = pos - i; return i + 1 < a.length ? a[i] * (1 - t) + a[i + 1] * t : 0; };
  function comb(flux, fps, bpm, beats = 1) { const lag = beats * 60 / bpm * fps; let s = 0; for (let i = 0; i + lag < flux.length; i++) s += flux[i] * at(flux, i + lag); return s; }
  // Longer lags (a bar, two bars) pin the tempo down far more precisely than a single beat.
  const fineComb = (flux, fps, bpm) => [1, 2, 4, 8, 16, 32].reduce((s, k) => k * 60 / bpm * fps < flux.length / 2 ? s + comb(flux, fps, bpm, k) : s, 0);

  // Tempo in quarter-note BPM plus the first beat's time. Prefers the 60–130 range hip-hop lives in.
  function tempoFromFlux(flux, fps) {
    const mean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1), f = flux.map(v => v - mean);
    let best = 0, bestScore = -Infinity; const scores = new Map();
    for (let bpm = 55; bpm <= 185; bpm += 0.5) { const s = comb(f, fps, bpm); scores.set(bpm, s); if (s > bestScore) { bestScore = s; best = bpm; } }
    for (const alt of [best / 2, best * 2]) {
      const near = Math.round(alt * 2) / 2;
      // Rap and screw records sit at 60-130 BPM; hi-hats on every half beat make double time score high,
      // so a half-time reading wins more easily than a double-time one.
      if (near >= 60 && near < 130 && (best < 60 || best >= 130) && (scores.get(near) || -Infinity) > (alt < best ? 0.45 : 0.75) * bestScore) best = near;
    }
    let fine = best, fineScore = -Infinity;
    for (let bpm = best - 1; bpm <= best + 1; bpm += 0.05) { const s = fineComb(f, fps, bpm); if (s > fineScore) { fineScore = s; fine = bpm; } }
    const rough = fine;
    for (let bpm = rough - 0.06; bpm <= rough + 0.06; bpm += 0.005) { const s = fineComb(f, fps, bpm); if (s > fineScore) { fineScore = s; fine = bpm; } }
    const period = 60 / fine * fps; let phase = 0, phaseScore = -Infinity;
    for (let p = 0; p < period; p += 0.5) { let s = 0; for (let t = p; t < f.length; t += period) s += at(flux, t); if (s > phaseScore) { phaseScore = s; phase = p; } }
    return { bpm: Math.round(fine * 1000) / 1000, firstBeat: phase / fps };
  }

  function detectTempo(buffer) {
    const { x, sr } = mono(buffer, 240), a = analyze(x, sr, 4, 512, 256);
    if (a.flux.length < a.fps * 4) return { bpm: 90, firstBeat: 0, guessed: true };
    return tempoFromFlux(a.flux, a.fps);
  }

  // Bars, vocal activity per bar and the most-repeated 2-bar phrase (the likely hook).
  function analyzeSong(mix, vocals, tempo) {
    const m = mono(mix), am = analyze(m.x, m.sr, 4);
    const t = tempo || tempoFromFlux(am.flux, am.fps);
    const src = vocals ? (() => { const v = mono(vocals); return analyze(v.x, v.sr, 16); })() : analyze(m.x, m.sr, 16);
    const beat = 60 / t.bpm, barLen = beat * BAR, duration = mix.duration, bars = [];
    for (let s = t.firstBeat; s + barLen <= duration + 1e-6; s += barLen) bars.push({ start: s, end: s + barLen });
    const B = src.bands, mean = new Float64Array(B);
    const frames = src.energy.length;
    for (let f = 0; f < frames; f++) for (let b = 0; b < B; b++) mean[b] += src.feats[f * B + b] / frames;
    for (const bar of bars) {
      const f0 = Math.floor(bar.start * src.fps), f1 = Math.min(frames, Math.floor(bar.end * src.fps)), v = new Float64Array(B);
      let e = 0; for (let f = f0; f < f1; f++) { e += src.energy[f]; for (let b = 0; b < B; b++) v[b] += src.feats[f * B + b] - mean[b]; }
      const norm = Math.hypot(...v) || 1; bar.vec = v.map(x => x / norm); bar.vocal = f1 > f0 ? e / (f1 - f0) : 0;
    }
    const sorted = bars.map(b => b.vocal).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] || 0;
    bars.forEach(b => { b.hasVocal = b.vocal > median * 0.9; });
    const sim = (i, j) => { let s = 0; for (const k of [0, 1]) for (let b = 0; b < B; b++) s += bars[i + k].vec[b] * bars[j + k].vec[b]; return s / 2; };
    const sims = [];
    for (let i = 0; i + 1 < bars.length; i++) for (let j = i + 2; j + 1 < bars.length; j++) sims.push(sim(i, j));
    sims.sort((a, b) => a - b);
    const cut = Math.max(0.55, sims[Math.floor(sims.length * 0.97)] || 1);
    let hook = null;
    for (let i = 2; i + 1 < bars.length; i++) {
      if (!bars[i].hasVocal) continue;
      const hits = [];
      for (let j = 0; j + 1 < bars.length; j++) if (j === i || (Math.abs(j - i) >= 2 && sim(i, j) >= cut)) { if (!hits.length || j - hits[hits.length - 1] >= 4) hits.push(j); }
      if (hits.length >= 3 && (!hook || hits.length > hook.bars.length)) hook = { bars: hits };
    }
    return { bpm: t.bpm, firstBeat: t.firstBeat, beat, barLen, duration, bars, hook: hook && hook.bars.length >= 2 ? hook : null };
  }

  /* The true length of "N beats back" at this spot in the record. Matches the hits in the last couple of
     seconds before `pos` against the hits `len` earlier, searching ±spread around the tempo estimate,
     so a slightly-off BPM or a drifting record still lands on the beat. Returns source seconds. */
  function measureLag(buffer, pos, len, spread = 0.03) {
    const lagMax = len * (1 + spread), lagMin = len * (1 - spread), W = Math.min(2.5, pos - lagMax - 0.03);
    if (!(W >= 0.6)) return null;
    const sr = buffer.sampleRate, start = pos - W - lagMax - 0.03, from = Math.floor(start * sr), to = Math.min(buffer.length, Math.ceil(pos * sr));
    const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const x = new Float32Array(Math.floor((to - from) / 2));
    for (let i = 0; i < x.length; i++) { let s = 0; for (const ch of chans) s += ch[from + 2 * i] + ch[from + 2 * i + 1]; x[i] = s; }
    const hop = 64, a = analyze(x, sr / 2, 1, 512, hop), f = a.flux, fps = a.fps;
    const mean = f.reduce((p, v) => p + v, 0) / (f.length || 1); for (let i = 0; i < f.length; i++) f[i] -= mean;
    const end = f.length - 1, span = Math.floor(W * fps), score = L => { let s = 0; for (let i = end - span; i <= end; i++) if (i - L >= 0) s += f[i] * f[i - L]; return s; };
    let best = -1, bestS = -Infinity;
    for (let L = Math.floor(lagMin * fps); L <= Math.ceil(lagMax * fps); L++) { const s = score(L); if (s > bestS) { bestS = s; best = L; } }
    if (best < 0 || bestS <= 0 || best <= Math.floor(lagMin * fps) || best >= Math.ceil(lagMax * fps)) return null;
    const l = score(best - 1), r = score(best + 1), d = l - 2 * bestS + r, frac = d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d)) : 0;
    return (best + frac) / fps;
  }
  const refineBack = (buffer, pos, len, spread) => measureLag(buffer, pos, len, spread) ?? len;
  // Exact length of a run-back of `beats` at `pos`. Short ones are measured over 4 beats (more hits to
  // match, better precision) and scaled; 1 bar and up are measured directly. Falls back to the tempo.
  function runBackLength(buffer, pos, beats, beatSec) {
    for (const k of [...new Set([Math.max(beats, 4), Math.max(beats, 2), Math.max(beats, 1)])]) {
      const m = measureLag(buffer, pos, k * beatSec);
      if (m != null) return beats * m / k;
    }
    return beats * beatSec;
  }

  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const label = (beats) => beats === 0.5 ? '½ beat' : beats === 1 ? '1 beat' : beats < 4 ? beats + ' beats' : beats === 4 ? '1 bar' : beats / 4 + ' bars';

  /* Turn an analysis into a list of source segments played back to back.
     Run it back = play up to P, replay the last N beats (times ×), then keep going from P.
     That is the two-turntable move: the second copy sits N beats behind, you cut to it,
     and the song drops back in from there. Doubles play a second copy one beat behind. */
  const STYLES = {
    screw: { name: 'DJ Screw', every: 4, moves: [[1, 1], [2, 1], [1, 1], [4, 1]], double: 16, hook: { beats: 4, times: 1, double: true }, treble: -3 },
    watts: { name: 'Michael Watts', every: 8, moves: [[2, 1], [4, 1], [2, 2], [8, 1]], double: 0, hook: { beats: 8, times: 2, double: false }, treble: 0 },
    slowed: { name: 'Slowed only', every: 0, moves: [], double: 0, hook: null, treble: 0 },
  };

  function planVersion(an, styleKey, { rate = 0.75, seed = 1, hook: markedHook, refine } = {}) {
    const style = STYLES[styleKey] || STYLES.slowed, rand = rng(seed), events = [];
    const { bars, beat } = an, taken = new Set();
    const hookStarts = markedHook ? [markedHook.start] : an.hook ? an.hook.bars.slice(0, 2).map(i => bars[i].start) : [];
    if (style.hook) for (const start of hookStarts) {
      const P = start + style.hook.beats * beat;
      if (P >= an.duration - beat) continue;
      events.push({ at: P, beats: style.hook.beats, times: style.hook.times, why: 'hook' });
      if (style.hook.double) events.push({ at: P, doubleBars: 2, why: 'hook' });
      const b = bars.findIndex(x => Math.abs(x.start - start) < beat / 2); for (let k = b - 2; k <= b + 4; k++) taken.add(k);
    }
    if (style.every) {
      let k = 0;
      for (let b = 4; b < bars.length - 2; b += style.every) {
        let pick = -1;
        for (let j = b; j < Math.min(b + 3, bars.length - 2); j++) if (!taken.has(j) && bars[j - 1].hasVocal) { pick = j; break; }
        if (pick < 0) continue;
        const [beats, times] = style.moves[(k++ + Math.floor(rand() * 2)) % style.moves.length];
        events.push({ at: bars[pick].start, beats, times, why: 'line' });
        if (style.double && pick % style.double === 0 && !taken.has(pick + 1)) events.push({ at: bars[pick].start, doubleBars: 2, why: 'line' });
        for (let j = pick - 1; j <= pick + 1; j++) taken.add(j);
      }
    }
    events.sort((a, b) => a.at - b.at || (a.doubleBars ? 1 : -1));
    const segments = [], notes = [], fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    let cursor = 0, out = 0;
    const push = (from, to, double = 0) => { if (to - from > 0.01) { segments.push({ from, to, double }); out += (to - from) / rate; } };
    for (const e of events) {
      if (e.at < cursor - 1e-6) continue;
      if (e.doubleBars) {
        push(cursor, e.at); const end = Math.min(an.duration, e.at + e.doubleBars * an.barLen);
        notes.push({ at: out, text: fmt(out) + ' · double up: second table 1 beat behind for ' + e.doubleBars + ' bars' + (e.why === 'hook' ? ' (hook)' : '') });
        push(e.at, end, beat); cursor = end; continue;
      }
      const back = refine ? refine(e.at, e.beats, beat) : e.beats * beat;
      if (e.at - back < 0) continue;
      push(cursor, e.at);
      notes.push({ at: out, text: fmt(out) + ' · run it back ' + label(e.beats) + (e.times > 1 ? ' ×' + e.times : '') + (e.why === 'hook' ? ' (hook)' : '') + ', then drop back in' });
      for (let t = 0; t < e.times; t++) push(e.at - back, e.at);
      cursor = e.at;
    }
    push(cursor, an.duration);
    return { style: styleKey, name: style.name, treble: style.treble, rate, segments, notes, outDuration: out };
  }

  // Cassette dub character, 0..1: slow wow + fast flutter (tiny pitch wobble), soft tape saturation and
  // a rolled-off top end. Every stage runs fully wet (no dry blend) so it never comb-filters. At 0 the
  // whole chain is switched out, so the record sounds exactly as it did without TAPE.
  function makeTape(T, context, amount) {
    const c = context ? { context } : {};
    const input = new T.Gain(c), output = new T.Gain(c), dry = new T.Gain({ ...c, gain: 1 }), wet = new T.Gain({ ...c, gain: 0 });
    const wow = new T.Vibrato({ ...c, frequency: 0.55, depth: 0, maxDelay: 0.006, wet: 1 });
    const flutter = new T.Vibrato({ ...c, frequency: 6.5, depth: 0, maxDelay: 0.002, wet: 1 });
    const shaper = new T.WaveShaper({ ...c, length: 2048 });
    const lowpass = new T.Filter({ ...c, type: 'lowpass', frequency: 18000, rolloff: -12, Q: 0.707 });
    input.connect(dry); dry.connect(output);
    input.chain(wow, flutter, shaper, lowpass, wet, output);
    const tape = {
      input, output, value: 0,
      set(a) {
        a = Math.max(0, Math.min(1, +a || 0)); tape.value = a;
        dry.gain.value = a > 0 ? 0 : 1; wet.gain.value = a > 0 ? 1 : 0;
        wow.depth.value = 0.45 * a; flutter.depth.value = 0.35 * a;
        const g = 2.5 * a; shaper.setMap(x => g ? Math.tanh(g * x) / Math.tanh(g) : x, 2048);
        lowpass.frequency.value = 18000 * Math.pow(4800 / 18000, a);
      },
      dispose() { [input, output, dry, wet, wow, flutter, shaper, lowpass].forEach(n => n.dispose()); }
    };
    tape.set(amount);
    return tape;
  }

  // Offline render. Lanes: one full mix, or instrumental + vocals with their own pitch.
  async function renderVersion(T, src, plan, o) {
    const lanes = src.vocals && src.instrumental
      ? [{ buf: src.instrumental, pitch: o.pitch || 0 }, { buf: src.vocals, pitch: (o.pitch || 0) + (o.vocalPitch || 0) }]
      : [{ buf: src.mix, pitch: o.pitch || 0 }];
    const tail = o.syrup ? 4 : 0.25, duration = plan.outDuration + tail;
    if (duration > 1800 || duration * 44100 * 4 > 300 * 1024 * 1024) throw Error('Versions are limited to 30 minutes. Speed it up a little.');
    const ctx = new T.OfflineContext(2, duration, 44100), nodes = [];
    try {
      const limiter = new T.Limiter({ context: ctx, threshold: -1 }).toDestination();
      const eq = new T.EQ3({ context: ctx, low: o.bass || 0, mid: 0, high: (o.treble || 0) + (plan.treble || 0) }).connect(limiter);
      const reverb = new T.Reverb({ context: ctx, decay: 3.5, wet: o.syrup ? 0.55 : 0 }).connect(eq);
      nodes.push(limiter, eq, reverb); await reverb.generate();
      const tape = makeTape(T, ctx, o.tape || 0); tape.output.connect(reverb); nodes.push(tape);
      for (const lane of lanes) {
        lane.node = new T.PitchShift({ context: ctx, pitch: lane.pitch, wet: lane.pitch ? 1 : 0 }).connect(tape.input); nodes.push(lane.node);
        lane.dbl = new T.Gain({ context: ctx, gain: 0.7 }).connect(lane.node); nodes.push(lane.dbl);
      }
      let t = 0;
      for (const seg of plan.segments) {
        const len = seg.to - seg.from;
        for (const lane of lanes) {
          const play = (from, dest) => { const p = new T.Player({ context: ctx, url: lane.buf, playbackRate: plan.rate, fadeIn: 0.004, fadeOut: 0.004 }).connect(dest); nodes.push(p); if (from < lane.buf.duration) p.start(t, from, Math.min(len, lane.buf.duration - from)); };
          play(seg.from, seg.double ? lane.dbl : lane.node);
          if (seg.double && seg.from - seg.double >= 0) play(seg.from - seg.double, lane.dbl);
        }
        t += len / plan.rate;
      }
      return (await ctx.render()).get();
    } finally { nodes.forEach(n => n.dispose()); ctx.dispose(); }
  }

  // Two Tone players (instrumental + vocals) driven as one deck so vocals can take their own pitch.
  class PairPlayer {
    constructor(players) { this.players = players; }
    start(t, o, d) { this.players.forEach(p => p.start(t, o, d)); return this; }
    stop(t) { this.players.forEach(p => p.stop(t)); return this; }
    restart(t, o, d) { this.players.forEach(p => p.restart(t, o, d)); return this; }
    get state() { return this.players[0].state; }
    get loop() { return this.players[0].loop; } set loop(v) { this.players.forEach(p => { p.loop = v; }); }
    get loopStart() { return this.players[0].loopStart; } set loopStart(v) { this.players.forEach(p => { p.loopStart = v; }); }
    get loopEnd() { return this.players[0].loopEnd; } set loopEnd(v) { this.players.forEach(p => { p.loopEnd = v; }); }
    get playbackRate() { return this.players[0].playbackRate; } set playbackRate(v) { this.players.forEach(p => { p.playbackRate = v; }); }
    dispose() { this.players.forEach(p => p.dispose()); }
  }

  const api = { fft, mono, analyze, tempoFromFlux, detectTempo, refineBack, runBackLength, analyzeSong, planVersion, renderVersion, makeTape, PairPlayer, STYLES, beatsLabel: label };
  if (typeof window !== 'undefined') window.ScrewChop = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
