/* One browser over the existing local library, stems, recordings and sampler saves. */
window.SongLibrary = class {
  constructor(app) {
    this.app = app; this.category = 'All'; this.search = ''; this.sort = 'newest';
    this.groups = new Map(); this.hidden = new Set(); this.lastFetch = 0;
    this.polishJobs = []; this.polishPreset = 'engineer'; this.polishStrength = 'gentle'; this.mixName = ''; this.matchLoudness = new Map();
    this.timer = setInterval(() => this.refresh(), 350); this.refresh();
  }
  esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  notify(message) { this.app.setState({notice: message}); }
  async checked(query) { return this.app.studio.checked(query); }
  url(raw, bucket = 'beats') { return raw.url || (raw.storage_path ? this.app.studio.url(raw.bucket || bucket, raw.storage_path) : null); }
  refresh() {
    if (this.disposed) return;
    const host = document.getElementById('ss-song-library');
    if (!host) { if (this.host) { this.stopPreview(); this.releaseComparison(this.host); } this.host = null; return; }
    if (host !== this.host) { if (this.host) this.releaseComparison(this.host); this.host = host; this.mount(); this.signature = ''; }
    if (this.app.sb && !this.polishFetching && Date.now() - (this.lastPolishFetch || 0) > 2000) this.fetchPolishJobs();
    const workspace = this.app.workspace;
    if (workspace && this.app.sb && Date.now() - this.lastFetch > 5000) {
      this.lastFetch = Date.now(); workspace.refreshLibrary().catch(error => this.notify(error.message));
    }
    const signature = JSON.stringify([this.app.state.library, this.app.state.allStems, this.app.state.splitJobs, workspace?.folders, workspace?.takes, workspace?.beats, workspace?.kits, workspace?.chops, [...this.hidden]]);
    // Polling must not replace the name a person is typing, or disrupt a drag.
    if (signature !== this.signature && !this.dragging && !this.host.querySelector('[data-name]:focus')) {
      this.signature = signature; this.render();
    }
  }
  mount() {
    this.host.innerHTML = `<section class="ss-library" aria-label="Song and sound library">
      <header class="ss-library-heading"><div><span class="ss-eyebrow">YOUR WORKSPACE</span><h2>Songs & sounds</h2><p>Find an original, an edit, or a sound and keep creating.</p></div><div class="ss-library-import"><button data-upload class="ss-primary">+ UPLOAD FILE</button><button data-import-folder>Import folder</button></div></header>
      <section class="ss-studio-save" aria-label="Save your Studio mix"><div><span class="ss-eyebrow">FROM STUDIO TO SONGS</span><h3>Keep your latest mix</h3><p>Save the current arrangement as a WAV. Your editable Studio session stays available.</p></div><div class="ss-studio-save-form"><label>Mix name<input data-mix-name type="text" maxlength="160" aria-label="Studio mix name" placeholder="Give your mix a name" value="${this.esc(this.mixName)}"></label><button data-save-studio class="ss-primary">SAVE STUDIO MIX TO SONGS</button></div><p data-mix-status class="ss-inline-status" role="status">${this.esc(this.mixStatus || '')}</p></section>
      <section class="ss-polish" aria-label="Mix and clarity"><header><div><span class="ss-eyebrow">A FRESH LISTEN</span><h3>Mix & clarity</h3><p>Polish a finished mix with gentle tone, dynamics and loudness processing. Your original is kept.</p></div><span class="ss-polish-badge">PROCESSED ON YOUR COMPUTER</span></header>
      <div class="ss-polish-workbench"><div class="ss-polish-source"><div class="ss-polish-drop" tabindex="0" role="button" aria-label="Choose or drop audio to polish"><span aria-hidden="true">↥</span><strong>Drop a song here</strong><span>or choose audio from your phone or computer</span><button data-polish-file>CHOOSE AUDIO FILE</button><input data-polish-input type="file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aiff,.aif" hidden></div><div data-polish-selected class="ss-polish-selected" ${this.polishSource ? '' : 'hidden'}></div><p class="ss-polish-source-hint">Already in SONGS? Open a song’s More menu and choose <strong>Polish mix</strong>.</p></div>
      <div class="ss-polish-settings"><label>Sound direction<select data-polish-preset aria-label="Polish sound direction"><option value="engineer">Engineer mix (split, mix, master)</option><option value="balanced">Balanced polish</option><option value="vocal">Vocal clarity polish</option><option value="warm">Warm polish</option></select></label><p data-polish-preset-note></p><label>Processing strength<select data-polish-strength aria-label="Polish processing strength"><option value="gentle">Gentle</option><option value="standard">Standard</option></select></label><label>Version name<input data-polish-name type="text" maxlength="160" aria-label="Polished version name" placeholder="Choose a song first" value="${this.esc(this.polishName || '')}"></label><button data-start-polish class="ss-primary" ${this.polishSource ? '' : 'disabled'}>CREATE POLISHED VERSION</button><p data-polish-status class="ss-inline-status" role="status">${this.esc(this.polishStatus || '')}</p></div></div>
      <p class="ss-polish-note">Engineer mix rebalances vocals against the beat using AI stem separation; the polish options process the whole file. For hands-on control, use separate tracks and the MIXER in STUDIO. Compare both versions and keep the one you prefer.</p><div class="ss-polish-jobs" aria-label="Polished versions and progress"></div></section>
      <div class="ss-library-browser"><nav class="ss-library-categories" aria-label="Library categories"></nav><div class="ss-library-content">
      <div class="ss-library-toolbar"><label class="ss-library-search"><span aria-hidden="true">⌕</span><input type="search" data-search aria-label="Search songs and sounds" placeholder="Search songs, sounds, or instruments"></label><label class="ss-library-sort">Sort<select data-sort aria-label="Sort songs and sounds"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option><option value="type">Type</option></select></label></div>
      <p class="ss-library-count" role="status"></p><div class="ss-library-results"></div></div></div>
      <div class="ss-library-preview" hidden><button data-stop-preview aria-label="Stop audio preview" title="Stop">■</button><button data-toggle-preview aria-label="Pause preview" title="Play / pause">❚❚</button><span data-preview-name></span><input data-preview-seek type="range" min="0" max="0" step="0.01" value="0" aria-label="Preview position"><span data-preview-time class="ss-preview-time" role="timer" aria-live="off">0:00 / 0:00</span><audio preload="metadata" aria-label="Library audio preview"></audio></div>
      <dialog class="ss-pad-dialog" aria-label="Load sound into sampler pad"><form method="dialog"><h3>Load into sampler</h3><p data-pad-source></p><label>Choose a pad<select data-song-pad aria-label="Choose sampler pad"></select></label><p data-pad-detail></p><div><button value="cancel">Cancel</button><button type="button" data-confirm-pad class="ss-primary" disabled>LOAD PAD</button></div><p data-pad-status role="status"></p></form></dialog>
      </section>`;
    this.host.querySelector('[data-upload]').onclick = () => this.app.uploadToLibrary();
    this.host.querySelector('[data-import-folder]').onclick = () => this.run(() => this.app.workspace.importFiles(true));
    const search = this.host.querySelector('[data-search]'); search.value = this.search;
    search.oninput = () => { this.search = search.value; this.render(); };
    const sort = this.host.querySelector('[data-sort]'); sort.value = this.sort;
    sort.onchange = () => { this.sort = sort.value; this.render(); };
    this.host.querySelector('[data-stop-preview]').onclick = () => this.stopPreview();
    this.host.querySelector('[data-toggle-preview]').onclick = () => { const audio = this.host.querySelector('.ss-library-preview audio'); if (audio.paused) audio.play().catch(error => this.notify('Preview failed: ' + error.message)); else audio.pause(); };
    this.host.querySelector('[data-preview-seek]').oninput = event => { const audio = this.host.querySelector('.ss-library-preview audio'); audio.currentTime = (this.previewItem?.start || 0) + Number(event.target.value); this.updatePreviewTime(); };
    this.mountMixAndPolish();
    this.host.onclick = event => {
      const dots = event.target.closest('[data-row-menu]');
      if (dots) { const item = this.items.find(x => x.key === dots.closest('[data-entry]')?.dataset.entry); if (item) this.openMenu(item, dots); return; }
      const button = event.target.closest('[data-category],[data-library-action]');
      if (!button || button.disabled) return;
      if (button.dataset.category) { this.category = button.dataset.category; this.render(); return; }
      const item = this.items.find(x => x.key === button.closest('[data-entry]')?.dataset.entry);
      if (item) this.run(() => this.action(button.dataset.libraryAction, item));
    };
    // Right-click a row: the same menu as its ⋮ button. Text boxes keep the normal copy/paste menu.
    this.host.oncontextmenu = event => {
      const row = event.target.closest('.ss-library-row'); if (!row || event.target.closest('input')) return;
      const item = this.items.find(x => x.key === row.dataset.entry); if (!item) return;
      event.preventDefault(); this.openMenu(item, event, row.querySelector('[data-row-menu]'));
    };
    // Delete key on a focused row (not while typing a name); Shift+F10 / Menu key opens its menu.
    this.host.onkeydown = event => {
      const row = event.target.closest('.ss-library-row'); if (!row || event.target.closest('input')) return;
      const item = this.items.find(x => x.key === row.dataset.entry); if (!item) return;
      if (event.key === 'Delete') { event.preventDefault(); this.run(() => this.remove(item)); }
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const dots = row.querySelector('[data-row-menu]'); this.openMenu(item, dots, dots); }
    };
    this.host.onchange = event => {
      if (!event.target.matches('[data-name]')) return;
      const item = this.items.find(x => x.key === event.target.closest('[data-entry]').dataset.entry);
      const name = event.target.value.trim();
      if (!name) { event.target.value = item.name; this.notify('Enter a name before saving.'); return; }
      this.run(() => this.rename(item, name));
    };
    this.host.ondragstart = event => {
      const item = this.items.find(x => x.key === event.target.closest('[data-entry]')?.dataset.entry);
      if (!item?.url || event.target.closest('input,button,a,summary')) { event.preventDefault(); return; }
      this.dragging = true; event.dataTransfer.setData('application/x-screwshop-loop', JSON.stringify(item)); event.dataTransfer.effectAllowed = 'copy';
    };
    this.host.ondragend = () => { this.dragging = false; this.refresh(); };
  }
  mountMixAndPolish() {
    const query = selector => this.host.querySelector(selector);
    query('[data-mix-name]').oninput = event => { this.mixName = event.target.value; };
    query('[data-save-studio]').onclick = async () => {
      const button = query('[data-save-studio]'); button.disabled = true;
      this.mixStatus = 'Rendering your Studio arrangement…'; query('[data-mix-status]').textContent = this.mixStatus;
      try {
        const row = await this.app.workspace.saveStudioToSongs(this.mixName.trim());
        this.mixStatus = 'Saved “' + row.name + '” in Studio mixes.';
        this.category = 'Studio mixes'; this.signature = ''; this.refresh();
      } catch (error) { this.mixStatus = 'Mix was not saved: ' + error.message + ' You can retry.'; }
      if (this.host) { query('[data-mix-status]').textContent = this.mixStatus; query('[data-save-studio]').disabled = false; }
    };
    const fileInput = query('[data-polish-input]'), drop = query('.ss-polish-drop');
    query('[data-polish-file]').onclick = () => fileInput.click();
    drop.onclick = event => { if (event.target === drop || !event.target.closest('button,input')) fileInput.click(); };
    drop.onkeydown = event => { if (event.target === drop && ['Enter', ' '].includes(event.key)) { event.preventDefault(); fileInput.click(); } };
    fileInput.onchange = () => { if (fileInput.files?.[0]) this.uploadPolishFile(fileInput.files[0]); fileInput.value = ''; };
    drop.ondragover = event => { event.preventDefault(); drop.classList.add('ss-drop-active'); event.dataTransfer.dropEffect = 'copy'; };
    drop.ondragleave = event => { if (!drop.contains(event.relatedTarget)) drop.classList.remove('ss-drop-active'); };
    drop.ondrop = event => {
      event.preventDefault(); event.stopPropagation(); drop.classList.remove('ss-drop-active');
      const raw = event.dataTransfer.getData('application/x-screwshop-loop');
      if (raw) { try { this.selectPolishSource(JSON.parse(raw)); } catch (error) { this.setPolishStatus(error.message || 'This sound could not be selected. Try choosing an audio file.'); } }
      else if (event.dataTransfer.files?.[0]) this.uploadPolishFile(event.dataTransfer.files[0]);
    };
    query('[data-polish-preset]').value = this.polishPreset;
    query('[data-polish-strength]').value = this.polishStrength;
    query('[data-polish-preset]').onchange = event => { this.polishPreset = event.target.value; this.updatePresetNote(); };
    query('[data-polish-strength]').onchange = event => { this.polishStrength = event.target.value; };
    query('[data-polish-name]').oninput = event => { this.polishName = event.target.value; };
    query('[data-start-polish]').onclick = () => this.queuePolish();
    query('.ss-polish-jobs').onclick = event => {
      const button = event.target.closest('[data-polish-retry]');
      if (button) this.retryPolish(button.dataset.polishRetry, button);
    };
    // Comparing files should never stack two players over one another.
    this.host.addEventListener('play', event => { if (event.target.tagName === 'AUDIO') this.host.querySelectorAll('audio').forEach(audio => { if (audio !== event.target) audio.pause(); }); }, true);
    query('[data-song-pad]').onchange = event => {
      const index = event.target.value, slot = index === '' ? null : this.app.workspace.slots[+index];
      query('[data-confirm-pad]').disabled = index === '';
      query('[data-confirm-pad]').textContent = +index >= 16 ? 'LOAD INSTRUMENT' : 'LOAD PAD';
      query('[data-pad-detail]').textContent = index === '' ? '' : slot ? 'Currently: ' + slot.name + '. Replacing it needs confirmation.' : 'This destination is empty.';
    };
    query('[data-confirm-pad]').onclick = async () => {
      const index = query('[data-song-pad]').value; if (index === '' || !this.padSource) return;
      const current = this.app.workspace.slots[+index];
      const destination = +index >= 16 ? 'Instrument ' + (+index - 15) : 'Pad ' + (+index + 1);
      if (current && !confirm('Replace ' + destination + ' (“' + current.name + '”) with “' + this.padSource.name + '”?')) return;
      const button = query('[data-confirm-pad]'); button.disabled = true; query('[data-pad-status]').textContent = 'Loading sound…';
      try { await this.app.workspace.loadSongToPad(this.padSource, +index); query('.ss-pad-dialog')?.close(); }
      catch (error) { if (this.host) { query('[data-pad-status]').textContent = error.message; button.disabled = false; } }
    };
    this.updatePresetNote(); this.renderPolishSource(); this.renderPolishJobs();
  }
  updatePresetNote() {
    const descriptions = {engineer:'Splits the song into vocals, drums, bass and music, mixes each part like an engineer (EQ, compression, de-essing, space for the vocal), brings the vocal forward, then masters to -14 LUFS. Takes about twice the song length.',balanced:'A restrained starting point for a complete mix.',vocal:'Adds a subtle presence lift. It affects the whole mix, including instruments.',warm:'A smoother tonal balance with restrained brightness.'};
    this.host.querySelector('[data-polish-preset-note]').textContent = descriptions[this.polishPreset];
  }
  setPolishStatus(message) { this.polishStatus = message; const status = this.host?.querySelector('[data-polish-status]'); if (status) status.textContent = message; }
  localSource(item) {
    if (item.storage_path) return {storage_path:item.storage_path, bucket:item.bucket || (item.type === 'Stems' ? 'stems' : item.type === 'Recordings' ? 'takes' : 'beats')};
    const url = new URL(item.url || '', location.href), match = url.pathname.match(/^\/audio\/(beats|stems|takes)\/(.+)$/);
    if (url.origin !== location.origin || !match) throw Error('Choose an audio file stored in SONGS on this computer.');
    return {bucket:match[1],storage_path:match[2].split('/').map(decodeURIComponent).join('/')};
  }
  selectPolishSource(item) {
    if (this.isTrimmed(item)) throw Error('This sound is a trimmed phrase. Add it to STUDIO, save a mix to SONGS, then polish that file.');
    this.localSource(item); this.polishSource = {...item}; this.polishName = item.name + ' · polished';
    this.setPolishStatus('Ready to create a separate polished version.'); this.renderPolishSource();
    this.host?.querySelector('.ss-polish')?.scrollIntoView({behavior:'smooth',block:'start'});
  }
  isTrimmed(item) { return item.type === 'Chops' || +item.start > 0 || item.end != null; }
  renderPolishSource() {
    if (!this.host) return;
    const selected = this.host.querySelector('[data-polish-selected]'), item = this.polishSource;
    selected.hidden = !item;
    if (item) selected.innerHTML = `<span class="ss-eyebrow">SELECTED SONG</span><strong>${this.esc(item.name)}</strong><small>Full source file · original kept</small>`;
    this.host.querySelector('[data-polish-name]').value = this.polishName || '';
    this.host.querySelector('[data-start-polish]').disabled = !item || !!this.polishUploading || !!this.polishQueuing;
  }
  async uploadPolishFile(file) {
    if (this.polishUploading) return;
    if (!/^audio\//i.test(file.type) && !/\.(mp3|wav|m4a|flac|ogg|aiff?|aac|webm|mp4)$/i.test(file.name)) { this.setPolishStatus('Choose an audio file such as WAV, MP3 or M4A.'); return; }
    if (!this.app.sb || !this.app.state.session) { this.setPolishStatus('Connect to your ScrewShop computer first.'); return; }
    this.polishUploading = true; this.setPolishStatus('Saving the original song to SONGS…'); this.renderPolishSource();
    try {
      const name = file.name.replace(/\.[^.]+$/, ''), path = 'local/library/' + window.ScrewShop.id() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      await this.checked(this.app.sb.storage.from('beats').upload(path, file));
      const row = await this.checked(this.app.sb.from('library').insert({user_id:this.app.state.session.user.id,name,storage_path:path,bucket:'beats',source_kind:'imported'}).select().single());
      await this.app.loadLibrary();
      this.selectPolishSource({...row,bucket:'beats',url:this.app.studio.url('beats',path)});
      this.signature = ''; this.refresh();
    } catch (error) { this.setPolishStatus('The file was not selected: ' + error.message + ' Choose the file again to retry.'); }
    finally { this.polishUploading = false; this.renderPolishSource(); }
  }
  async polishRequest(body) {
    const response = await fetch('/api/polish', body ? {method:'POST',headers:{'X-ScrewShop':'1','Content-Type':'application/json'},body:JSON.stringify(body)} : {});
    const result = await response.json();
    if (!response.ok || result.error) throw Error(result.error?.message || result.error || 'The computer could not process this request.');
    return result.data;
  }
  async queuePolish() {
    if (!this.polishSource || this.polishQueuing || this.polishUploading) return;
    this.polishQueuing = true; this.renderPolishSource(); this.setPolishStatus('Queuing your polished version…');
    try {
      const source = this.polishSource;
      const job = await this.polishRequest({...this.localSource(source),source_id:source.id,name:this.polishName.trim() || source.name + ' · polished',preset:this.polishPreset,strength:this.polishStrength});
      this.polishJobs = [job,...this.polishJobs.filter(old => old.id !== job.id)]; this.renderPolishJobs();
      this.setPolishStatus('Queued. You can keep working while your computer processes the song.'); this.lastPolishFetch = 0;
    } catch (error) { this.setPolishStatus('Could not queue this song: ' + error.message + ' You can retry.'); }
    finally { this.polishQueuing = false; this.renderPolishSource(); }
  }
  async fetchPolishJobs() {
    this.polishFetching = true; this.lastPolishFetch = Date.now();
    try {
      const jobs = await this.polishRequest();
      const finished = new Set(this.polishJobs.filter(job => job.status === 'done').map(job => job.id));
      this.polishJobs = jobs || []; this.renderPolishJobs();
      if (this.polishJobs.some(job => job.status === 'done' && !finished.has(job.id))) { await this.app.loadLibrary(); this.signature = ''; }
      this.polishFetchError = false;
    } catch (error) { if (!this.polishFetchError) this.setPolishStatus('Progress is unavailable: ' + error.message + ' Reconnecting automatically.'); this.polishFetchError = true; }
    finally { this.polishFetching = false; }
  }
  async retryPolish(id, button) {
    button.disabled = true;
    try { await this.polishRequest({action:'retry',job_id:id}); this.lastPolishFetch = 0; await this.fetchPolishJobs(); }
    catch (error) { this.setPolishStatus('Could not retry: ' + error.message); button.disabled = false; }
  }
  measurement(value, unit) { return Number.isFinite(value) ? value.toFixed(1) + ' ' + unit : 'Unavailable'; }
  polishReport(report) {
    if (!report) return '';
    const rows = [['Loudness','integrated_lufs','LUFS'],['True peak','true_peak_db','dBTP'],['Loudness range','loudness_range_lu','LU']];
    return `<details class="ss-polish-report"><summary>Measured before & after</summary><table><caption>Audio measurements</caption><thead><tr><th scope="col">Measurement</th><th scope="col">Original</th><th scope="col">Polished</th></tr></thead><tbody>${rows.map(([name,key,unit]) => `<tr><th scope="row">${name}</th><td>${this.measurement(report.before?.[key],unit)}</td><td>${this.measurement(report.after?.[key],unit)}</td></tr>`).join('')}</tbody></table><p>${this.esc((report.processing || []).join(' · '))}</p>${(report.notes || []).map(note => `<p>${this.esc(note)}</p>`).join('')}<small>Listen at a similar volume when comparing. Louder does not always sound better.</small></details>`;
  }
  updateComparison(card, job) {
    const checkbox = card.querySelector('[data-match-loudness]');
    const before = job.report?.before?.integrated_lufs, after = job.report?.after?.integrated_lufs;
    const matched = checkbox?.checked && Number.isFinite(before) && Number.isFinite(after), quiet = Math.min(before,after);
    card.querySelectorAll('.ss-polish-comparison audio').forEach((audio,index) => {
      audio.listenGain = matched ? Math.min(1,10**((quiet-(index === 0 ? before : after))/20)) : 1;
      if (audio.comparisonGain) audio.comparisonGain.gain.value = audio.listenGain;
      else audio.volume = audio.listenGain;
      audio.onplay = () => {
        try {
          const context = this.app.studio.context(); context.resume().catch(() => {});
          if (!audio.comparisonGain) {
            const source = context.createMediaElementSource(audio), gain = context.createGain();
            source.connect(gain); gain.connect(context.destination); audio.comparisonGain = gain; audio.comparisonSource = source;
          }
          audio.volume = 1; audio.comparisonGain.gain.value = audio.listenGain;
        } catch (_) { audio.volume = audio.listenGain; }
      };
    });
    if (checkbox) checkbox.onchange = () => { this.matchLoudness.set(job.id,checkbox.checked); this.updateComparison(card,job); };
  }
  releaseComparison(card) { card.querySelectorAll('audio').forEach(audio => { audio.pause(); audio.comparisonSource?.disconnect(); audio.comparisonGain?.disconnect(); }); }
  renderPolishJobs() {
    const host = this.host?.querySelector('.ss-polish-jobs'); if (!host) return;
    if (!host.querySelector('.ss-polish-recent')) {
      host.innerHTML = '<div class="ss-polish-recent"></div><details class="ss-polish-history"><summary>Earlier versions <small></small></summary><div></div></details>';
      const history = host.querySelector('.ss-polish-history'); history.open = !!this.polishHistoryOpen;
      history.ontoggle = () => { if (history.isConnected) this.polishHistoryOpen = history.open; };
    }
    const recent = host.querySelector('.ss-polish-recent'), history = host.querySelector('.ss-polish-history'), previous = history.querySelector('div');
    const latestDone = this.polishJobs.find(job => job.status === 'done')?.id, latestError = this.polishJobs.find(job => job.status === 'error')?.id;
    const isRecent = job => !['done','error'].includes(job.status) || job.id === latestDone || job.id === latestError;
    const oldCount = this.polishJobs.filter(job => !isRecent(job)).length;
    history.hidden = oldCount === 0; history.querySelector('small').textContent = '(' + oldCount + ')';
    const keys = new Set(this.polishJobs.map(job => String(job.id)));
    host.querySelectorAll('[data-polish-job]').forEach(card => { if (!keys.has(card.dataset.polishJob)) { this.releaseComparison(card); card.remove(); } });
    this.polishJobs.forEach((job, index) => {
      let card = [...host.querySelectorAll('[data-polish-job]')].find(el => el.dataset.polishJob === String(job.id));
      const container = isRecent(job) ? recent : previous;
      if (!card) { card = document.createElement('article'); card.className = 'ss-polish-job'; card.dataset.polishJob = job.id; }
      const containerIndex = this.polishJobs.slice(0,index).filter(old => isRecent(old) === isRecent(job)).length;
      if (card.parentElement !== container || container.children[containerIndex] !== card) container.insertBefore(card,container.children[containerIndex] || null);
      const signature = JSON.stringify(job); if (signature === card.jobSignature) return; card.jobSignature = signature; this.releaseComparison(card);
      const status = {pending:'Queued',running:'Processing',done:'Ready in SONGS',error:'Needs attention'}[job.status] || job.status;
      const progress = Math.max(0,Math.min(100,+job.progress || 0));
      const canMatch = Number.isFinite(job.report?.before?.integrated_lufs) && Number.isFinite(job.report?.after?.integrated_lufs);
      card.innerHTML = `<header><div><strong>${this.esc(job.name)}</strong><small>${this.esc(({engineer:'Engineer mix',balanced:'Balanced',vocal:'Vocal clarity',warm:'Warm'})[job.preset] || job.preset)} · ${this.esc(job.strength)}</small></div><span class="ss-polish-job-state" data-state="${this.esc(job.status)}">${this.esc(status)}</span></header>` +
        (job.status === 'done' ? `<div class="ss-polish-comparison"><label>Original<audio controls preload="none" src="${this.esc(job.source_url || '')}" aria-label="Original ${this.esc(job.name)}"></audio></label><label>Polished<audio controls preload="none" src="${this.esc(job.result_url || '')}" aria-label="Polished ${this.esc(job.name)}"></audio></label></div>${canMatch ? `<label class="ss-loudness-match"><input type="checkbox" data-match-loudness ${this.matchLoudness.get(job.id) !== false ? 'checked' : ''}> Match listening loudness<span>Turns down the louder preview for a fair comparison.</span></label>` : ''}<a class="ss-polish-download" href="${this.esc(job.result_url || '')}" download>Download polished WAV</a>${this.polishReport(job.report)}` : job.status === 'error' ? `<p class="ss-polish-error" role="status">${this.esc(job.error_message || 'Processing could not finish.')}</p><button data-polish-retry="${this.esc(job.id)}">RETRY PROCESSING</button>` : `<div class="ss-polish-progress"><progress value="${progress}" max="100" aria-label="Processing ${this.esc(job.name)}"></progress><span>${progress}%</span></div><p role="status">${this.esc(job.stage || 'Waiting for the audio processor')}</p>`);
      if (job.status === 'done') this.updateComparison(card,job);
    });
  }
  showPadPicker(item) {
    this.padSource = item;
    const dialog = this.host.querySelector('.ss-pad-dialog');
    dialog.querySelector('[data-pad-source]').textContent = item.name;
    dialog.querySelector('[data-song-pad]').innerHTML = '<option value="">Select a destination…</option>' + Array.from({length:18},(_,index) => `<option value="${index}">${index < 16 ? 'Pad '+(index+1) : 'Instrument '+(index-15)+' (keys)'} — ${this.esc(this.app.workspace.slots[index]?.name || 'Empty')}</option>`).join('');
    dialog.querySelector('[data-pad-detail]').textContent = 'Select the destination before loading your sound.';
    dialog.querySelector('[data-pad-status]').textContent = ''; dialog.querySelector('[data-confirm-pad]').textContent = 'LOAD PAD'; dialog.querySelector('[data-confirm-pad]').disabled = true;
    dialog.showModal();
  }
  collect() {
    const state = this.app.state, workspace = this.app.workspace, result = [], seen = new Set();
    const add = (raw, type, group, bucket, extra = {}) => {
      const item = {...raw, ...extra, type, group, bucket: raw.bucket || bucket, url: this.url(raw, bucket)};
      item.key = type + ':' + (raw.id || raw.storage_path || group + ':' + raw.name);
      item.name = raw.name || raw.label || raw.kind || 'Untitled';
      const asset = item.url && item.url + ':' + (item.start || 0) + ':' + (item.end || '');
      if (asset && seen.has(asset)) return;
      if (asset) seen.add(asset);
      result.push(item);
    };
    for (const raw of state.library || []) {
      const generated = /\/[a-f0-9-]{25,}\.(wav|webm|m4a|mp3)$/i.test(raw.storage_path || '');
      const type = raw.source_kind === 'studio-mix' ? 'Studio mixes' : raw.source_kind === 'polished-version' ? 'Polished' : raw.source_stem_revision ? 'Stems' : raw.source_kind === 'screw-version' || generated ? 'Saved versions' : 'Imported';
      const group = {'Stems':'Saved stem copies','Imported':'Original audio','Studio mixes':'Your Studio mixes','Polished':'Your polished versions'}[type] || 'Your finished versions';
      add(raw, type, group, 'beats', {table: 'library'});
    }
    for (const raw of state.allStems || []) add({...raw, name: (raw.trackName || 'Track') + ' · ' + (raw.kind || 'Stem')}, 'Stems', raw.trackName || 'Separated stems', 'stems', {stem: raw});
    for (const folder of workspace?.folders || []) {
      if (folder.folder_type === 'pack') {
        result.push({...folder, key: 'Packs:' + folder.id, name: folder.name || 'Sound pack', type: 'Packs', group: 'Sound packs', table: 'settings', folder});
      } else {
        result.push({...folder,key:'Split packs:'+folder.id,name:folder.name || 'Separated track',type:'Split packs',group:'Separated tracks',table:'settings',folder});
        for (const raw of folder.files || []) add(raw, 'Stems', folder.name || 'Separated stems', 'stems', {folder});
      }
    }
    for (const raw of workspace?.takes || []) add(raw, 'Recordings', 'Studio recordings', 'takes', {table: 'takes'});
    for (const raw of workspace?.chops || []) add(raw, 'Chops', 'Saved sampler chops', raw.bucket || 'beats');
    for (const beat of workspace?.beats || []) result.push({...beat, key: 'Beats:' + beat.id, name: beat.name || 'Untitled beat', type: 'Beats', group: 'Editable sampler beats', table: 'settings', beat, url: beat.render?.url});
    for (const kit of workspace?.kits || []) result.push({...kit, key: 'Kits:' + kit.id, name: kit.name || 'Untitled kit', type: 'Kits', group: 'Sampler kits', table: 'settings', kit});
    return result.filter(item => !this.hidden.has(item.key));
  }
  date(item) { return item.created_at ? new Date(item.created_at).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'}) : ''; }
  metadata(item) {
    const buffer = this.app.studio.buffers?.get(item.url) || this.app.workspace?.buffers?.get(item.url);
    const seconds = item.end != null ? item.end - (item.start || 0) : item.duration || buffer?.duration;
    const kind = item.storage_path?.split('.').pop()?.toUpperCase();
    return [item.type, item.type === 'Beats' ? (item.beat.project?.bpm || '') + ' BPM' : item.type === 'Kits' ? (item.kit.kit?.slots?.filter(Boolean).length || 0) + ' sounds' : ['Packs','Split packs'].includes(item.type) ? (item.files?.length || 0) + ' sounds' : kind, Number.isFinite(seconds) ? Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0') : null, this.date(item)].filter(Boolean).join(' · ');
  }
  button(action, label, disabled = false, cls = '') { return `<button data-library-action="${action}" class="${cls}" ${disabled ? 'disabled' : ''}>${label}</button>`; }
  render() {
    if (!this.host?.isConnected) return;
    if (!this.renderedSearch) this.host.querySelectorAll('[data-library-group]').forEach(el => this.groups.set(el.dataset.libraryGroup, el.open));
    this.renderedSearch = this.search;
    this.items = this.collect();
    const categories = ['All', 'Imported', 'Studio mixes', 'Polished', 'Saved versions', 'Stems', 'Split packs', 'Recordings', 'Chops', 'Beats', 'Kits', 'Packs'];
    this.host.querySelector('.ss-library-categories').innerHTML = categories.map(type => `<button data-category="${type}" aria-pressed="${this.category === type}"><span>${type === 'All' ? 'All songs & sounds' : type}</span><small>${type === 'All' ? this.items.length : this.items.filter(x => x.type === type).length}</small></button>`).join('');
    const search = this.search.toLocaleLowerCase().trim();
    const visible = this.items.filter(item => (this.category === 'All' || this.category === item.type) && [item.name, item.type, item.group, item.kind].join(' ').toLocaleLowerCase().includes(search));
    visible.sort((a, b) => this.sort === 'name' ? a.name.localeCompare(b.name, undefined, {numeric:true}) : this.sort === 'type' ? a.type.localeCompare(b.type) || a.name.localeCompare(b.name) : this.sort === 'oldest' ? String(a.created_at || '').localeCompare(String(b.created_at || '')) : String(b.created_at || '').localeCompare(String(a.created_at || '')));
    this.host.querySelector('.ss-library-count').textContent = visible.length + ' ' + (visible.length === 1 ? 'item' : 'items') + (search ? ' matching “' + this.search + '”' : '') + ' · stored on this computer';
    const groups = [...new Set(visible.map(x => x.group))];
    this.parkPreview();
    this.host.querySelector('.ss-library-results').innerHTML = visible.length ? groups.map(group => `<details class="ss-library-group" data-library-group="${this.esc(group)}" ${search || this.groups.get(group) !== false ? 'open' : ''}><summary><span>${this.esc(group)}</span><small>${visible.filter(x => x.group === group).length}</small></summary><div>${visible.filter(x => x.group === group).map(item => this.row(item)).join('')}</div></details>`).join('') : `<div class="ss-library-empty"><div aria-hidden="true">♫</div><h3>${this.items.length ? 'No matching sounds' : 'Your next song starts here'}</h3><p>${this.items.length ? 'Try another search or choose a different category.' : 'Upload audio to begin. Saved versions, stems, recordings, beats and kits appear here automatically.'}</p>${this.items.length ? '<button data-category="All">Show all categories</button>' : ''}</div>`;
    this.host.querySelectorAll('[data-library-group]').forEach(el => {
      el.querySelector('summary').onclick = () => { if (!this.search) this.groups.set(el.dataset.libraryGroup, !el.open); };
      el.ontoggle = () => { if (el.isConnected && !this.search) this.groups.set(el.dataset.libraryGroup, el.open); };
    });
    this.placePreview();
  }
  row(item) {
    const name = this.esc(item.name), editable = !!item.table, ready = !!item.url;
    const nameControl = editable ? `<input data-name aria-label="Name of ${name}" value="${name}" title="Rename ${name}">` : `<strong>${name}</strong>`;
    const main = item.type === 'Beats' ? this.button('open-beat', 'Open beat') : item.type === 'Kits' ? this.button('open-kit', 'Load kit') : item.type === 'Packs' || item.type === 'Split packs' ? this.button('open-pack', 'Open pack') : this.button('studio', 'Add to Studio', !ready);
    const job = this.app.state.splitJobs[item.id], message = job && (job.error || ({pending:'Queued for separation',processing:'Separating on this computer',done:'Split complete',linking:'Preparing audio',error:'Split failed'}[job.status] || job.status));
    return `<article class="ss-library-row" data-entry="${this.esc(item.key)}" draggable="${ready}"><button class="ss-library-play" data-library-action="preview" aria-label="Preview ${name}" ${ready ? '' : 'disabled'}>▶</button><div class="ss-library-file">${nameControl}<small>${this.esc(this.metadata(item))}</small>${message ? `<span class="ss-library-job" role="status">${this.esc(message)}</span>` : ''}</div><div class="ss-library-row-actions">${main}<button class="im-dots" data-row-menu aria-haspopup="menu" aria-expanded="false" aria-label="All actions for ${name}" title="All actions (or right-click the row)">⋮</button></div></article>`;
  }
  // Everything you can do to one item, in one menu (⋮ button or right-click).
  menuItems(item) {
    const ready = !!item.url, job = this.app.state.splitJobs[item.id], splitting = ['linking','pending','processing'].includes(job?.status);
    const a = (id, label, extra = {}) => ({id, label, run: () => this.run(() => this.action(id, item)), ...extra});
    const open = item.type === 'Beats' ? [a('open-beat', 'Open beat in sampler')] : item.type === 'Kits' ? [a('open-kit', 'Load kit onto pads')] : ['Packs','Split packs'].includes(item.type) ? [a('open-pack', 'Open pack (load onto pads)')] : [];
    const audio = ready ? [
      a('preview', this.previewKey === item.key ? 'Stop preview' : 'Play preview'), '-',
      a('studio', 'Add to Studio (new track)'), a('beat', 'Use as Studio beat'),
      a('deck-a', 'Load on SCREW deck A'), a('deck-b', 'Load on SCREW deck B'), '-',
      a('sampler-pad', 'Load onto a sampler pad…'), a('chop', 'Chop a piece onto a pad…'),
    ] : [];
    const split = item.table === 'library' && ready ? ['-',
      a('quick-split', 'Quick split · vocals + music', {disabled: splitting, why: 'A split is already running for this song.'}),
      a('full-split', 'Full split · vocals, drums, bass, other + hits', {disabled: splitting, why: 'A split is already running for this song.'})] : [];
    const extra = [ready && !this.isTrimmed(item) && item.type !== 'Beats' ? a('polish', 'Polish mix…') : null, item.stem ? a('copy-stem', 'Save a copy in SONGS') : null].filter(Boolean);
    const files = [item.table ? a('rename', 'Rename') : null, ready ? a('download', 'Download audio') : null,
      item.beat || item.kit ? a('download-source', 'Download editable source (.json)') : item.folder && ['Packs','Split packs'].includes(item.type) ? a('download-source', 'Download pack list (.json)') : null].filter(Boolean);
    const del = this.deleteBlock(item);
    return [...open, ...(open.length ? ['-'] : []), ...audio, ...split, ...(extra.length ? ['-', ...extra] : []), '-', ...files, '-',
      a('delete', 'Delete…', {danger: true, hint: 'Del', disabled: !!del, why: del})];
  }
  openMenu(item, at, anchor = at instanceof Element ? at : null) {
    window.ItemMenu.show(at, this.menuItems(item), {title: item.name + ' · ' + item.type, anchor, label: 'Actions'});
  }
  // Why an item can't be deleted right now (or '' when it can).
  deleteBlock(item) {
    const ws = this.app.workspace;
    if (item.type === 'Beats' && ws?.project && item.id === 'sampler-beat-' + ws.project.id) return 'This beat is open in the sampler. Open or start another beat first, then delete it.';
    if (item.type === 'Stems' && !item.stem && !item.folder && !item.table) return 'This stem has no saved record to delete.';
    if (this.app.state.splitJobs[item.id] && ['linking','pending','processing'].includes(this.app.state.splitJobs[item.id].status)) return 'Wait for the split to finish before deleting this song.';
    return '';
  }
  async run(action) { try { await action(); } catch (error) { this.notify('Library action failed: ' + error.message); } }
  async rename(item, name) {
    const field = item.table === 'takes' ? 'label' : 'name';
    await this.checked(this.app.sb.from(item.table).update({[field]:name}).eq('id', item.id));
    if (item.table === 'library') await this.app.loadLibrary(); else await this.app.workspace.refreshLibrary();
    this.signature = ''; this.refresh();
  }
  async action(action, item) {
    const workspace = this.app.workspace;
    if (action === 'preview') return this.preview(item);
    if (action === 'polish') return this.selectPolishSource(item);
    if (action === 'sampler-pad') return this.showPadPicker(item);
    if (action === 'chop') { this.app.setState({tab:'packs'}); return workspace.openClip(item); }
    if (action === 'studio') { const clip = await this.app.studio.addClip(null, item, this.app.studio.cursor); if (clip) this.app.setState({tab:'studio'}); return; }
    if (action === 'beat') return item.table === 'library' ? this.app.setAsBeat(item) : this.app.studio.setBeat(item);
    if (action === 'deck-a' || action === 'deck-b') return this.app.loadDeckFromLibrary(action === 'deck-a' ? 'A' : 'B', item);
    if (action === 'quick-split' || action === 'full-split') return this.app.requestSplit(item, action === 'quick-split' ? 'quick' : 'full');
    if (action === 'copy-stem') return this.app.reuseStem(item.stem);
    if (action === 'delete') return this.remove(item);
    if (action === 'rename') {
      const input = this.host.querySelector(`[data-entry="${CSS.escape(item.key)}"] [data-name]`);
      if (input) { input.scrollIntoView({block: 'nearest'}); input.focus(); input.select(); }
      return;
    }
    if (action === 'download') {
      const anchor = document.createElement('a'); anchor.href = item.url; anchor.download = ''; document.body.append(anchor); anchor.click(); anchor.remove(); return;
    }
    if (action === 'open-pack') { this.app.setState({tab:'packs'}); return workspace.openPack(item.folder.id); }
    if (action === 'open-beat' || action === 'open-kit') {
      if (workspace.playing || workspace.recording) throw Error('Stop sampler playback or recording before opening another save.');
      // Opening another source preserves the current editable beat first.
      await this.checked(this.app.sb.from('settings').upsert({id:'sampler-beat-'+workspace.project.id,kind:'sampler-beat',name:workspace.project.name,project:workspace.snapshot(),render:workspace.lastRender||null}));
      workspace.checkpoint();
      if (action === 'open-beat') await workspace.restore(item.beat.project);
      else { workspace.stop(); Object.assign(workspace.project, JSON.parse(JSON.stringify(item.kit.kit))); workspace.project.kitId = item.kit.id; workspace.syncLegacy(); await workspace.prepare(); workspace.changed(); workspace.draw(); workspace.prune(); }
      this.app.setState({tab:'packs'}); return;
    }
    if (action === 'download-source') {
      const content = item.beat ? {version:1, name:item.name, project:item.beat.project} : item.kit ? {version:1, name:item.name, kit:item.kit.kit} : {version:1,name:item.name,files:item.files};
      const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], {type:'application/json'}));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name.replace(/[^\w .-]/g, '_') + '.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  // DELETE: gone from the list at once, UNDO for 10 seconds, then the computer moves it to Deleted Files.
  async remove(item) {
    const block = this.deleteBlock(item); if (block) throw Error(block);
    const ws = this.app.workspace, keys = [item.key];
    let request;
    if (item.type === 'Chops') {
      const index = ws.chops.indexOf(ws.chops.find(c => (c.id && c.id === item.id) || (c.url === item.url && c.start === item.start && c.end === item.end)));
      if (index < 0) throw Error('That chop is no longer saved.');
      const chop = ws.chops[index];
      return window.ItemMenu.remove({label: item.name, items: [{note: {...chop, type: 'Sampler chop'}}],
        hide: () => { ws.chops.splice(index, 1); ws.save?.(); this.signature = ''; this.refresh(); },
        restore: () => { ws.chops.splice(Math.min(index, ws.chops.length), 0, chop); ws.save?.(); this.signature = ''; this.refresh(); }});
    }
    if (item.table === 'library') {
      // A split song: ask whether its stems go too (default: keep them).
      const beats = await this.checked(this.app.sb.from('beats').select('*').eq('storage_path', item.storage_path)).catch(() => []);
      const ids = new Set((beats || []).map(b => b.id));
      const stems = this.items.filter(x => x.type === 'Stems' && ids.has(x.stem?.beatId ?? x.folder?.beat_id));
      const packs = this.items.filter(x => x.type === 'Split packs' && ids.has(x.folder?.beat_id));
      let withStems = false;
      if (stems.length || packs.length) {
        const answer = await window.ItemMenu.ask({title: 'Delete “' + item.name + '”?', text: 'This song was split into ' + (stems.length || 'some') + ' stem' + (stems.length === 1 ? '' : 's') + '. Stems you keep stay in SONGS and on your pads.', check: 'Also delete its stems and split pack', ok: 'DELETE', danger: true});
        if (!answer.ok) return;
        withStems = answer.checked;
        if (withStems) keys.push(...stems.map(x => x.key), ...packs.map(x => x.key));
      }
      request = {table: 'library', id: item.id, with_stems: withStems};
    } else if (item.type === 'Split packs') {
      const beat = item.folder.beat_id, stems = beat ? this.items.filter(x => x.type === 'Stems' && x.stem?.beatId === beat) : [];
      let withStems = false;
      if (stems.length) {
        const answer = await window.ItemMenu.ask({title: 'Delete split pack “' + item.name + '”?', text: 'The pack goes. Its ' + stems.length + ' stem' + (stems.length === 1 ? '' : 's') + ' can stay in SONGS as separate sounds.', check: 'Also delete its stems', ok: 'DELETE', danger: true});
        if (!answer.ok) return;
        withStems = answer.checked;
        if (withStems) keys.push(...stems.map(x => x.key));
      }
      request = {table: 'settings', id: item.id, with_stems: withStems};
    } else if (item.stem) request = {table: 'stems', id: item.stem.id};
    else if (item.type === 'Stems' && item.folder) request = {table: 'settings', id: item.folder.id, file: item.storage_path};
    else if (item.table === 'takes' || item.table === 'settings') request = {table: item.table, id: item.id};
    else throw Error('This item can’t be deleted.');
    if (keys.includes(this.previewKey)) this.stopPreview();
    return window.ItemMenu.remove({label: item.name, items: [request],
      hide: () => { keys.forEach(k => this.hidden.add(k)); this.render(); },
      restore: () => { keys.forEach(k => this.hidden.delete(k)); this.render(); },
      after: async () => {
        await Promise.allSettled([this.app.loadLibrary(), this.app.loadAllStems?.(), ws?.refreshLibrary()]);
        keys.forEach(k => this.hidden.delete(k)); this.signature = ''; this.refresh();
      }});
  }
  preview(item) {
    const player = this.host.querySelector('.ss-library-preview'), audio = player.querySelector('audio');
    if (this.previewKey === item.key && !audio.paused) { this.stopPreview(); return; }
    this.app.workspace?.previewAudio?.pause(); this.previewKey = item.key; this.previewItem = item; player.hidden = false;
    player.querySelector('[data-preview-name]').textContent = item.name; audio.src = item.url;
    audio.currentTime = item.start || 0;
    // Times are shown relative to the clip, so a chop or split piece reads 0:00 → its own length.
    const update = () => this.updatePreviewTime();
    audio.onloadedmetadata = update; audio.ondurationchange = update; audio.onpause = update; audio.onplay = update;
    audio.ontimeupdate = () => { if (item.end != null && audio.currentTime >= item.end) audio.pause(); update(); };
    audio.onended = update;
    this.placePreview(); update();
    audio.play().catch(error => this.notify('Preview failed: ' + error.message));
  }
  previewClock(seconds) { const s = Math.max(0, Math.floor(seconds || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  updatePreviewTime() {
    const player = this.host?.querySelector('.ss-library-preview'), item = this.previewItem;
    if (!player || !item) return;
    const audio = player.querySelector('audio'), start = item.start || 0;
    const end = item.end != null ? item.end : (Number.isFinite(audio.duration) ? audio.duration : 0);
    const length = Math.max(0, end - start), at = Math.min(length, Math.max(0, audio.currentTime - start));
    player.querySelector('[data-preview-time]').textContent = this.previewClock(at) + ' / ' + (length ? this.previewClock(length) : '–:––');
    const seek = player.querySelector('[data-preview-seek]'); seek.max = String(length); if (document.activeElement !== seek) seek.value = String(at);
    const toggle = player.querySelector('[data-toggle-preview]'); toggle.textContent = audio.paused ? '▶' : '❚❚'; toggle.setAttribute('aria-label', audio.paused ? 'Play preview' : 'Pause preview');
  }
  // The player sits directly under the row being previewed; park it before the list re-renders so it survives.
  parkPreview() { const player = this.host?.querySelector('.ss-library-preview'), home = this.host?.querySelector('.ss-library'); if (player && home && player.parentElement !== home) home.appendChild(player); }
  placePreview() {
    const player = this.host?.querySelector('.ss-library-preview');
    if (!player || !this.previewKey) return;
    const row = [...this.host.querySelectorAll('[data-entry]')].find(el => el.dataset.entry === this.previewKey);
    if (row) row.after(player); else this.parkPreview();
  }
  stopPreview() { const player = this.host?.querySelector('.ss-library-preview'); player?.querySelector('audio')?.pause(); if (player) player.hidden = true; this.previewKey = null; this.previewItem = null; this.parkPreview(); }
  dispose() { this.disposed = true; clearInterval(this.timer); this.stopPreview(); if (this.host) this.releaseComparison(this.host); }
};
