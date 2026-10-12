/* Turntable-software layer for the SCREW tables: stacked scrolling waveforms with a beat grid
   (like Serato / rekordbox), per-table SLOW (drag or wind-down, 0.02 s to 4 s), TAPE character,
   and transformer pads (cut, flick, lag) on the mixer. Audio work lives in screw-room.js. */
window.ScrewTables = class {
  constructor(room) {
    this.room = room; this.app = room.app; this.waves = new WeakMap();
    const saved = this.read();
    const deck = (s, pads) => ({ pads: ['chop', 'slow'].includes(s?.pads) ? s.pads : pads, mode: s?.mode === 'stop' ? 'stop' : 'drag', time: this.clamp(+s?.time || .5, .02, 4), depth: this.clamp(+s?.depth || .3, .05, .95), tape: this.clamp(+s?.tape || 0, 0, 1) });
    this.settings = { A: deck(saved.A, 'chop'), B: deck(saved.B, 'slow') };
    this.zoom = this.clamp(+saved.zoom || 3, .75, 12); this.lag = [.5, 1, 2, 4].includes(+saved.lag) ? +saved.lag : 1;
  }
  clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  read() { try { return JSON.parse(localStorage.getItem('screwshop.tables.v1')) || {}; } catch (e) { return {}; } }
  save() { try { localStorage.setItem('screwshop.tables.v1', JSON.stringify({ ...this.settings, zoom: this.zoom, lag: this.lag })); } catch (e) {} }
  lagBeats() { return this.lag; }
  // Read-only: which table is on air. (room.live() also updates its memory, so the UI must not call it.)
  onAir() { const x = this.app.state.crossfade; return x < -.05 ? 'A' : x > .05 ? 'B' : this.room.lastLive; }
  // Slow time slider is logarithmic so the short end is easy to set: 0..1 -> 0.02..4 s.
  toTime(v) { return .02 * Math.pow(200, v); }
  fromTime(t) { return Math.log(t / .02) / Math.log(200); }

  tick(room) {
    if (!room.querySelector('.tt-waves')) this.drawWaves(room);
    for (const w of ['A', 'B']) {
      const deck = document.getElementById('turntable-' + w);
      if (deck && !deck.querySelector('.tt-ctrl')) this.drawDeck(deck, w);
      if (deck && !deck.querySelector('.tt-pads')) this.drawPads(deck, w);
      if (deck) this.refreshPads(deck, w);
      if (deck) this.refreshDeck(deck, w);
      const d = this.app.deckStore(w);
      if (d.tape && d.tape.value !== this.settings[w].tape) this.room.setTape(w, this.settings[w].tape);
    }
    const mixer = room.querySelector('.dj-mixer');
    if (mixer && !mixer.querySelector('.tt-cut')) this.drawMixer(mixer);
    if (mixer) mixer.querySelectorAll('[data-tt-cut]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ttCut === this.onAir() && Math.abs(this.app.state.crossfade) > .05));
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  // ---- Per-table controls under each platter ----
  drawDeck(deck, w) {
    const box = document.createElement('div'); box.className = 'tt-ctrl'; box.dataset.deck = w;
    box.innerHTML = `<div class="tt-read"><output data-tt-bpm>— BPM</output><output data-tt-pct>0.0%</output></div>
      <div class="tt-slow-row"><button class="tt-slow" data-tt-slow aria-label="Slow table ${w} down (hold)">SLOW ${w} <kbd>${w === 'A' ? 'Q' : 'P'}</kbd></button>
        <div class="tt-mode" role="group" aria-label="Table ${w} slow mode"><button data-tt-mode="drag" title="Slows while held, comes back on release">DRAG</button><button data-tt-mode="stop" title="Motor off: the record winds down to a stop">STOP</button></div></div>
      <label class="tt-range">SLOW TIME <output data-tt-time-out></output><input data-tt-time aria-label="Table ${w} slow time" type="range" min="0" max="1" step="0.001"></label>
      <label class="tt-range" data-tt-depth-row>DRAG DEPTH <output data-tt-depth-out></output><input data-tt-depth aria-label="Table ${w} drag depth" type="range" min="5" max="95" step="1"></label>
      <label class="tt-range">TAPE <output data-tt-tape-out></output><input data-tt-tape aria-label="Table ${w} tape" type="range" min="0" max="100" step="1"></label>`;
    (deck.querySelector('.deck-buttons') || deck.lastElementChild).after(box);
    const s = this.settings[w], q = sel => box.querySelector(sel);
    q('[data-tt-time]').value = this.fromTime(s.time); q('[data-tt-depth]').value = Math.round(s.depth * 100); q('[data-tt-tape]').value = Math.round(s.tape * 100);
    q('[data-tt-time]').oninput = e => { s.time = Math.round(this.toTime(+e.target.value) * 100) / 100; this.save(); };
    q('[data-tt-depth]').oninput = e => { s.depth = +e.target.value / 100; this.save(); };
    q('[data-tt-tape]').oninput = e => { s.tape = +e.target.value / 100; this.room.setTape(w, s.tape); this.save(); };
    box.querySelectorAll('[data-tt-mode]').forEach(b => b.onclick = () => { s.mode = b.dataset.ttMode; this.save(); });
    box.addEventListener('input', () => this.refreshDeck(deck, w)); box.addEventListener('click', () => this.refreshDeck(deck, w));
    const pad = q('[data-tt-slow]');
    pad.onpointerdown = e => { e.preventDefault(); pad.setPointerCapture(e.pointerId); this.room.run(() => this.room.slowDown(w)); };
    pad.onpointerup = pad.onpointercancel = pad.onlostpointercapture = () => this.room.slowUp(w);
  }
  refreshDeck(deck, w) {
    const box = deck.querySelector('.tt-ctrl'), s = this.settings[w], d = this.app.deckStore(w), q = sel => box.querySelector(sel);
    const rate = d.rate ?? this.app.state['deck' + w].rate ?? 1;
    q('[data-tt-bpm]').textContent = d.bpm ? (d.bpm * rate).toFixed(1) + ' BPM' : '— BPM';
    const pct = (rate - 1) * 100; q('[data-tt-pct]').textContent = (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(1) + '%';
    q('[data-tt-time-out]').textContent = s.time.toFixed(2) + ' s';
    q('[data-tt-depth-out]').textContent = Math.round(s.depth * 100) + '% slower';
    q('[data-tt-tape-out]').textContent = Math.round(s.tape * 100) + '%';
    q('[data-tt-depth-row]').hidden = s.mode !== 'drag';
    box.querySelectorAll('[data-tt-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ttMode === s.mode));
    q('[data-tt-slow]').setAttribute('aria-pressed', !!this.room.slowing[w]);
  }

  // ---- Performance pads: CHOP (run-backs, hook, double, lag) or SLOW (speed steps −0.01 … −0.08) ----
  padSet(mode) {
    return mode === 'slow'
      ? [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ label: '−0.0' + n, step: -n / 100 }))
      : [['½ BEAT', .5], ['1 BEAT', 1], ['2 BEATS', 2], ['1 BAR', 4], ['2 BARS', 8], ['HOOK', 'hook'], ['DOUBLE', 'double'], ['LAG', 'lag']].map(([label, act]) => ({ label, act }));
  }
  drawPads(deck, w) {
    const box = document.createElement('div'); box.className = 'tt-pads'; box.dataset.deck = w;
    box.innerHTML = `<div class="tt-pad-modes" role="group" aria-label="Table ${w} pad mode"><button data-pad-mode="chop">CHOP</button><button data-pad-mode="slow">SLOW −</button><button data-pad-reset aria-label="Table ${w} back to 1.00×">1.00×</button></div><div class="tt-pad-grid"></div>`;
    (deck.querySelector('.deck-buttons') || deck.lastElementChild).before(box);
    box.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.padMode) { this.settings[w].pads = b.dataset.padMode; this.save(); this.refreshPads(deck, w); return; }
      if (b.dataset.padReset != null) return this.room.run(() => this.room.stepSpeed(w, null));
      const pad = this.padSet(this.settings[w].pads)[+b.dataset.pad]; if (!pad) return;
      b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 140);
      if (pad.step) return this.room.run(() => this.room.stepSpeed(w, pad.step));
      const r = this.room, act = { hook: () => r.playHook(), double: () => r.toggleDouble(), lag: () => r.lagBehind() }[pad.act];
      this.room.run(act || (() => r.runBack(pad.act)));
    };
  }
  refreshPads(deck, w) {
    const box = deck.querySelector('.tt-pads'), mode = this.settings[w].pads, grid = box.querySelector('.tt-pad-grid');
    if (grid.dataset.mode !== mode) {
      grid.dataset.mode = mode;
      grid.innerHTML = this.padSet(mode).map((p, i) => `<button data-pad="${i}" aria-label="Table ${w} pad ${p.label}">${p.label}</button>`).join('');
    }
    box.querySelectorAll('[data-pad-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.padMode === mode));
  }

  // ---- Transformer pads on the mixer ----
  drawMixer(mixer) {
    const box = document.createElement('div'); box.className = 'tt-cut';
    box.innerHTML = `<div class="tt-cut-pads"><button data-tt-cut="A" aria-label="Cut to table A">◀ A <kbd>[</kbd></button><button data-tt-cut="B" aria-label="Cut to table B">B ▶ <kbd>]</kbd></button></div>
      <button class="tt-flick" data-tt-flick aria-label="Flick to the other table while held">FLICK <kbd>F</kbd></button>
      <label class="tt-lag">LAG <select data-tt-lag aria-label="Lag length"><option value=".5">½ beat</option><option value="1">1 beat</option><option value="2">2 beats</option><option value="4">1 bar</option></select></label>
      <button data-tt-lag-go aria-label="Start the off-air table behind the live one">LAG OFF-AIR <kbd>G</kbd></button>`;
    mixer.append(box);
    const lag = box.querySelector('[data-tt-lag]'); lag.value = String(this.lag);
    lag.onchange = () => { this.lag = +lag.value; this.save(); };
    box.querySelectorAll('[data-tt-cut]').forEach(b => b.onclick = () => this.room.cutTo(b.dataset.ttCut));
    box.querySelector('[data-tt-lag-go]').onclick = () => this.room.run(() => this.room.lagBehind());
    const flick = box.querySelector('[data-tt-flick]');
    flick.onpointerdown = e => { e.preventDefault(); flick.setPointerCapture(e.pointerId); this.room.flickDown(); };
    flick.onpointerup = flick.onpointercancel = flick.onlostpointercapture = () => this.room.flickUp();
  }

  // ---- Scrolling waveforms ----
  drawWaves(room) {
    const box = document.createElement('section'); box.className = 'tt-waves'; box.setAttribute('aria-label', 'Table waveforms');
    box.innerHTML = `<canvas data-tt-canvas aria-label="Scrolling waveforms for table A (top) and table B (bottom). Click to jump."></canvas>
      <div class="tt-wave-bar"><span data-tt-lagread>Load a record.</span><span class="tt-zoom"><button data-tt-zoom="1" aria-label="Zoom out">−</button><button data-tt-zoom="-1" aria-label="Zoom in">+</button></span></div>`;
    (room.querySelector('.dj-console') || room.lastElementChild).before(box);
    box.querySelectorAll('[data-tt-zoom]').forEach(b => b.onclick = () => { this.zoom = this.clamp(this.zoom * (+b.dataset.ttZoom > 0 ? 1.5 : 1 / 1.5), .75, 12); this.save(); });
    const canvas = box.querySelector('canvas');
    canvas.onclick = e => {
      const r = canvas.getBoundingClientRect(), w = e.clientY - r.top < r.height / 2 ? 'A' : 'B', d = this.app.deckStore(w);
      if (!d.buffer) return;
      const half = this.zoom * this.room.baseRate(w), t = this.app.deckPosition(w) + ((e.clientX - r.left) / r.width * 2 - 1) * half;
      this.room.seek(w, t);
    };
  }
  // 100 columns per second of record: peak level and brightness (zero-crossing rate) for the colour.
  wave(buffer) {
    let v = this.waves.get(buffer);
    if (v) return v;
    const data = buffer.getChannelData(0), step = Math.round(buffer.sampleRate / 100), n = Math.ceil(data.length / step);
    const peak = new Float32Array(n), tone = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let max = 0, zc = 0, prev = data[i * step] || 0;
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j++) { const x = data[j]; if (x > max) max = x; else if (-x > max) max = -x; if ((x >= 0) !== (prev >= 0)) zc++; prev = x; }
      peak[i] = max; tone[i] = Math.min(1, Math.sqrt(zc / step / .22));
    }
    v = { peak, tone, n }; this.waves.set(buffer, v); return v;
  }
  frame() {
    this.raf = null;
    const a = this.app, canvas = document.querySelector('.tt-waves canvas');
    if (a.state.tab !== 'screw' || !canvas || canvas.closest('.dj-scroll')?.dataset.mode === 'stems') return;
    const dpr = window.devicePixelRatio || 1, W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) { this.raf = requestAnimationFrame(() => this.frame()); return; }
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d'), gap = 4 * dpr, lane = (H - gap) / 2;
    ctx.fillStyle = '#0c0913'; ctx.fillRect(0, 0, W, H);
    this.lane(ctx, 'A', 0, lane, W, dpr); this.lane(ctx, 'B', lane + gap, lane, W, dpr);
    this.lagRead();
    this.raf = requestAnimationFrame(() => this.frame());
  }
  lane(ctx, w, y, h, W, dpr) {
    const a = this.app, d = a.deckStore(w), S = a.state['deck' + w], live = this.onAir() === w, mid = y + h / 2;
    ctx.fillStyle = live ? '#1b1228' : '#120d1b'; ctx.fillRect(0, y, W, h);
    ctx.font = `800 ${11 * dpr}px system-ui, sans-serif`; ctx.textBaseline = 'top';
    if (!d.buffer) { ctx.fillStyle = '#7f6f93'; ctx.fillText(`TABLE ${w} · no record`, 10 * dpr, y + 8 * dpr); return; }
    const v = this.wave(d.buffer), pos = a.deckPosition(w), half = this.zoom * this.room.baseRate(w), perPx = 2 * half / W;
    for (let x = 0; x < W; x++) {
      const t0 = pos - half + x * perPx, i0 = Math.floor(t0 * 100), i1 = Math.max(i0 + 1, Math.floor((t0 + perPx) * 100));
      if (i1 <= 0 || i0 >= v.n) continue;
      let p = 0, c = 0, k = 0;
      for (let i = Math.max(0, i0); i < Math.min(v.n, i1); i++) { if (v.peak[i] > p) p = v.peak[i]; c += v.tone[i]; k++; }
      const bh = Math.max(1, p * (h - 18 * dpr));
      ctx.fillStyle = `hsla(${Math.round(355 + (c / k) * 215) % 360},85%,${55 + (c / k) * 12}%,${x < W / 2 ? .5 : .95})`;
      ctx.fillRect(x, mid - bh / 2, 1, bh);
    }
    const sx = t => W / 2 + (t - pos) / perPx;
    if (d.bpm) {
      const beat = 60 / d.bpm, first = d.firstBeat || 0;
      if (beat / perPx > 5) for (let n = Math.ceil((pos - half - first) / beat); first + n * beat < pos + half; n++) {
        const bar = ((n % 4) + 4) % 4 === 0; ctx.fillStyle = bar ? '#ffffff80' : '#ffffff26';
        ctx.fillRect(Math.round(sx(first + n * beat)), bar ? y : y + h * .2, Math.max(1, dpr), bar ? h : h * .6);
      }
    }
    const shade = (from, to, color) => { if (from == null || to == null) return; const x1 = sx(from), x2 = sx(to); if (x2 < 0 || x1 > W) return; ctx.fillStyle = color; ctx.fillRect(x1, y, x2 - x1, h); };
    shade(d.loopStart, d.loopEnd, '#8b5cf640');
    if (this.room.hook && this.room.same(w)) shade(this.room.hook.start, this.room.hook.end, '#f5c54226');
    ctx.fillStyle = '#fff'; ctx.fillRect(W / 2 - dpr, y, 2 * dpr, h);
    const rate = d.rate ?? S.rate ?? 1, slow = this.room.slowing[w];
    ctx.fillStyle = live ? '#e2c6ff' : '#9c8bb3';
    ctx.fillText(`${w}${live ? ' · ON AIR' : ''}${slow ? (slow.mode === 'stop' ? ' · WINDING DOWN' : ' · DRAG') : ''}`, 10 * dpr, y + 6 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText(`${d.bpm ? (d.bpm * rate).toFixed(1) + ' BPM · ' : ''}${rate.toFixed(3)}× · -${a.fmtClock(d.buffer.duration - pos)}`, W - 10 * dpr, y + 6 * dpr);
    ctx.textAlign = 'left';
  }
  // How far apart the two copies are, in beats: the number Screw lines up by ear.
  lagRead() {
    const el = document.querySelector('[data-tt-lagread]'), a = this.app, A = a.deckStore('A'), B = a.deckStore('B');
    if (!el) return;
    let text = 'Click a waveform to jump. − / + zoom.';
    if (A.buffer && B.buffer && this.room.same('A') && A.bpm) {
      const beats = (a.deckPosition('A') - a.deckPosition('B')) / (60 / A.bpm), n = Math.abs(beats);
      text = n < .03 ? 'A and B are in sync.' : `${beats > 0 ? 'B' : 'A'} is ${n.toFixed(2)} beat${n >= .995 && n < 1.005 ? '' : 's'} behind ${beats > 0 ? 'A' : 'B'}.`;
    }
    if (el.textContent !== text) el.textContent = text;
  }
  dispose() { cancelAnimationFrame(this.raf); this.raf = null; }
};
