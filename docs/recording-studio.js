/* ScrewShop STUDIO — a GarageBand-style multitrack session on one Web Audio clock.
   Tracks hold clips. A clip plays its audio from `start` (session seconds) for
   `length` seconds, beginning at `sourceOffset` in the audio file; a length longer than the audio repeats it (a loop).
   The arrange area (ruler, track headers, lanes, clips) is drawn straight into
   #gb-arrange by this file, so dragging stays smooth and never re-renders the app. */
window.RecordingStudio = class RecordingStudio {
  constructor(app) {
    this.app = app; this.tracks = []; this.buffers = new Map(); this.voices = []; this.cursor = 0;
    this.playing = false; this.busy = false; this.ready = false; this.rate = 1;
    this.bpm = 82; this.cycle = { on: false, start: 0, end: 0 }; this.metronome = false; this.countIn = true;
    this.zoom = 26; // pixels per beat
    this.follow = false; // the view stays where you put it while playing; FOLLOW turns page-turning back on
    this.selected = null; this.drag = null; this.dirty = true;
    this.clipboard = null; this.trackMenu = null; this.splitPoint = null; this.undoStack = []; this.redoStack = [];
    this.timer = setInterval(() => this.tick(), 50);
    this.onPointerDown = (e) => this.pointerDown(e);
    this.onKey = (e) => this.key(e);
    this.onDragStart = (e) => this.loopDragStart(e);
    this.onMenuClick = (e) => { if (this.trackMenu && !this.trackMenu.contains(e.target)) this.hideTrackMenu(); };
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('dragstart', this.onDragStart);
    document.addEventListener('click', this.onMenuClick);
    this.onResize = () => { this.dirty = true; };
    window.addEventListener('resize', this.onResize);
  }

  // ---------- plumbing ----------
  notify(message) { this.app.setState({ notice: message }); }
  refresh() { this.dirty = true; this.app.setState(p => ({ studioRevision: (p.studioRevision || 0) + 1 })); }
  context() {
    if (!this.ctx) { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination); }
    return this.ctx;
  }
  async checked(query) { const result = await query; if (result.error) throw new Error(result.error.message); return result.data; }
  url(bucket, path) { return '/audio/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/'); }
  newId() { return window.ScrewShop?.id ? window.ScrewShop.id() : Math.random().toString(36).slice(2); }
  beat() { return 60 / this.bpm; }
  bar() { return this.beat() * 4; }
  pps() { return this.zoom / this.beat(); } // pixels per session second
  snap(sec, free) { if (free) return Math.max(0, sec); const b = this.beat(); return Math.max(0, Math.round(sec / b) * b); }
  snapBar(sec) { const b = this.bar(); return Math.max(0, Math.round(sec / b) * b); }
  snapCycle(sec, free) {
    if (free) return Math.max(0, sec);
    const step = Math.min(this.beat() / 48, 1 / this.pps()); // effectively free: the loop goes exactly where you drag, at any zoom
    return Math.max(0, Math.round(sec / step) * step);
  }
  allClips() { return this.tracks.flatMap(t => t.clips.map(c => ({ track: t, clip: c }))); }
  findClip(id) { return this.allClips().find(x => x.clip.id === id); }
  clipLen(c) { return c.length != null ? c.length : (this.buffers.get(c.url)?.duration || c.dur || 0); }
  audioLen(c) { return this.buffers.get(c.url)?.duration || c.dur || 0; }

  // Old sessions stored one audio file per track with an `offset`. Turn each into a one-clip track.
  normalize(t) {
    if (Array.isArray(t.clips)) return { volume: 0.8, ...t, clips: t.clips.map(c => ({ id: c.id || this.newId(), ...c })) };
    const clips = t.url ? [{ id: t.id + '-clip', name: t.name, url: t.url, start: +t.offset || 0, length: null, dur: t.duration }] : [];
    return { id: t.id, name: t.name, volume: t.volume ?? 0.8, muted: !!t.muted, solo: !!t.solo, clips };
  }

  async load() {
    try {
      const saved = await this.checked(this.app.sb.from('settings').select('*').eq('id', 'recording-session').maybeSingle());
      if (saved && Array.isArray(saved.tracks)) {
        this.tracks = saved.tracks.map(t => this.normalize(t));
        if (saved.bpm) this.bpm = +saved.bpm;
        if (saved.cycle) this.cycle = { ...this.cycle, ...saved.cycle };
        if (saved.metronome != null) this.metronome = !!saved.metronome;
        if (saved.countIn != null) this.countIn = !!saved.countIn;
        if (saved.zoom) this.zoom = +saved.zoom;
        if (saved.follow != null) this.follow = !!saved.follow;
      } else {
        const beats = await this.checked(this.app.sb.from('beats').select('*').eq('song_id', this.app.SONG_UUID).order('created_at', { ascending: false }));
        if (beats?.[0]?.storage_path) this.tracks.push(this.normalize({ id: 'beat', name: beats[0].label || 'Beat', url: this.url('beats', beats[0].storage_path), offset: 0, volume: 0.8 }));
        const takes = await this.checked(this.app.sb.from('takes').select('*').eq('song_id', this.app.SONG_UUID).order('created_at'));
        for (const take of takes || []) this.tracks.push(this.normalize({ id: take.id, name: take.label || 'Vocal take', url: this.url('takes', take.storage_path), offset: take.offset_secs || 0, volume: 0.8 }));
        if (this.app.state?.sourceBpm) this.bpm = this.app.state.sourceBpm;
      }
      this.ready = true; this.refresh();
      await Promise.all(this.allClips().map(({ clip }) => this.decode(clip).catch(e => { clip.loadError = e.message; })));
      this.refresh();
    } catch (e) { this.notify('Could not load recording session: ' + e.message); }
  }

  save() {
    const tracks = this.tracks.map(t => ({ ...t, clips: t.clips.map(({ loadError, ...c }) => c) }));
    const body = { id: 'recording-session', version: 3, tracks, bpm: this.bpm, cycle: this.cycle, metronome: this.metronome, countIn: this.countIn, zoom: this.zoom, follow: this.follow };
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => this.checked(this.app.sb.from('settings').upsert(body))).catch(e => { this.notify('Session not saved: ' + e.message); throw e; });
    this.saving.catch(() => {});
    return this.saving;
  }

  async decode(clipOrTrack) {
    const url = clipOrTrack.url;
    if (!url) return null;
    if (this.buffers.has(url)) { clipOrTrack.dur = this.buffers.get(url).duration; return this.buffers.get(url); }
    const response = await fetch(url); if (!response.ok) throw new Error('Audio file unavailable');
    const buffer = await this.context().decodeAudioData(await response.arrayBuffer());
    this.buffers.set(url, buffer); clipOrTrack.dur = buffer.duration; delete clipOrTrack.loadError; return buffer;
  }

  contentEnd() { return Math.max(0, ...this.allClips().map(({ clip }) => (+clip.start || 0) + this.clipLen(clip))); }
  duration() { return Math.max(this.bar() * 8, this.contentEnd(), this.recording ? this.position() + 2 : 0); }

  // ---------- playback ----------
  cyclePlan(recording) {
    const c = this.cycle;
    if (recording || !c.on || c.end - c.start < this.beat() - 1e-6 || this.cursor >= c.end) return null;
    return { start: c.start, end: c.end };
  }
  position() {
    if (!this.playing) return this.cursor;
    const el = Math.max(0, this.context().currentTime - this.t0) * this.rate;
    const plan = this.plan;
    if (!plan) return this.p0 + el;
    const first = plan.end - this.p0;
    if (el < first) return this.p0 + el;
    const len = plan.end - plan.start;
    return plan.start + ((el - first) % len);
  }
  // Remember a scheduled sound so STOP can silence it; forget it once it finishes.
  track(source) { const v = { source }; this.voices.push(v); source.onended = () => { const i = this.voices.indexOf(v); if (i >= 0) this.voices.splice(i, 1); }; }
  level(track) { return track.muted || (this.tracks.some(t => t.solo) && !track.solo) ? 0 : (track.volume ?? 0.8); }
  click(at, accent) {
    const ctx = this.context(), osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175; g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(accent ? 0.45 : 0.28, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    osc.connect(g); g.connect(this.master); osc.start(at); osc.stop(at + 0.07);
    this.track(osc);
  }
  // Play session time [from, to) starting at context time `at`.
  schedulePass(from, to, at) {
    const ctx = this.context();
    for (const track of this.tracks) {
      const gain = this.trackGains.get(track.id); if (!gain) continue;
      for (const clip of track.clips) {
        const buffer = this.buffers.get(clip.url); if (!buffer) continue;
        const D = buffer.duration, L = this.clipLen(clip); if (D <= 0 || L <= 0) continue;
        const segStart = Math.max(from, clip.start), segEnd = Math.min(to, clip.start + L);
        let t = segStart, guard = 0;
        while (t < segEnd - 1e-4 && guard++ < 4000) {
          const local = ((clip.sourceOffset || 0) + t - clip.start) % D, chunk = Math.min(D - local, segEnd - t);
          if (chunk > 1e-4) {
            const source = ctx.createBufferSource(); source.buffer = buffer; source.playbackRate.value = this.rate;
            source.connect(gain); source.start(at + (t - from) / this.rate, local, chunk);
            this.track(source);
          }
          t += Math.max(chunk, 1e-4);
        }
      }
    }
  }
  scheduleClicks(from, to, at) {
    if (!this.metronome) return;
    const b = this.beat();
    for (let k = Math.ceil((from - 1e-6) / b); k * b < to; k++) this.click(at + (k * b - from) / this.rate, k % 4 === 0);
  }
  halt(reset = false) {
    this.cursor = reset ? 0 : this.position(); this.playing = false; this.plan = null;
    for (const voice of this.voices) { try { voice.source.stop(); } catch (_) {} try { voice.source.disconnect(); } catch (_) {} }
    for (const g of this.trackGains?.values() || []) { try { g.disconnect(); } catch (_) {} }
    this.voices = []; this.trackGains = new Map(); this.refresh();
  }
  async play(recording = false) {
    if (this.busy || !this.ready) return;
    this.busy = true;
    try {
      const ctx = this.context(); await ctx.resume();
      await Promise.all(this.allClips().map(({ clip }) => this.decode(clip).catch(e => { clip.loadError = e.message; })));
      if (this.cursor >= this.contentEnd() && !recording && !this.cycle.on) this.cursor = 0;
      this.trackGains = new Map();
      for (const track of this.tracks) { const g = ctx.createGain(); g.gain.value = this.level(track); g.connect(this.master); this.trackGains.set(track.id, g); }
      this.t0 = ctx.currentTime + (recording ? 0 : 0.05); this.p0 = this.cursor; this.plan = this.cyclePlan(recording);
      this.playing = true;
      if (this.plan) {
        this.schedulePass(this.cursor, this.plan.end, this.t0); this.scheduleClicks(this.cursor, this.plan.end, this.t0);
        this.nextPassAt = this.t0 + (this.plan.end - this.cursor) / this.rate;
      } else {
        this.schedulePass(this.cursor, Infinity, this.t0);
        this.clickUntil = this.cursor; this.topUpClicks();
      }
      this.app.setState({ transportSource: 'studio', transportTitle: 'STUDIO · Multitrack session', beatRate: this.rate }); this.refresh();
    } catch (e) { this.halt(); this.notify('Could not play session: ' + e.message); throw e; }
    finally { this.busy = false; }
  }
  // Linear playback: keep about 4 seconds of metronome clicks queued ahead.
  topUpClicks() {
    if (!this.playing || this.plan || !this.metronome) return;
    const ahead = this.position() + 4 * this.rate;
    if (this.clickUntil >= ahead) return;
    const from = this.clickUntil, to = ahead;
    this.scheduleClicks(from, to, this.t0 + (from - this.p0) / this.rate);
    this.clickUntil = to;
  }
  async toggle() {
    if (this.recording) { this.stopRecord(); return; }
    if (this.playing) this.halt(); else { this.app.stopPlayback(); await this.play(); }
  }
  restartIfPlaying(fn) {
    const resume = this.playing && !this.recording; if (resume) this.halt();
    fn();
    if (resume) this.play().catch(() => {});
    this.refresh();
  }
  seek(value) {
    if (this.recording || this.busy) return;
    this.restartIfPlaying(() => { this.cursor = Math.max(0, Math.min(this.duration(), Number(value) || 0)); });
  }
  setRate(value) { if (this.recording) return; this.restartIfPlaying(() => { this.rate = value; }); }

  // ---------- editing ----------
  change(id, patch) {
    const track = this.tracks.find(t => t.id === id); if (!track) return;
    Object.assign(track, patch);
    const ctx = this.ctx;
    if (ctx) for (const t of this.tracks) { const g = this.trackGains?.get(t.id); if (g) g.gain.setTargetAtTime(this.level(t), ctx.currentTime, 0.01); }
    this.save(); this.refresh();
  }
  setBpm(v) {
    v = Math.round(+v); if (!(v >= 30 && v <= 300)) return;
    this.restartIfPlaying(() => { this.bpm = v; }); this.save();
  }
  setCycle(a, z, on = true) { a = Math.max(0, Math.min(a, z)); z = Math.max(a + 0.01, z); this.restartIfPlaying(() => { this.cycle = { on, start: a, end: z }; }); this.save(); }
  toggleCycle() {
    this.restartIfPlaying(() => {
      if (this.cycle.end - this.cycle.start < this.beat()) {
        const s = this.snapBar(this.cursor); this.cycle = { on: true, start: s, end: s + this.bar() * 4 };
      } else this.cycle.on = !this.cycle.on;
    }); this.save();
  }
  hideTrackMenu() {
    if (this.trackMenu) { this.trackMenu.remove(); this.trackMenu = null; }
  }
  showTrackMenu(trackId, clipId, x = 0, y = 0) {
    this.hideTrackMenu();
    const track = this.tracks.find(t => t.id === trackId);
    const found = clipId ? this.findClip(clipId) : null;
    const clip = found?.clip || null;
    const menu = document.createElement('div');
    menu.id = 'gb-track-menu';
    menu.className = 'gb-track-menu';
    const actions = [
      ['Split at playhead', () => this.splitClipAtPlayhead(clipId || found?.clip?.id || this.selected || track?.clips?.[0]?.id)],
      ['Split to new track', () => this.splitClipToNewTrack(clipId || found?.clip?.id || this.selected || track?.clips?.[0]?.id)],
      ['Duplicate', () => this.duplicateClip(clipId || found?.clip?.id || this.selected || track?.clips?.[0]?.id)],
      ['Copy', () => this.copyClip(clipId || found?.clip?.id || this.selected || track?.clips?.[0]?.id)],
      ['Paste', () => this.pasteClip(trackId, this.cursor)],
      [track?.locked ? 'Unlock track' : 'Lock track', () => this.toggleTrackLock(trackId)],
      ['Delete', () => clipId ? this.deleteClip(clipId) : this.deleteTrack(trackId)],
      ['Mute', () => track && this.change(track.id, { muted: !track.muted })],
      ['Solo', () => track && this.change(track.id, { solo: !track.solo })],
    ].filter(([, fn]) => typeof fn === 'function');
    menu.innerHTML = actions.map(([label]) => '<button type="button" data-track-action="' + label + '">' + label + '</button>').join('');
    actions.forEach(([label, fn]) => {
      const btn = Array.from(menu.querySelectorAll('button')).find(b => b.dataset.trackAction === label);
      if (btn) btn.addEventListener('click', () => { fn(); this.hideTrackMenu(); });
    });
    Object.assign(menu.style, { position: 'fixed', left: x + 'px', top: y + 'px', zIndex: '99' });
    document.body.appendChild(menu);
    this.trackMenu = menu;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) + 'px';
  }
  toggleTrackLock(trackId) {
    const track = this.tracks.find(t => t.id === trackId); if (!track) return;
    track.locked = !track.locked; this.save(); this.refresh();
  }
  copyClip(clipId) {
    const found = this.findClip(clipId); if (!found) return;
    this.clipboard = { type: 'clip', clip: { ...found.clip, id: this.newId(), start: found.clip.start }, fromTrack: found.track.id, name: found.clip.name + ' copy' };
    this.notify('Clip copied to the clipboard.');
  }
  pasteClip(targetTrackId, at = this.cursor) {
    if (!this.clipboard || this.clipboard.type !== 'clip') { this.notify('Nothing to paste yet.'); return; }
    const source = this.clipboard.clip; const targetTrack = this.tracks.find(t => t.id === targetTrackId) || this.tracks[0]; if (!this.editable(targetTrack)) return; this.checkpoint();
    const pasted = { ...source, id: this.newId(), start: this.snap(at), name: source.name || 'Clip' };
    this.restartIfPlaying(() => { targetTrack.clips.push(pasted); });
    this.selected = pasted.id; this.save(); this.refresh();
  }
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.tracks));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(redo = false) {
    if (this.recording || this.busy) return;
    const from = redo ? this.redoStack : this.undoStack, to = redo ? this.undoStack : this.redoStack;
    if (!from.length) return;
    to.push(JSON.stringify(this.tracks));
    this.restartIfPlaying(() => { this.tracks = JSON.parse(from.pop()); });
    this.selected = null; this.splitPoint = null; this.hideTrackMenu(); this.save(); this.refresh();
  }
  editable(track) {
    if (this.recording || this.busy) return false;
    if (track?.locked) { this.notify('Unlock this track before editing its regions.'); return false; }
    return !!track;
  }
  prepareSplit(clipId, time) {
    const found = this.findClip(clipId); if (!found || !this.editable(found.track)) return;
    if (this.playing) this.halt();
    this.selected = clipId; this.cursor = time;
    this.splitPoint = { clipId, time }; this.refresh();
  }
  splitClipAtPlayhead(clipId, newTrack = false) {
    const found = this.findClip(clipId); if (!found || !this.editable(found.track)) return;
    const clip = found.clip, time = this.splitPoint?.clipId === clipId ? this.splitPoint.time : this.position();
    const split = time - clip.start, length = this.clipLen(clip);
    if (split < 0.001 || length - split < 0.001) { this.notify('Place the scissors inside the region to split it.'); return; }
    const left = { ...clip, id: this.newId(), length: split };
    const right = { ...clip, id: this.newId(), start: clip.start + split, length: length - split,
      sourceOffset: (clip.sourceOffset || 0) + split };
    this.checkpoint();
    this.restartIfPlaying(() => {
      const index = found.track.clips.indexOf(clip);
      found.track.clips.splice(index, 1, left, ...(newTrack ? [] : [right]));
      if (newTrack) this.tracks.push({ ...found.track, id: this.newId(), name: found.track.name + ' Split', clips: [right] });
    });
    this.selected = right.id; this.splitPoint = null; this.hideTrackMenu(); this.save(); this.refresh();
  }
  splitClipToNewTrack(clipId) { this.splitClipAtPlayhead(clipId, true); }
  toggleMetronome() { this.restartIfPlaying(() => { this.metronome = !this.metronome; }); this.save(); }
  toggleCountIn() { this.countIn = !this.countIn; this.save(); this.refresh(); }
  // Zoom goes down to single samples. The only ceiling is the browser's maximum page width (about 16 million px).
  zoomMax() { const total = Math.max(1, this.duration() + this.bar() * 4); return Math.max(8, this.beat() * Math.min(48000, 16e6 / total)); }
  zoomTo(zoom, clientX) {
    const host = document.getElementById('gb-arrange'); zoom = Math.max(8, Math.min(this.zoomMax(), zoom));
    if (!host) { this.zoom = zoom; this.save(); this.refresh(); return; }
    const oldPps = this.pps(), rect = host.getBoundingClientRect(), view = host.clientWidth - this.headW;
    // Keep one point still: the mouse, else the playhead if it is on screen, else the middle of the view.
    let x = clientX != null ? clientX - rect.left - this.headW : null;
    if (x == null) { const head = this.position() * oldPps - host.scrollLeft; x = head >= 0 && head <= view ? head : view / 2; }
    x = Math.max(0, Math.min(view, x));
    const anchor = (host.scrollLeft + x) / oldPps;
    this.zoom = zoom; this.build(host); host.scrollLeft = Math.max(0, anchor * this.pps() - x);
    clearTimeout(this.zoomSave); this.zoomSave = setTimeout(() => this.save(), 250); this.app.setState(p => ({ studioRevision: (p.studioRevision || 0) + 1 }));
  }
  setZoom(dir) { this.zoomTo(this.zoom * (dir > 0 ? 1.5 : 1 / 1.5)); }
  zoomFit() {
    const host = document.getElementById('gb-arrange'), view = Math.max(200, (host?.clientWidth || 1000) - this.headW - 24);
    this.zoom = Math.max(8, Math.min(this.zoomMax(), view / Math.max(this.contentEnd(), this.bar() * 4) * this.beat()));
    if (host) { this.build(host); host.scrollLeft = 0; } this.save(); this.refresh();
  }
  toggleFollow() { this.follow = !this.follow; this.save(); this.refresh(); this.notify(this.follow ? 'FOLLOW on: the view turns the page to keep the playhead in sight.' : 'FOLLOW off: the view stays where you put it while the song plays.'); }
  trackColor(t, i) {
    if (t.id === 'beat' || /beat|drum|instrumental/i.test(t.name)) return '#66bb78';
    if (/vocal|take|voice/i.test(t.name) || t.clips.some(c => c.url?.includes('/takes/'))) return '#62afe9';
    if (/ad.?lib/i.test(t.name)) return '#e9b457';
    return this.palette(i);
  }
  palette(i) { return ['#62afe9', '#e9b457', '#b98af2', '#63d6b2', '#f27ab0', '#e8d45c', '#8fd16a', '#ff8a7a'][i % 8]; }
  addTrack(name) {
    const n = this.tracks.length + 1;
    const track = { id: this.newId(), name: name || 'Track ' + n, volume: 0.8, muted: false, solo: false, clips: [] };
    this.tracks.push(track); this.save(); this.refresh(); return track;
  }
  deleteTrack(id) {
    if (this.recording) return;
    const t = this.tracks.find(x => x.id === id); if (!t) return;
    if (t.clips.length && !confirm('Remove track "' + t.name + '" and its clips from the session? Your audio files stay in SONGS/takes.')) return;
    this.restartIfPlaying(() => { this.tracks = this.tracks.filter(x => x.id !== id); }); this.save();
  }
  async addClip(trackId, item, start) {
    if (!item?.url) { this.notify('That file has no audio address yet.'); return; }
    const clip = { id: this.newId(), name: item.name || 'Clip', url: item.url, start: this.snap(start ?? this.cursor), length: null };
    try { await this.decode(clip); } catch (e) { this.notify('Could not load ' + clip.name + ': ' + e.message); return; }
    // Chops and word clips carry a trim: bring just that part, not the whole source file.
    if (Number.isFinite(item.end) && item.end > (item.start || 0)) { clip.sourceOffset = Math.max(0, item.start || 0); clip.length = item.end - clip.sourceOffset; }
    let track = this.tracks.find(t => t.id === trackId);
    this.restartIfPlaying(() => {
      if (!track) { track = this.addTrack(item.name); }
      track.clips.push(clip);
    });
    this.selected = clip.id; this.save(); this.refresh();
  }
  moveClip(clipId, trackId, start) {
    const found = this.findClip(clipId); if (!found || !this.editable(found.track)) return; this.checkpoint();
    this.restartIfPlaying(() => {
      found.clip.start = Math.max(0, start);
      let dest = this.tracks.find(t => t.id === trackId);
      if (trackId === '__new') dest = this.addTrack(found.clip.name);
      if (dest && dest !== found.track) { found.track.clips = found.track.clips.filter(c => c !== found.clip); dest.clips.push(found.clip); }
    }); this.save();
  }
  setClipLength(clipId, len) {
    const found = this.findClip(clipId); if (!found || !this.editable(found.track)) return; this.checkpoint();
    this.restartIfPlaying(() => { found.clip.length = Math.max(this.beat() / 4, len); }); this.save();
  }
  deleteClip(clipId) {
    const found = this.findClip(clipId); if (!found || !this.editable(found.track)) return; this.checkpoint();
    this.restartIfPlaying(() => { found.track.clips = found.track.clips.filter(c => c !== found.clip); });
    if (this.selected === clipId) this.selected = null; this.save();
  }
  duplicateClip(clipId) {
    const found = this.findClip(clipId); if (!found || !this.editable(found.track)) return; this.checkpoint();
    const c = found.clip, copy = { ...c, id: this.newId(), start: c.start + this.clipLen(c) };
    this.restartIfPlaying(() => { found.track.clips.push(copy); }); this.selected = copy.id; this.save();
  }
  async setBeat(item) {
    if (this.recording || this.busy) { this.notify('Stop recording or loading before replacing the beat.'); return; }
    try {
      const clip = { id: this.newId(), name: item.name || item.label || 'Instrumental', url: item.url, start: 0, length: null };
      await this.decode(clip); this.app.stopPlayback(); this.halt(true);
      let beat = this.tracks.find(t => t.id === 'beat');
      if (!beat) { beat = { id: 'beat', name: clip.name, volume: 0.8, muted: false, solo: false, clips: [] }; this.tracks.unshift(beat); }
      beat.name = clip.name; beat.clips = [clip];
      await this.save();
      this.app.setState({ tab: 'studio', transportSource: 'studio', transportTitle: 'STUDIO · ' + clip.name }); this.refresh();
    } catch (e) { this.notify('Beat could not be loaded: ' + e.message); }
  }
  async uploadFile(file) {
    const path = 'local/library/' + this.newId() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    await this.checked(this.app.sb.storage.from('beats').upload(path, file));
    const row = await this.checked(this.app.sb.from('library').insert({ user_id: 'local', name: file.name, storage_path: path }).select().single());
    this.app.loadLibrary();
    return { ...row, name: file.name.replace(/\.[^.]+$/, ''), url: this.url('beats', path) };
  }
  // IMPORT AUDIO: the first import becomes the beat on Track 1; later ones get their own track at the playhead.
  importBeat() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/*,.wav,.mp3,.m4a';
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const item = await this.uploadFile(file);
        if (!this.tracks.some(t => t.id === 'beat' && t.clips.length)) await this.setBeat(item);
        else await this.addClip(null, item, this.cursor);
      } catch (e) { this.notify('Import failed: ' + e.message); }
    }; input.click();
  }

  // ---------- recording ----------
  async record(input = 'mic') {
    if (this.recording) { this.stopRecord(); return; }
    if (this.busy || !this.ready || this.pending) return;
    this.busy = true; this.refresh(); let stream;
    try {
      const ctx = this.context(); await ctx.resume();
      stream = input === 'midi' ? this.app.workspace.recordStream() : await navigator.mediaDevices.getUserMedia({ audio: true });
      await Promise.all(this.allClips().map(({ clip }) => this.decode(clip).catch(() => {})));
      const offset = this.position(); this.app.stopPlayback(); this.cursor = offset; this.rate = 1;
      if (this.countIn) { // one bar of clicks before the take starts
        const b = this.beat(), at = ctx.currentTime + 0.05;
        for (let i = 0; i < 4; i++) this.click(at + i * b, i === 0);
        this.app.setState({ notice: 'Count-in… 1 2 3 4' });
        await new Promise(r => setTimeout(r, (0.05 + 4 * b) * 1000));
      }
      const recorder = new MediaRecorder(stream), chunks = [];
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        this.pending = { blob, offset: this.captureOffset, id: this.newId(), name: (input === 'midi' ? 'Oxygen performance ' : 'Vocal ') + (this.tracks.filter(t => t.id !== 'beat').length + 1) };
        this.app.setState({ rec: false, secs: 0 }); this.refresh(); await this.saveRecording();
      };
      this.recorder = recorder; this.recording = true; this.recordStarted = performance.now();
      this.busy = false; await this.play(true);
      // Align the clip with the shared audio clock at the instant capture starts.
      recorder.start(); this.captureOffset = this.position();
      this.app.setState({ tab: 'studio', rec: true, secs: 0 }); this.refresh();
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop()); this.recording = false; this.halt();
      this.notify('Recording could not start: ' + e.message);
    } finally { this.busy = false; this.refresh(); }
  }
  stopRecord() {
    if (this.recorder?.state === 'recording') { this.busy = true; this.recorder.stop(); }
    this.recording = false; this.halt(); this.app.setState({ rec: false }); this.refresh();
  }
  async saveRecording() {
    const pending = this.pending; if (!pending) return;
    this.busy = true; this.refresh();
    try {
      const path = 'local/' + this.app.SONG_UUID + '/' + pending.id + (pending.blob.type.includes('mp4') ? '.m4a' : '.webm');
      await this.checked(this.app.sb.storage.from('takes').upload(path, pending.blob));
      const clip = { id: pending.id + '-clip', name: pending.name, url: this.url('takes', path), start: pending.offset, length: null };
      await this.decode(clip);
      await this.checked(this.app.sb.from('takes').upsert({ id: pending.id, user_id: 'local', song_id: this.app.SONG_UUID, storage_path: path, duration_secs: clip.dur, offset_secs: clip.start, label: pending.name, bar_start: 0 }));
      if (!this.tracks.some(t => t.id === pending.id)) this.tracks.push({ id: pending.id, name: pending.name, volume: 0.8, muted: false, solo: false, clips: [clip] });
      await this.save(); this.pending = null; this.notify(pending.name + ' saved locally on its own track.'); this.app.workspace?.refreshLibrary();
    } catch (e) { this.notify('Recording is still in memory. Use RETRY SAVE before closing: ' + e.message); }
    finally { this.busy = false; this.refresh(); }
  }

  // ---------- clock ----------
  tick() {
    if (this.playing && this.ctx) {
      if (this.plan) {
        if (this.ctx.currentTime > this.nextPassAt - 0.6) {
          this.schedulePass(this.plan.start, this.plan.end, this.nextPassAt); this.scheduleClicks(this.plan.start, this.plan.end, this.nextPassAt);
          this.nextPassAt += (this.plan.end - this.plan.start) / this.rate;
        }
      } else {
        this.topUpClicks();
        if (!this.recording && this.position() >= this.contentEnd() + 0.05) { this.halt(); this.cursor = this.contentEnd(); }
      }
    }
    if (this.recording) this.app.setState({ secs: Math.floor((performance.now() - this.recordStarted) / 1000) });
    const position = this.position(), b = this.beat();
    const bar = Math.floor(position / (b * 4)) + 1, beatIn = Math.floor(position / b) % 4 + 1, sixteenth = Math.floor(position / (b / 4)) % 4 + 1;
    for (const el of document.querySelectorAll('[data-studio-clock]')) el.textContent = this.app.fmtTime(position) + ' / ' + this.app.fmtTime(Math.max(this.contentEnd(), position));
    for (const el of document.querySelectorAll('[data-gb-bars]')) el.textContent = bar + '.' + beatIn + '.' + sixteenth;
    const host = document.getElementById('gb-arrange');
    if (host) {
      if ((this.dirty || host.dataset.built !== '1') && !this.drag) this.build(host);
      const head = host.querySelector('.gb-playhead');
      if (head) head.style.transform = 'translateX(' + (position * this.pps()) + 'px)';
      if (this.playing && !this.drag && this.follow === true) {
        const x = position * this.pps() + this.headW, left = host.scrollLeft, w = host.clientWidth;
        if (x > left + w - 40 || x < left + this.headW) host.scrollLeft = Math.max(0, x - this.headW - 40);
      }
    }
  }

  // ---------- arrange view ----------
  headW = 214;
  build(host) {
    this.dirty = false; host.dataset.built = '1';
    const pps = this.pps(), b = this.beat(), barPx = this.zoom * 4;
    const total = Math.max(this.duration() + this.bar() * 4, host.clientWidth / pps);
    const W = Math.ceil(total * pps), bars = Math.ceil(total / this.bar());
    const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    let html = '<div class="gb-inner" style="width:' + (W + this.headW) + 'px">';
    // ruler + cycle strip
    html += '<div class="gb-row gb-ruler-row"><div class="gb-corner">' + this.tracks.length + ' TRACK' + (this.tracks.length === 1 ? '' : 'S') + '</div><div class="gb-ruler" style="width:' + W + 'px;--bar:' + barPx + 'px;--beatw:' + this.zoom + 'px">';
    const c = this.cycle;
    html += '<div class="gb-cycle-strip" title="LOOP: drag left or right here to draw a loop. Drag its edges to resize, its middle to move it. Double-click it or press C to turn it on/off."><span>drag here to loop</span></div>';
    if (c.end - c.start > 0) html += '<div class="gb-cycle-region' + (c.on ? ' on' : '') + '" style="left:' + (c.start * pps) + 'px;width:' + ((c.end - c.start) * pps) + 'px" title="Drag the middle to move, the edges to resize. Double-click to turn the loop ' + (c.on ? 'off' : 'on') + '."><i class="gb-cycle-edge" data-cycle-edge="l"></i><i class="gb-cycle-edge" data-cycle-edge="r"></i><button class="gb-cycle-off" data-cycle-off="1" aria-label="' + (c.on ? 'Turn loop off' : 'Turn loop on') + '" title="' + (c.on ? 'Turn loop off' : 'Turn loop on') + '">' + (c.on ? '×' : '⟲') + '</button></div>';
    for (let i = 0; i < bars; i++) html += '<span class="gb-barnum" style="left:' + (i * barPx) + 'px">' + (i + 1) + '</span>';
    html += '</div></div>';
    // tracks
    this.tracks.forEach((t, i) => {
      const color = this.trackColor(t, i);
      html += '<div class="gb-row" data-row="' + esc(t.id) + '"><div class="gb-head" style="--c:' + color + '">'
        + '<div class="gb-head-top"><span class="gb-swatch"></span><input class="gb-name" data-track-name="' + esc(t.id) + '" aria-label="Track name" value="' + esc(t.name) + '" />'
        + '<button class="gb-x" data-track-del="' + esc(t.id) + '" title="Remove track" aria-label="Remove track ' + esc(t.name) + '">×</button></div>'
        + '<div class="gb-head-ctl"><button data-track-mute="' + esc(t.id) + '" class="gb-ms' + (t.muted ? ' on' : '') + '" aria-label="Mute ' + esc(t.name) + '">M</button>'
        + '<button data-track-solo="' + esc(t.id) + '" class="gb-ms gb-solo' + (t.solo ? ' on' : '') + '" aria-label="Solo ' + esc(t.name) + '">S</button>'
        + '<button data-track-lock="' + esc(t.id) + '" class="gb-ms gb-lock' + (t.locked ? ' on' : '') + '" aria-label="' + (t.locked ? 'Unlock ' : 'Lock ') + esc(t.name) + '">' + (t.locked ? '🔒' : '🔓') + '</button>'
        + '<input type="range" min="0" max="1" step="0.01" value="' + (t.volume ?? 0.8) + '" data-track-vol="' + esc(t.id) + '" aria-label="' + esc(t.name) + ' volume" /></div></div>'
        + '<div class="gb-lane" data-lane="' + esc(t.id) + '" style="width:' + W + 'px;--bar:' + barPx + 'px;--beatw:' + this.zoom + 'px">';
      for (const clip of t.clips) {
        const L = this.clipLen(clip), D = this.audioLen(clip), w = Math.max(6, L * pps);
        const reps = D > 0 && L > D + 1e-3 ? Math.ceil(L / D - 1e-6) : 1;
        html += '<div class="gb-clip' + (this.selected === clip.id ? ' sel' : '') + (t.muted ? ' muted' : '') + '" data-clip="' + esc(clip.id) + '" style="left:' + (clip.start * pps) + 'px;width:' + w + 'px;--c:' + color + '" title="' + esc(clip.name) + ' — drag to move, drag the right edge to loop or trim">'
          + '<div class="gb-clip-top"><span>' + esc(clip.name) + (reps > 1 ? ' ⟳' + reps : '') + (clip.loadError ? ' ⚠ ' + esc(clip.loadError) : '') + '</span><button class="gb-clip-dup" data-clip-dup="' + esc(clip.id) + '" title="Duplicate after itself" aria-label="Duplicate clip">⧉</button><button class="gb-clip-x" data-clip-del="' + esc(clip.id) + '" title="Delete clip" aria-label="Delete clip ' + esc(clip.name) + '">×</button></div>'
          + '<canvas data-clip-wave="' + esc(clip.id) + '" width="' + Math.min(4000, Math.ceil(w)) + '" height="46"></canvas>'
          + '<div class="gb-clip-loop" data-clip-loop="' + esc(clip.id) + '" title="Drag to loop (repeat) or trim"></div></div>';
      }
      if (this.splitPoint && t.clips.some(c => c.id === this.splitPoint.clipId)) {
        html += '<div class="gb-scissors" style="left:' + (this.splitPoint.time * pps) + 'px"><button data-split-here="' + esc(this.splitPoint.clipId) + '" aria-label="Drag scissors down to split" title="Drag down through the region to split"><span class="gb-scissors-icon">&#9986;</span></button></div>';
      }
      html += '</div></div>';
    });
    html += '<div class="gb-row gb-new-row"><div class="gb-head gb-new-head"><button data-add-track="1">+ NEW TRACK</button><small>or drop audio / loops on the lane →</small></div><div class="gb-lane gb-new-lane" data-lane="__new" style="width:' + W + 'px"><span>Drop a loop, stem or audio file here to start a new track</span></div></div>';
    html += '<div class="gb-playhead" style="left:' + this.headW + 'px"><button class="gb-playhead-handle" aria-label="Drag playhead" title="Drag to position playback or edits"></button></div></div>';
    const keepLeft = host.scrollLeft, keepTop = host.scrollTop;
    host.innerHTML = html; host.scrollLeft = keepLeft; host.scrollTop = keepTop;
    const corner = host.querySelector('.gb-corner'); if (corner?.offsetWidth) this.headW = corner.offsetWidth;
    const ph = host.querySelector('.gb-playhead'); if (ph) ph.style.left = this.headW + 'px';
    host.querySelectorAll('canvas[data-clip-wave]').forEach(cv => this.drawClip(cv));
    if (!host.dataset.wired) this.wire(host);
  }
  drawClip(canvas) {
    const found = this.findClip(canvas.dataset.clipWave); if (!found) return;
    const { clip } = found, buffer = this.buffers.get(clip.url);
    const arrange = canvas.closest('.gb-arrange'), region = canvas.parentElement;
    const bounds = region.getBoundingClientRect(), viewport = arrange.getBoundingClientRect();
    const offset = Math.max(0, viewport.left + this.headW - bounds.left);
    const width = Math.max(1, Math.min(bounds.width - offset, viewport.right - Math.max(bounds.left, viewport.left + this.headW)));
    canvas.style.marginLeft = offset + 'px'; canvas.style.width = width + 'px';
    canvas.width = Math.ceil(width * Math.min(2, window.devicePixelRatio || 1));
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h);
    if (!buffer) { ctx.fillStyle = '#ffffff55'; ctx.font = '11px system-ui'; ctx.fillText('loading…', 6, 26); return; }
    const L = this.clipLen(clip), D = buffer.duration, data = buffer.getChannelData(0), perPx = width / this.pps() / w, viewStart = offset / this.pps();
    ctx.fillStyle = 'rgba(15,8,24,.72)';
    const perSample = perPx * buffer.sampleRate;
    if (perSample < 1.5) { // zoomed in to single samples: draw the real wave, with dots on each sample when there is room
      ctx.strokeStyle = 'rgba(15,8,24,.85)'; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let x = 0; x < w; x++) { const t = ((clip.sourceOffset || 0) + viewStart + x * perPx) % D, i = Math.min(data.length - 1, Math.floor(t * buffer.sampleRate)); const y = h / 2 - data[i] * (h / 2 - 2); if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke(); ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(0, h / 2, w, 1);
      if (perSample < 0.12) { ctx.fillStyle = 'rgba(15,8,24,.95)'; const first = Math.ceil(((clip.sourceOffset || 0) + viewStart) * buffer.sampleRate); for (let i = first; ; i++) { const x = (i / buffer.sampleRate - (clip.sourceOffset || 0) - viewStart) / perPx; if (x > w) break; const y = h / 2 - data[i % data.length] * (h / 2 - 2); ctx.fillRect(x - 2, y - 2, 4, 4); } }
    } else
    for (let x = 0; x < w; x++) {
      const t0 = ((clip.sourceOffset || 0) + viewStart + x * perPx) % D, t1 = t0 + perPx;
      const a = Math.floor(t0 / D * data.length), z = Math.min(data.length, Math.max(a + 1, Math.floor(t1 / D * data.length)));
      let peak = 0; for (let i = a; i < z; i += Math.max(1, Math.floor((z - a) / 60))) peak = Math.max(peak, Math.abs(data[i]));
      const bh = Math.max(1, peak * (h - 4)); ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
    if (L > D + 1e-3) { // loop notches like GarageBand
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      for (let r = D - ((clip.sourceOffset || 0) % D); r < L; r += D) { if (r < viewStart || r > viewStart + width / this.pps()) continue; const x = Math.round((r - viewStart) / perPx); ctx.fillRect(x, 0, 1, h); ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 6); ctx.fill(); }
    }
  }

  // ---------- interaction ----------
  wire(host) {
    host.dataset.wired = '1';
    host.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey || e.shiftKey) || this.drag) return;
      const delta = e.deltaY || e.deltaX; if (!delta) return;
      e.preventDefault();
      this.zoomTo(this.zoom * Math.pow(1.0025, -Math.max(-120, Math.min(120, delta))), e.clientX);
    }, { passive: false });
    host.addEventListener('scroll', () => {
      if (this.waveFrame) return;
      this.waveFrame = requestAnimationFrame(() => { this.waveFrame = null; host.querySelectorAll('canvas[data-clip-wave]').forEach(cv => this.drawClip(cv)); });
    });
    host.addEventListener('pointerdown', this.onPointerDown);
    host.addEventListener('dblclick', e => { if (e.target.closest('.gb-cycle-region') && !e.target.closest('button')) this.toggleCycle(); });
    host.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.trackName) this.change(t.dataset.trackName, { name: t.value });
    });
    host.addEventListener('input', e => {
      const t = e.target;
      if (t.dataset.trackVol) { const track = this.tracks.find(x => x.id === t.dataset.trackVol); if (track) { track.volume = +t.value; const g = this.trackGains?.get(track.id); if (g) g.gain.setTargetAtTime(this.level(track), this.ctx.currentTime, 0.01); clearTimeout(this.volSave); this.volSave = setTimeout(() => this.save(), 400); } }
    });
    host.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.splitHere) { if (e.detail === 0) this.splitClipAtPlayhead(t.dataset.splitHere); }
      else if (t.dataset.trackMute) { const tr = this.tracks.find(x => x.id === t.dataset.trackMute); this.change(tr.id, { muted: !tr.muted }); }
      else if (t.dataset.trackSolo) { const tr = this.tracks.find(x => x.id === t.dataset.trackSolo); this.change(tr.id, { solo: !tr.solo }); }
      else if (t.dataset.trackLock) { const tr = this.tracks.find(x => x.id === t.dataset.trackLock); if (tr) this.toggleTrackLock(tr.id); }
      else if (t.dataset.trackDel) this.deleteTrack(t.dataset.trackDel);
      else if (t.dataset.clipDel) this.deleteClip(t.dataset.clipDel);
      else if (t.dataset.clipDup) this.duplicateClip(t.dataset.clipDup);
      else if (t.dataset.addTrack) this.addTrack();
    });
    host.addEventListener('dblclick', e => {
      if (e.target.closest('button,input')) return;
      const clip = e.target.closest('[data-clip]');
      const lane = e.target.closest('[data-lane]');
      const trackHead = e.target.closest('.gb-head');
      if (clip) {
        this.prepareSplit(clip.dataset.clip, this.laneTime(lane, e.clientX));
        const found = this.findClip(clip.dataset.clip);
        if (found) this.showTrackMenu(found.track.id, found.clip.id, e.clientX + 32, e.clientY + 12);
      } else if (trackHead) {
        const id = trackHead.querySelector('[data-track-name]')?.dataset?.trackName || lane?.dataset?.lane;
        if (id) this.showTrackMenu(id, null, e.clientX, e.clientY);
      }
    });
    host.addEventListener('dragover', e => { const lane = e.target.closest('[data-lane]'); if (lane) { e.preventDefault(); host.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover')); lane.classList.add('drop-hover'); } });
    host.addEventListener('dragleave', e => { if (!host.contains(e.relatedTarget)) host.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover')); });
    host.addEventListener('drop', e => this.drop(e, host));
  }
  laneTime(lane, clientX) { const r = lane.getBoundingClientRect(); return (clientX - r.left) / this.pps(); }
  markerDrag(e) {
    const scissors = e.target.closest('[data-split-here]'), handle = e.target.closest('.gb-playhead-handle');
    if (!scissors && !handle) return false;
    if (e.button !== 0 || this.recording || this.busy) return true;
    e.preventDefault(); this.hideTrackMenu();
    const host = e.currentTarget, resume = this.playing;
    this.drag = {}; // Keep the DOM stable throughout the gesture.
    if (resume) this.halt();
    const initial = this.cursor, point = this.splitPoint && { ...this.splitPoint };
    let distance = 0;
    const update = ev => {
      if (scissors) {
        distance = Math.max(0, Math.min(68, ev.clientY - e.clientY));
        scissors.style.transform = 'translateY(' + distance + 'px)';
      } else {
        this.cursor = Math.max(0, Math.min(this.duration(), this.laneTime(host.querySelector('.gb-ruler'), ev.clientX)));
        if (this.splitPoint) {
          this.splitPoint.time = this.cursor;
          const marker = host.querySelector('.gb-scissors');
          if (marker) marker.style.left = this.cursor * this.pps() + 'px';
        }
        host.querySelector('.gb-playhead').style.transform = 'translateX(' + this.cursor * this.pps() + 'px)';
      }
    };
    const finish = ev => {
      window.removeEventListener('pointermove', update); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      const cancelled = ev.type === 'pointercancel';
      if (!cancelled) update(ev);
      this.drag = null;
      if (cancelled) { this.cursor = initial; this.splitPoint = point; }
      if (scissors && !cancelled && distance >= 48) this.splitClipAtPlayhead(scissors.dataset.splitHere);
      this.refresh();
      if (resume) this.play().catch(() => {});
    };
    window.addEventListener('pointermove', update); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
    return true;
  }
  pointerDown(e) {
    if (this.markerDrag(e)) return;
    const cycleOff = e.target.closest('[data-cycle-off]');
    if (cycleOff && e.button === 0) { e.preventDefault(); e.stopPropagation(); this.toggleCycle(); return; }
    if (e.button !== 0 || e.target.closest('button,input')) return;
    this.splitPoint = null; e.currentTarget.querySelectorAll('.gb-scissors').forEach(el => el.remove());
    const host = e.currentTarget, loop = e.target.closest('[data-clip-loop]'), clipEl = e.target.closest('[data-clip]');
    const strip = e.target.closest('.gb-cycle-strip'), ruler = e.target.closest('.gb-ruler'), lane = e.target.closest('[data-lane]');
    const free = e.altKey, pps = this.pps();
    let drag = null;
    const regionEl = e.target.closest('.gb-cycle-region');
    if (regionEl) {
      const edge = e.target.closest('[data-cycle-edge]')?.dataset.cycleEdge, a0 = this.cycle.start, z0 = this.cycle.end, ruler0 = regionEl.parentElement;
      const t0 = this.laneTime(ruler0, e.clientX);
      drag = { move: ev => {
          const t = this.laneTime(ruler0, ev.clientX); let a = a0, z = z0;
          if (edge === 'l') a = this.snapCycle(t, ev.altKey); else if (edge === 'r') z = this.snapCycle(t, ev.altKey);
          else { const d = this.snapCycle(Math.max(0, a0 + t - t0), ev.altKey) - a0; a = a0 + d; z = z0 + d; }
          if (z < a) [a, z] = [z, a]; // dragging an edge past the other one just flips it
          drag.a = a; drag.z = z; drag.moved = drag.moved || Math.abs(ev.clientX - e.clientX) > 2;
          regionEl.style.left = a * pps + 'px'; regionEl.style.width = Math.max(2, (z - a) * pps) + 'px';
        },
        up: () => { if (drag.moved && drag.a != null) this.setCycle(drag.a, drag.z, this.cycle.on || true); } };
    } else if (loop) {
      const found = this.findClip(loop.dataset.clipLoop); if (!found) return;
      if (found.track.locked) { this.notify('This track is locked. Unlock it before editing the clip.'); return; }
      const el = loop.parentElement, len0 = this.clipLen(found.clip);
      drag = { move: ev => { const len = Math.max(this.beat() / 4, this.snapCycle(found.clip.start + len0 + (ev.clientX - e.clientX) / pps, ev.altKey) - found.clip.start); drag.len = len; el.style.width = Math.max(6, len * pps) + 'px'; },
        up: () => { if (drag.len != null) this.setClipLength(found.clip.id, drag.len); } };
    } else if (clipEl) {
      const found = this.findClip(clipEl.dataset.clip); if (!found) return;
      if (found.track.locked) { this.notify('This track is locked. Unlock it before moving clips.'); return; }
      this.selected = found.clip.id; host.querySelectorAll('.gb-clip.sel').forEach(x => x.classList.remove('sel')); clipEl.classList.add('sel');
      const s0 = found.clip.start;
      drag = { move: ev => {
          const dx = ev.clientX - e.clientX; if (Math.abs(dx) + Math.abs(ev.clientY - e.clientY) < 4 && !drag.moved) return;
          drag.moved = true; drag.start = this.snap(s0 + dx / pps, ev.altKey); clipEl.style.left = drag.start * pps + 'px';
          clipEl.style.transform = 'translateY(' + (ev.clientY - e.clientY) + 'px)'; clipEl.classList.add('dragging');
          const under = document.elementsFromPoint(ev.clientX, ev.clientY).find(x => x.dataset?.lane);
          host.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover')); if (under) under.classList.add('drop-hover'); drag.lane = under?.dataset.lane;
        },
        up: () => { if (drag.moved) this.moveClip(found.clip.id, drag.lane || found.track.id, drag.start ?? s0); } };
    } else if (strip) {
      const t0 = this.snapCycle(this.laneTime(strip.parentElement, e.clientX), e.altKey);
      const region = (() => { const d = document.createElement('div'); d.className = 'gb-cycle-region on'; strip.parentElement.prepend(d); return d; })();
      region.innerHTML = '';
      drag = { move: ev => { const t1 = this.snapCycle(this.laneTime(strip.parentElement, ev.clientX), ev.altKey); const a = Math.min(t0, t1), z = Math.max(t0, t1); drag.a = a; drag.z = z; region.classList.add('on'); region.style.left = a * pps + 'px'; region.style.width = Math.max(2, (z - a) * pps) + 'px'; },
        up: () => { if (drag.a == null || drag.z - drag.a < 3 / pps) { region.remove(); this.refresh(); return; } this.setCycle(drag.a, drag.z, true); } };
      drag.move(e);
    } else if (ruler || lane) {
      const base = ruler || lane; this.seek(this.laneTime(base, e.clientX));
      if (lane && !clipEl) { this.selected = null; host.querySelectorAll('.gb-clip.sel').forEach(x => x.classList.remove('sel')); }
      return;
    } else return;
    e.preventDefault();
    this.drag = drag;
    const move = ev => drag.move(ev), up = ev => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      host.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
      this.drag = null; drag.up(ev);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  key(e) {
    if (this.app.state?.tab !== 'studio' || e.target.closest?.('input,textarea,[contenteditable]')) return;
    if (e.key === 'Escape') { this.splitPoint = null; this.hideTrackMenu(); this.refresh(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(e.shiftKey); return; }
    if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); this.splitClipAtPlayhead(this.selected); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.deleteClip(this.selected); }
    else if (e.key === 'c' || e.key === 'C') this.toggleCycle();
    else if (e.key === 'k' || e.key === 'K') this.toggleMetronome();
    else if ((e.key === 'f' || e.key === 'F') && !mod) this.toggleFollow();
    else if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey) && this.selected) { e.preventDefault(); this.duplicateClip(this.selected); }
  }
  // Loop browser rows carry data-loop-url / data-loop-name; dragging one onto a lane adds a clip there.
  loopDragStart(e) {
    const row = e.target.closest?.('[data-loop-url]'); if (!row) return;
    e.dataTransfer.setData('application/x-screwshop-loop', JSON.stringify({ url: row.dataset.loopUrl, name: row.dataset.loopName }));
    e.dataTransfer.effectAllowed = 'copy';
  }
  async drop(e, host) {
    const lane = e.target.closest('[data-lane]'); host.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
    if (!lane) return; e.preventDefault();
    const trackId = lane.dataset.lane === '__new' ? null : lane.dataset.lane, at = this.laneTime(lane, e.clientX);
    const raw = e.dataTransfer.getData('application/x-screwshop-loop');
    if (raw) { try { await this.addClip(trackId, JSON.parse(raw), at); } catch (err) { this.notify(err.message); } return; }
    const files = [...(e.dataTransfer.files || [])].filter(f => /^audio\//.test(f.type) || /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(f.name));
    let start = at;
    for (const file of files) {
      try { const item = await this.uploadFile(file); await this.addClip(trackId, item, start); start = null; }
      catch (err) { this.notify('Import failed: ' + err.message); }
    }
  }
  rows() { return this.tracks.map((t, i) => ({ id: t.id, name: t.name, number: i + 1 })); }
  dispose() {
    clearInterval(this.timer); this.stopRecord();
    document.removeEventListener('keydown', this.onKey); document.removeEventListener('dragstart', this.onDragStart); window.removeEventListener('resize', this.onResize);
    this.ctx?.close();
  }
};
