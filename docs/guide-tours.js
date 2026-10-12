/* The walkthroughs. Each step: what to do (title/text), what to light up (target), how ScrewShop
   knows you did it (done), and how to do it for you (show). Engine: guide.js. */
(() => {
  const stepEl = (g, i) => g.q('.screw-box')?.querySelectorAll('.ss-step')[i];
  const deckButton = (g, w, label) => [...(g.q('#turntable-' + w + ' .deck-buttons')?.querySelectorAll('button') || [])].find(b => b.textContent.trim().toUpperCase().startsWith(label));
  const onAir = g => g.room.tables.onAir();
  const deck = (g, w) => g.app.deckStore(w);
  const playing = (g, w) => g.app.state['deck' + w].playing;
  const nowBpm = (g, w) => { const d = deck(g, w); return d.bpm ? d.bpm * (d.rate ?? 1) : 0; };

  const screwMix = { id: 'screw-mix', title: 'SCREW MIX', button: 'WALK ME THROUGH A SCREW MIX', steps: [
    { id: 'welcome', title: 'The setup', target: '.dj-console',
      text: 'Two turntables (A left, B right) and a mixer in the middle, like DJ Screw\'s setup. You\'ll slow a record down, chop it with two copies, then blend in a second song, recording the whole mix as you go.',
      tip: 'Each step lights up what to touch. Do it yourself and the card moves on, or press SHOW ME and watch it done for you.' },
    { id: 'load1', title: 'Put record 1 on both tables', target: g => stepEl(g, 0),
      text: 'Pick a song in <b>Saved songs</b> and press <b>LOAD ON BOTH TABLES</b> (or <b>LOAD SONG FILE</b>). The same record goes on A and B: two copies is how Screw repeats words.',
      done: g => g.room.same('A'),
      async show(g) {
        const songs = g.library(), select = g.q('.screw-box [data-library]');
        if (songs.length && select) { await g.cursorTo(select); g.set(select, songs[0].id); await g.click('.screw-box [data-action="library"]'); }
        else { await g.cursorTo(g.q('.screw-box [data-action="load"]')); await g.room.loadBoth(g.demoSong(1)); }
      }, waitMax: 20000 },
    { id: 'slow', title: 'Slow it down', target: g => stepEl(g, 1),
      text: 'Screw tapes sit around 60–70 BPM. Press <b>−30%</b>, type a target BPM and press <b>SET BPM</b>, or pull the pitch fader. Tempo and pitch drop together, which is what makes the voices deep.',
      done: g => (deck(g, 'A').rate ?? 1) <= .86 && (deck(g, 'B').rate ?? 1) <= .86,
      show: g => g.click('.screw-box [data-rate-to=".7"]') },
    { id: 'sound', title: 'Give it the tape sound', target: '#turntable-A .tt-ctrl',
      text: 'Turn up <b>TAPE</b> under each table (cassette warble and a dull top end) and press <b>SYRUP</b> for the room. That\'s the dubbed-tape character of a gray tape.',
      done: g => deck(g, 'A').tapeValue > 0 && g.app.state.deckA.reverbOn,
      async show(g) {
        for (const w of ['A', 'B']) { const knob = g.q(`#turntable-${w} [data-tt-tape]`); await g.cursorTo(knob); g.set(knob, 35); }
        for (const w of ['A', 'B']) if (!g.app.state['deck' + w].reverbOn) await g.click(deckButton(g, w, 'SYRUP'));
      } },
    { id: 'play', title: 'Play it', target: '.screw-box [data-action="play"]',
      text: 'Press <b>▶ PLAY / PAUSE</b>. Table A plays on air; B waits, silent, with the same record.',
      done: g => playing(g, 'A') || playing(g, 'B'),
      show: g => g.click('.screw-box [data-action="play"]') },
    { id: 'read', title: 'Read the screen', target: '.tt-waves',
      text: 'The scrolling waveforms are A (top) and B (bottom). The white line is the needle, the grid lines are beats (bright = bar), and <b>ON AIR</b> shows which table you hear. Bottom left, ScrewShop tells you how many beats one copy is behind the other; <b>− +</b> zoom.',
      read: 4500 },
    { id: 'record', title: 'Start recording your mix', target: '.screw-box [data-action="record"]',
      text: 'Press <b>RECORD LIVE MIX</b>. Everything you do from here (chops, scratches, the blend) is recorded until you press <b>STOP &amp; SAVE MIX</b>.',
      done: g => g.room.recording, show: g => g.click('.screw-box [data-action="record"]') },
    { id: 'runback', title: 'Run a line back', target: '.screw-box .ss-run',
      text: 'When a line hits, press <b>↺ 1 BEAT</b> (key <b>X</b>) or a CHOP pad on table A. The other table jumps that far behind and the fader cuts to it, so the words repeat and the song keeps going.',
      tip: 'Keys: Z ½ beat · X 1 beat · C 2 beats · V 1 bar · B 2 bars. Try it twice.',
      done: g => g.since('runBack') >= 2, waiting: g => `Run-backs so far: ${g.since('runBack')} of 2.`,
      async show(g) { await g.click('.screw-box [data-back="1"]'); await g.sleep(1800); await g.click('.screw-box [data-back="2"]'); } },
    { id: 'lag', title: 'Put the second copy behind', target: '.tt-cut',
      text: 'Press <b>LAG OFF-AIR</b> (key <b>G</b>). The silent table starts a beat behind the one you hear. This is the Screw setup: two copies, one a little late.',
      done: g => g.since('lag') >= 1, show: g => g.click('.tt-cut [data-tt-lag-go]') },
    { id: 'flick', title: 'Chop with the flick', target: '.tt-cut [data-tt-flick]',
      text: 'Hold <b>FLICK</b> (or hold <b>F</b>) for a moment, then let go. While you hold it you hear the late copy, so the last words repeat. Tap it in rhythm: that\'s the chop.',
      done: g => g.since('flick') >= 3, waiting: g => `Flicks so far: ${g.since('flick')} of 3.`,
      async show(g) { const pad = g.q('.tt-cut [data-tt-flick]'); for (let i = 0; i < 3; i++) await g.hold(pad, 350, () => g.room.flickDown(), () => g.room.flickUp()); } },
    { id: 'slowside', title: 'Drag one side', target: g => g.q(`#turntable-${onAir(g)} [data-tt-slow]`),
      text: 'Hold <b>SLOW</b> under the table you hear (key <b>Q</b> for A, <b>P</b> for B). It slows like a hand on the record and comes back when you let go. <b>SLOW TIME</b> sets how long the slowdown takes (0.02–4 s), and <b>STOP</b> mode winds the record all the way down.',
      done: g => g.since('slow') >= 1,
      async show(g) { const w = onAir(g); await g.hold(g.q(`#turntable-${w} [data-tt-slow]`), 1200, () => g.room.slowDown(w), () => g.room.slowUp(w)); } },
    { id: 'scratch', title: 'Scratch', target: g => g.q('#vinyl-' + onAir(g)),
      text: 'Grab the gold top of the jog wheel you hear and push it back and forth. The record follows your hand; holding still stops it; letting go drops it back in. The ridged outer ring nudges the tempo instead.',
      done: g => g.since('scratch') >= 1,
      async show(g) {
        const w = onAir(g), el = g.q('#vinyl-' + w); await g.cursorTo(el);
        const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width * .3;
        const at = a => ({ clientX: cx + R * Math.cos(a), clientY: cy + R * Math.sin(a) });
        await g.room.beginScratch(w, { button: 0, pointerId: 1, preventDefault() {}, currentTarget: el, ...at(-Math.PI / 2) });
        g.cursor.classList.add('down');
        try {
          for (const [from, to] of [[-90, -150], [-150, -90], [-90, -150], [-150, -60]]) for (let k = 1; k <= 8; k++) {
            const a = (from + (to - from) * k / 8) * Math.PI / 180, p = at(a); g.room.moveScratch(w, p); g.cursor.style.left = p.clientX + 'px'; g.cursor.style.top = p.clientY + 'px'; await g.sleep(30);
          }
        } finally { g.cursor?.classList.remove('down'); g.room.endScratch(w); }   // STOP mid-scratch still lets go of the record
      } },
    { id: 'load2', title: 'Cue up record 2 on table B', target: '#turntable-B .deck-heading',
      text: 'First make sure <b>A</b> is on air (press <b>◀ A</b> on the mixer). Then put the next song on table B with <b>LOAD TRACK</b>, or from SONGS: ⋮ → Load on SCREW deck B. Nobody hears B yet.',
      done: g => !!deck(g, 'B').buffer && !g.room.same('A'),
      async show(g) {
        await g.click('.tt-cut [data-tt-cut="A"]');
        const songs = g.library(), first = deck(g, 'A'), other = songs.find(x => x.name && !g.app.state.deckA.fileName.startsWith(x.name));
        await g.cursorTo(g.q('#turntable-B .deck-heading button'));
        await g.app.mountDeck('B', other ? await g.fileFor(other) : g.demoSong(2));
        if (!first.buffer) return;
      }, waitMax: 20000 },
    { id: 'match', title: 'Match B\'s speed to A', target: '#turntable-B .platter-bed',
      text: 'The two BPM readouts under the decks need to match. Move B\'s tempo slider, or tap B\'s <b>SLOW −</b> pads (−0.01, −0.02 …) until B\'s BPM is within 1 of A\'s.',
      done: g => !!deck(g, 'B').bpm && Math.abs(nowBpm(g, 'A') - nowBpm(g, 'B')) < 1,
      waiting: g => deck(g, 'B').bpm ? `A ${nowBpm(g, 'A').toFixed(1)} BPM · B ${nowBpm(g, 'B').toFixed(1)} BPM` : 'Load a record on B first.',
      async show(g) { const target = nowBpm(g, 'A') / deck(g, 'B').bpm, fader = g.q('#turntable-B .tt-pitch input'); await g.cursorTo(fader); g.room.glide(['B'], Math.round(target * 1000) / 1000, 900); await g.sleep(1000); } },
    { id: 'cue', title: 'Start B on the beat', target: g => deckButton(g, 'B', 'PLAY') || g.q('#turntable-B .deck-play'),
      text: 'While A plays, press B\'s <b>PLAY</b> right on a beat of A (the waveforms\' bright bar lines help). Keep the mixer on A: you\'re lining B up in silence.',
      done: g => playing(g, 'B') && onAir(g) === 'A',
      async show(g) {
        await g.cursorTo(g.q('#turntable-B .deck-play')); const a = g.app, A = deck(g, 'A'), B = deck(g, 'B'), T = a._Tone;
        if (!playing(g, 'A')) { await g.click('.screw-box [data-action="play"]'); await g.sleep(400); }
        const beat = 60 / A.bpm / (A.rate ?? 1), posA = a.deckPosition('A', T.now() + .1), next = Math.ceil((posA - (A.firstBeat || 0)) / (60 / A.bpm)) * (60 / A.bpm) + (A.firstBeat || 0);
        a.startDeckAt('B', T.now() + .1 + (next - posA) / (A.rate ?? 1), B.firstBeat || 0); void beat;
      } },
    { id: 'blend', title: 'Blend into record 2', target: '.crossfader',
      text: 'Slide the crossfader from <b>A</b> over to <b>B</b> across a bar or two, or cut straight over on the first beat of a bar with <b>B ▶</b>. Now record 2 is on air.',
      done: g => playing(g, 'B') && g.app.state.crossfade > .5,
      async show(g) { await g.cursorTo(g.q('.crossfader input')); for (let i = 0; i <= 40; i++) { g.app.setCrossfade(-1 + i / 20); await g.sleep(70); } g.room.cutTo('B'); } },
    { id: 'save', title: 'Stop and save your mix', target: '.screw-box [data-action="record"]',
      text: 'Press <b>STOP &amp; SAVE MIX</b>. Your performance goes to SONGS as a new song; both originals are untouched.',
      done: g => g.since('record') > 0 ? !g.room.recording : g.count('record') > 0 && !g.room.recording,
      show: g => g.room.recording ? g.click('.screw-box [data-action="record"]') : null },
    { id: 'version', title: 'Bonus: let ScrewShop chop it', target: g => stepEl(g, 4),
      text: '<b>MAKE A VERSION</b> builds a whole DJ Screw or Michael Watts style version of the record on A: it finds the beat, the vocal lines and the hook, plans the chops and renders a WAV. <b>PREVIEW</b> it, try <b>NEW CHOPS</b>, then <b>SAVE TO SONGS</b>.',
      tip: 'That\'s the full workflow: load → slow → tape sound → record → run-backs, lag + flick, drag, scratch → cue record 2 → match → blend → save.' },
  ] };

  // ---- M-AUDIO / SAMPLER ----
  const pads = g => (g.ws?.slots || []).slice(0, 16).filter(Boolean).length;
  const events = (g, lane) => (g.ws?.pattern?.events || []).filter(e => lane == null || e.lane === lane).length;
  const songRow = (g, item) => item && [...document.querySelectorAll('.ss-library-row')].find(r => r.textContent.includes(item.name) || r.querySelector('input')?.value === item.name);
  const job = g => g.data.song && g.app.state.splitJobs[g.data.song.id];
  async function saveBeat(g, name) {
    const prompt = window.prompt; window.prompt = () => name;
    try { await g.click('#ss-sampler [data-action="beat"]'); await g.sleep(600); } finally { window.prompt = prompt; }
  }
  async function hit(g, lane, ms = 120) { const el = g.q(`#ss-sampler [data-dest="${lane}"]`); if (el) await g.cursorTo(el); g.ws.press(lane, 60, 110, 'guide:' + lane); await g.sleep(ms); g.ws.releaseToken('guide:' + lane); }
  async function demoKit(g) {
    const kinds = ['kick', 'snare', 'hat', 'clap'];
    for (let i = 0; i < kinds.length; i++) if (!g.ws.slots[i]) { const item = await g.addToLibrary(g.drumFile(kinds[i]), 'Demo ' + kinds[i]); await g.ws.assign(i, item); }
  }
  const toSampler = g => g.goTab('M-AUDIO', 'packs');

  const splitBeat = { id: 'split-beat', title: 'BEAT FROM A SPLIT', button: 'MAKE A BEAT FROM A SONG (UPLOAD → SPLIT → PADS)', steps: [
    { id: 'plan', title: 'The plan', target: '#ss-sampler',
      text: 'Start to finish: upload a song in SONGS, split it into stems (vocals, drums, bass…), open the split as a sound pack, load the sounds onto your Oxygen pads, play and record a beat, then save it.',
      enter: g => { g.data.libStart = g.library().length; } },
    { id: 'songs', title: 'Go to SONGS', tab: 'songs', tabLabel: 'SONGS', target: '[data-upload]',
      text: 'Everything you import lives in <b>SONGS</b>. Open that tab.', done: g => g.app.state.tab === 'songs', show: g => g.goTab('SONGS', 'songs') },
    { id: 'upload', title: 'Upload your MP3', tab: 'songs', tabLabel: 'SONGS', target: '[data-upload]',
      text: 'Press <b>+ UPLOAD FILE</b> and choose an MP3. Already have it in SONGS? Press NEXT; the walkthrough uses your newest song.',
      done: g => g.library().length > (g.data.libStart ?? 0),
      async show(g) { await g.cursorTo(g.q('[data-upload]')); g.data.song = await g.addToLibrary(g.demoSong(1), 'ScrewShop demo record'); } },
    { id: 'split', title: 'Full split it', tab: 'songs', tabLabel: 'SONGS', target: g => { const r = songRow(g, g.data.song); return r?.querySelector('[data-row-menu]') || r; },
      text: 'On the song\'s row press <b>⋮</b> (or right-click the row) → <b>Full split</b>. Full split gives vocals, drums, bass, guitar, piano and other, plus ready-cut drum hits. (Quick split only gives vocals + instrumental, with no drums.)',
      enter: g => { if (!g.data.song) g.data.song = [...g.library()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]; },
      done: g => { const hit = Object.entries(g.app.state.splitJobs || {}).find(([, j]) => ['linking', 'pending', 'processing', 'done'].includes(j.status)); if (hit && hit[0] !== g.data.song?.id) g.data.song = g.library().find(x => x.id === hit[0]) || g.data.song; return !!hit; },
      async show(g) { const r = songRow(g, g.data.song); await g.click(r?.querySelector('[data-row-menu]')); await g.sleep(250); await g.click(document.querySelector('.im-menu [data-action="full-split"]')); } },
    { id: 'wait', title: 'Let it separate', tab: 'songs', tabLabel: 'SONGS', target: g => songRow(g, g.data.song),
      text: 'The split runs on this computer. A full split takes a few minutes for a normal song. The row shows Queued → Separating → Split complete. You can keep using the app meanwhile.',
      done: g => job(g)?.status === 'done', waitMax: 30 * 60 * 1000,
      waiting: g => { const j = job(g); return j ? (j.status === 'error' ? 'Split failed: ' + (j.error || 'see the row') : 'Split status: ' + j.status + '…') : 'Waiting for the split to start.'; } },
    { id: 'pack', title: 'Open the split as a pack', tab: 'songs', tabLabel: 'SONGS', target: '[data-category="Split packs"]',
      text: 'In SONGS pick the <b>Split packs</b> category, find your song and press <b>Open pack</b>. It jumps to the sampler with the pack picker open.',
      done: g => !!g.q('#sp-pack[open]'),
      async show(g) { await g.click('[data-category="Split packs"]'); await g.sleep(300); const rows = [...document.querySelectorAll('[data-library-action="open-pack"]')]; await g.click(rows.find(b => b.closest('.ss-library-row')?.textContent.includes(g.data.song?.name || '')) || rows[0]); } },
    { id: 'pick', title: 'Choose your sounds', target: '#sp-pack',
      text: 'Press ▶ to hear each sound and tick the ones you want (the first 16 are ticked for you). Drum hits, a bass phrase and a vocal phrase make a good start. <b>Only fill empty pads</b> keeps pads you already set.',
      done: g => (g.ws.pack?.checked?.size || 0) > 0, read: 2500 },
    { id: 'load', title: 'Load them onto the Oxygen', target: '#sp-pack [data-pack="load"]',
      text: 'Press <b>Load … onto the Oxygen</b>. Each ticked sound goes onto a pad, in order, and the picker says which pads it used. One ↶ undoes the whole load. Then close the picker.',
      enter: g => { if (g.ws.pack) g.ws.pack.status = ''; },
      done: g => /^Loaded/.test(g.ws.pack?.status || ''),
      async show(g) { await g.click('#sp-pack [data-pack="load"]'); for (let i = 0; i < 120 && !/^Loaded/.test(g.ws.pack?.status || ''); i++) await g.sleep(250); await g.sleep(1200); g.q('#sp-pack')?.close(); }, waitMax: 30000 },
    { id: 'midi', title: 'Connect the keyboard (optional)', target: '#ss-sampler [data-action="midi"]',
      text: 'Plug in the Oxygen and press <b>MIDI</b>. First time only: press <b>Learn all 8 pads</b> and hit pads 1→8 (then BANK 2 and again for 9–16). No keyboard? Click the on-screen pads, or use keys 1 2 3 4 / Q W E R / A S D F / Z X C V.',
      show: g => g.click('#ss-sampler [data-action="midi"]') },
    { id: 'jam', title: 'Play the pads', target: '#ss-sampler .sp-oxygen',
      text: 'Hit some pads to hear what you loaded. Find a kick, a snare and something melodic.', done: g => g.since('press') >= 4, waiting: g => `Pad hits: ${g.since('press')} of 4.`,
      async show(g) { await toSampler(g); for (const lane of [0, 1, 0, 2]) await hit(g, lane, 260); } },
    { id: 'shape', title: 'Trim a sound', target: '#ss-sampler [data-action="jump-editor"]',
      text: 'Press <b>🎚 Sample editor</b> to trim the selected pad: bar buttons (1, 2, 4), Start/End, volume, pitch, reverse, and gate (sound stops when you let go). <b>✂ Chop this sound → pad</b> cuts a phrase onto another pad.',
      show: g => g.click('#ss-sampler [data-action="jump-editor"]') },
    { id: 'tempo', title: 'Set the tempo and click', target: '#ss-sampler .sp-toolbar',
      text: 'Set <b>BPM</b> (try 72 for a slow Houston bounce), tick <b>Click</b> for the metronome and <b>Count-in</b> so you get a bar to get ready.',
      done: g => !!g.ws.project.metro,
      async show(g) { const bpm = g.q('#ss-sampler [data-project="bpm"]'); await g.cursorTo(bpm); g.set(bpm, 72); const m = g.q('#ss-sampler [data-project="metro"]'); if (!m.checked) await g.click(m); } },
    { id: 'record', title: 'Record a beat', target: '#ss-sampler [data-action="record"]',
      text: 'Press <b>Record</b>, wait out the count-in, and play your pattern on the pads. Tick <b>Quantize</b> in the sequencer to snap hits to the grid. Press <b>Stop Record</b> when done; hits become notes you can edit.',
      enter: g => { g.data.evStart = events(g); }, done: g => !g.ws.recording && events(g) > g.data.evStart,
      async show(g) {
        await g.click('#ss-sampler [data-action="record"]');
        const beat = 60 / g.ws.project.bpm; await g.sleep(g.ws.project.countIn ? beat * 4000 : 100);
        for (const lane of [0, 1, 0, 1]) { await hit(g, lane, 80); await g.sleep(beat * 1000 - 80); }
        if (g.ws.recording) await g.click('#ss-sampler [data-action="record"]'); if (g.ws.playing) await g.click('#ss-sampler [data-action="play"]');
      }, waitMax: 30000 },
    { id: 'listen', title: 'Play it back and fix it', target: '#ss-sampler [data-action="play"]',
      text: 'Press <b>Play</b>. Your hits are in the sequencer at the bottom: click a cell to add or remove a hit, right-click (or <b>Edit notes</b>) to change velocity and length. ↶ undoes.',
      done: g => g.ws.playing, async show(g) { await g.click('#ss-sampler [data-action="play"]'); await g.sleep(2500); await g.click('#ss-sampler [data-action="play"]'); } },
    { id: 'save', title: 'Save the beat', target: '#ss-sampler [data-action="beat"]',
      text: 'Press <b>Save Beat</b> and name it. It shows up in SONGS under <b>Beats</b>, where <b>Open beat</b> brings it back. <b>Save Kit</b> saves just the pad sounds to reuse in another beat.',
      done: g => g.since('saveBeat') >= 1, show: g => saveBeat(g, 'My split beat') },
    { id: 'out', title: 'Take it further', target: '#ss-sampler [data-action="sequence"]',
      text: 'Open the sequencer\'s <b>Project, transfer &amp; export</b>: <b>Send to Studio</b> puts the beat on a Studio track to record vocals over; <b>Export WAV / MP3</b> saves the current pattern as audio.',
      tip: 'Next: try the SEQUENCER BEAT walkthrough to program drums step by step.' },
  ] };

  const seqBeat = { id: 'sequencer-beat', title: 'SEQUENCER BEAT', button: 'PROGRAM A BEAT ON THE SEQUENCER', steps: [
    { id: 'intro', title: 'Step-sequencing', tab: 'packs', tabLabel: 'M-AUDIO', target: '#ss-sampler',
      text: 'Instead of playing live, you\'ll click hits onto a grid: 16 steps = one bar of 4 beats. Each row (lane) is one pad.' },
    { id: 'kit', title: 'Sounds on pads 1–4', target: '#ss-sampler .sp-oxygen',
      text: 'You need a kick, snare, hi-hat and clap (or anything) on pads 1–4. Use the split walkthrough, SONGS → ⋮ → Load onto a sampler pad, or press SHOW ME to load a demo kit.',
      done: g => [0, 1, 2].every(i => g.ws.slots[i]),
      async show(g) { await toSampler(g); await g.cursorTo(g.q('#ss-sampler [data-dest="0"]')); await demoKit(g); }, waitMax: 30000 },
    { id: 'open', title: 'Open the sequencer', target: '#ss-sampler .sp-jump [data-action="sequence"]',
      text: 'Press <b>▴ Show sequencer</b>. Set <b>Beats</b> to 4 for a one-bar loop; <b>Grid</b> 1/16 means each cell is a sixteenth note.',
      done: g => g.ws.ui.sequence && !!g.q('#ss-sampler [data-cell]'),
      async show(g) { if (!g.ws.ui.sequence) await g.click('#ss-sampler .sp-jump [data-action="sequence"]'); } },
    { id: 'kick', title: 'Kick on 1 and 3', target: g => g.q('#ss-sampler [data-cell^="0:"]')?.closest('.sp-lane'),
      text: 'On lane 1 (kick) click cells <b>1</b> and <b>9</b> (beats 1 and 3). Add one on cell 7 or 11 for bounce.', done: g => events(g, 0) >= 2,
      async show(g) { for (const step of [0, 6, 8]) await g.click(g.q(`#ss-sampler [data-cell^="0:"][data-cell$=":${step}"]`)); } },
    { id: 'snare', title: 'Snare on 2 and 4', target: g => g.q('#ss-sampler [data-cell^="1:"]')?.closest('.sp-lane'),
      text: 'On lane 2 (snare) click cells <b>5</b> and <b>13</b>, the backbeat.', done: g => events(g, 1) >= 2,
      async show(g) { for (const step of [4, 12]) await g.click(g.q(`#ss-sampler [data-cell^="1:"][data-cell$=":${step}"]`)); } },
    { id: 'hats', title: 'Hi-hats', target: g => g.q('#ss-sampler [data-cell^="2:"]')?.closest('.sp-lane'),
      text: 'On lane 3 click every other cell (1, 3, 5 …) for eighth-note hats. Lower <b>Velocity</b> first for softer ghost hits.', done: g => events(g, 2) >= 4,
      async show(g) { for (let step = 0; step < 16; step += 2) await g.click(g.q(`#ss-sampler [data-cell^="2:"][data-cell$=":${step}"]`)); } },
    { id: 'play', title: 'Loop it', target: '#ss-sampler [data-action="play"]',
      text: 'Press <b>Play</b>. The lit column is the playhead. Click cells while it plays to try changes; ↶ undoes.', done: g => g.ws.playing,
      show: g => g.click('#ss-sampler [data-action="play"]') },
    { id: 'swing', title: 'Add swing', target: '#ss-sampler [data-project="swing"]',
      text: 'Set <b>Swing</b> to about 15–25 to push the off-beats late, for a laid-back groove.', done: g => g.ws.project.swing > 0,
      async show(g) { const el = g.q('#ss-sampler [data-project="swing"]'); await g.cursorTo(el); g.set(el, 20); } },
    { id: 'variation', title: 'Make a variation', target: '#ss-sampler [data-action="duplicate-pattern"]',
      text: 'Press <b>Duplicate</b> to copy this pattern, then change a few hits (an extra kick, a clap roll) for a second part. Switch patterns with the Pattern menu.',
      done: g => g.ws.project.patterns.length >= 2,
      async show(g) { const prompt = window.prompt; window.prompt = () => 'Pattern 2 (variation)'; try { await g.click('#ss-sampler [data-action="duplicate-pattern"]'); } finally { window.prompt = prompt; } } },
    { id: 'save', title: 'Save it', target: '#ss-sampler [data-action="beat"]',
      text: 'Stop playback and press <b>Save Beat</b>. Then <b>Send to Studio</b> or <b>Export WAV</b> under <b>Project, transfer &amp; export</b>.',
      done: g => g.since('saveBeat') >= 1,
      async show(g) { if (g.ws.playing) await g.click('#ss-sampler [data-action="play"]'); await saveBeat(g, 'My sequencer beat'); } },
  ] };

  // Sampler steps point at the M-AUDIO tab first when you're somewhere else.
  for (const t of [splitBeat, seqBeat]) for (const s of t.steps) if (!s.tab && (typeof s.target !== 'string' || s.target.startsWith('#ss-sampler') || s.target.startsWith('#sp-pack'))) { s.tab = 'packs'; s.tabLabel = 'M-AUDIO'; }
  window.ScrewGuideTours = { 'screw-mix': screwMix, 'split-beat': splitBeat, 'sequencer-beat': seqBeat };
})();
