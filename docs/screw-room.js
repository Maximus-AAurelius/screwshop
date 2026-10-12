/* SCREW station over the two decks: one record on both tables, BPM slowdown, vocal pitch,
   beat-locked run-backs and a DJ Screw / Michael Watts version builder. Saves go to SONGS. */
window.ScrewRoom = class {
  constructor(app) {
    this.app = app;
    this.stems = new window.ScrewStemEditor(this);
    this.glideRaf = {}; this.slowing = {};
    this.stats = {}; // how many times each move has been done (walkthroughs follow along with these)
    this.tables = new window.ScrewTables(this);
    this.tempoCache = new WeakMap();
    this.lastLive = 'A'; this.timers = { A: [], B: [] };
    this.timer = setInterval(() => this.tick(), 150);
    this.blur = () => { ['A','B'].forEach(w => { this.endScratch(w); this.slowUp(w); }); this.dragging = null; this.flickUp(); };
    window.addEventListener('blur', this.blur);
    const runKeys = { z: .5, x: 1, c: 2, v: 4, b: 8 };
    this.key = e => {
      if (app.state.tab !== 'screw' || /TEXTAREA|SELECT/.test(e.target.tagName) || (e.target.tagName === 'INPUT' && !/range|checkbox|radio|button/.test(e.target.type)) || e.target.isContentEditable || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const k = e.key.toLowerCase();
      const actions = { '1': () => app.toggleDeckPlay('A'), '2': () => app.toggleDeckPlay('B'), '[': () => this.cutTo('A'), ']': () => this.cutTo('B'), '\\': () => app.setCrossfade(0), h: () => this.playHook(), d: () => this.hold(), q: () => this.slowDown('A'), p: () => this.slowDown('B'), f: () => this.flickDown(), g: () => this.lagBehind() };
      if (runKeys[k]) actions[k] = () => this.runBack(runKeys[k]);
      if (actions[k]) { e.preventDefault(); this.run(actions[k]); }
    };
    this.keyUp = e => { const k = e.key.toLowerCase(); if (k === 'd') this.release(); if (k === 'q') this.slowUp('A'); if (k === 'p') this.slowUp('B'); if (k === 'f') this.flickUp(); };
    document.addEventListener('keydown', this.key); document.addEventListener('keyup', this.keyUp);
  }
  bump(k) { this.stats[k] = (this.stats[k] || 0) + 1; }
  message(text) { this.app.setState({notice:text}); if(this.host?.isConnected) this.host.querySelector('[data-status]').textContent=text; }
  async run(fn) { try { await fn(); } catch(e) { this.message(e.message); } }
  esc(s) { return this.app.workspace.esc(s); }
  selectTransport(){
    const a=this.app;
    if(a.studio?.playing||a.state.seqPlaying||a.state.padPlaying||(a._beatAudio&&!a._beatAudio.paused))return;
    const stems=this.mode==='stems';a._resumeTransport=null;
    a.setState({transportSource:stems?'screw-stems':'decks',transportTitle:stems?'SCREW · Vocals + Instrumental':'SCREW · Decks A / B',beatPos:stems?this.stems.position:0,beatDur:stems?this.stems.duration():0,beatRate:stems?this.stems.rate:a.state.deckA.rate,beatLoop:stems&&!!this.stems.loop});
  }

  // ---- Which table is on air ----
  live(){const x=this.app.state.crossfade;if(x<-.05)this.lastLive='A';else if(x>.05)this.lastLive='B';return this.lastLive;}
  other(w){return w==='A'?'B':'A';}
  // Same record on both tables: shared buffer, or the same file loaded twice.
  same(w){const a=this.app,L=a.deckStore(w),O=a.deckStore(this.other(w));return !!L.buffer&&!!O.buffer&&(L.buffer===O.buffer||(Math.abs(L.buffer.duration-O.buffer.duration)<.01&&a.state.deckA.fileName===a.state.deckB.fileName));}
  bpm(w){const d=this.app.deckStore(w);return d.bpm||null;}
  nowBpm(w){const b=this.bpm(w);return b?b*(this.app.deckStore(w).rate??this.app.state['deck'+w].rate):null;}

  tick() {
    this.stems.syncTransport();
    if (this.app.state.tab !== 'screw') { this.blur(); return; }
    const room = document.querySelector('.dj-scroll');
    if (!room) return;
    this.stems.tick(room);
    this.tables.tick(room);
    if(!room.querySelector('.screw-modes')){
      const nav=document.createElement('nav');nav.className='screw-modes';nav.setAttribute('aria-label','Screw workspace');nav.innerHTML='<button data-mode="decks">SCREW A SONG · TABLES</button><button data-mode="stems">VOCALS + INSTRUMENTAL</button>';
      room.querySelector('.dj-intro').after(nav);
      nav.onclick=e=>{const mode=e.target.dataset.mode;if(!mode)return;this.mode=mode;this.blur();this.app.pauseBothDecks();this.stopPreview();this.stems.pause();this.selectTransport();this.tick();};
    }
    room.dataset.mode=this.mode||'decks';
    room.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.mode===room.dataset.mode));
    if (!this.host?.isConnected) this.draw(room);
    this.refresh();
    for(const w of ['A','B']) {
      const record=document.getElementById('vinyl-'+w);
      if(record&&!record.dataset.scratch){record.dataset.scratch='1';record.onpointerdown=e=>this.run(()=>this.beginScratch(w,e));record.onpointermove=e=>this.moveScratch(w,e);record.onpointerup=record.onpointercancel=record.onlostpointercapture=()=>this.endScratch(w);}
    }
  }

  draw(room){
    const beats=[[.5,'½ BEAT'],[1,'1 BEAT'],[2,'2 BEATS'],[4,'1 BAR'],[8,'2 BARS']];
    this.host=document.createElement('section');this.host.className='screw-box';this.host.setAttribute('aria-label','Screw station');
    this.host.innerHTML=`<h3>SCREW STATION <small>One record on both tables. Slow it down, pitch the vocals, run lines back, save your version.</small></h3>
      <div class="ss-step"><b>1 · RECORD</b>
        <div class="screw-tools"><label>Saved songs <select data-library aria-label="Saved songs"><option value="">Choose a song</option></select></label><button data-action="library">LOAD ON BOTH TABLES</button><button data-action="load">LOAD SONG FILE</button></div>
        <p data-song>No record yet. Pick a song and it goes on table A and table B, like Screw with two copies of the same record.</p></div>
      <div class="ss-step"><b>2 · SPEED</b>
        <div class="ss-bpm"><output data-bpm>— BPM</output><small data-bpm-sub>Load a record to read its tempo.</small></div>
        <div class="screw-tools"><label>Record's original BPM (detected; fix it if it's wrong)<input data-src-bpm aria-label="Record original BPM" type="number" min="30" max="250" step="0.01"></label><button data-action="half">½×</button><button data-action="double2">2×</button></div>
        <label class="ss-wide">Pitch fader (tempo + pitch drop together, like a turntable)<input data-rate aria-label="Record speed" type="range" min="0.5" max="1.1" step="0.005" value="1"></label>
        <div class="screw-tools"><button data-rate-to="1">ORIGINAL</button><button data-rate-to=".9">−10%</button><button data-rate-to=".8">−20%</button><button data-rate-to=".7">−30%</button><label>Target BPM<input data-target type="number" min="30" max="200" step="0.5" aria-label="Target BPM" placeholder="65"></label><button data-action="target">SET BPM</button></div>
        <div class="screw-tools"><label class="ss-check"><input type="checkbox" data-link checked> Both tables move together</label><button data-hold aria-label="Hold to drag the live record">✋ HOLD TO DRAG (D)</button></div></div>
      <div class="ss-step"><b>3 · PITCH + VOICE</b>
        <p class="ss-keys">The screwed voice comes from slowing the record: the voice drops with the beat, like a turntable. Add TAPE under each table for the dubbed-cassette warble and dull top end, SYRUP for the room, and DOUBLE UP for the echo. Vocal pitch takes the voice lower than the beat. Whole song pitch is a digital shifter and can sound robotic; leave it at 0 for the classic sound.</p>
        <div class="screw-tools"><label>Vocal pitch<input data-vocal aria-label="Vocal pitch" type="range" min="-12" max="12" step="1" value="0"><output data-vocal-label>0 st</output></label><label>Whole song pitch<input data-pitch aria-label="Extra pitch" type="range" min="-12" max="12" step="1" value="0"><output data-pitch-label>0 st</output></label></div>
        <p data-vocal-note></p><button data-action="split" hidden>SPLIT VOCALS FROM BEAT</button></div>
      <div class="ss-step"><b>4 · CHOP IT LIVE</b>
        <p>Play the record. When a line hits, RUN IT BACK: the other table jumps that many beats behind and the fader cuts to it, so the line plays again and the song keeps going from there. Press again to run it back again.</p>
        <div class="screw-tools"><button data-action="play" class="ss-go">▶ PLAY / PAUSE</button><button data-action="stop">■ STOP</button><label>Repeat<select data-times aria-label="Repeat times"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label></div>
        <div class="screw-tools ss-run" aria-label="Run it back">${beats.map(([n,l])=>`<button data-back="${n}">↺ ${l}</button>`).join('')}</div>
        <div class="screw-tools"><button data-action="hookIn">HOOK IN</button><button data-action="hookOut">HOOK OUT</button><button data-action="hook">PLAY HOOK → DROP IN (H)</button><button data-action="double" aria-pressed="false">DOUBLE UP</button></div>
        <p class="ss-keys" data-hook>Keys: Z ½ beat · X 1 beat · C 2 beats · V 1 bar · B 2 bars · H hook · hold D drag · hold Q / P slow A / B · G lag · hold F flick · [ ] cut tables.</p></div>
      <div class="ss-step"><b>5 · MAKE A VERSION</b>
        <div class="screw-tools ss-styles" role="radiogroup" aria-label="Version style"><label><input type="radio" name="ss-style" value="screw" checked> DJ Screw</label><label><input type="radio" name="ss-style" value="watts"> Michael Watts</label><label><input type="radio" name="ss-style" value="slowed"> Slowed only</label></div>
        <p data-style-note></p>
        <div class="screw-tools"><label>New version name <input data-name aria-label="New version name" placeholder="My screwed version"></label><button data-action="build" class="ss-go">BUILD VERSION</button><button data-action="reshuffle" hidden>NEW CHOPS</button></div>
        <ol class="ss-plan" data-plan hidden></ol>
        <div class="screw-tools"><button data-action="preview" hidden>▶ PREVIEW</button><button data-action="saveVersion" hidden>SAVE TO SONGS</button><button data-action="record">RECORD LIVE MIX</button><button data-action="retry" hidden>RETRY SAVE</button></div></div>
      <p data-status role="status"></p>`;
    (room.querySelector('.screw-modes')||room.querySelector('.dj-intro')).after(this.host);
    const q=s=>this.host.querySelector(s);
    this.host.onclick=e=>{const b=e.target.closest('button');if(!b||b.dataset.hold!=null)return;
      if(b.dataset.back)return this.run(()=>this.runBack(+b.dataset.back));
      if(b.dataset.rateTo)return this.run(()=>this.setSpeed(+b.dataset.rateTo,600));
      if(b.dataset.action)this.run(()=>this.action(b.dataset.action));};
    q('[data-rate]').oninput=e=>this.run(()=>this.setSpeed(+e.target.value,120));
    q('[data-vocal]').oninput=e=>this.run(()=>this.setVocalPitch(+e.target.value));
    q('[data-src-bpm]').onchange=e=>this.run(()=>this.setRecordBpm(+e.target.value));
    q('[data-pitch]').oninput=e=>{for(const w of ['A','B'])this.pitch(w,+e.target.value);};
    q('[data-style-note]').textContent=this.styleNote('screw');
    this.host.querySelectorAll('[name=ss-style]').forEach(r=>r.onchange=()=>{q('[data-style-note]').textContent=this.styleNote(r.value);this.clearVersion();});
    const hold=q('[data-hold]');hold.onpointerdown=e=>{e.preventDefault();hold.setPointerCapture(e.pointerId);this.run(()=>this.hold());};hold.onpointerup=hold.onpointercancel=hold.onlostpointercapture=()=>this.release();
    this.librarySignature=null;
  }
  styleNote(style){return {
    screw:'DJ Screw: two copies of the record, one a beat behind. Short chops (1–2 beats) on lines, a bar back on the hook, doubled-up echo spots, slightly darker top end. Tempo lands around 60–70 BPM.',
    watts:'Michael Watts: cleaner and crisper. Fewer, bigger chops that grab a phrase and bring it back (2 beats to 2 bars), and the hook run back twice before the song drops back in.',
    slowed:'Slowed only: the whole record at the table speed and pitch, with no chops.'}[style];}

  refresh(){
    const q=s=>this.host.querySelector(s),a=this.app,w=this.live(),d=a.deckStore(w),S=a.state['deck'+w];
    const library=a.state.library||[],signature=JSON.stringify(library.map(x=>[x.id,x.name]));
    if(signature!==this.librarySignature){const select=q('[data-library]'),old=select.value;select.innerHTML='<option value="">Choose a song</option>'+library.map(x=>`<option value="${this.esc(x.id)}">${this.esc(x.name)}</option>`).join('');select.value=old;this.librarySignature=signature;}
    const rate=d.rate??S.rate,bpm=this.bpm(w);
    if(document.activeElement!==q('[data-rate]'))q('[data-rate]').value=rate;
    q('[data-bpm]').textContent=bpm?(bpm*rate).toFixed(1)+' BPM':'— BPM';
    if(document.activeElement!==q('[data-src-bpm]'))q('[data-src-bpm]').value=bpm?bpm.toFixed(2):'';
    q('[data-bpm-sub]').textContent=bpm?`Table ${w} on air · original ${bpm.toFixed(1)} BPM · ${rate.toFixed(3)}× speed${this.app.deckStore(this.other(w)).buffer?` · table ${this.other(w)} ${(this.nowBpm(this.other(w))||0).toFixed(1)} BPM`:''}`:'Load a record to read its tempo.';
    q('[data-song]').textContent=d.buffer?`${S.fileName} · ${a.fmtClock(d.buffer.duration)} · ${d.stems?'vocals split loaded':'full mix'}${this.same(w)?' · on both tables':''}`:q('[data-song]').textContent;
    q('[data-vocal]').disabled=!d.stems;q('[data-vocal]').value=d.vocalPitchValue||0;q('[data-vocal-label]').textContent=(d.vocalPitchValue||0)+' st';
    q('[data-pitch]').value=d.pitchValue||0;q('[data-pitch-label]').textContent=(d.pitchValue||0)+' st';
    const job=this.item&&a.state.splitJobs?.[this.item.id],split=q('[data-action=split]');
    split.hidden=!d.buffer||!!d.stems||!this.item||(job&&!['error'].includes(job.status));
    q('[data-vocal-note]').textContent=d.stems?'Vocals move on their own. The beat keeps the table pitch.':job&&job.status!=='error'?'Splitting vocals from the beat: '+job.status+'… they load onto the tables when ready.':job?.status==='error'?'Split failed: '+(job.error||'unknown error'):this.item?'Vocal pitch needs the vocals split from the beat (takes a minute or two).':d.buffer?'Vocal pitch needs a song from SONGS (so it can be split). Whole song pitch works on any file.':'';
    const stemSig=(a.state.allStems||[]).map(s=>s.id).join();
    if(job?.status==='done'&&!d.stems&&!this.loading&&this.attachSig!==stemSig&&!a.state.deckA.playing&&!a.state.deckB.playing){this.attachSig=stemSig;this.run(()=>this.loadBoth(this.item,true));}
    q('[data-hook]').textContent=this.hook?`Hook ${a.fmtClock(this.hook.start)}–${a.fmtClock(this.hook.end)} (${((this.hook.end-this.hook.start)/(60/(bpm||90))).toFixed(1)} beats). Keys: Z X C V B run back · H hook · hold D drag.`:'Keys: Z ½ beat · X 1 beat · C 2 beats · V 1 bar · B 2 bars · H hook · hold D drag · hold Q / P slow A / B · G lag · hold F flick · [ ] cut tables.';
    q('[data-action=double]').setAttribute('aria-pressed',!!this.doubled);
    q('[data-action=record]').textContent=this.recording?'STOP & SAVE MIX':'RECORD LIVE MIX';
    q('[data-action=retry]').hidden=!this.pending;
    q('[data-action=preview]').textContent=this.previewing?'■ STOP PREVIEW':'▶ PREVIEW';
  }

  // ---- Record loading ----
  async decode(data){const T=await this.app.ensureScrewLibs();return T.getContext().rawContext.decodeAudioData(data);}
  async fetchBuffer(url){const r=await fetch(url);if(!r.ok)throw Error('Could not read audio ('+r.status+').');return this.decode(await r.arrayBuffer());}
  async findStems(item){
    const a=this.app;if(!a.sb||!item.storage_path)return null;
    const {data:beat}=await a.sb.from('beats').select('*').eq('storage_path',item.storage_path).maybeSingle();if(!beat)return null;
    const stems=(a.state.allStems||[]).filter(s=>s.beatId===beat.id&&s.url),v=stems.find(s=>s.kind==='vocals'),i=stems.find(s=>s.kind==='instrumental');
    if(!v||!i)return null;
    const [vocals,instrumental]=await Promise.all([this.fetchBuffer(v.url),this.fetchBuffer(i.url)]);
    return {vocals,instrumental};
  }
  async loadBoth(source,keep){
    if(this.loading)throw Error('Still loading the last record.');
    this.loading=true;
    try{
      const a=this.app;this.stopPreview();this.release();for(const w of ["A","B"]){cancelAnimationFrame(this.glideRaf[w]);this.slowing[w]=null;}this.clearVersion();
      let name,buffer,stems=null;
      if(source instanceof File){name=source.name;this.message('Loading '+name+'…');buffer=await this.decode(await source.arrayBuffer());this.item=null;}
      else{if(!source.url)throw Error('That song has no audio file.');name=source.name;this.message('Loading '+name+'…');[buffer,stems]=await Promise.all([this.fetchBuffer(source.url),this.findStems(source).catch(()=>null)]);this.item=source;}
      a.pauseBothDecks();
      const kept=keep&&{rate:a.deckStore('A').rate??1,pitch:a.deckStore('A').pitchValue||0};
      for(const w of ['A','B']){await a.mountDeckBuffer(w,name,buffer,stems);if(kept){a.setDeckRate(w,kept.rate);this.pitch(w,kept.pitch);}}
      this.hook=null;this.doubled=false;this.clearTimers('A');this.clearTimers('B');
      a.setCrossfade(-1);this.lastLive='A';
      this.message(`${name} is on both tables · ${this.bpm('A').toFixed(1)} BPM${stems?' · vocals split loaded':''}. Slow it down, then PLAY.`);
    }finally{this.loading=false;}
  }
  pitch(w,n){const d=this.app.deckStore(w);d.pitchValue=n;if(d.pitch){d.pitch.pitch=n;d.pitch.wet.value=n===0?0:1;}}
  setVocalPitch(n){
    if(!this.app.deckStore(this.live()).stems)throw Error('Vocal pitch needs the vocals split loaded first.');
    for(const w of ['A','B']){const d=this.app.deckStore(w);if(!d.vocalPitch)continue;d.vocalPitchValue=n;d.vocalPitch.pitch=n;d.vocalPitch.wet.value=n?1:0;}
  }
  setRecordBpm(bpm){
    const a=this.app,w=this.live(),d=a.deckStore(w);
    if(!d.buffer)throw Error('Load a record first.');
    if(!(bpm>=30&&bpm<=250))throw Error('Record BPM should be between 30 and 250.');
    for(const k of ['A','B']){const o=a.deckStore(k);if(k===w||this.same(w))o.bpm=bpm;}
    this.tempoCache.set(d.buffer,{bpm,firstBeat:d.firstBeat||0});this.analysis=null;this.clearVersion();
    a.setState({sourceBpm:Math.round(bpm*10)/10});this.message('Record BPM set to '+bpm.toFixed(2)+'. Run-backs now use this tempo.');
  }
  deckLoaded(w){
    const d=this.app.deckStore(w);
    let tempo=this.tempoCache.get(d.buffer);
    if(!tempo){tempo=window.ScrewChop.detectTempo(d.buffer);this.tempoCache.set(d.buffer,tempo);}
    d.bpm=tempo.bpm;d.firstBeat=tempo.firstBeat;
    if(w==='A')this.app.setState({sourceBpm:Math.round(tempo.bpm*10)/10});
    if(this.recorder)d.gain.connect(this.recorder);
    if(!this.loading)this.message('Table '+w+' ready at '+d.bpm.toFixed(1)+' BPM. Drag the record to scratch.');
  }
  seek(w,pos){const a=this.app,d=a.deckStore(w);if(!d.buffer)return;pos=Math.max(0,Math.min(d.buffer.duration-.001,pos));if(a.state['deck'+w].playing)a.startDeckAt(w,a._Tone.now(),pos);else{d.startOffset=pos;d.startedAt=a._Tone.now();}}

  // ---- Speed: glide like a pitch fader / hand on the platter ----
  quietRate(w,r){const a=this.app,d=a.deckStore(w);if(!d.player)return;if(a.state['deck'+w].playing){const now=a._Tone.now();d.startOffset=a.deckPosition(w,now);d.startedAt=now;}d.rate=r;d.player.playbackRate=r;}
  // Each table glides on its own, so one side can slow down while the other keeps going.
  // linear = constant deceleration (a platter braking); otherwise ease-out (a hand on the pitch fader).
  glide(decks,target,ms,linear,done){
    const a=this.app;decks=decks.filter(w=>a.deckStore(w).player);
    this.rateTarget ||= {};
    for(const w of decks){
      cancelAnimationFrame(this.glideRaf[w]);this.rateTarget[w]=target;
      const from=a.deckStore(w).rate??a.state['deck'+w].rate,t0=performance.now();
      const step=()=>{const k=Math.min(1,(performance.now()-t0)/Math.max(1,ms)),e=linear?k:1-Math.pow(1-k,2);
        this.quietRate(w,from+(target-from)*e);
        if(k<1){this.glideRaf[w]=requestAnimationFrame(step);return;}
        this.glideRaf[w]=null;a.setDeckRate(w,target);if(a.state.transportSource==='decks'&&w===this.live())a.setState({beatRate:target});done?.(w);};
      step();
    }
  }
  linked(){return this.host?.querySelector('[data-link]')?.checked!==false;}
  setSpeed(rate,ms=300){
    const w=this.live();if(!this.app.deckStore(w).buffer)throw Error('Load a record first.');
    rate=Math.max(.25,Math.min(2,rate));this.glide(this.linked()?['A','B']:[w],rate,ms);
  }
  // ---- Slow one side down: DRAG (hand on the platter while held) or STOP (motor off, record winds down) ----
  // Time is how long the slowdown takes, from 0.02 s (a snap) to 4 s.
  slowDown(w,settings){
    const a=this.app,d=a.deckStore(w);if(!d.player||this.slowing[w])return;
    if(!a.state['deck'+w].playing){this.message('Table '+w+' is not playing.');return;}
    const s=settings||this.tables.settings[w],rate=d.rate??a.state['deck'+w].rate,ms=s.time*1000;
    this.slowing[w]={rate,mode:s.mode,time:s.time};this.bump('slow');
    if(s.mode==='stop'){
      this.glide([w],0.001,ms,true,()=>{if(!this.slowing[w])return;a.pauseDeckAt(w,a._Tone.now());a.setDeckRate(w,rate);this.slowing[w]=null;this.message('Table '+w+' wound down. Press PLAY to start it again.');});
      this.message('Table '+w+' winding down over '+s.time.toFixed(2)+' s.');
    } else this.glide([w],rate*(1-s.depth),ms,false);
  }
  slowUp(w){
    const h=this.slowing[w];if(!h||h.mode==='stop')return;
    this.slowing[w]=null;this.glide([w],h.rate,h.time*1000,false);
  }
  // HOLD TO DRAG / D: slow the live table by about 18%, quickly, like a hand on the record.
  hold(){const w=this.live();if(this.dragging)return;this.dragging=w;this.slowDown(w,{mode:'drag',depth:.18,time:.22});}
  release(){const w=this.dragging;if(!w)return;this.dragging=null;this.slowUp(w);}
  get held(){const w=this.dragging;return w&&this.slowing[w]?{w,rate:this.slowing[w].rate}:null;}
  // Speed pads: move one table's speed by `step` (−0.01, −0.02 …). Repeated taps add up exactly.
  stepSpeed(w,step){
    const a=this.app,d=a.deckStore(w);if(!d.player)throw Error('Load a record on table '+w+' first.');
    const h=this.slowing[w],fit=r=>Math.round(Math.max(.25,Math.min(2,r))*1000)/1000;
    if(h&&h.mode==='drag'){h.rate=fit(h.rate+step);return;}
    const from=this.glideRaf[w]&&this.rateTarget?.[w]!=null?this.rateTarget[w]:(d.rate??a.state['deck'+w].rate),to=step==null?1:fit(from+step);
    this.glide([w],to,120);this.bump('step');
    this.message('Table '+w+' at '+to.toFixed(2)+'×'+(d.bpm?' · '+(d.bpm*to).toFixed(1)+' BPM':'')+'.');
  }
  setTape(w,v){const d=this.app.deckStore(w);d.tapeValue=v;d.tape?.set(v);}

  // ---- Chops ----
  clearTimers(w){this.timers[w].forEach(clearTimeout);this.timers[w]=[];const d=this.app.deckStore(w);if(d.chopMarks){[d.loopStart,d.loopEnd]=d.chopMarks;d.chopMarks=null;}}
  cutTo(w,time){
    const a=this.app,T=a._Tone;if(!T)return;time=time??T.now();
    const x=w==='A'?-1:w==='B'?1:0;
    for(const k of ['A','B']){const g=a.deckStore(k).gain;if(!g)continue;const blend=k==='A'?Math.cos((x+1)*Math.PI/4):Math.sin((x+1)*Math.PI/4);g.gain.cancelScheduledValues(time);g.gain.rampTo((a.state['deck'+k].level??1)*(blend<1e-9?0:blend),.005,time);}
    if(w!=='center')this.lastLive=w;
    a.setState({crossfade:x});
  }
  // The other table plays `from`..`to` `times` times, then keeps going (the drop-in). The fader cuts to it on time.
  // Speed the table really runs at: a held (dragged) table counts at its normal speed.
  baseRate(w){const d=this.app.deckStore(w);return this.slowing[w]?this.slowing[w].rate:(d.rate??this.app.state['deck'+w].rate);}
  chop(from,to,times,why,t){
    const a=this.app,w=this.live(),o=this.other(w),L=a.deckStore(w),O=a.deckStore(o);
    if(!L.buffer)throw Error('Load a record first.');
    if(!this.same(w))throw Error('Both tables need the same record. Use LOAD ON BOTH TABLES.');
    const T=a._Tone;t=t??T.now()+.03;
    const rate=this.baseRate(w);if(O.rate!==rate||a.state['deck'+o].rate!==rate)a.setDeckRate(o,rate);
    this.clearTimers(o);this.doubled=false;
    a.startDeckAt(o,t,from);
    if(times>1){
      O.chopMarks=[O.loopStart,O.loopEnd];O.loopStart=from;O.loopEnd=to;O.player.loopStart=from;O.player.loopEnd=to;O.player.loop=true;
      const pass=(to-from)/(O.rate??1),unloop=t+(times-.5)*pass;
      this.timers[o].push(setTimeout(()=>{const now=T.now(),pos=a.deckPosition(o,now);O.player.loop=false;O.startOffset=pos;O.startedAt=now;[O.loopStart,O.loopEnd]=O.chopMarks||[null,null];O.chopMarks=null;},Math.max(0,(unloop-T.now())*1000)));
    }
    this.cutTo(o,t);
    this.message(why+(times>1?' ×'+times:'')+' on table '+o+', then the song drops back in.');
  }
  async runBack(beats,times){
    const a=this.app,w=this.live();
    if(!a.state['deck'+w].playing)throw Error('Press PLAY first, then run it back on a line you like.');
    times=times||+this.host.querySelector('[data-times]').value||1;
    const L=a.deckStore(w),beatLen=beats*60/(this.bpm(w)||90);
    if(a.deckPosition(w,a._Tone.now()+.03)-beatLen<0)throw Error('Not far enough into the song to run back '+window.ScrewChop.beatsLabel(beats)+'.');
    // Measure the exact N-beat length at this spot, then schedule from the position at the cut time.
    const len=window.ScrewChop.runBackLength(L.buffer,a.deckPosition(w,a._Tone.now()+.05),beats,60/(this.bpm(w)||90));
    const t=a._Tone.now()+.03,pos=a.deckPosition(w,t);
    if(!this.same(w)){a.startDeckAt(w,t,Math.max(0,pos-len));this.bump('runBack');this.message('Ran table '+w+' back '+window.ScrewChop.beatsLabel(beats)+' (different records on A and B, so the live table jumps back itself).');return;}
    this.chop(Math.max(0,pos-len),pos,times,'Ran it back '+window.ScrewChop.beatsLabel(beats),t);this.bump('runBack');
  }
  snap(w,t){const d=this.app.deckStore(w),beat=60/(d.bpm||90),n=Math.round((t-(d.firstBeat||0))/beat),s=(d.firstBeat||0)+n*beat;return Math.abs(s-t)<.12&&s>=0?s:t;}
  async playHook(){
    const a=this.app,w=this.live();
    if(!this.hook)throw Error('Mark HOOK IN (and HOOK OUT) while the hook plays first.');
    if(!a.deckStore(w).buffer)throw Error('Load a record first.');
    if(!a.state['deck'+w].playing){a.startDeckAt(w,a._Tone.now()+.03,this.hook.start);return;}
    this.chop(this.hook.start,this.hook.end,+this.host.querySelector('[data-times]').value||2,'Hook');
  }
  // Start the off-air table `beats` behind the live one at the same speed (the Screw setup).
  behind(beats){
    const a=this.app,w=this.live(),o=this.other(w),L=a.deckStore(w);
    if(!a.state['deck'+w].playing)throw Error('Press PLAY first.');
    if(!this.same(w))throw Error('Both tables need the same record. Use LOAD ON BOTH TABLES.');
    const len=window.ScrewChop.runBackLength(L.buffer,a.deckPosition(w,a._Tone.now()+.05),beats,60/(this.bpm(w)||90)),t=a._Tone.now()+.03,pos=a.deckPosition(w,t);
    a.setDeckRate(o,this.baseRate(w));this.clearTimers(o);
    a.startDeckAt(o,t,Math.max(0,pos-len));return {w,o,t};
  }
  async toggleDouble(){
    if(this.doubled){this.doubled=false;this.cutTo(this.lastLive);return;}
    const {w,o,t}=this.behind(1);this.cutTo('center',t);this.doubled=true;this.lastLive=w;
    this.message('Doubled up: table '+o+' runs one beat behind. Press DOUBLE UP again to go back to one table.');
  }
  // LAG (G): the off-air table runs behind, silent. Hold F (FLICK) or [ ] to chop back and forth.
  lagBehind(beats){
    beats=beats||this.tables.lagBeats();if(this.doubled){this.doubled=false;this.cutTo(this.lastLive);}
    const {w,o}=this.behind(beats);this.bump('lag');
    this.message('Table '+o+' is running '+window.ScrewChop.beatsLabel(beats)+' behind table '+w+'. Hold F (FLICK) to chop to it, or [ ] to switch tables.');
  }
  // Transformer-style flick: the other table only while held.
  flickDown(){if(this.flick)return;const w=this.live(),o=this.other(w);if(!this.app.deckStore(o).buffer)return;this.flick={back:w};this.doubled=false;this.cutTo(o);this.bump('flick');}
  flickUp(){if(!this.flick)return;const {back}=this.flick;this.flick=null;this.cutTo(back);}

  async action(action){
    const a=this.app,w=this.live(),d=a.deckStore(w);
    if(action==='load'){const input=document.createElement('input');input.type='file';input.accept='audio/*,.mp3,.wav,.m4a';input.onchange=()=>input.files[0]&&this.run(()=>this.loadBoth(input.files[0]));input.click();return;}
    if(action==='library'){const item=a.state.library.find(x=>x.id===this.host.querySelector('[data-library]').value);if(!item)throw Error('Choose a saved song first.');return this.loadBoth(item);}
    if(action==='retry')return this.savePending();
    if(action==='record')return this.record();
    if(action==='split'){if(!this.item)throw Error('Load a song from SONGS to split it.');await a.requestSplit(this.item,'quick');return;}
    if(action==='preview')return this.togglePreview();
    if(action==='saveVersion')return this.saveVersion();
    if(action==='reshuffle'){this.seed=(this.seed||1)+1;return this.build();}
    if(!d.buffer)throw Error('Load a record first.');
    if(action==='play'){this.stopPreview();if(a.state['deck'+w].playing){a.pauseBothDecks();return;}this.cutTo(w);return a.toggleDeckPlay(w);}
    if(action==='stop'){this.clearTimers('A');this.clearTimers('B');this.doubled=false;for(const k of ['A','B']){const h=this.slowing[k];if(h){cancelAnimationFrame(this.glideRaf[k]);this.slowing[k]=null;a.setDeckRate(k,h.rate);}}return a.stopBothDecks();}
    if(action==='target'){const target=+this.host.querySelector('[data-target]').value;if(!(target>0))throw Error('Type a target BPM first.');return this.setSpeed(target/(this.bpm(w)||target),700);}
    if(action==='hookIn'){const t=this.snap(w,a.deckPosition(w));this.hook={start:t,end:t+8*60/(this.bpm(w)||90)};this.clearVersion();return;}
    if(action==='hookOut'){if(!this.hook)throw Error('Set HOOK IN first.');const t=this.snap(w,a.deckPosition(w));if(t-this.hook.start<.2)throw Error('HOOK OUT has to come after HOOK IN.');this.hook.end=t;this.clearVersion();return;}
    if(action==='hook')return this.playHook();
    if(action==='half'||action==='double2')return this.setRecordBpm((d.bpm||90)*(action==='half'?.5:2));
    if(action==='double')return this.toggleDouble();
    if(action==='build')return this.build();
  }

  // ---- Build a Screw / Watts version offline ----
  style(){return this.host.querySelector('[name=ss-style]:checked')?.value||'screw';}
  defaultRate(style,bpm){const base=bpm>=120?bpm/2:bpm,target={screw:64,watts:70,slowed:66}[style];return Math.max(.6,Math.min(.85,target/base));}
  clearVersion(){this.version=null;if(!this.host)return;const q=s=>this.host.querySelector(s);q('[data-plan]').hidden=true;q('[data-action=preview]').hidden=q('[data-action=saveVersion]').hidden=q('[data-action=reshuffle]').hidden=true;this.stopPreview();}
  async build(){
    if(this.building)return;
    if(this.stems.exporting||this.recording)throw Error('Finish the current render or live recording first.');
    const a=this.app,w=this.live(),d=a.deckStore(w),S=a.state['deck'+w],style=this.style();
    if(!d.buffer)throw Error('Load a record first.');
    this.building=true;this.clearVersion();
    try{
      let rate=d.rate??S.rate;
      if(rate>.99&&style!=='slowed'){rate=Math.round(this.defaultRate(style,d.bpm||90)*1000)/1000;this.glide(['A','B'],rate,600);}
      this.message('Listening to the record: beats, vocal lines, the hook…');await new Promise(r=>setTimeout(r,30));
      if(this.analysis?.buffer!==d.buffer||this.analysis.vocals!==d.stems?.vocals)this.analysis={buffer:d.buffer,vocals:d.stems?.vocals,an:window.ScrewChop.analyzeSong(d.buffer,d.stems?.vocals,{bpm:d.bpm,firstBeat:d.firstBeat})};
      const plan=window.ScrewChop.planVersion(this.analysis.an,style,{rate,seed:this.seed||1,hook:this.hook,refine:(at,beats,beat)=>window.ScrewChop.runBackLength(d.buffer,at,beats,beat)});
      this.message(`Rendering ${plan.name} version at ${(d.bpm*rate).toFixed(1)} BPM (${a.fmtClock(plan.outDuration)} long)…`);await new Promise(r=>setTimeout(r,30));
      const buffer=await window.ScrewChop.renderVersion(a._Tone,{mix:d.buffer,...(d.stems||{})},plan,{pitch:d.pitchValue||0,vocalPitch:d.vocalPitchValue||0,bass:S.bass||0,treble:S.treble||0,syrup:S.reverbOn,tape:d.tapeValue||0});
      const song=S.fileName.replace(/\.[^.]+$/,''),name=this.host.querySelector('[data-name]').value.trim()||`${song} (${plan.name} style)`;
      this.version={buffer,plan,name};
      const list=this.host.querySelector('[data-plan]');
      list.innerHTML=(plan.notes.length?plan.notes:[{text:'No chops: straight slowed version.'}]).map(n=>`<li>${this.esc(n.text)}</li>`).join('');list.hidden=false;
      for(const k of ['preview','saveVersion'])this.host.querySelector(`[data-action=${k}]`).hidden=false;
      this.host.querySelector('[data-action=reshuffle]').hidden=style==='slowed';
      this.message(`${plan.name} version ready: ${plan.notes.length} chops, ${a.fmtClock(buffer.duration)}. PREVIEW it, then SAVE TO SONGS.`);
    }finally{this.building=false;}
  }
  async togglePreview(){
    if(this.previewing){this.stopPreview();return;}
    if(!this.version)throw Error('Build a version first.');
    const a=this.app,T=await a.ensureScrewLibs();await T.start();a.pauseBothDecks();this.stems.pause();
    this.previewPlayer=new T.Player(this.version.buffer).toDestination();this.previewPlayer.onstop=()=>{this.previewing=false;};
    this.previewPlayer.start();this.previewing=true;
  }
  stopPreview(){if(this.previewPlayer){this.previewPlayer.onstop=()=>{};this.previewPlayer.stop();this.previewPlayer.dispose();this.previewPlayer=null;}this.previewing=false;}
  async saveVersion(){
    if(!this.version)throw Error('Build a version first.');
    if(this.pending)throw Error('Retry saving the previous version first.');
    this.pending={blob:this.wav(this.version.buffer),name:this.version.name,ext:'wav'};await this.savePending();
  }

  // ---- Jog wheel: drag the top to scratch, the outer ring to nudge ----
  // One full turn is 1.8 s of record (33⅓ rpm), so the platter and the sound move together.
  // Touching the top stops the record (vinyl mode); letting go drops it back in at speed.
  async scratchNode(d){
    const T=this.app._Tone,ctx=T.getContext();
    this.scratchReady ||= ctx.rawContext.audioWorklet.addModule('/scratch-worklet.js');
    await this.scratchReady;
    if(d.scratchNode&&d.scratchFor===d.pitch)return d.scratchNode;
    d.scratchNode?.disconnect();
    d.scratchNode=ctx.createAudioWorkletNode('ss-scratch',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
    T.connect(d.scratchNode,d.pitch);d.scratchFor=d.pitch;return d.scratchNode;
  }
  // The worklet gets ±12 s of record around the hand, not the whole song.
  scratchWindow(d,pos,keep){
    const b=d.buffer,sr=b.sampleRate,i0=Math.floor(Math.max(0,pos-12)*sr),i1=Math.min(b.length,Math.ceil((pos+12)*sr));
    const ch=Array.from({length:b.numberOfChannels},(_,c)=>b.getChannelData(c).slice(i0,i1));
    d.scratch.win=[i0/sr,i1/sr];
    d.scratchNode.port.postMessage({type:'load',ch,start:i0/sr,sr,pos:keep?undefined:pos},ch.map(x=>x.buffer));
  }
  jog(e,el){const r=el.getBoundingClientRect(),x=e.clientX-(r.left+r.width/2),y=e.clientY-(r.top+r.height/2);return {angle:Math.atan2(y,x),r:Math.hypot(x,y)/(r.width/2)};}
  async beginScratch(w,e){
    if(e.button!==0)return;
    const a=this.app,d=a.deckStore(w);if(!d.buffer){this.message('Load a song first.');return;}
    e.preventDefault();const el=e.currentTarget;try{el.setPointerCapture(e.pointerId);}catch(err){}
    this.stems.pause();this.stopPreview();this.endScratch(w);
    const {angle,r}=this.jog(e,el),playing=a.state['deck'+w].playing;
    if(r>.86&&playing){d.scratch={nudge:true,el,angle,x:e.clientX,time:performance.now(),rate:d.rate??a.state['deck'+w].rate};return;}
    const pos=a.deckPosition(w,a._Tone.immediate());
    a.pauseDeckAt(w,a._Tone.immediate());
    d.scratch={el,angle,x:e.clientX,pos,resume:playing};
    await a._Tone.start();await this.scratchNode(d);
    if(d.scratch?.el===el&&!d.scratch.win)this.scratchWindow(d,d.scratch.pos);
  }
  moveScratch(w,e){
    const a=this.app,d=a.deckStore(w),s=d.scratch;if(!s)return;
    const {angle,r}=this.jog(e,s.el);
    let turn=angle-s.angle;if(turn>Math.PI)turn-=2*Math.PI;if(turn<-Math.PI)turn+=2*Math.PI;
    // Near the spindle the angle jumps around, so use left/right movement there instead.
    if(r<.18)turn=(e.clientX-s.x)/(s.el.clientWidth/2);
    s.angle=angle;s.x=e.clientX;if(!turn)return;
    if(s.nudge){
      const now=performance.now(),dt=Math.max(8,now-s.time)/1000,bend=Math.max(-.4,Math.min(.4,turn/dt/(2*Math.PI/1.8)*.3));
      s.time=now;this.quietRate(w,s.rate*(1+bend));clearTimeout(s.back);s.back=setTimeout(()=>this.quietRate(w,s.rate),80);return;
    }
    if(!s.moved){s.moved=true;this.bump('scratch');}
    s.pos=Math.max(0,Math.min(d.buffer.duration-.001,s.pos+turn/(2*Math.PI)*1.8));
    d.startOffset=s.pos;d.angle=(d.angle||0)+turn*180/Math.PI;
    if(!s.win)return;
    if((s.pos<s.win[0]+2&&s.win[0]>0)||(s.pos>s.win[1]-2&&s.win[1]<d.buffer.duration))this.scratchWindow(d,s.pos,true);
    d.scratchNode.port.postMessage({type:'target',pos:s.pos});
  }
  endScratch(w){
    const a=this.app,d=a.deckStore(w),s=d.scratch;if(!s)return;d.scratch=null;
    if(s.nudge){clearTimeout(s.back);this.quietRate(w,s.rate);return;}
    if(!s.resume){d.scratchNode?.port.postMessage({type:'stop'});d.startOffset=s.pos;return;}
    // The deck starts one look-ahead from now; the worklet carries the record at speed until then.
    const T=a._Tone,lead=Math.max(0,T.now()-T.immediate()),rate=d.rate??a.state['deck'+w].rate;
    d.scratchNode?.port.postMessage({type:'run',rate,dur:lead});
    a.startDeckAt(w,T.now(),s.pos+rate*lead);
  }

  // ---- Live recording and saving ----
  async record(){
    if(this.building||this.stems.exporting)throw Error('Wait for the WAV render to finish.');
    if(this.recordBusy)return;this.recordBusy=true;
    try {
      if(this.recording){const blob=await this.recorder.stop();this.recording=false;for(const w of ['A','B'])this.app.deckStore(w).gain?.disconnect(this.recorder);this.recorder.dispose();this.recorder=null;this.pending={blob,name:this.versionName('Live screw mix'),ext:blob.type.includes('mp4')?'m4a':'webm'};await this.savePending();return;}
      if(this.pending)throw Error('Retry saving the previous mix before recording another.');
      if(!['A','B'].some(w=>this.app.deckStore(w).buffer))throw Error('Load a song first.');
      const T=await this.app.ensureScrewLibs();await T.start();
      this.recorder=new T.Recorder();for(const w of ['A','B'])this.app.deckStore(w).gain?.connect(this.recorder);
      await this.recorder.start();this.recording=true;this.bump('record');this.message('Recording both tables. PLAY and chop it, then STOP & SAVE MIX.');
    }finally{this.recordBusy=false;}
  }
  versionName(fallback){return this.host.querySelector('[data-name]').value.trim()||fallback+' — screwed';}
  async savePending(){
    if(this.saving||!this.pending)return;this.saving=true;
    try{
      const a=this.app,p=this.pending;if(!a.sb)throw Error('Connect to the local computer before saving.');
      p.path ||= 'local/library/'+window.ScrewShop.id()+'.'+p.ext;p.id ||= window.ScrewShop.id();
      const upload=await a.sb.storage.from('beats').upload(p.path,p.blob);if(upload.error)throw Error(upload.error.message);
      const result=await a.sb.from('library').upsert({id:p.id,user_id:'local',name:p.name,storage_path:p.path,source_kind:'screw-version'});if(result.error)throw Error(result.error.message);
      this.pending=null;await a.loadLibrary();this.message('Saved “'+p.name+'” in SONGS. Original preserved.');
      this.stems.status('Saved “'+p.name+'” in SONGS. Original preserved.');
    }catch(e){this.message('Save failed; audio retained here. Use RETRY SAVE. '+e.message);}finally{this.saving=false;}
  }
  wav(buffer){
    const channels=buffer.numberOfChannels,frames=buffer.length,bytes=frames*channels*2,view=new DataView(new ArrayBuffer(44+bytes));
    const str=(at,s)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));};
    str(0,'RIFF');view.setUint32(4,36+bytes,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,buffer.sampleRate,true);view.setUint32(28,buffer.sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,bytes,true);
    const data=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));let at=44;
    for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){const n=Math.max(-1,Math.min(1,data[c][i]));view.setInt16(at,n*(n<0?32768:32767),true);at+=2;}
    return new Blob([view],{type:'audio/wav'});
  }
  dispose(){clearInterval(this.timer);Object.values(this.glideRaf).forEach(cancelAnimationFrame);this.tables.dispose();this.clearTimers('A');this.clearTimers('B');this.stopPreview();this.stems.dispose();this.blur();window.removeEventListener('blur',this.blur);document.removeEventListener('keydown',this.key);document.removeEventListener('keyup',this.keyUp);this.recorder?.dispose();for(const w of ['A','B']){this.app.deckStore(w).pitch?.dispose();this.app.deckStore(w).vocalPitch?.dispose();this.app.deckStore(w).tape?.dispose();this.app.deckStore(w).scratchNode?.disconnect();}}
};
