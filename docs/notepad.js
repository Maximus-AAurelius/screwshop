/* Local notebook editor. Only the explicit online lookup sends a search term. */
window.ScrewShopNotepad = class {
  constructor(app) {
    this.app = app; this.colors = ['#d7e8fb','#f7d4de','#d8ebc9','#f5e3ac','#e5d8f3','#c4e9e3'];
    this.documents = []; this.saveChain = Promise.resolve();
    this.timer = setInterval(() => this.sync(), 150);
    this.resize = () => this.paint(); window.addEventListener('resize', this.resize);
  }
  dispose() { this.beatAudio?.pause(); clearInterval(this.timer); clearTimeout(this.paintTimer); clearTimeout(this.saveTimer); this.request?.abort(); window.removeEventListener('resize', this.resize); }
  escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  title(song) { return song.title.trim() || 'Untitled song'; }
  draftKey(id) { return 'screwshop-lyric-draft:' + id; }
  rememberDraft(song) {
    try {
      localStorage.setItem(this.draftKey(song.id), JSON.stringify({ id: song.id, title: song.title, lines: song.lines, meta: song.meta, at: song.editedAt || Date.now() }));
      song.draftRetained = true;
    } catch (_) { song.draftRetained = false; }
  }
  async load() {
    if (this.loading) return;
    this.loading = true; this.loadError = false; this.sync();
    try {
      const { data, error } = await this.app.sb.from('songs').select('*').order('updated_at', { ascending: false });
      if (error || !Array.isArray(data)) throw Error('Could not load your songs.');
      this.documents = data.map(row => {
        let meta = {}; try { meta = JSON.parse(row.meta || '{}'); } catch (_) {}
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
        const marker = Number(meta._notepadEditedAt);
        const editedAt = Number.isFinite(marker) && marker > 0 ? marker : Date.parse(row.updated_at) || 0;
        return { id: row.id, title: String(row.title || 'Untitled song'), lines: Array.isArray(meta.lines) ? meta.lines.map(String) : [''], meta, updated_at: row.updated_at, editedAt, revision: 0, status: 'SAVED ON DISK' };
      });
      const recover = (id, draft, legacy = false) => {
        if (!draft || !Array.isArray(draft.lines) || !draft.lines.every(line => typeof line === 'string') || !Number.isFinite(draft.at) || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return;
        let song = this.documents.find(doc => doc.id === id);
        const savedAt = legacy ? Date.parse(song?.updated_at) || 0 : song?.editedAt || 0;
        if (song && draft.at <= (song.recoveredAt || savedAt)) return;
        if (!song) { song = { id, title: 'Untitled song', meta: {}, revision: 0 }; this.documents.push(song); }
        song.title = typeof draft.title === 'string' ? draft.title : song.title;
        song.lines = draft.lines.slice(); song.status = 'NOT SAVED'; song.recoveredAt = draft.at; song.editedAt = draft.at;
        if (draft.meta && typeof draft.meta === 'object' && !Array.isArray(draft.meta)) song.meta = { ...song.meta, ...draft.meta };
      };
      try {
        const legacy = JSON.parse(localStorage.getItem('screwshop-draft') || 'null');
        recover(this.app.SONG_UUID, legacy, true);
      } catch (_) {}
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith('screwshop-lyric-draft:')) continue;
          try { recover(key.slice('screwshop-lyric-draft:'.length), JSON.parse(localStorage.getItem(key))); } catch (_) {}
        }
      } catch (_) {}
      if (!this.documents.length) this.documents.push({ id: this.app.SONG_UUID, title: 'MAP OF THE CITY', lines: this.app.state.lines.slice(), meta: {}, revision: 0, status: 'NOT SAVED' });
      let remembered; try { remembered = localStorage.getItem('screwshop-notepad-active'); } catch (_) {}
      this.ready = true;
      this.activate(this.documents.find(song => song.id === remembered) || this.documents.find(song => song.id === this.app.SONG_UUID) || this.documents[0]);
      const recovered = this.documents.filter(song => song.status !== 'SAVED ON DISK');
      for (const song of recovered) { this.rememberDraft(song); await this.queueSave(song); }
      if (recovered.some(song => song.recoveredAt)) this.app.setState({ notice: 'Recovered your lyric drafts. Each draft stays with its own song.' });
    } catch (_) {
      this.loadError = true; this.ready = false;
      this.app.setState({ saveStatus: 'NOT SAVED', notice: 'Could not load your songs. Reconnect and press RETRY LOAD in the notepad.' });
    } finally { this.loading = false; this.sync(); }
  }
  activate(song) {
    this.active = song; this.composing = false;
    this.app.setState({ lines: song.lines.slice(), lyricSongId: song.id, lyricTitle: song.title, edit: -1, word: null, saveStatus: song.status });
    try { localStorage.setItem('screwshop-notepad-active', song.id); } catch (_) {}
    if (this.host?.isConnected) {
      this.editor.value = song.lines.join('\n'); this.editor.setSelectionRange(0, 0);
      this.host.querySelector('.np-song-title').value = song.title; this.paint();
    }
    this.listSignature = null; this.loadBeat();
  }
  save(lines, immediate = false) {
    if (!this.ready || !this.active) return Promise.resolve(false);
    const song = this.active;
    song.lines = (lines || this.app.state.lines).slice(); song.revision++; song.status = 'SAVING';
    song.editedAt = Math.max(Date.now(), (song.editedAt || 0) + 1);
    this.rememberDraft(song); this.app.setState({ saveStatus: 'SAVING' });
    clearTimeout(this.saveTimer);
    if (immediate) return this.queueSave(song);
    this.saveTimer = setTimeout(() => this.queueSave(song), 350);
  }
  queueSave(song) {
    // Capture the document before queuing; switching songs must never redirect an older save.
    // Use edit time for draft recovery: an older queued write can reach disk after a newer edit.
    const snapshot = { id: song.id, user_id: 'local', title: this.title(song), meta: JSON.stringify({ ...song.meta, lines: song.lines.slice(), _notepadEditedAt: song.editedAt || Date.now() }) };
    const revision = song.revision;
    song.status = 'SAVING';
    this.saveChain = this.saveChain.then(async () => {
      if (song.deleted) return false;
      let result;
      try { result = await this.app.sb.from('songs').upsert(snapshot).select('*').single(); }
      catch (_) { result = { error: true }; }
      const saved = !result.error;
      if (song.revision === revision) {
        song.status = saved ? 'SAVED ON DISK' : 'NOT SAVED';
        if (saved) {
          song.updated_at = result.data?.updated_at;
          try { localStorage.removeItem(this.draftKey(song.id)); if (song.id === this.app.SONG_UUID) localStorage.removeItem('screwshop-draft'); } catch (_) {}
        }
        if (this.active === song) this.app.setState({ saveStatus: song.status });
      }
      return saved;
    });
    return this.saveChain;
  }
  flush() { return this.save(this.host?.isConnected ? this.editor.value.split('\n') : this.active?.lines, true); }
  async chooseSong(id) {
    if (!this.ready || this.busy || id === this.active?.id) return;
    const song = this.documents.find(doc => doc.id === id); if (!song) return;
    this.busy = true; this.renderSongs();
    try { if (await this.flush()) this.activate(song); }
    finally { this.busy = false; this.sync(); }
  }
  async newSong() {
    if (!this.ready || this.busy) return;
    this.busy = true; this.renderSongs();
    try {
      if (!await this.flush()) return;
      let title = 'Untitled song', number = 2;
      while (this.documents.some(song => this.title(song) === title)) title = 'Untitled song ' + number++;
      const song = { id: window.ScrewShop.id(), title, lines: [''], meta: {}, revision: 0, status: 'NOT SAVED' };
      this.documents.unshift(song); this.activate(song); await this.save(song.lines, true);
    } finally {
      this.busy = false; this.sync();
      if (this.active?.lines.join('') === '') this.host?.querySelector('.np-song-title').focus();
    }
  }
  songMenu(id) {
    const song = this.documents.find(d => d.id === id); if (!song) return [];
    const blocked = !this.ready || this.busy;
    const why = 'Wait for the current save to finish.';
    return [
      {id: 'open', label: song === this.active ? 'Open (already open)' : 'Open', disabled: blocked || song === this.active, why, run: () => this.chooseSong(id)},
      {id: 'rename', label: 'Rename', disabled: blocked, why, run: async () => { if (song !== this.active) await this.chooseSong(id); const input = this.host?.querySelector('.np-song-title'); input?.focus(); input?.select(); }},
      {id: 'duplicate', label: 'Duplicate', disabled: blocked, why, run: () => this.duplicateSong(id)},
      {id: 'download', label: 'Download lyrics (.txt)', run: () => {
        const lines = song === this.active && this.editor ? this.editor.value.split('\n') : song.lines;
        const url = URL.createObjectURL(new Blob([this.title(song) + '\n\n' + lines.join('\n') + '\n'], {type: 'text/plain'}));
        const a = document.createElement('a'); a.href = url; a.download = this.title(song).replace(/[^\w .-]/g, '_') + '.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }},
      '-',
      {id: 'delete', label: 'Delete…', danger: true, hint: 'Del', disabled: blocked, why, run: () => this.deleteSong(id)},
    ];
  }
  async duplicateSong(id) {
    const source = this.documents.find(d => d.id === id); if (!source || !this.ready || this.busy) return;
    this.busy = true; this.renderSongs();
    try {
      if (!await this.flush()) return;
      const lines = source === this.active && this.editor ? this.editor.value.split('\n') : source.lines.slice();
      const song = {id: window.ScrewShop.id(), title: this.title(source) + ' (copy)', lines, meta: {...source.meta}, revision: 0, status: 'NOT SAVED'};
      this.documents.splice(this.documents.indexOf(source), 0, song); this.activate(song); await this.save(song.lines, true);
    } finally { this.busy = false; this.sync(); }
  }
  // DELETE: gone at once, UNDO for 10 seconds, then the lyrics are saved in Deleted Files as a .md.
  async deleteSong(id) {
    const song = this.documents.find(d => d.id === id); if (!song || !this.ready || this.busy) return;
    if (song === this.active) { clearTimeout(this.saveTimer); if (this.editor) song.lines = this.editor.value.split('\n'); }
    await this.saveChain;
    const index = this.documents.indexOf(song), wasActive = song === this.active;
    const forgetDraft = () => { try { localStorage.removeItem(this.draftKey(song.id)); if (song.id === this.app.SONG_UUID) localStorage.removeItem('screwshop-draft'); } catch (_) {} };
    window.ItemMenu.remove({label: this.title(song), items: [{table: 'songs', id: song.id}],
      hide: () => {
        song.deleted = true; forgetDraft();
        this.documents.splice(this.documents.indexOf(song), 1);
        if (wasActive) {
          let next = this.documents[index] || this.documents[index - 1];
          if (!next) { next = {id: window.ScrewShop.id(), title: 'Untitled song', lines: [''], meta: {}, revision: 0, status: 'NOT SAVED'}; this.documents.push(next); }
          this.activate(next);
        }
        this.listSignature = null; this.sync();
      },
      restore: () => {
        song.deleted = false;
        this.documents.splice(Math.min(index, this.documents.length), 0, song);
        if (song.status !== 'SAVED ON DISK') { this.rememberDraft(song); this.queueSave(song); }
        if (wasActive) this.activate(song);
        this.listSignature = null; this.sync();
      },
      after: forgetDraft});
  }
  renderSongs() {
    if (!this.host?.isConnected) return;
    const disabled = !this.ready || !!this.busy;
    this.editor.disabled = disabled;
    const input = this.host.querySelector('.np-song-title'); input.disabled = disabled;
    if (this.active && input.value !== this.active.title) input.value = this.active.title;
    this.host.querySelector('.np-new-song').disabled = disabled;
    this.host.querySelector('.np-save-song').disabled = disabled;
    this.host.querySelector('.np-retry-load').hidden = !this.loadError;
    this.host.querySelector('.np-song-total').textContent = this.documents.length;
    const signature = JSON.stringify([this.active?.id, disabled, this.documents.map(song => [song.id, this.title(song), song.lines.filter(line => line.trim()).length, song.status])]);
    if (signature !== this.listSignature) {
      this.listSignature = signature;
      this.host.querySelector('.np-song-list').innerHTML = this.documents.map(song => {
        const bars = song.lines.filter(line => line.trim()).length;
        return `<div class="np-song-row"><button type="button" class="np-song-item" data-song-id="${this.escape(song.id)}" aria-current="${song === this.active ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}><strong>${this.escape(this.title(song))}</strong><small>${bars} ${bars === 1 ? 'bar' : 'bars'}${song.status === 'NOT SAVED' ? ' · Unsaved draft' : ''}</small></button><button type="button" class="im-dots np-song-dots" data-song-menu="${this.escape(song.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${this.escape(this.title(song))}" title="Rename, duplicate, download or delete (or right-click the song)" ${disabled ? 'disabled' : ''}>⋮</button></div>`;
      }).join('');
    }
    const status = this.host.querySelector('.np-song-status');
    status.dataset.state = this.loadError || this.active?.status === 'NOT SAVED' ? 'error' : this.active?.status || 'loading';
    status.textContent = this.loadError ? 'Songs could not be loaded. Reconnect and retry.' : !this.ready ? 'Loading your songs…' : this.busy ? 'Saving before switching…' : this.active.status === 'SAVED ON DISK' ? 'Saved to this computer · Autosave is on' : this.active.status === 'SAVING' ? 'Saving this song…' : this.active.draftRetained ? 'Not saved to disk. Draft kept in this browser. Press SAVE SONG to retry.' : 'Not saved. Keep this tab open and press SAVE SONG to retry.';
  }
  sync() {
    const host = document.getElementById('ss-notepad');
    if (!host) { if (this.beatAudio && !this.beatAudio.paused) this.beatAudio.pause(); return; }
    if (this.host !== host) { this.mount(host); this.loadBeat(); }
    // SONGS loads after the notepad; refresh the beat picker when the library arrives or changes.
    if ((!this.currentBeat || this.choosingBeat) && this.beatLibrary !== this.app.state.library) { this.beatLibrary = this.app.state.library; this.renderBeat(); }
    const value = this.app.state.lines.join('\n');
    if (value !== this.editor.value && !this.composing) { this.editor.value = value; this.paint(); }
    if (this.engine !== this.app.E) { this.engine = this.app.E; this.paint(); }
    this.renderSongs();
  }
  // ---- Beat saved with each song: pick it once and it opens with the lyrics. ----
  beatChoices() {
    const items = this.app.songLibrary?.collect?.() || [];
    return items.filter(item => typeof item.url === 'string' && item.url.startsWith('/') && !['Beats', 'Kits', 'Packs', 'Split packs'].includes(item.type));
  }
  clock(seconds) { const s = Math.max(0, Math.floor(seconds || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  beatAudioFor(beat) {
    if (!this.beatAudio) {
      const audio = this.beatAudio = new Audio(); audio.preload = 'metadata';
      const update = () => this.updateBeatTime();
      audio.addEventListener('loadedmetadata', update); audio.addEventListener('durationchange', update);
      audio.addEventListener('play', update); audio.addEventListener('pause', update);
      audio.addEventListener('timeupdate', () => {
        const b = this.currentBeat;
        if (b?.end != null && audio.currentTime >= b.end) { if (this.beatLoop) audio.currentTime = b.start || 0; else audio.pause(); }
        update();
      });
      audio.addEventListener('ended', () => { if (this.beatLoop) { audio.currentTime = this.currentBeat?.start || 0; audio.play().catch(() => {}); } update(); });
    }
    const audio = this.beatAudio;
    if (!beat) { audio.pause(); delete audio.dataset.beatUrl; audio.removeAttribute('src'); audio.load(); }
    else if (audio.dataset.beatUrl !== beat.url) { audio.pause(); audio.dataset.beatUrl = beat.url; audio.src = beat.url; audio.currentTime = beat.start || 0; }
    audio.volume = this.beatVolume ?? 0.8;
    return audio;
  }
  loadBeat() {
    const beat = this.active?.meta?.beat && typeof this.active.meta.beat.url === 'string' ? this.active.meta.beat : null;
    if (this.currentBeat?.url !== beat?.url) this.beatAudioFor(beat);
    this.currentBeat = beat; this.choosingBeat = false; this.renderBeat();
  }
  setBeat(item) {
    if (!this.active) return;
    const beat = item ? { name: String(item.name || 'Beat'), url: item.url, start: Number(item.start) || 0, end: item.end != null ? Number(item.end) : null, type: item.type || '' } : null;
    this.active.meta = { ...this.active.meta }; if (beat) this.active.meta.beat = beat; else delete this.active.meta.beat;
    this.save(this.editor.value.split('\n'), true);
    this.loadBeat();
    this.app.setState({ notice: beat ? 'Saved “' + beat.name + '” as the beat for this song. It opens whenever you open the song.' : 'Removed the beat from this song. It is still in SONGS.' });
  }
  renderBeat() {
    const box = this.host?.querySelector('.np-beat'); if (!box) return;
    const beat = this.currentBeat;
    if (!beat || this.choosingBeat) {
      const choices = this.beatChoices(), groups = [...new Set(choices.map(c => c.type))];
      box.innerHTML = `<label class="np-beat-pick"><span>${beat ? 'Change the beat for this song' : 'Beat for this song'}</span><select class="np-beat-select" aria-label="Choose a beat from SONGS"><option value="">${choices.length ? 'Choose a beat from SONGS…' : 'No audio in SONGS yet. Upload a beat there first.'}</option>${groups.map(g => `<optgroup label="${this.escape(g)}">${choices.filter(c => c.type === g).map(c => `<option value="${this.escape(c.key)}">${this.escape(c.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>${beat ? '<button type="button" class="np-beat-cancel">CANCEL</button>' : ''}<small>Saved with the song, so it opens with your lyrics.</small>`;
      box.querySelector('.np-beat-select').onchange = e => { const item = choices.find(c => c.key === e.target.value); if (item) this.setBeat(item); };
      box.querySelector('.np-beat-cancel')?.addEventListener('click', () => { this.choosingBeat = false; this.renderBeat(); });
      return;
    }
    box.innerHTML = `<div class="np-beat-head"><span class="np-beat-label">BEAT</span><strong class="np-beat-name" title="${this.escape(beat.name)}">${this.escape(beat.name)}</strong><button type="button" class="np-beat-change" title="Pick a different beat for this song">CHANGE</button><button type="button" class="np-beat-remove" title="Remove the beat from this song" aria-label="Remove beat from this song">✕</button></div>
      <div class="np-beat-transport"><button type="button" class="np-beat-play" aria-label="Play beat">▶</button><button type="button" class="np-beat-stop" aria-label="Stop beat and go back to the start" title="Stop">■</button><button type="button" class="np-beat-back" aria-label="Back 5 seconds" title="Back 5 seconds">−5s</button><input type="range" class="np-beat-seek" min="0" max="0" step="0.01" value="0" aria-label="Beat position"><span class="np-beat-time" role="timer">0:00 / –:––</span><label class="np-beat-loop" title="Start the beat over when it ends"><input type="checkbox" ${this.beatLoop ? 'checked' : ''}> Loop</label><label class="np-beat-vol" title="Beat volume"><span aria-hidden="true">VOL</span><input type="range" min="0" max="1" step="0.01" value="${this.beatVolume ?? 0.8}" aria-label="Beat volume"></label></div>`;
    const audio = this.beatAudioFor(beat), start = () => beat.start || 0;
    box.querySelector('.np-beat-play').onclick = () => { if (audio.paused) audio.play().catch(e => this.app.setState({ notice: 'Could not play the beat: ' + e.message })); else audio.pause(); };
    box.querySelector('.np-beat-stop').onclick = () => { audio.pause(); audio.currentTime = start(); this.updateBeatTime(); };
    box.querySelector('.np-beat-back').onclick = () => { audio.currentTime = Math.max(start(), audio.currentTime - 5); this.updateBeatTime(); };
    box.querySelector('.np-beat-seek').oninput = e => { audio.currentTime = start() + Number(e.target.value); this.updateBeatTime(); };
    box.querySelector('.np-beat-loop input').onchange = e => { this.beatLoop = e.target.checked; };
    box.querySelector('.np-beat-vol input').oninput = e => { this.beatVolume = Number(e.target.value); audio.volume = this.beatVolume; };
    box.querySelector('.np-beat-change').onclick = () => { this.choosingBeat = true; this.renderBeat(); };
    box.querySelector('.np-beat-remove').onclick = () => { if (window.confirm('Remove “' + beat.name + '” from this song? The beat stays in SONGS.')) this.setBeat(null); };
    this.updateBeatTime();
  }
  updateBeatTime() {
    const box = this.host?.querySelector('.np-beat'), beat = this.currentBeat, audio = this.beatAudio;
    if (!box || !beat || !audio || !box.querySelector('.np-beat-time')) return;
    const start = beat.start || 0, end = beat.end != null ? beat.end : (Number.isFinite(audio.duration) ? audio.duration : 0);
    const length = Math.max(0, end - start), at = Math.min(length, Math.max(0, audio.currentTime - start));
    box.querySelector('.np-beat-time').textContent = this.clock(at) + ' / ' + (length ? this.clock(length) : '–:––');
    const seek = box.querySelector('.np-beat-seek'); seek.max = String(length); if (document.activeElement !== seek) seek.value = String(at);
    const play = box.querySelector('.np-beat-play'); play.textContent = audio.paused ? '▶' : '❚❚'; play.setAttribute('aria-label', audio.paused ? 'Play beat' : 'Pause beat');
  }
  mount(host) {
    this.host = host; this.listSignature = null; // a fresh page needs the song list drawn again
    host.innerHTML = `<div class="np-top"><div><small>SCREWSHOP / VERSE BOOK</small><h2>Notepad</h2></div><div class="np-count" aria-live="polite"></div><label><input class="np-highlight" type="checkbox" checked> Rhyme colors</label><button class="np-tools-toggle" aria-expanded="true">WORD DESK</button></div>
    <div class="np-layout"><aside class="np-songs" aria-label="Written songs"><div class="np-songs-heading"><h3>MY SONGS</h3><span class="np-song-total"></span></div><button type="button" class="np-new-song">+ NEW SONG</button><p class="np-songs-help">Pick a song to keep writing. Each song has its own page.</p><button type="button" class="np-retry-load" hidden>RETRY LOAD</button><nav class="np-song-list" aria-label="Choose a song"></nav></aside><section class="np-paper" aria-label="College ruled notebook"><div class="np-paper-title"><form class="np-song-form"><label>Song name<input class="np-song-title" aria-label="Song name" maxlength="160" placeholder="Name this song"></label><button class="np-save-song" type="submit">SAVE SONG</button></form><div class="np-beat" aria-label="Beat for this song"></div><span class="np-song-status" role="status"></span><span>College ruled &middot; one line = one bar</span></div><div class="np-sheet"><div class="np-numbers" aria-hidden="true"></div><div class="np-text"><div class="np-mirror" aria-hidden="true"></div><textarea class="np-editor" aria-label="Verse notebook" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Start your verse here..."></textarea></div></div><footer>Return for a new bar. Arrow keys to move. Blank lines separate sections.</footer></section>
    <aside class="np-desk" aria-label="Word desk"><h3>WORD DESK</h3><p>Look up a word when you need one.</p><form class="np-search"><label>Word or phrase<input class="np-query" maxlength="100" placeholder="e.g. night, change, paper" required></label><label>Dictionary<select class="np-mode"><option value="rhyme">Rhymes (offline)</option><option value="syn">Thesaurus</option><option value="hom">Homophones / wordplay</option><option value="meaning">Meanings / double entendres</option></select></label><button type="submit" class="np-lookup">FIND RHYMES</button></form><p class="np-privacy">Local rhyme dictionary. Nothing is searched while you write.</p><div class="np-results" aria-live="polite">Your words, your choices.</div><a class="np-external" target="_blank" rel="noopener noreferrer" href="https://www.rhymezone.com/">Open RhymeZone dictionary &#8599;</a>
    <details><summary>Wordplay &amp; double entendres</summary><p>A double entendre is a line that supports two meanings. A dictionary supplies meanings and sound-alikes; you supply the connection.</p><p><b>Two meanings:</b> a bar can be a lyric, a place to drink, or a barrier. A key can open a lock or set a musical pitch.</p><p><b>Sound-alikes:</b> write / right, sole / soul. Try the homophone lookup.</p><p><b>Build it:</b> pick two meanings, list details from each, then write a setup that makes both readings work. Read it aloud to check the turn.</p></details>
    <details><summary>Rhyme schemes &amp; writing tips</summary><p><b>AABB:</b> two rhyming pairs. Land a thought every two bars.</p><p><b>ABAB:</b> alternate two end sounds to stretch a thought across four bars.</p><p><b>AAAA:</b> hold one sound, then change it at a section boundary.</p><p><b>Internal rhyme:</b> rhyme inside the line as well as at the end. <b>Multis:</b> match several stressed syllables, not just the last word.</p><p>Write the idea first. Leave space for breath. Say the verse over the beat; the written bar count is a guide, not a timing measurement.</p><p>Colors group likely shared sounds. Pronunciation and delivery decide what works.</p></details><small>Online word data: <a href="https://www.datamuse.com/api/" target="_blank" rel="noopener noreferrer">Datamuse</a>. Definitions: WordNet / Wiktionary. No subscription in ScrewShop.</small></aside></div>`;
    this.editor = host.querySelector('.np-editor'); this.editor.value = this.app.state.lines.join('\n');
    host.querySelector('.np-new-song').addEventListener('click', () => this.newSong());
    const list = host.querySelector('.np-song-list');
    list.addEventListener('click', event => {
      const dots = event.target.closest('[data-song-menu]');
      if (dots) { window.ItemMenu.toggle(dots, this.songMenu(dots.dataset.songMenu), {title: this.title(this.documents.find(d => d.id === dots.dataset.songMenu) || {title: ''}), label: 'Song actions'}); return; }
      const button = event.target.closest('[data-song-id]'); if (button) this.chooseSong(button.dataset.songId);
    });
    // Right-click a song: the same menu as its ⋮ button.
    list.addEventListener('contextmenu', event => {
      const button = event.target.closest('[data-song-id]'); if (!button || button.disabled) return;
      event.preventDefault();
      const song = this.documents.find(d => d.id === button.dataset.songId);
      if (song) window.ItemMenu.show(event, this.songMenu(song.id), {title: this.title(song), label: 'Song actions'});
    });
    list.addEventListener('keydown', event => {
      const id = event.target.closest('[data-song-id]')?.dataset.songId;
      if (id && event.key === 'Delete') { event.preventDefault(); this.deleteSong(id); }
    });
    host.querySelector('.np-retry-load').addEventListener('click', () => this.load());
    host.querySelector('.np-song-title').addEventListener('input', event => {
      if (!this.active) return;
      this.active.title = event.target.value; this.app.setState({ lyricTitle: event.target.value }); this.save(this.editor.value.split('\n'));
    });
    host.querySelector('.np-song-title').addEventListener('blur', () => {
      if (this.active && !this.active.title.trim()) { this.active.title = 'Untitled song'; host.querySelector('.np-song-title').value = this.active.title; this.save(this.editor.value.split('\n')); }
    });
    host.querySelector('.np-song-form').addEventListener('submit', event => { event.preventDefault(); this.flush(); });
    this.editor.addEventListener('compositionstart', () => { this.composing = true; });
    this.editor.addEventListener('compositionend', () => { this.composing = false; this.changed(); });
    this.editor.addEventListener('input', () => this.changed());
    host.querySelector('.np-sheet').addEventListener('click', e => {
      if (e.target === this.editor) return;
      this.editor.focus(); this.editor.setSelectionRange(this.editor.value.length, this.editor.value.length);
    });
    host.querySelector('.np-highlight').addEventListener('change', () => this.paint());
    host.querySelector('.np-tools-toggle').addEventListener('click', e => { const hidden = host.classList.toggle('np-hide-desk'); e.currentTarget.setAttribute('aria-expanded', String(!hidden)); this.paint(); });
    host.querySelector('.np-mode').addEventListener('change', () => {
      this.request?.abort(); this.lookupVersion = (this.lookupVersion || 0) + 1;
      const offline = host.querySelector('.np-mode').value === 'rhyme';
      host.querySelector('.np-lookup').textContent = offline ? 'FIND RHYMES' : 'LOOK UP ONLINE';
      host.querySelector('.np-privacy').textContent = offline ? 'Local rhyme dictionary. Nothing is searched while you write.' : 'Search sends only the word you enter to Datamuse. Internet required.';
      host.querySelector('.np-results').textContent = 'Enter a word and press Search when you need it.';
    });
    host.querySelector('.np-search').addEventListener('submit', e => { e.preventDefault(); this.lookup(); });
    this.paint(); this.renderSongs();
  }
  changed() {
    const lines = this.editor.value.split('\n');
    this.app.setState({ lines, edit: -1, word: null }); this.app.saveSong(lines);
    this.paint(false); clearTimeout(this.paintTimer); this.paintTimer = setTimeout(() => this.paint(), 180);
  }
  paint(analyze = true) {
    if (!this.host?.isConnected) return;
    const lines = this.editor.value.split('\n'), mirror = this.host.querySelector('.np-mirror');
    const active = lines.filter(l => l.trim()).length;
    this.host.querySelector('.np-count').textContent = active + ' BARS / ' + lines.length + ' LINES';
    const colored = this.host.querySelector('.np-highlight').checked;
    if (analyze) this.families = colored && this.app.E ? this.app.E.rhymeFamilies(lines, 'Rap') : null;
    const families = colored ? this.families : null;
    const scheme = new Map(); let next = 0;
    mirror.innerHTML = lines.map((line, li) => {
      let wi = -1, last = null;
      if (/^\s/.test(line)) wi = 0;
      const text = line.split(/(\s+)/).map(token => {
        if (/^\s*$/.test(token)) return this.escape(token);
        wi++; const family = families?.of(li, wi);
        last = family;
        if (family == null) return this.escape(token);
        return '<mark style="background:' + this.colors[family % this.colors.length] + '">' + this.escape(token) + '</mark>';
      }).join('');
      let letter = '';
      if (last != null) { if (!scheme.has(last)) scheme.set(last, String.fromCharCode(65 + next++)); letter = scheme.get(last); }
      return '<div class="np-line" data-scheme="' + letter + '">' + (text || '<br>') + '</div>';
    }).join('');
    this.editor.style.height = mirror.offsetHeight + 'px';
    const nums = this.host.querySelector('.np-numbers');
    nums.innerHTML = Array.from(mirror.children).map((row, i) => '<span style="top:' + row.offsetTop + 'px">' + String(i + 1).padStart(2,'0') + '<b>' + row.dataset.scheme + '</b></span>').join('');
  }
  async lookup() {
    const host = this.host, word = host.querySelector('.np-query').value.trim(); if (!word) return;
    const mode = host.querySelector('.np-mode').value, results = host.querySelector('.np-results');
    const version = this.lookupVersion = (this.lookupVersion || 0) + 1;
    this.request?.abort();
    const external = host.querySelector('.np-external');
    external.href = 'https://www.rhymezone.com/r/rhyme.cgi?' + new URLSearchParams({Word: word, typeofrhyme: {rhyme:'perfect',syn:'syn',hom:'hom',meaning:'def'}[mode]});
    if (mode === 'rhyme') {
      if (!this.app.E) { results.textContent = 'Local rhyme dictionary is loading. Try again in a moment.'; return; }
      const words = this.app.E.getRhymes(word, 'slant', {pool:'words',limit:35});
      this.showResults(results, words.map(w => ({word:w.word, note:w.tier + ' rhyme'}))); return;
    }
    results.textContent = 'Looking up ' + word + '...';
    const request = this.request = new AbortController(); const timeout = setTimeout(() => request.abort(), 10000);
    try {
      const query = new URLSearchParams({max:'35',md:'d'});
      query.set(mode === 'meaning' ? 'sp' : 'rel_' + mode, word);
      if (mode === 'meaning') query.set('qe','sp');
      const response = await fetch('https://api.datamuse.com/words?' + query, {signal:request.signal, credentials:'omit', referrerPolicy:'no-referrer'});
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json(); if (!Array.isArray(data)) throw new Error('invalid');
      if (version !== this.lookupVersion || host !== this.host) return;
      this.showResults(results, data.filter(w => typeof w.word === 'string').map(w => ({word:w.word, note:(w.defs || []).slice(0,4).join('; ').replace(/\t/g, ': ')})));
    } catch (_) {
      if (version === this.lookupVersion && host === this.host) results.textContent = 'Online lookup is unavailable. Use the RhymeZone link below, or try again later. Your writing is saved locally.';
    } finally { clearTimeout(timeout); }
  }
  showResults(host, words) {
    host.replaceChildren();
    if (!words.length) { host.textContent = 'No matches found. Try another word or the full RhymeZone dictionary.'; return; }
    words.forEach(w => { const row = document.createElement('div'); row.className = 'np-result'; const title = document.createElement('strong'); title.textContent = w.word; row.append(title); if (w.note) { const note = document.createElement('small'); note.textContent = w.note; row.append(note); } host.append(row); });
  }
};
