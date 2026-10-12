/* ScrewShop audio processors (AudioWorklet). Loaded by mix-engine.js into both the live
   AudioContext and the OfflineAudioContext used for exports, so both sound identical.

   ss-comp    Feed-forward, stereo-linked compressor in the log domain with a soft knee
              (Giannoulis, Massberg & Reiss, "Digital Dynamic Range Compressor Design", JAES 2012).
              No look-ahead, no automatic makeup gain: what the knobs say is what you get.
   ss-limiter Look-ahead brick-wall peak limiter. A sliding minimum of the required gain over
              the look-ahead window, smoothed by a moving average of the same length and applied
              to the delayed signal, guarantees no sample exceeds the ceiling while avoiding
              instant gain jumps. Release is smoothed exponentially. */
const db2lin = db => Math.pow(10, db / 20);

class SSComp extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: 0, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 1, minValue: 1, maxValue: 40, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 6, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.01, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.12, minValue: 0.005, maxValue: 3, automationRate: 'k-rate' },
      { name: 'makeup', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.reduction = 0; }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) return true;
    const T = p.threshold[0], R = p.ratio[0], W = p.knee[0], makeup = p.makeup[0];
    const aA = Math.exp(-1 / (p.attack[0] * sampleRate)), aR = Math.exp(-1 / (p.release[0] * sampleRate));
    const n = input[0].length, chans = output.length;
    let y = this.reduction;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) { const v = Math.abs(input[c][i]); if (v > peak) peak = v; }
      const x = peak > 1e-9 ? 20 * Math.log10(peak) : -180;
      let g; // static curve output level
      const over = x - T;
      if (R <= 1 || 2 * over < -W) g = x;
      else if (W > 0 && 2 * Math.abs(over) <= W) g = x + (1 / R - 1) * (over + W / 2) * (over + W / 2) / (2 * W);
      else g = T + over / R;
      const want = x - g; // dB of reduction wanted (>= 0)
      y = want > y ? aA * y + (1 - aA) * want : aR * y + (1 - aR) * want;
      const gain = db2lin(makeup - y);
      for (let c = 0; c < chans; c++) output[c][i] = (input[c] || input[0])[i] * gain;
    }
    this.reduction = y;
    return true;
  }
}

class SSLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: 0, minValue: -24, maxValue: 0, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.08, minValue: 0.005, maxValue: 2, automationRate: 'k-rate' },
      { name: 'active', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    const L = this.L = Math.max(1, Math.round(0.0015 * sampleRate)); // 1.5 ms look-ahead (mix-engine.js LATENCY)
    // Delay of exactly L samples: with the (L+1)-sample minimum and L-sample average below, every gain
    // averaged for an output sample was computed with that sample inside its window, so it cannot exceed the ceiling.
    this.delay = [new Float32Array(L), new Float32Array(L)]; this.d = 0;
    this.need = new Float32Array(L + 1); this.qi = new Int32Array(L + 2); this.qh = 0; this.qt = 0; this.t = 0; // sliding-min deque
    this.box = new Float32Array(L); this.b = 0; this.sum = L; this.box.fill(1);
    this.g = 1;
  }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0], L = this.L, N = L + 1;
    const ceiling = db2lin(p.ceiling[0]), aR = Math.exp(-1 / (p.release[0] * sampleRate)), active = p.active[0] >= 0.5;
    const n = output[0].length;
    for (let i = 0; i < n; i++) {
      const l = input[0] ? input[0][i] : 0, r = input[1] ? input[1][i] : l;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const t = this.t++, need = active && peak > ceiling ? ceiling / peak : 1;
      this.need[t % N] = need;
      // Sliding minimum of `need` over the last L+1 samples (monotonic deque of sample indices).
      while (this.qt > this.qh && this.need[this.qi[(this.qt - 1) % (L + 2)] % N] >= need) this.qt--;
      this.qi[this.qt++ % (L + 2)] = t;
      while (this.qi[this.qh % (L + 2)] <= t - N) this.qh++;
      const hold = this.need[this.qi[this.qh % (L + 2)] % N];
      // Moving average over L samples of the held minimum.
      this.sum += hold - this.box[this.b]; this.box[this.b] = hold; this.b = (this.b + 1) % L;
      const avg = this.sum / L;
      this.g = avg < this.g ? avg : aR * this.g + (1 - aR) * avg;
      // Output the sample from L samples ago.
      const k = this.d, outL = this.delay[0][k], outR = this.delay[1][k];
      this.delay[0][k] = l; this.delay[1][k] = r; this.d = (k + 1) % L;
      const g = Math.min(this.g, 1);
      output[0][i] = outL * g; if (output[1]) output[1][i] = outR * g;
    }
    return true;
  }
}

registerProcessor('ss-comp', SSComp);
registerProcessor('ss-limiter', SSLimiter);
