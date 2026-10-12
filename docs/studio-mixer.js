/* STUDIO MIXER — manual channel strips for every Studio track plus the master bus.
   Settings live on each track (`track.mix`) and the session (`studio.mixMaster`); mix-engine.js
   applies them to live playback and to SAVE MIX / EXPORT renders identically.
   The drawer is plain DOM outside the app template (like the arrange view), so moving a
   control never re-renders the app. */
window.StudioMixer = (() => {
  let host = null, studio = null, signature = '', watch = null, frame = null;
  const meters = new Map();
  const M = () => window.ScrewMix;
  const get = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
  const put = (o, path, value) => { const keys = path.split('.'), last = keys.pop(); keys.reduce((v, k) => (v[k] = v[k] || {}), o)[last] = value; return o; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hz = v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : Math.round(v) + '';
  const db = v => (v > 0 ? '+' : '') + (+v).toFixed(1) + ' dB';
  const volDb = v => v <= 0 ? '-∞' : db(20 * Math.log10(v));

  // [label, path, min, max, step, format]
  const TRACK_ROWS = [
    ['EQ', [
      ['High-pass', 'hpf', 20, 400, 1, v => v <= 20 ? 'OFF' : hz(v) + ' Hz'],
      ['Low', 'low.gain', -15, 15, 0.5, db], ['Low freq', 'low.freq', 40, 400, 1, v => hz(v) + ' Hz'],
      ['Mid', 'mid.gain', -15, 15, 0.5, db], ['Mid freq', 'mid.freq', 200, 8000, 10, v => hz(v) + ' Hz'], ['Mid width (Q)', 'mid.q', 0.3, 6, 0.1, v => (+v).toFixed(1)],
      ['High', 'high.gain', -15, 15, 0.5, db], ['High freq', 'high.freq', 2000, 16000, 100, v => hz(v) + ' Hz'],
    ]],
    ['COMP', [
      ['Threshold', 'comp.threshold', -60, 0, 0.5, db], ['Ratio', 'comp.ratio', 1, 20, 0.1, v => (+v).toFixed(1) + ':1'],
      ['Attack', 'comp.attack', 0.5, 200, 0.5, v => (+v).toFixed(1) + ' ms'], ['Release', 'comp.release', 20, 1000, 5, v => Math.round(v) + ' ms'],
      ['Makeup', 'comp.makeup', 0, 24, 0.5, db],
    ], 'comp.on'],
    ['DE-ESS', [
      ['Frequency', 'deess.freq', 3000, 10000, 50, v => hz(v) + ' Hz'], ['Amount', 'deess.amount', 0, 12, 0.5, v => (+v).toFixed(1)],
    ], 'deess.on'],
    ['COLOR & SPACE', [
      ['Saturation', 'drive', 0, 1, 0.01, v => Math.round(v * 100) + '%'],
      ['Reverb send', 'reverb', 0, 1, 0.01, v => Math.round(v * 100) + '%'], ['Delay send', 'delay', 0, 1, 0.01, v => Math.round(v * 100) + '%'],
      ['Pan', 'pan', -1, 1, 0.01, v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)],
    ]],
  ];
  const MASTER_ROWS = [
    ['REVERB', [
      ['Decay', 'reverb.decay', 0.3, 6, 0.1, v => (+v).toFixed(1) + ' s'], ['Pre-delay', 'reverb.predelay', 0, 120, 1, v => Math.round(v) + ' ms'],
      ['Tone', 'reverb.tone', 1500, 16000, 100, v => hz(v) + ' Hz'],
    ]],
    ['DELAY', [
      ['Time', 'delay.division', null, null, null, null, [[0.25, '1/16'], [0.5, '1/8'], [0.75, '1/8 dotted'], [1, '1/4'], [1.5, '1/4 dotted'], [2, '1/2']]],
      ['Feedback', 'delay.feedback', 0, 0.85, 0.01, v => Math.round(v * 100) + '%'], ['Tone', 'delay.tone', 1000, 12000, 100, v => hz(v) + ' Hz'],
    ]],
    ['GLUE COMP', [
      ['Threshold', 'glue.threshold', -40, 0, 0.5, db], ['Ratio', 'glue.ratio', 1, 10, 0.1, v => (+v).toFixed(1) + ':1'],
      ['Attack', 'glue.attack', 1, 100, 1, v => Math.round(v) + ' ms'], ['Release', 'glue.release', 50, 1000, 10, v => Math.round(v) + ' ms'],
    ], 'glue.on'],
    ['OUTPUT', [
      ['Master gain', 'gain', -24, 12, 0.5, db], ['Limiter ceiling', 'limiter.ceiling', -6, 0, 0.1, db],
    ], 'limiter.on'],
  ];

  function control([label, path, min, max, step, fmt, options], settings, scope) {
    const value = get(settings, path);
    if (options) return `<label class="mx-row"><span>${label}</span><select data-scope="${scope}" data-path="${path}">${options.map(([v, l]) => `<option value="${v}"${+v === +value ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
    return `<label class="mx-row"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-scope="${scope}" data-path="${path}" aria-label="${esc(label)}"><output>${fmt(value)}</output></label>`;
  }
  function sections(rows, settings, scope) {
    return rows.map(([title, items, toggle]) => `<fieldset class="mx-sec"><legend>${title}${toggle ? `<button type="button" class="mx-on${get(settings, toggle) ? ' on' : ''}" data-scope="${scope}" data-toggle="${toggle}" aria-pressed="${!!get(settings, toggle)}">${get(settings, toggle) ? 'ON' : 'OFF'}</button>` : ''}</legend>${items.map(i => control(i, settings, scope)).join('')}</fieldset>`).join('');
  }
  function strip(track) {
    const m = M().trackSettings(track.mix), vol = track.volume ?? 0.8;
    return `<section class="mx-strip" data-track="${esc(track.id)}"><header><b title="${esc(track.name)}">${esc(track.name || 'Track')}</b><div class="mx-meter"><i data-meter="${esc(track.id)}"></i></div></header>
      ${sections(TRACK_ROWS, m, 'track:' + track.id)}
      <fieldset class="mx-sec mx-fader"><legend>FADER</legend><label class="mx-row"><span>Volume</span><input type="range" min="0" max="1.5" step="0.01" value="${vol}" data-scope="track:${esc(track.id)}" data-volume="1" aria-label="Volume"><output>${volDb(vol)}</output></label>
      <div class="mx-btns"><button type="button" class="${track.muted ? 'on' : ''}" data-mute="${esc(track.id)}">M</button><button type="button" class="${track.solo ? 'on' : ''}" data-solo="${esc(track.id)}">S</button><button type="button" data-reset="${esc(track.id)}" title="Set every control on this strip back to flat">RESET</button></div></fieldset></section>`;
  }
  // MIX NOTES: a to-do list for the mix ("2nd verse vocals lower"), saved with the session.
  // A note can name a track and remember the playhead time so it jumps back to that spot.
  const clock = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  const notes = () => (studio.mixNotes = Array.isArray(studio.mixNotes) ? studio.mixNotes : []);
  function renderNotes() {
    const list = host.querySelector('.mx-note-list'), pick = host.querySelector('[data-note-track]'), all = notes();
    const keep = pick.value;
    pick.innerHTML = '<option value="">Whole song</option>' + studio.tracks.map(t => `<option value="${esc(t.id)}">${esc(t.name || 'Track')}</option>`).join('');
    pick.value = studio.tracks.some(t => t.id === keep) ? keep : '';
    const open = all.filter(n => !n.done).length;
    host.querySelector('.mx-note-count').textContent = all.length ? `${open} to do` : '';
    const sorted = [...all].sort((a, b) => (a.done - b.done) || ((a.time ?? -1) - (b.time ?? -1)));
    list.innerHTML = sorted.length ? sorted.map(n => {
      const track = n.trackId ? (studio.tracks.find(t => t.id === n.trackId)?.name || 'Removed track') : 'Whole song';
      const when = n.time != null ? `<button type="button" class="mx-note-when" data-note-seek="${+n.time}" title="Move the playhead here">${clock(n.time)}</button>` : '<span class="mx-note-when">—</span>';
      return `<li class="mx-note${n.done ? ' done' : ''}"><input type="checkbox" data-note-done="${esc(n.id)}"${n.done ? ' checked' : ''} aria-label="Done"> ${when}<span class="mx-note-track">${esc(track)}</span><span class="mx-note-text">${esc(n.text)}</span><button type="button" class="mx-note-del" data-note-delete="${esc(n.id)}" aria-label="Delete note" title="Delete note">×</button></li>`;
    }).join('') : '<li class="mx-note-empty">No notes yet. Play the song; when you hear something to fix, type it here. The note remembers where the playhead was.</li>';
  }
  function addNote(e) {
    e.preventDefault();
    const input = host.querySelector('[data-note-text]'), text = input.value.trim();
    if (!text) return input.focus();
    notes().push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), text: text.slice(0, 300), trackId: host.querySelector('[data-note-track]').value || null, time: host.querySelector('[data-note-pin]').checked ? +studio.position().toFixed(2) : null, done: false, created: new Date().toISOString() });
    studio.saveSoon(); input.value = ''; input.focus(); renderNotes();
  }
  function render() {
    if (!host || !studio) return;
    renderNotes();
    const master = M().masterSettings(studio.mixMaster);
    signature = studio.tracks.map(t => t.id + ':' + (t.name || '')).join('|');
    host.querySelector('.mx-strips').innerHTML = (studio.tracks.length ? studio.tracks.map(strip).join('') : '<p class="mx-empty">Add or record a track to mix it.</p>')
      + `<section class="mx-strip mx-master"><header><b>MASTER</b><div class="mx-meter"><i data-meter="__master"></i></div></header>${sections(MASTER_ROWS, master, 'master')}</section>`;
  }
  function apply(el) {
    const scope = el.dataset.scope; if (!scope) return;
    const value = el.tagName === 'SELECT' ? +el.value : +el.value;
    const out = el.parentElement.querySelector('output');
    if (scope === 'master') {
      const m = M().masterSettings(studio.mixMaster); put(m, el.dataset.path, value); studio.setMasterMix(m);
      const row = MASTER_ROWS.flatMap(r => r[1]).find(r => r[1] === el.dataset.path); if (out && row?.[5]) out.textContent = row[5](value);
      return;
    }
    const id = scope.slice(6), track = studio.tracks.find(t => t.id === id); if (!track) return;
    if (el.dataset.volume) { track.volume = value; studio.applyLevels(); studio.dirty = true; studio.saveSoon(); if (out) out.textContent = volDb(value); return; }
    const m = M().trackSettings(track.mix); put(m, el.dataset.path, value); studio.setMix(id, m);
    const row = TRACK_ROWS.flatMap(r => r[1]).find(r => r[1] === el.dataset.path); if (out && row) out.textContent = row[5](value);
  }
  function click(e) {
    const b = e.target.closest('button'); if (!b || !studio) return;
    if (b.dataset.close) return close();
    if (b.dataset.noteSeek) { studio.seek(+b.dataset.noteSeek); studio.refresh?.(); return; }
    if (b.dataset.noteDelete) { studio.mixNotes = notes().filter(n => n.id !== b.dataset.noteDelete); studio.saveSoon(); return renderNotes(); }
    if (b.dataset.toggle) {
      const path = b.dataset.toggle;
      if (b.dataset.scope === 'master') { const m = M().masterSettings(studio.mixMaster); put(m, path, !get(m, path)); studio.setMasterMix(m); }
      else { const id = b.dataset.scope.slice(6), t = studio.tracks.find(x => x.id === id); if (!t) return; const m = M().trackSettings(t.mix); put(m, path, !get(m, path)); studio.setMix(id, m); }
      return render();
    }
    if (b.dataset.mute || b.dataset.solo) {
      const id = b.dataset.mute || b.dataset.solo, t = studio.tracks.find(x => x.id === id); if (!t) return;
      studio.change(id, b.dataset.mute ? { muted: !t.muted } : { solo: !t.solo }); return render();
    }
    if (b.dataset.reset) { studio.setMix(b.dataset.reset, {}); return render(); }
  }
  // Peak meters (post-fader). Strips are rebuilt on every play, so analysers attach lazily.
  function meter() {
    frame = requestAnimationFrame(meter);
    if (!host || !studio) return;
    const level = (key, node) => {
      let m = meters.get(key);
      if (node && (!m || m.node !== node)) { const a = node.context.createAnalyser(); a.fftSize = 1024; node.connect(a); m = { node, a, buf: new Float32Array(1024) }; meters.set(key, m); }
      const el = host.querySelector(`[data-meter="${CSS.escape(key)}"]`); if (!el) return;
      let peak = 0; if (m && studio.playing && node) { m.a.getFloatTimeDomainData(m.buf); for (const v of m.buf) peak = Math.max(peak, Math.abs(v)); }
      const dbv = peak > 0 ? 20 * Math.log10(peak) : -90;
      el.style.width = Math.max(0, Math.min(100, (dbv + 60) / 60 * 100)) + '%'; el.classList.toggle('hot', dbv > -1);
    };
    for (const t of studio.tracks) level(t.id, studio.strips?.get(t.id)?.nodes.pan);
    level('__master', studio.bus?.nodes.trim);
  }
  function open(s) {
    studio = s;
    if (!host) {
      host = document.createElement('div'); host.id = 'ss-mixer'; host.className = 'ss-mixer'; host.setAttribute('role', 'dialog'); host.setAttribute('aria-label', 'Studio mixer');
      host.innerHTML = '<div class="mx-top"><b>MIXER</b><span>Every knob changes the sound live and is used by SAVE MIX TO SONGS and EXPORT. Start flat; small moves.</span><button type="button" data-close="1">CLOSE</button></div>'
        + '<section class="mx-notes" aria-label="Mix notes"><form class="mx-note-add"><b>MIX NOTES <span class="mx-note-count"></span></b>'
        + '<input type="text" maxlength="300" data-note-text placeholder="What should change? e.g. 2nd verse vocals lower, kick hit harder" aria-label="Mix note">'
        + '<select data-note-track aria-label="Which track"></select>'
        + '<label class="mx-note-pin" title="Save the current playhead time with the note"><input type="checkbox" data-note-pin checked> at playhead</label>'
        + '<button type="submit">ADD NOTE</button></form><ol class="mx-note-list"></ol></section><div class="mx-strips"></div>';
      host.addEventListener('input', e => apply(e.target)); host.addEventListener('change', e => apply(e.target)); host.addEventListener('click', click);
      host.querySelector('.mx-note-add').addEventListener('submit', addNote);
      host.addEventListener('change', e => {
        const id = e.target.dataset.noteDone, n = id && notes().find(x => x.id === id); if (!n) return;
        n.done = e.target.checked; studio.saveSoon(); renderNotes();
      });
      document.body.appendChild(host);
    }
    host.hidden = false; render();
    clearInterval(watch); watch = setInterval(() => { if (studio && studio.tracks.map(t => t.id + ':' + (t.name || '')).join('|') !== signature) render(); }, 700);
    cancelAnimationFrame(frame); meter();
  }
  function close() { if (host) host.hidden = true; clearInterval(watch); cancelAnimationFrame(frame); meters.clear(); }
  return { open, close, toggle: s => (host && !host.hidden ? close() : open(s)), isOpen: () => !!host && !host.hidden };
})();
