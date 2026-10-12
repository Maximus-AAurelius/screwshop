/* Two aligned stems, shared transport, and non-destructive per-track Smart Controls. */
window.ScrewStemEditor = class {
  constructor(room){this.room=room;this.app=room.app;this.rate=.75;this.position=0;this.selected=1;this.tracks=[this.empty('Instrumental'),this.empty('Vocals')];this.saveChain=Promise.resolve();}
  empty(name){return {name,url:null,level:.8,pitch:0,bass:0,treble:0,reverb:0,echo:0,mute:false,solo:false,start:0,end:null};}
  esc(s){return this.room.esc(s);}
  async checked(q){const r=await q;if(r.error)throw Error(r.error.message);return r.data;}
  snapshot(){return {rate:this.rate,tracks:this.tracks.map(({buffer,nodes,peaks,...t})=>t)};}
  async restore(){
    this.restoring=true;
    try{const saved=await this.checked(this.app.sb.from('settings').select('*').eq('id','screw-stem-editor').maybeSingle());if(saved?.project){this.rate=saved.project.rate;this.tracks=saved.project.tracks.map((t,i)=>({...this.empty(i?'Vocals':'Instrumental'),...t}));await Promise.all(this.tracks.map(async t=>{if(t.url)t.buffer=await this.decode(t.url);}));this.draw();}}
    catch(e){this.room.message('Stem session could not reopen: '+e.message);}
    finally{this.restoring=false;}
  }
  save(){
    if(!this.app.sb||this.restoring)return;
    const project=this.snapshot();
    this.saveChain=this.saveChain.catch(()=>{}).then(()=>this.checked(this.app.sb.from('settings').upsert({id:'screw-stem-editor',kind:'screw-stems',project}))).then(()=>{this.status('Edits saved on this computer.');}).catch(e=>this.status('Edits not saved: '+e.message));
  }
  status(text){this.lastStatus=text;const h=this.host?.querySelector('[data-stem-status]');if(h)h.textContent=text;}
  async decode(url){const r=await fetch(url);if(!r.ok)throw Error('Could not read stem ('+r.status+').');const T=await this.app.ensureScrewLibs();return T.getContext().rawContext.decodeAudioData(await r.arrayBuffer());}
  syncTransport(){
    let pos=this.current();const duration=this.duration();
    if(this.playing&&pos>=duration){this.pause();this.position=pos=0;if(this.loop)this.room.run(()=>this.play());}
    const s=this.app.state;
    if(s.transportSource==='screw-stems'&&(Math.abs((s.beatPos||0)-pos)>.1||s.beatDur!==duration||s.beatRate!==this.rate||s.beatLoop!==!!this.loop))this.app.setState({beatPos:pos,beatDur:duration,beatRate:this.rate,beatLoop:!!this.loop});
  }
  tick(room){
    if(!this.loaded&&this.app.sb){this.loaded=true;this.room.run(()=>this.restore());}
    if(!this.host?.isConnected){this.host=document.createElement('section');this.host.className='screw-stems';this.host.setAttribute('aria-label','Two-track stem editor');room.querySelector('.dj-intro').after(this.host);this.draw();}
    const signature=JSON.stringify((this.app.state.allStems||[]).map(s=>s.id));if(signature!==this.signature){this.signature=signature;this.updateSources();}
    const pos=this.current();
    const clock=this.host.querySelector('[data-stem-clock]');if(clock)clock.textContent=this.app.fmtClock(pos/this.rate)+' / '+this.app.fmtClock(this.duration()/this.rate);
    this.host.querySelector('[data-stem-action=play]').textContent=this.playing?'PAUSE':'▶ PLAY STEMS';
    this.host.querySelector('[data-stem-action=retry]').hidden=!this.room.pending;
    const speed=this.host.querySelector('[data-stem-speed]');if(document.activeElement!==speed)speed.value=this.rate;
    const src=this.tracks.find(t=>t.buffer)?.buffer,bpm=src&&this.room.tempoCache.get(src)?.bpm;this.host.querySelector('[data-stem-bpm]').textContent=this.rate.toFixed(3)+'×'+(bpm?' · '+(bpm*this.rate).toFixed(1)+' BPM (original '+bpm.toFixed(1)+')':'');
    this.paint(pos);
  }
  duration(){return Math.max(0,...this.tracks.map(t=>t.buffer?.duration||0));}
  current(){return this.playing?Math.min(this.duration(),this.position+Math.max(0,this.app._Tone.now()-this.started)*this.rate):this.position;}
  draw(){
    if(!this.host)return;
    this.host.innerHTML=`<header><div><small>VOCALS + INSTRUMENTAL</small><h3>Shape the vocals apart from the beat.</h3><p>Both stems share one speed. Double-click a track to change its pitch, EQ, reverb and echo. Originals are never changed.</p></div></header>
    <div class="screw-tools"><label>Completed splits<select data-split aria-label="Completed splits"></select></label><button data-stem-action="pair">LOAD SPLIT PAIR</button><button data-stem-action="play">▶ PLAY STEMS</button><button data-stem-action="stop">↤ START</button><label>Linked speed <output data-stem-bpm></output><input data-stem-speed aria-label="Stem playback speed" type="range" min="0.5" max="1.1" step="0.005" value="${this.rate}"></label><output data-stem-clock></output></div>
    <div class="stem-ruler"><span>TRACKS</span><span>Click waveform to seek · shared source timeline</span></div>
    ${this.tracks.map((t,i)=>`<div class="stem-row ${i===this.selected?'selected':''}" data-track="${i}"><div class="stem-heading"><strong>${i?'◉':'♫'} ${i?'Vocals':'Instrumental'}</strong><small title="${this.esc(t.name)}">${this.esc(t.url?t.name:'Load a stem to begin')}</small><div><button data-edit="${i}" aria-label="Edit ${i?'vocals':'instrumental'}">EDIT</button><button data-import="${i}" aria-label="Load ${i?'vocals':'instrumental'} file">LOAD</button><button data-mute="${i}" aria-pressed="${t.mute}">M</button><button data-solo="${i}" aria-pressed="${t.solo}">S</button></div></div><canvas width="1000" height="100" data-stem-wave="${i}" tabindex="0" role="button" aria-label="${i?'Vocals':'Instrumental'} region: double-click or press Enter to edit"></canvas></div>`).join('')}
    <div class="stem-inspector" data-inspector></div>
    <div class="screw-tools"><label>Stem mix version name<input data-stem-name aria-label="Stem mix version name" placeholder="My screwed vocals mix" value="${this.esc(this.version||'')}"></label><button data-stem-action="export">SAVE STEM MIX AS WAV</button><button data-stem-action="tables">SCREW THESE ON THE TABLES →</button><button data-stem-action="retry">RETRY AUDIO SAVE</button></div><p data-stem-status role="status">${this.esc(this.lastStatus||'Load a completed split, or load instrumental and vocals files separately. Both start at zero.')}</p>`;
    this.updateSources();this.inspector();
    this.host.onclick=e=>this.room.run(async()=>{
      const b=e.target.closest('button');if(!b)return;
      if(b.dataset.edit!=null){this.selected=+b.dataset.edit;this.inspector();return;}
      if(b.dataset.import!=null)return this.importFile(+b.dataset.import);
      if(b.dataset.mute!=null||b.dataset.solo!=null){const i=+(b.dataset.mute??b.dataset.solo),key=b.dataset.mute!=null?'mute':'solo';this.tracks[i][key]=!this.tracks[i][key];b.setAttribute('aria-pressed',this.tracks[i][key]);this.applyLevels();this.save();return;}
      const action=b.dataset.stemAction;
      if(action==='pair')return this.loadPair();
      if(action==='play')return this.playing?this.pause():this.play();
      if(action==='stop'){this.pause();this.position=0;return;}
      if(action==='reset'){const t=this.tracks[this.selected];Object.assign(t,{pitch:0,level:.8,bass:0,treble:0,reverb:0,echo:0,start:0,end:null});this.changed();this.inspector();return;}
      if(action==='deep'){Object.assign(this.tracks[this.selected],{pitch:-4,bass:2,treble:-2,reverb:.12,echo:.08});this.changed();this.inspector();return;}
      if(action==='export')return this.export();
      if(action==='tables')return this.toTables();
      if(action==='retry')return this.room.savePending();
    });
    this.host.querySelector('[data-stem-speed]').onchange=e=>{const resume=this.playing;this.pause();this.rate=+e.target.value;this.save();if(resume)this.room.run(()=>this.play());};
    this.host.querySelector('[data-stem-speed]').oninput=e=>{this.rate=+e.target.value;for(const t of this.tracks)if(t.nodes)t.nodes.player.playbackRate=this.rate;};
    this.host.querySelector('[data-stem-name]').oninput=e=>this.version=e.target.value;
    for(const canvas of this.host.querySelectorAll('[data-stem-wave]')){
      const edit=()=>{this.selected=+canvas.dataset.stemWave;this.inspector();};
      canvas.ondblclick=edit;canvas.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();edit();}};
      canvas.onclick=e=>{const rect=canvas.getBoundingClientRect(),resume=this.playing;this.pause();this.position=Math.max(0,Math.min(this.duration(),(e.clientX-rect.left)/rect.width*this.duration()));if(resume)this.room.run(()=>this.play());};
    }
  }
  updateSources(){
    if(!this.host)return;const select=this.host.querySelector('[data-split]'),old=select.value,stems=this.app.state.allStems||[];
    const pairs=stems.filter(s=>s.kind==='vocals'&&stems.some(x=>x.beatId===s.beatId&&x.kind==='instrumental'));
    select.innerHTML='<option value="">Choose completed split</option>'+pairs.map(s=>`<option value="${this.esc(s.beatId)}">${this.esc(s.trackName)}</option>`).join('');select.value=old;
  }
  inspector(){
    const t=this.tracks[this.selected],h=this.host.querySelector('[data-inspector]');
    for(const row of this.host.querySelectorAll('[data-track]'))row.classList.toggle('selected',+row.dataset.track===this.selected);
    const sliders=[['pitch','Pitch (semitones)',-12,12,1],['level','Level',0,1,.01],['bass','Bass (dB)',-24,12,1],['treble','Treble (dB)',-24,12,1],['reverb','Reverb',0,.7,.01],['echo','Echo',0,.6,.01]];
    h.innerHTML=`<div class="stem-inspector-title"><strong>${this.selected?'VOCALS':'INSTRUMENTAL'} · SOUND CONTROLS</strong><button data-stem-action="deep">DEEP & SPACED</button><button data-stem-action="reset">RESET TRACK</button></div><div class="stem-knobs">${sliders.map(([key,label,min,max,step])=>`<label>${label}<output data-value="${key}">${t[key]}</output><input data-param="${key}" aria-label="${this.selected?'Vocals':'Instrumental'} ${label}" type="range" min="${min}" max="${max}" step="${step}" value="${t[key]}"></label>`).join('')}</div><div class="screw-tools"><label>Region in (source seconds)<input data-trim="start" aria-label="Region in" type="number" min="0" step=".01" value="${t.start}"></label><label>Region out (source seconds)<input data-trim="end" aria-label="Region out" type="number" min="0" step=".01" value="${t.end??t.buffer?.duration??0}"></label><span>Trim silences the edges; both stems stay aligned.</span></div><p>Linked speed slows both stems and lowers their pitch. This track’s pitch control changes only this stem without changing its duration. M = mute · S = solo.</p>`;
    h.oninput=e=>{const key=e.target.dataset.param;if(!key)return;t[key]=+e.target.value;h.querySelector('[data-value='+key+']').textContent=t[key];this.applyTrack(t);};
    h.onchange=e=>{const key=e.target.dataset.trim;if(key){const n=+e.target.value,start=key==='start'?n:t.start,end=key==='end'?n:(t.end??t.buffer?.duration??0);if(!Number.isFinite(n)||start<0||end<=start||end>(t.buffer?.duration??0)){this.status('Region out must follow region in and stay within the stem.');this.inspector();return;}t[key]=n;this.changed();}else if(e.target.dataset.param)this.save();};
  }
  async loadPair(){
    if(this.loading||this.restoring)throw Error('Wait for the current stems to finish loading.');
    const id=this.host.querySelector('[data-split]').value,stems=this.app.state.allStems||[],pair=['instrumental','vocals'].map(kind=>stems.find(s=>s.beatId===id&&s.kind===kind));
    if(pair.some(x=>!x))throw Error('Choose a completed vocals / instrumental split.');
    this.loading=true;this.status('Loading both stems…');
    try{const buffers=await Promise.all(pair.map(s=>this.decode(s.url)));this.pause();this.position=0;this.tracks=pair.map((s,i)=>({...this.empty(s.trackName+' · '+s.kind),url:s.url,buffer:buffers[i]}));this.draw();this.save();}finally{this.loading=false;}
  }
  importFile(i){
    if(this.loading||this.restoring)throw Error('Wait for the current stems to finish loading.');
    const input=document.createElement('input');input.type='file';input.accept='audio/*,.wav,.mp3,.m4a';input.onchange=()=>this.room.run(async()=>{
      const file=input.files[0];if(!file)return;this.loading=true;
      try{const T=await this.app.ensureScrewLibs(),buffer=await T.getContext().rawContext.decodeAudioData(await file.arrayBuffer());
        const path='local/library/'+window.ScrewShop.id()+'_'+file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
        await this.checked(this.app.sb.storage.from('beats').upload(path,file));
        await this.checked(this.app.sb.from('library').insert({user_id:'local',name:file.name,storage_path:path}));
        const {data}=await this.app.sb.storage.from('beats').createSignedUrl(path);
        this.pause();this.position=0;this.tracks[i]={...this.empty(file.name),url:data.signedUrl,buffer};this.draw();this.save();await this.app.loadLibrary();
      }finally{this.loading=false;}
    });input.click();
  }
  level(t,tracks=this.tracks){return t.mute||(tracks.some(x=>x.solo)&&!t.solo)?0:t.level;}
  async graph(t,context,destination,tracks=this.tracks){
    const T=this.app._Tone;
    const gain=new T.Gain({context,gain:this.level(t,tracks)}).connect(destination);
    const eq=new T.EQ3({context,low:t.bass,high:t.treble,mid:0}).connect(gain);
    const reverb=new T.Reverb({context,decay:2.5,wet:t.reverb}).connect(eq);
    const echo=new T.FeedbackDelay({context,delayTime:.28,feedback:.3,wet:t.echo}).connect(reverb);
    const pitch=new T.PitchShift({context,pitch:t.pitch,wet:t.pitch?1:0}).connect(echo);
    const player=new T.Player({context,url:t.buffer,playbackRate:this.rate}).connect(pitch);
    const nodes={player,pitch,echo,reverb,eq,gain};
    try{await reverb.generate();return nodes;}catch(e){Object.values(nodes).forEach(n=>n.dispose());throw e;}
  }
  async play(){
    if(this.starting||this.playing)return;
    if(!this.tracks.some(t=>t.buffer))throw Error('Load instrumental and/or vocals first.');
    this.starting=true;const token=this.playToken=(this.playToken||0)+1;
    try{
      const T=await this.app.ensureScrewLibs();await T.start();this.app.pauseBothDecks();this.app._beatAudio?.pause();this.app.studio?.halt();
      if(this.position>=this.duration())this.position=0;
      this.master=new T.Limiter(-1).toDestination();
      for(const t of this.tracks)if(t.buffer){const nodes=await this.graph(t,T.getContext(),this.master);if(token!==this.playToken){Object.values(nodes).forEach(n=>n.dispose());return;}t.nodes=nodes;}
      this.started=T.now()+.05;
      for(const t of this.tracks)if(t.nodes){const offset=Math.max(this.position,t.start),end=t.end??t.buffer.duration;if(end>offset)t.nodes.player.start(this.started+(offset-this.position)/this.rate,offset,end-offset);}
      this.playing=true;
      this.app.setState({transportSource:'screw-stems',transportTitle:'SCREW · Vocals + Instrumental',beatPlaying:true,beatRate:this.rate,beatLoop:!!this.loop});
    }catch(e){this.pause();throw e;}finally{this.starting=false;}
  }
  pause(){this.position=this.current();const wasPlaying=this.playing;this.playing=false;this.playToken=(this.playToken||0)+1;for(const t of this.tracks){if(t.nodes)Object.values(t.nodes).forEach(n=>n.dispose());t.nodes=null;}this.master?.dispose();this.master=null;if(wasPlaying&&this.app.state.transportSource==='screw-stems')this.app.setState({beatPlaying:false});}
  applyTrack(t){const n=t.nodes;if(!n)return;n.pitch.pitch=t.pitch;n.pitch.wet.value=t.pitch?1:0;n.reverb.wet.value=t.reverb;n.echo.wet.value=t.echo;n.eq.low.value=t.bass;n.eq.high.value=t.treble;n.gain.gain.rampTo(this.level(t),.02);}
  applyLevels(){this.tracks.forEach(t=>this.applyTrack(t));}
  changed(){const resume=this.playing;this.pause();this.save();if(resume)this.room.run(()=>this.play());}
  paint(pos){
    const duration=this.duration()||1;
    for(const c of this.host.querySelectorAll('[data-stem-wave]')){
      const i=+c.dataset.stemWave,t=this.tracks[i],ctx=c.getContext('2d'),w=c.width,h=c.height;
      ctx.clearRect(0,0,w,h);ctx.fillStyle=i?'#322746':'#173b3d';ctx.fillRect(0,0,w,h);
      if(t.buffer){t.peaks ||= this.app.computePeaks(t.buffer,600);ctx.fillStyle=i?'#c0a0f2':'#71c8b2';const scale=t.buffer.duration/duration*w/t.peaks.length;for(let j=0;j<t.peaks.length;j++){const amplitude=Math.max(1,t.peaks[j]*(h-18));ctx.fillRect(j*scale,(h-amplitude)/2,Math.max(1,scale-1),amplitude);}ctx.fillStyle='#0009';ctx.fillRect(0,0,t.start/duration*w,h);const end=(t.end??t.buffer.duration)/duration*w;ctx.fillRect(end,0,w-end,h);}else{ctx.fillStyle='#c1b3ce';ctx.font='18px system-ui';ctx.fillText('Load '+(i?'vocals':'instrumental')+' file or a completed split',18,56);}
      ctx.fillStyle='#fff';ctx.fillRect(pos/duration*w,0,2,h);
    }
  }
  async export(){
    if(this.room.building||this.room.recording)throw Error('Finish the deck render or live recording first.');
    if(this.exporting)return;if(this.room.pending)throw Error('Retry saving the previous audio first.');
    if(!this.duration())throw Error('Load stems first.');
    const rate=this.rate,tracks=this.tracks.map(t=>({...t,nodes:null})),duration=this.duration()/rate+(this.tracks.some(t=>t.reverb||t.echo)?4:0);
    if(duration>1800 || duration*44100*4+44>300*1024*1024)throw Error('Export up to 30 minutes at a time.');
    this.exporting=true;this.status('Rendering your stem mix…');
    const T=this.app._Tone,ctx=new T.OfflineContext(2,duration,44100),nodes=[];
    try{const master=new T.Limiter({context:ctx,threshold:-1}).toDestination();nodes.push(master);for(const t of tracks)if(t.buffer){const n=await this.graph(t,ctx,master,tracks);nodes.push(...Object.values(n));n.player.playbackRate=rate;const end=t.end??t.buffer.duration;if(end>t.start)n.player.start(t.start/rate,t.start,end-t.start);}
      const result=await ctx.render();this.room.pending={blob:this.room.wav(result.get()),name:this.version?.trim()||'Screwed stem mix',ext:'wav'};await this.room.savePending();this.status(this.room.pending?'Audio save failed. Use RETRY AUDIO SAVE.':'New WAV saved in SONGS. Your stems and edits remain available.');
    }finally{nodes.forEach(n=>n.dispose());ctx.dispose();this.exporting=false;}
  }
  // Send both stems to the tables: one summed record for the waveform and scratching, stems for playback.
  async toTables(){
    const [inst,voc]=this.tracks.map(t=>t.buffer);
    if(!inst||!voc)throw Error('Load both the instrumental and the vocals first.');
    this.pause();
    const ctx=this.app._Tone.getContext().rawContext,len=Math.max(inst.length,voc.length),ch=Math.max(inst.numberOfChannels,voc.numberOfChannels),mix=ctx.createBuffer(ch,len,inst.sampleRate);
    for(let c=0;c<ch;c++){const out=mix.getChannelData(c);for(const b of [inst,voc]){const d=b.getChannelData(Math.min(c,b.numberOfChannels-1));for(let i=0;i<d.length;i++)out[i]+=d[i];}}
    const name=this.tracks[1].name.replace(/ · vocals$/,'');
    for(const w of ['A','B']){await this.app.mountDeckBuffer(w,name,mix,{instrumental:inst,vocals:voc});this.app.setDeckRate(w,this.rate);}
    this.room.item=null;this.room.mode='decks';this.app.setCrossfade(-1);this.room.lastLive='A';
    if(this.tracks[1].pitch)this.room.setVocalPitch(this.tracks[1].pitch);
    this.room.tick();this.room.message(name+' is on both tables with vocals split. Chop it.');
  }
  dispose(){this.pause();}
};
