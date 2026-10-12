/* ScrewShop scratch processor (AudioWorklet). The jog wheel sends where the "needle" should be
   (seconds into the record); the processor glides the read head there through two smoothing
   stages, so the speed changes continuously the way a hand-moved record does. Forward, backward,
   still (silence) and every speed in between come out of the same read head.
   Messages: {type:'load', ch:[Float32Array...], start, sr, pos?}  a window of the record
             {type:'target', pos}                                where the hand has the record
             {type:'run', rate, dur}                             let go: motor carries the record at `rate`
                                                                 for `dur` s while the deck takes over, then fades
             {type:'stop'}                                       fade out now */
class SSScratch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null; this.start = 0; this.sr = sampleRate; this.pos = 0; this.mid = 0; this.target = 0;
    this.gain = 0; this.on = false; this.run = 0; this.left = 0; this.x1 = [0, 0]; this.y1 = [0, 0];
    // ~6 ms per smoothing stage: smooth enough to hide pointer-event steps, fast enough to feel direct.
    this.k = 1 - Math.exp(-1 / (sampleRate * 0.006));
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'load') { this.ch = m.ch; this.start = m.start; this.sr = m.sr; if (m.pos != null) this.pos = this.mid = this.target = m.pos; this.on = true; }
      else if (m.type === 'target') { this.target = m.pos; this.on = true; }
      else if (m.type === 'run') { this.run = m.rate; this.left = Math.round(m.dur * sampleRate); }
      else if (m.type === 'stop') { this.on = false; this.left = 0; }
    };
  }
  // 4-point Hermite read: much cleaner than linear when the record moves slowly.
  read(d, x) {
    const i = Math.floor(x), f = x - i, n = d.length;
    if (i < 1 || i + 2 >= n) return 0;
    const a = d[i - 1], b = d[i], c = d[i + 1], e = d[i + 2];
    const c1 = .5 * (c - a), c2 = a - 2.5 * b + 2 * c - .5 * e, c3 = .5 * (e - a) + 1.5 * (b - c);
    return ((c3 * f + c2) * f + c1) * f + b;
  }
  process(inputs, outputs) {
    const out = outputs[0], n = out[0].length;
    if (!this.ch || (!this.on && this.gain < 1e-4)) { for (const o of out) o.fill(0); return true; }
    const chs = this.ch.length, fade = 1 / (sampleRate * 0.008);
    for (let i = 0; i < n; i++) {
      if (this.left > 0) { this.target += this.run / sampleRate; if (--this.left === 0) this.on = false; }
      this.mid += (this.target - this.mid) * this.k;
      this.pos += (this.mid - this.pos) * this.k;
      this.gain = this.on ? Math.min(1, this.gain + fade) : Math.max(0, this.gain - fade);
      const x = (this.pos - this.start) * this.sr;
      for (let c = 0; c < out.length; c++) {
        const s = this.read(this.ch[Math.min(c, chs - 1)], x);
        // DC blocker: a record held still is silent, not a stuck sample value.
        const y = s - this.x1[c] + 0.995 * this.y1[c]; this.x1[c] = s; this.y1[c] = y;
        out[c][i] = y * this.gain;
      }
    }
    return true;
  }
}
registerProcessor('ss-scratch', SSScratch);
