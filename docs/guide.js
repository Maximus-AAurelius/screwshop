/* ScrewShop walkthroughs. A step card follows you through a real workflow: it lights up the
   control to use, explains it, notices when you've done it and moves on. SHOW ME does the step
   for you with an on-screen cursor; AUTO-PLAY runs the whole thing like a demo. Progress is
   remembered on this device. Tours live in guide-tours.js; this file is the engine. */
(() => {
  const SR = 44100;

  // ---- Demo audio, so SHOW ME works even with an empty library ----
  function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
  function demoSong({ bpm = 90, seconds = 48, root = 55, seed = 7 } = {}) {
    const n = Math.round(SR * seconds), out = new Float32Array(n), beat = 60 / bpm, noise = rng(seed);
    const scale = [1, 1.2, 1.335, 1.5, 1.782], bassLine = [0, 0, 3, 2], lead = [4, 3, 2, 3, 1, 2, 0, 1];
    let hp = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR, b = t / beat, k = Math.floor(b), ph = (b - k) * beat, bar = Math.floor(k / 4), inBar = k % 4;
      let v = 0;
      const kf = 45 + 80 * Math.exp(-ph * 30); v += .9 * Math.sin(2 * Math.PI * kf * ph) * Math.exp(-ph * 9) * (inBar === 0 || inBar === 2 || (inBar === 3 && (b % 1) > .5) ? 1 : 0);
      const wn = noise(); if (inBar === 1 || inBar === 3) v += (.38 * wn + .3 * Math.sin(2 * Math.PI * 190 * ph)) * Math.exp(-ph * 20);
      hp = .7 * (hp + wn - prev); prev = wn; const half = (b * 2) % 1 * beat / 2; v += .16 * hp * Math.exp(-half * 70);
      const bf = root * scale[bassLine[bar % 4]]; v += .35 * Math.sin(2 * Math.PI * bf * t) * Math.min(1, ph * 40) * Math.exp(-ph * 1.8);
      // a sung-sounding line on beats 1-2 of every bar: something worth running back
      if (inBar < 2) { const lf = root * 4 * scale[lead[(bar * 2 + inBar) % 8]] * (1 + .006 * Math.sin(2 * Math.PI * 5.5 * t)), env = Math.min(1, ph * 12) * Math.exp(-ph * 1.2);
        v += .22 * env * (Math.sin(2 * Math.PI * lf * t) + .5 * Math.sin(4 * Math.PI * lf * t) + .3 * Math.sin(6 * Math.PI * lf * t)); }
      out[i] = v;
    }
    let peak = 0; for (const x of out) peak = Math.max(peak, Math.abs(x)); for (let i = 0; i < n; i++) out[i] *= .8 / peak;
    return out;
  }
  function drumHit(kind, seed = 3) {
    const len = Math.round(SR * ({ kick: .5, snare: .35, hat: .12, clap: .3 }[kind] || .3)), out = new Float32Array(len), noise = rng(seed);
    let hp = 0, prev = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR, wn = noise(); hp = .7 * (hp + wn - prev); prev = wn;
      out[i] = kind === 'kick' ? Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 8)
        : kind === 'snare' ? (.6 * wn + .4 * Math.sin(2 * Math.PI * 185 * t)) * Math.exp(-t * 18)
        : kind === 'hat' ? .7 * hp * Math.exp(-t * 45)
        : .7 * wn * (Math.exp(-t * 30) + .6 * Math.exp(-Math.max(0, t - .012) * 30) * (t > .012) + .4 * Math.exp(-Math.max(0, t - .024) * 18) * (t > .024));
    }
    return out;
  }
  function wavFile(name, data) {
    const view = new DataView(new ArrayBuffer(44 + data.length * 2)), str = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, SR, true); view.setUint32(28, SR * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) { const x = Math.max(-1, Math.min(1, data[i])); view.setInt16(44 + i * 2, x * (x < 0 ? 32768 : 32767), true); }
    return new File([view], name, { type: 'audio/wav' });
  }

  class GuideStopped extends Error { constructor() { super('Stopped'); } }
  window.ScrewGuide = class {
    constructor(app) {
      this.app = app; this.tours = window.ScrewGuideTours || {}; this.tour = null; this.counts = {};
      try { this.progress = JSON.parse(localStorage.getItem('screwshop.guides.v1')) || {}; } catch (e) { this.progress = {}; }
      this.timer = setInterval(() => this.tick(), 250);
      this.onKey = e => { if (e.key !== 'Escape' || !this.tour || /INPUT|TEXTAREA/.test(e.target.tagName)) return; if (this.busy || this.auto) { this.auto = false; this.halt(); this.draw(); } else this.stop(); };
      document.addEventListener('keydown', this.onKey);
    }
    save() { try { localStorage.setItem('screwshop.guides.v1', JSON.stringify(this.progress)); } catch (e) {} }
    // ---- helpers the tours use ----
    q(sel) { return document.querySelector(sel); }
    get room() { return this.app.screwRoom; }
    get ws() { return this.app.workspace; }
    // Every SHOW ME action waits through sleep(), so STOP (or closing the card) ends it at the next pause.
    sleep(ms) { const run = this.run; return new Promise((resolve, reject) => setTimeout(() => (run && run !== this.run) ? reject(new GuideStopped()) : resolve(), ms)); }
    halt() { this.run = null; this.busy = false; if (this.cursor) { this.cursor.hidden = true; this.cursor.classList.remove('down', 'hold'); } }
    bump(k) { this.counts[k] = (this.counts[k] || 0) + 1; }
    count(k) { return (this.room?.stats[k] || 0) + (this.counts[k] || 0); }
    since(k) { return this.count(k) - (this.base[k] || 0); }
    tabButton(label) { return [...document.querySelectorAll('.studio-tabs button, [role=tablist] button')].find(b => b.textContent.trim().toUpperCase().startsWith(label)); }
    async goTab(label, tab) { if (this.app.state.tab === tab) return; const b = this.tabButton(label); await this.click(b || null); if (!b) this.app.setState({ tab }); await this.sleep(400); }
    demoSong(n = 1) { return n === 1 ? wavFile('ScrewShop demo record (90 BPM).wav', demoSong()) : wavFile('ScrewShop demo record 2 (80 BPM).wav', demoSong({ bpm: 80, root: 49, seed: 11 })); }
    drumFile(kind) { return wavFile(`Demo ${kind}.wav`, drumHit(kind)); }
    library() { return (this.app.state.library || []).filter(x => x.url); }
    async addToLibrary(file, name) {
      const a = this.app, path = 'local/library/' + window.ScrewShop.id() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const up = await a.sb.storage.from('beats').upload(path, file); if (up.error) throw Error(up.error.message);
      const { data, error } = await a.sb.from('library').insert({ user_id: a.state.session?.user?.id || 'local', name, storage_path: path, bucket: 'beats', source_kind: 'imported' }).select().single();
      if (error) throw Error(error.message);
      await a.loadLibrary(); return this.library().find(x => x.id === data.id) || { ...data, url: a.studio.url('beats', path) };
    }
    async fileFor(item) { const r = await fetch(item.url); if (!r.ok) throw Error('Could not read ' + item.name); return new File([await r.blob()], item.name + '.' + (item.storage_path?.split('.').pop() || 'wav')); }
    set(el, value) { if (!el) return; el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }

    // ---- on-screen cursor ----
    async cursorTo(el) {
      if (!el) return;
      this.reveal(el);
      const r = el.getBoundingClientRect(), c = this.cursor;
      c.hidden = false; c.style.left = (r.left + Math.min(r.width / 2, 60)) + 'px'; c.style.top = (r.top + Math.min(r.height / 2, 30)) + 'px';
      await this.sleep(520);
    }
    // Bring a control into view only if part of it is hidden, with the smallest jump possible.
    reveal(el) {
      const r = el?.getBoundingClientRect(); if (!r || !r.width) return;
      let box = el.parentElement;
      while (box && box !== document.body) { const st = getComputedStyle(box); if (/(auto|scroll)/.test(st.overflowY) && box.scrollHeight > box.clientHeight) break; box = box.parentElement; }
      const view = box && box !== document.body ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      if (r.top < view.top || r.bottom > view.bottom) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    async click(el) { if (typeof el === 'string') el = this.q(el); if (!el) return; await this.cursorTo(el); this.cursor.classList.add('down'); await this.sleep(140); el.click(); this.cursor.classList.remove('down'); await this.sleep(250); }
    async hold(el, ms, down, up) { await this.cursorTo(el); this.cursor.classList.add('down', 'hold'); try { await down(); await this.sleep(ms); } finally { await up(); this.cursor.classList.remove('down', 'hold'); } await this.sleep(200); }

    // ---- running a tour ----
    start(id, auto = false) {
      const tour = this.tours[id]; if (!tour) return;
      this.stop(true); this.tour = tour; this.data = {}; this.auto = false;
      const saved = this.progress[id] || {}; this.doneIds = new Set(saved.done || []);
      this.mount(); this.go(Math.min(saved.at || 0, tour.steps.length - 1));
      if (auto) this.autoplay();
    }
    stop(silent) {
      if (!this.tour) return;
      this.auto = false; this.halt(); this.tour = null;
      this.card?.remove(); this.ring?.remove(); this.cursor?.remove(); this.card = this.ring = this.cursor = null;
      if (!silent) this.app.setState({ notice: 'Walkthrough closed. Start it again any time from the WALK ME THROUGH button; your progress is kept.' });
    }
    get step() { return this.tour?.steps[this.index]; }
    go(i) {
      const t = this.tour; this.index = Math.max(0, Math.min(t.steps.length - 1, i));
      this.base = { ...(this.room?.stats || {}) }; for (const k in this.counts) this.base[k] = (this.base[k] || 0) + this.counts[k];
      if (this.busy) this.halt();
      this.stepDone = false; this.busy = false; this.advancing = false; this.revealed = false; this.placed = false;
      this.progress[t.id] = { done: [...this.doneIds], at: this.index }; this.save();
      this.step.enter?.(this); this.draw();
      if (this.ring) { this.ring.style.animation = 'none'; void this.ring.offsetWidth; this.ring.style.animation = ''; }   // pulse once for the new target
    }
    finishStep() {
      const s = this.step; if (!s) return;
      this.doneIds.add(s.id); this.progress[this.tour.id] = { done: [...this.doneIds], at: this.index }; this.save();
    }
    next() {
      this.finishStep();
      if (this.index >= this.tour.steps.length - 1) { const name = this.tour.title; this.progress[this.tour.id] = { done: [...this.doneIds], at: 0, finished: true }; this.save(); this.stop(true); this.app.setState({ notice: `Walkthrough finished: ${name}. Run it again any time, or AUTO-PLAY it to watch the whole thing.` }); return; }
      this.go(this.index + 1);
    }
    async showMe() {
      const s = this.step; if (!s?.show) return;
      if (this.busy) { this.halt(); this.draw(); return; }   // the same button is STOP while it runs
      const run = this.run = {}; this.busy = true; this.draw();
      try { await s.show(this); } catch (e) { if (!(e instanceof GuideStopped) && this.run === run) this.note = 'Could not do that step automatically: ' + e.message; }
      finally { if (this.run === run) { this.run = null; this.busy = false; if (this.cursor) this.cursor.hidden = true; } this.draw(); }
    }
    async autoplay() {
      if (this.auto) { this.auto = false; this.halt(); this.draw(); return; }
      this.auto = true; this.draw();
      while (this.auto && this.tour) {
        const s = this.step, i = this.index;
        if (!(s.done?.(this))) await this.showMe();
        const until = Date.now() + (s.waitMax || 9000);
        while (this.auto && this.tour && this.index === i && s.done && !s.done(this) && Date.now() < until) await new Promise(r => setTimeout(r, 250));
        if (!this.auto || !this.tour || this.index !== i) continue;
        await new Promise(r => setTimeout(r, s.read || 1600));
        if (!this.auto || !this.tour || this.index !== i) continue;
        if (i === this.tour.steps.length - 1) { this.auto = false; this.next(); break; }
        this.next();
      }
    }

    // Count pad hits and beat saves so sampler steps can follow along.
    hook() {
      const ws = this.ws; if (!ws?.press || ws.guideHooked) return; ws.guideHooked = true;
      const guide = this, press = ws.press, saveNamed = ws.saveNamed;
      ws.press = function (...a) { guide.bump('press'); return press.apply(this, a); };
      ws.saveNamed = async function (kind, ...a) {
        const message = this.message; let saved = false;
        this.message = function (text, ...rest) { if (/^Saved beat/.test(text)) saved = true; return message.call(this, text, ...rest); };
        try { return await saveNamed.call(this, kind, ...a); } finally { this.message = message; if (saved) guide.bump('saveBeat'); }
      };
    }
    // ---- UI ----
    mount() {
      this.card = document.createElement('aside'); this.card.className = 'sg-card'; this.card.setAttribute('role', 'dialog'); this.card.setAttribute('aria-label', 'Walkthrough');
      this.ring = document.createElement('div'); this.ring.className = 'sg-ring'; this.ring.hidden = true;
      this.cursor = document.createElement('div'); this.cursor.className = 'sg-cursor'; this.cursor.hidden = true; this.cursor.setAttribute('aria-hidden', 'true');
      document.body.append(this.ring, this.cursor, this.card);
      this.card.onclick = e => {
        const b = e.target.closest('[data-sg]'); if (!b) return;
        const act = b.dataset.sg;
        if (act === 'exit') return this.stop();
        if (act === 'min') { this.card.classList.toggle('min'); return; }
        if (act === 'back') return this.go(this.index - 1);
        if (act === 'next') return this.next();
        if (act === 'show') return this.showMe();
        if (act === 'auto') return this.autoplay();
        if (act === 'jump') return this.go(+b.dataset.i);
        if (act === 'restart') { this.doneIds.clear(); return this.go(0); }
      };
    }
    draw() {
      const t = this.tour, s = this.step; if (!t || !this.card) return;
      const done = this.stepDone || (s.done ? false : null), list = t.steps.map((x, i) => `<li class="${this.doneIds.has(x.id) ? 'ok' : ''} ${i === this.index ? 'now' : ''}"><button data-sg="jump" data-i="${i}">${i + 1}. ${x.title}</button></li>`).join('');
      const state = this.busy ? 'Doing it for you… press ■ STOP or Esc to take over.' : this.stepDone ? '✓ Done. Nice.' : s.done ? (s.waiting?.(this) || 'Your turn: do it on the screen, or press SHOW ME.') : 'Read this, then NEXT.';
      this.card.innerHTML = `<header><span>WALKTHROUGH · ${t.title}</span><button data-sg="min" aria-label="Minimise walkthrough">–</button><button data-sg="exit" aria-label="Close walkthrough">✕</button></header>
        <div class="sg-progress" aria-hidden="true"><i style="width:${(this.index + (this.stepDone ? 1 : 0)) / t.steps.length * 100}%"></i></div>
        <div class="sg-body"><b class="sg-count">STEP ${this.index + 1} OF ${t.steps.length}</b><h4>${s.title}</h4><p>${s.text}</p>${s.tip ? `<p class="sg-tip">${s.tip}</p>` : ''}
        <p class="sg-state ${this.stepDone ? 'ok' : ''}" role="status">${state}</p>${this.note ? `<p class="sg-note">${this.note}</p>` : ''}</div>
        <div class="sg-actions"><button data-sg="back" ${this.index ? '' : 'disabled'}>BACK</button>${s.show ? `<button data-sg="show" class="sg-show ${this.busy ? 'sg-stop' : ''}">${this.busy ? '■ STOP' : 'SHOW ME'}</button>` : ''}<button data-sg="next" class="${done === false ? '' : 'sg-go'}">${this.index === t.steps.length - 1 ? 'FINISH' : done === false ? 'SKIP' : 'NEXT'}</button></div>
        <div class="sg-foot"><button data-sg="auto" class="sg-auto">${this.auto ? '❚❚ PAUSE AUTO-PLAY' : '▶ AUTO-PLAY ALL'}</button><details><summary>All steps (${this.doneIds.size}/${t.steps.length} done)</summary><ol>${list}</ol><button data-sg="restart">Start over</button></details></div>`;
      this.note = '';
    }
    tick() {
      this.hook();
      if (!this.tour || !this.card) return;
      const s = this.step;
      // A modal dialog (pack picker, chop editor) blocks everything outside it, so the card goes inside.
      const layer = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
      if (this.card.parentElement !== layer) layer.append(this.ring, this.cursor, this.card);
      if (s.tab && this.app.state.tab !== s.tab && !this.busy) this.target = this.tabButton(s.tabLabel); else this.target = typeof s.target === 'function' ? s.target(this) : this.q(s.target || '');
      const el = this.target;
      if (el && !this.revealed && !this.busy) { this.revealed = true; this.reveal(el); }
      const r = el?.getBoundingClientRect(), clip = el?.closest('.screw-box')?.getBoundingClientRect();
      const visible = r && r.width && (!clip || (r.bottom > clip.top + 4 && r.top < clip.bottom - 4));
      if (visible) {
        const left = Math.round(r.left - 6) + 'px', top = Math.round(r.top - 6) + 'px', width = Math.round(r.width + 12) + 'px', height = Math.round(r.height + 12) + 'px', st = this.ring.style;
        if (st.left !== left || st.top !== top || st.width !== width || st.height !== height) Object.assign(st, { left, top, width, height });
        this.ring.hidden = false;
      } else this.ring.hidden = true;
      // Keep the card out of the way of what it points at. Decided once per step so it never flips back and forth.
      if (visible && !this.placed) { this.placed = true; this.card.classList.toggle('top', r.top + r.height / 2 > window.innerHeight * .55); }
      if (!this.stepDone && s.done && !this.advancing) {
        let ok = false; try { ok = !!s.done(this); } catch (e) {}
        if (ok) { this.stepDone = true; this.finishStep(); this.draw(); if (!this.auto && s.autoNext !== false) { this.advancing = true; const i = this.index; setTimeout(() => { if (this.tour && this.index === i) this.next(); }, 1300); } }
      }
      if (!this.stepDone && s.waiting && !this.busy) { const p = this.card.querySelector('.sg-state'), w = s.waiting(this); if (p && w && p.textContent !== w) p.textContent = w; }
    }

    // ---- launch buttons inside the tabs ----
    launcher(host, ids, where) {
      if (!host || host.querySelector(':scope > .sg-launch')) return;
      const box = document.createElement('div'); box.className = 'sg-launch'; box.dataset.tab = this.app.state.tab;
      box.innerHTML = `<div><b>NEW TO THIS? FOLLOW ALONG.</b><span>Each walkthrough lights up what to touch, waits for you, and can do any step for you.</span></div>` +
        ids.map(id => { const t = this.tours[id], p = this.progress[id]; return `<span class="sg-launch-row"><button data-sg-start="${id}" class="sg-launch-go">▶ ${t.button}</button><button data-sg-auto="${id}" aria-label="Auto-play ${t.title}">AUTO-PLAY</button>${p?.finished ? '<em>✓ done</em>' : p?.done?.length ? `<em>${p.done.length}/${t.steps.length}</em>` : ''}</span>`; }).join('');
      box.onclick = e => { const b = e.target.closest('[data-sg-start],[data-sg-auto]'); if (!b) return; this.start(b.dataset.sgStart || b.dataset.sgAuto, !!b.dataset.sgAuto); };
      where(box);
    }
    mountLaunchers() {
      const tab = this.app.state.tab;
      document.querySelectorAll('.sg-launch').forEach(el => { if (el.dataset.tab !== tab) el.remove(); });
      if (tab === 'screw') { const room = this.q('.dj-scroll'), nav = room?.querySelector('.screw-modes'); if (room && nav) this.launcher(room, ['screw-mix'], box => nav.after(box)); }
      if (tab === 'packs') { const host = this.q('#ss-sampler'); if (host) this.launcher(host.parentElement, ['split-beat', 'sequencer-beat'], box => host.before(box)); }
    }
    dispose() { clearInterval(this.timer); document.removeEventListener('keydown', this.onKey); this.stop(true); }
  };
  // Launchers are added from the same tick so they reappear after React re-renders a tab.
  const base = window.ScrewGuide.prototype.tick;
  window.ScrewGuide.prototype.tick = function () { try { this.mountLaunchers(); } catch (e) {} return base.call(this); };
})();
