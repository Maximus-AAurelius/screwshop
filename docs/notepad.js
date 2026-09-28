/* Local notebook editor. Only the explicit online lookup sends a search term. */
window.ScrewShopNotepad = class {
  constructor(app) {
    this.app = app; this.colors = ['#d7e8fb','#f7d4de','#d8ebc9','#f5e3ac','#e5d8f3','#c4e9e3'];
    this.timer = setInterval(() => this.sync(), 150);
    this.resize = () => this.paint(); window.addEventListener('resize', this.resize);
  }
  dispose() { clearInterval(this.timer); clearTimeout(this.paintTimer); this.request?.abort(); window.removeEventListener('resize', this.resize); }
  escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  sync() {
    const host = document.getElementById('ss-notepad'); if (!host) return;
    if (this.host !== host) this.mount(host);
    const value = this.app.state.lines.join('\n');
    if (value !== this.editor.value && !this.composing) { this.editor.value = value; this.paint(); }
    if (this.engine !== this.app.E) { this.engine = this.app.E; this.paint(); }
  }
  mount(host) {
    this.host = host;
    host.innerHTML = `<div class="np-top"><div><small>SCREWSHOP / VERSE BOOK</small><h2>Notepad</h2></div><div class="np-count" aria-live="polite"></div><label><input class="np-highlight" type="checkbox" checked> Rhyme colors</label><button class="np-tools-toggle" aria-expanded="true">WORD DESK</button></div>
    <div class="np-layout"><section class="np-paper" aria-label="College ruled notebook"><div class="np-paper-title">LYRICS <span>College ruled &middot; one line = one bar</span></div><div class="np-sheet"><div class="np-numbers" aria-hidden="true"></div><div class="np-text"><div class="np-mirror" aria-hidden="true"></div><textarea class="np-editor" aria-label="Verse notebook" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Start your verse here..."></textarea></div></div><footer>Return for a new bar. Arrow keys to move. Blank lines separate sections.</footer></section>
    <aside class="np-desk" aria-label="Word desk"><h3>WORD DESK</h3><p>Look up a word when you need one.</p><form class="np-search"><label>Word or phrase<input class="np-query" maxlength="100" placeholder="e.g. night, change, paper" required></label><label>Dictionary<select class="np-mode"><option value="rhyme">Rhymes (offline)</option><option value="syn">Thesaurus</option><option value="hom">Homophones / wordplay</option><option value="meaning">Meanings / double entendres</option></select></label><button type="submit" class="np-lookup">FIND RHYMES</button></form><p class="np-privacy">Local rhyme dictionary. Nothing is searched while you write.</p><div class="np-results" aria-live="polite">Your words, your choices.</div><a class="np-external" target="_blank" rel="noopener noreferrer" href="https://www.rhymezone.com/">Open RhymeZone dictionary &#8599;</a>
    <details><summary>Wordplay &amp; double entendres</summary><p>A double entendre is a line that supports two meanings. A dictionary supplies meanings and sound-alikes; you supply the connection.</p><p><b>Two meanings:</b> a bar can be a lyric, a place to drink, or a barrier. A key can open a lock or set a musical pitch.</p><p><b>Sound-alikes:</b> write / right, sole / soul. Try the homophone lookup.</p><p><b>Build it:</b> pick two meanings, list details from each, then write a setup that makes both readings work. Read it aloud to check the turn.</p></details>
    <details><summary>Rhyme schemes &amp; writing tips</summary><p><b>AABB:</b> two rhyming pairs. Land a thought every two bars.</p><p><b>ABAB:</b> alternate two end sounds to stretch a thought across four bars.</p><p><b>AAAA:</b> hold one sound, then change it at a section boundary.</p><p><b>Internal rhyme:</b> rhyme inside the line as well as at the end. <b>Multis:</b> match several stressed syllables, not just the last word.</p><p>Write the idea first. Leave space for breath. Say the verse over the beat; the written bar count is a guide, not a timing measurement.</p><p>Colors group likely shared sounds. Pronunciation and delivery decide what works.</p></details><small>Online word data: <a href="https://www.datamuse.com/api/" target="_blank" rel="noopener noreferrer">Datamuse</a>. Definitions: WordNet / Wiktionary. No subscription in ScrewShop.</small></aside></div>`;
    this.editor = host.querySelector('.np-editor'); this.editor.value = this.app.state.lines.join('\n');
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
    this.paint();
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
