/* Editable sampler projects. Audio references remain in the existing local store. */
(() => {
const clone = x => JSON.parse(JSON.stringify(x));
const clamp = (x,a,b) => Number.isFinite(+x)?Math.max(a,Math.min(b,+x)):a;
const uid = () => window.ScrewShop.id();
const noteName = n => ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][n%12]+(Math.floor(n/12)-1);
const defaults = () => ({id:uid(),name:'Untitled beat',bpm:82,swing:0,grid:4,quantize:true,countIn:true,metro:false,overdub:true,latency:0,octave:4,root:60,low:36,high:96,mode:'pads',
  slots:Array(18).fill(null),maps:{},mix:Array.from({length:18},()=>({volume:.8,mute:false,solo:false})),patterns:[{id:uid(),name:'Pattern 1',beats:4,events:[]}],pattern:0,kitId:null});
window.StudioWorkspace = class SamplerWorkspace extends window.StudioWorkspace {
  constructor(app) {
    super(app); this.project=defaults();this.history=[];this.future=[];this.held=new Map();this.inflight=new Map();this.prepared=new Map();this.assignmentTokens=new Map();
    this.pressTokens=new Map();this.pendingPresses=new Set();this.midiPedals=new Map();this.liveHits=new Map();
    this.ui={width:240,library:false,sequence:true,height:250,view:'pads',steps:16,page:0,roll:false};this.favorites=[];this.chops=[];this.beats=[];this.kits=[];this.selected=0;this.status='Loading…';
    this.onComputer=e=>this.computer(e);document.addEventListener('keydown',this.onComputer);document.addEventListener('keyup',this.onComputer);
    this.onBlur=()=>this.panic();window.addEventListener('blur',this.onBlur);
    this.scheduler=setInterval(()=>this.schedule(),25);
  }
  get pattern(){return this.project.patterns[this.project.pattern];}
  snapshot(){const p=clone(this.project);p.patterns.forEach(pattern=>pattern.events.forEach(e=>delete e.absolute));return p;}
  checkpoint(){this.history.push(this.snapshot());if(this.history.length>60)this.history.shift();this.future=[];}
  async restore(p){this.stop();this.project=clone(p);this.lastRender=null;this.syncLegacy();this.draw();await this.prepare();await this.save();this.prune();}
  undo(redo=false){const from=redo?this.future:this.history,to=redo?this.history:this.future;if(!from.length)return;to.push(this.snapshot());return this.restore(from.pop());}
  syncLegacy(){this.slots=this.project.slots;this.keySample=this.slots[16];this.rootNote=this.project.root;}
  async load(){
    await super.load();
    this.mp3Available=(await window.ScrewShop.connect()).export_formats?.includes('mp3')||false;
    this.app.setState({samplerMp3:this.mp3Available});
    const saved=await this.checked(this.app.sb.from('settings').select('*').eq('id','sampler-project').maybeSingle());
    if(saved?.project){this.project={...defaults(),...saved.project};this.ui={...this.ui,...saved.ui};this.favorites=saved.favorites||[];this.chops=saved.chops||[];this.volume=saved.volume??.8;this.previewVolume=saved.previewVolume??.5;}
    else {this.project.slots=this.project.slots.map((_,i)=>i===16?this.keySample:clone(this.slots[i]||null));
      this.project.root=this.rootNote;
      for(const [action,map] of Object.entries(this.maps||{}))if(['play','stop','record','volume'].includes(action))this.project.maps[action==='volume'?'master':action]=clone(map);
      this.padNotes.forEach((n,i)=>{this.project.maps['pad:'+i]=typeof n==='number'?{type:144,channel:9,number:n}:{type:144,channel:n.channel,number:n.note};});
      const preferences=await this.checked(this.app.sb.from('settings').select('*').eq('id','studio').maybeSingle());
      const old=preferences?.steps||this.app.state.sequencerSteps||[];if(Array.isArray(old))old.forEach((row,lane)=>Array.isArray(row)&&row.forEach((on,step)=>{if(on)this.pattern.events.push({id:uid(),lane,note:60,at:step/4,len:.25,velocity:100});}));
      this.project.bpm=preferences?.bpm||82;
      const legacyPads=await this.checked(this.app.sb.from('pads').select('*'));
      for(const row of legacyPads||[])if(row.pad_index<16&&!this.project.slots[row.pad_index])this.project.slots[row.pad_index]={name:row.label||'Pad '+(row.pad_index+1),url:this.app.studio.url('stems',row.storage_path),storage_path:row.storage_path,bucket:'stems',start:0};
    }
    this.ui.library=false;if(this.ui.view==='library')this.ui.view='pads';
    this.syncLegacy();this.ready=true;const prepared=await this.prepare();if(prepared)this.status='Ready';this.draw();
  }
  // The library polls every 5 s. Redraw only when something changed, so open menus, search focus and drags survive.
  async refreshLibrary(){await super.refreshLibrary();if(!this.app.sb)return;try{const rows=await this.checked(this.app.sb.from('settings').select('*'));this.beats=rows.filter(x=>x.kind==='sampler-beat');this.kits=rows.filter(x=>x.kind==='sampler-kit');this.drawLibraryIfChanged();}catch(e){this.message(e.message,true);}}
  drawLibraryIfChanged(){const signature=JSON.stringify([this.folders,this.takes,this.beats,this.kits,this.app.state.library,this.app.state.allStems,this.app.state.splitJobs]);
    if(signature===this.samplerSignature)return;if(this.dragging){this.libraryStale=true;return;}this.samplerSignature=signature;this.drawLibrary();}
  save(){
    clearTimeout(this.noteSaveTimer);this.noteSaveTimer=null;
    if(!this.ready)return Promise.resolve();this.status='Saving…';this.updateStatus();
    const body={id:'sampler-project',version:1,project:this.snapshot(),ui:clone(this.ui),favorites:[...this.favorites],chops:clone(this.chops),volume:this.volume,previewVolume:this.previewVolume??.5};
    const revision=this.saveRevision=(this.saveRevision||0)+1;
    const job=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>this.checked(this.app.sb.from('settings').upsert(body)));
    this.saving=job;job.then(()=>{if(revision===this.saveRevision){this.status='Saved locally';this.updateStatus();}},e=>this.message('Save failed — use Retry Save: '+e.message,true));return job;
  }
  changed(){this.lastRender=null;this.syncLegacy();this.save().catch(()=>{});}
  message(s,error=false){this.status=s;this.updateStatus();if(error)this.notify(s);}
  async prepare(){
    const missing=[];const results=await Promise.allSettled(this.project.slots.filter(Boolean).map(s=>this.prepareSlot(s).catch(e=>{missing.push(s.name);throw e;})));
    const failed=results.filter(r=>r.status==='rejected');if(failed.length)this.message('Missing/unreadable: '+missing.join(', ')+'. Replace the assignment or restore its source file.',true);
    return !failed.length;
  }
  async decode(item){
    if(this.buffers.has(item.url))return this.buffers.get(item.url);
    if(!this.inflight.has(item.url)){const job=super.decode(item).finally(()=>this.inflight.delete(item.url));this.inflight.set(item.url,job);}
    return this.inflight.get(item.url);
  }
  async prepareSlot(s){const b=await this.decode(s);s.start??=0;s.end??=b.duration;if(s.reverse&&!this.prepared.has(s.url)){const r=this.context().createBuffer(b.numberOfChannels,b.length,b.sampleRate);for(let c=0;c<b.numberOfChannels;c++)r.copyToChannel(b.getChannelData(c).slice().reverse(),c);this.prepared.set(s.url,r);}return b;}
  context(){const ctx=super.context();if(!this.meter){this.meter=ctx.createAnalyser();this.meter.fftSize=256;this.bus.connect(this.meter);this.meterData=new Float32Array(256);}return ctx;}
  prune(){const urls=new Set(this.slots.filter(Boolean).map(s=>s.url));for(const key of this.buffers.keys())if(!urls.has(key))this.buffers.delete(key);for(const key of this.prepared.keys())if(!urls.has(key))this.prepared.delete(key);}
  async assign(target,raw){
    const lane=target==='keys'?16:+target,item=this.item(raw);if(!/^\/audio\/(beats|takes|stems)\//.test(item.url))throw Error('Choose a local audio asset.');
    const token={};this.assignmentTokens.set(lane,token);this.message('Loading '+item.name+'…');this.host?.querySelector('[data-dest="'+lane+'"]')?.classList.add('loading');
    try{const buffer=await this.decode(item);if(this.assignmentTokens.get(lane)!==token)return;
      const fresh=raw.start==null&&raw.end==null,long=fresh&&buffer.duration>this.barSeconds(this.maxBars)+.05,from=long?this.firstSound(buffer):0;
      this.checkpoint();this.panic();this.slots[lane]={...item,start:raw.start??0,end:raw.end??buffer.duration,volume:1,pan:0,pitch:0,gate:lane>=16,loop:false,attack:.003,release:.03,choke:0,...raw,url:item.url};
      if(long){this.slots[lane].start=from;this.slots[lane].end=Math.min(buffer.duration,from+this.barSeconds(this.maxBars));}
      await this.prepareSlot(this.slots[lane]);this.selected=lane;this.pendingSound=null;this.changed();this.draw();
      const note=long?`${item.name} is ${(buffer.duration/this.barSeconds(1)).toFixed(0)} bars long, so Pad ${lane<16?lane+1:'keys'} got the first ${this.maxBars} bars with sound (${from.toFixed(2)}–${this.slots[lane].end.toFixed(2)} s at ${this.project.bpm} BPM). The full sound stays in the library; use the bar buttons or Start/End to pick a different part.`:'';if(long&&!this.quietAssign)this.notify(note);
      this.message(long?`Ready: ${item.name}, trimmed to the first ${this.maxBars} bars with sound (${from.toFixed(2)}–${this.slots[lane].end.toFixed(2)} s at ${this.project.bpm} BPM). The full sound stays in the library; use the bar buttons or Start/End to pick a different part.`:'Ready: '+item.name);this.prune();
    }catch(e){this.message('Could not load '+item.name+': '+e.message+'. Choose another file or retry.',true);throw e;}
    finally{this.host?.querySelector('[data-dest="'+lane+'"]')?.classList.remove('loading');}
  }
  async loadSongToPad(raw,index){
    if(!Number.isInteger(index)||index<0||index>=18)throw Error('Choose a pad or keyboard instrument.');
    if(!this.ready)throw Error('Wait for the sampler to finish loading.');
    if(this.recording||this.playing)throw Error('Stop sampler playback or recording before loading a sound.');
    if(!raw?.url&&!raw?.storage_path)throw Error('Choose a song or sound with an audio file.');
    const bucket=raw.bucket||(raw.table==='takes'?'takes':raw.table==='stems'||raw.stem?'stems':'beats');
    const item={...raw,bucket,name:raw.name||raw.label||raw.kind||'Song sound'};
    // Explicit trims from stems and saved chops survive the handoff from SONGS.
    if(item.start!=null&&!Number.isFinite(item.start)||item.end!=null&&!Number.isFinite(item.end))throw Error('This sound has an invalid trim.');
    const buffer=await this.decode(this.item(item)),from=item.start??0,to=item.end??buffer.duration;
    if(from<0||to<=from||to>buffer.duration+.001)throw Error('Choose a trim inside this sound.');
    await this.assign(index,item);
    this.ui.bank=index>=8&&index<16?1:0;this.ui.view='pads';this.project.mode=index>=16?String(index):'pads';await this.save();this.app.setState({tab:'packs'});this.draw();
    const trimmed=item.start==null&&item.end==null&&buffer.duration>this.barSeconds(this.maxBars)+.05;
    this.notify('Loaded '+item.name+' onto '+(index<16?'Pad '+(index+1):'Instrument '+(index-15))+'.'+(trimmed?' Using the first '+this.maxBars+' bars with sound. The whole song stays in SONGS; use Whole sound or Start/End to change the trim.':''));return this.slots[index];
  }
  // A bar = 4 beats. At 82 BPM one bar is 2.93 s, so 4 bars is 11.7 s.
  get maxBars(){return 4;}
  barSeconds(bars){return bars*4*60/this.project.bpm;}
  // Split stems often start with silence (a vocal that comes in at 0:40). Start the window where sound begins.
  firstSound(buffer){let peak=0;const chans=Array.from({length:buffer.numberOfChannels},(_,c)=>buffer.getChannelData(c));
    for(const d of chans)for(let i=0;i<d.length;i+=64)peak=Math.max(peak,Math.abs(d[i]));const floor=Math.max(.003,peak*.1);
    for(let i=0;i<chans[0].length;i+=32)if(chans.some(d=>Math.abs(d[i])>=floor))return Math.max(0,i/buffer.sampleRate-.01);return 0;}
  // Set the trim to N bars from Start. Pitch changes speed, so the source window is scaled to keep N bars of playback.
  setBars(bars){const s=this.slots[this.selected],b=s&&this.buffers.get(s.url);if(!b)throw Error('Select a pad with a sound first.');this.checkpoint();
    if(bars==='whole'){s.start=0;s.end=b.duration;}else{const rate=2**((s.pitch||0)/12);s.end=Math.min(b.duration,s.start+this.barSeconds(+bars)*rate);}
    this.changed();this.drawEditor();}
  laneAudible(lane){const m=this.project.mix[lane];return !m.mute&&(!this.project.mix.some(x=>x.solo)||m.solo);}
  voice(lane,note,velocity,when,ctx=this.context(),destination=this.bus,duration=null,registry=this.voices){
    const s=this.slots[lane];if(!s||!this.laneAudible(lane))return null;
    const original=this.buffers.get(s.url),buffer=s.reverse?this.prepared.get(s.url):original;if(!buffer){this.message('Sound not ready: '+s.name+'. Reassign to retry.');return null;}
    const start=clamp(s.start||0,0,original.duration-.001),end=clamp(s.end||original.duration,start+.001,original.duration);
    const source=ctx.createBufferSource(),gain=ctx.createGain(),pan=ctx.createStereoPanner();source.buffer=buffer;
    const rate=2**(((s.pitch||0)+(lane>=16?note-(s.root??this.project.root):0))/12);const live=!(ctx instanceof OfflineAudioContext);source.playbackRate.value=rate*(live?2**((this.bend||0)/12):1);
    const offset=s.reverse?original.duration-end:start,tail=s.reverse?original.duration-start:end;
    source.loop=!!s.loop;source.loopStart=offset;source.loopEnd=tail;
    const level=velocity/127*(s.volume??1)*this.project.mix[lane].volume;
    gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(level*(live?1-(this.mod||0)*.6:1),when+Math.max(.001,s.attack||.003));pan.pan.value=s.pan||0;
    source.connect(gain);gain.connect(pan);pan.connect(destination);
    const v={src:source,gain,pan,lane,rate,level,choke:s.choke||0,when,ctx,released:false};
    if(v.choke)for(const old of registry)if(old.choke===v.choke&&old.when<=when)this.endVoice(old,when,.005);
    if(lane<16&&s.mono!==false)for(const old of registry)if(old!==v&&old.lane===lane&&old.when<=when)this.endVoice(old,when,.005);
    registry.add(v);source.onended=()=>{registry.delete(v);if(v.token&&this.held.get(v.token)===v){this.held.delete(v.token);this.queueLiveUI();}source.disconnect();gain.disconnect();pan.disconnect();};
    // Duration is in source seconds: pitch bend must never play beyond the selected trim.
    if(source.loop)source.start(when,offset);else source.start(when,offset,end-start);
    const natural=(end-start)/source.playbackRate.value;
    if(duration!=null||!source.loop&&!s.gate){let length=s.gate||s.loop?(duration??natural):natural;if(!source.loop)length=Math.min(length,natural);const fade=Math.min(s.release||.005,.04,length/2);this.endVoice(v,when+length-fade,fade);}
    else if(!source.loop)this.endVoice(v,when+natural-.003,.003);
    return v;
  }
  endVoice(v,time,release){if(!v||v.stopTime!=null&&v.stopTime<=time)return;v.stopTime=time;const p=v.gain.gain;try{if(p.cancelAndHoldAtTime)p.cancelAndHoldAtTime(time);else p.cancelScheduledValues(time);p.setTargetAtTime(.00001,time,Math.max(.001,release/4));v.src.stop(time+release);}catch(_){}}
  inputClock(ctx,receivedTime){return ctx.currentTime+(Number.isFinite(receivedTime)?clamp((receivedTime-performance.now())/1000,-1,0):0);}
  async press(lane,note=60,velocity=100,token='pad:'+lane,meta={}){
    if(this.pendingSound){await this.assign(lane,this.pendingSound);return;}
    const ctx=this.context();this.releaseToken(token,true,meta);
    const pending={lane,note,velocity,token,scope:meta.scope,ctx,slot:this.slots[lane],inputAt:Number.isFinite(meta.receivedTime)?meta.receivedTime:performance.now(),captureAt:ctx.state==='running'?this.inputClock(ctx,meta.receivedTime):null,releasedAt:null};
    this.pressTokens.set(token,pending);
    // No promise hop in the playing path: short Note On/Off pairs must both reach audio.
    if(ctx.state==='running'){this.startPress(pending,ctx.currentTime);return;}
    this.pendingPresses.add(pending);
    if(!this.resumeJob){
      this.resumeJob=ctx.resume().then(()=>{
        const queued=[...this.pendingPresses].sort((a,b)=>a.inputAt-b.inputAt);this.pendingPresses.clear();
        const origin=queued[0]?.inputAt,at=ctx.currentTime+.004;
        for(const p of queued)this.startPress(p,at+(p.inputAt-origin)/1000);
      }).catch(e=>{for(const p of this.pendingPresses)if(this.pressTokens.get(p.token)===p)this.pressTokens.delete(p.token);this.pendingPresses.clear();this.message('Audio could not start: '+e.message,true);}).finally(()=>{this.resumeJob=null;});
    }
    return this.resumeJob;
  }
  startPress(p,when){
    if(p.cancelled||p.slot!==this.slots[p.lane]||!p.slot)return;
    const current=this.pressTokens.get(p.token)===p;
    const duration=p.releasedAt!=null&&(p.slot.gate||p.slot.loop)?Math.max(.003,(p.releasedAt-p.inputAt)/1000):null;
    const v=this.voice(p.lane,p.note,p.velocity,when,p.ctx,this.bus,duration);if(!v)return;
    v.note=p.note;v.token=p.token;v.scope=p.scope;
    v.released=!!p.sustained;
    if(current&&p.releasedAt==null)this.held.set(p.token,v);
    if(current)this.pressTokens.delete(p.token);
    this.selected=p.lane;this.queueLiveUI(p.lane,p.note,p.token);
    const captureAt=p.captureAt??when;this.capture(p.lane,p.note,p.velocity,p.token,captureAt);
    if(p.releasedAt!=null)this.finishCapture(p.token,captureAt+Math.max(0,(p.releasedAt-p.inputAt)/1000));
  }
  releaseToken(token,force=false,meta={}){
    const pending=this.pressTokens.get(token);
    if(pending){const pedal=pending.scope!=null?this.midiPedals.get(pending.scope):this.sustain;
      if(pedal&&!force&&(pending.slot?.gate||pending.slot?.loop)){pending.sustained=true;return;}
      pending.releasedAt=Number.isFinite(meta.receivedTime)?meta.receivedTime:performance.now();this.pressTokens.delete(token);}
    const v=this.held.get(token);if(v){
      const pedal=v.scope!=null?this.midiPedals.get(v.scope):this.sustain;
      if(pedal&&!force&&(this.slots[v.lane]?.gate||this.slots[v.lane]?.loop)){v.released=true;this.queueLiveUI();return;}
      if(this.slots[v.lane]?.gate||this.slots[v.lane]?.loop)this.endVoice(v,Math.max(v.when,this.inputClock(v.ctx,meta.receivedTime)),this.slots[v.lane]?.release||.03);
      this.held.delete(token);
    }
    this.finishCapture(token,this.inputClock(this.context(),meta.receivedTime));this.queueLiveUI();
  }
  finishCapture(token,time){const held=this.recordHeld?.get(token);if(!held)return;
    held.len=Math.max(1/64,Math.min(this.pattern.beats,(time-this.origin-(this.project.latency||0)/1000)*this.project.bpm/60-held.absolute));delete held.absolute;this.recordHeld.delete(token);this.queueNoteSave();}
  queueNoteSave(){this.lastRender=null;this.sequenceDirty=true;this.queueLiveUI();if(!this.noteSaveTimer)this.noteSaveTimer=setTimeout(()=>{this.noteSaveTimer=null;this.changed();},100);}
  queueLiveUI(lane,note,token){
    if(this.disposed)return;
    if(lane!=null){this.liveHits.set(token,{lane,note,until:performance.now()+100});this.liveLane=lane;this.liveNote=note;}
    if(this.liveFrame)return;this.liveFrame=requestAnimationFrame(()=>{this.liveFrame=null;this.flushLiveUI();});
  }
  flushLiveUI(){
    if(this.oxygenDirty){this.oxygenDirty=false;this.draw();}
    const now=performance.now();for(const[token,h]of this.liveHits)if(h.until<=now)this.liveHits.delete(token);
    for(const el of this.host?.querySelectorAll('[data-dest]')||[]){const lane=+el.dataset.dest,note=el.dataset.note!=null?+el.dataset.note:null;
      const match=v=>v.lane===lane&&(lane<16||note===v.note);
      el.classList.toggle('hit',[...this.held.values()].some(match)||[...this.liveHits.values()].some(match));}
    if(this.liveLane!=null){this.show?.(this.liveLane<16?'P'+(this.liveLane+1):noteName(this.liveNote).replace('#','').slice(0,3));this.flashLane(this.liveLane,this.editorLane!==this.selected);this.liveLane=null;}
    if(this.editorLane!==this.selected||this.editorSlot!==this.slots[this.selected])this.drawEditor();
    if(this.sequenceDirty){this.sequenceDirty=false;this.drawSequence();}
    clearTimeout(this.liveUITimer);if(this.liveHits.size)this.liveUITimer=setTimeout(()=>this.queueLiveUI(),110);
  }
  // Hitting a pad lights its row name in the sequencer, so you can see which lane that sound is.
  // A live hit also scrolls the row into view and marks it as the selected sound.
  flashLane(lane,reveal=false){const seq=this.host?.querySelector('.sp-sequence');if(!seq||this.ui.roll)return;
    const el=seq.querySelector('.sp-lane-label [data-lane-select="'+lane+'"]');if(!el)return;
    if(reveal){seq.querySelectorAll('[data-lane-select].sel').forEach(x=>x.classList.remove('sel'));el.classList.add('sel');
      const box=seq.getBoundingClientRect(),row=el.getBoundingClientRect(),bar=seq.querySelector('.sp-seq-toolbar')?.offsetHeight||0;
      if(row.top<box.top+bar)seq.scrollTop-=box.top+bar-row.top+4;else if(row.bottom>box.bottom)seq.scrollTop+=row.bottom-box.bottom+4;}
    el.classList.add('lane-hit');
    this.laneTimers=this.laneTimers||{};clearTimeout(this.laneTimers[lane]);this.laneTimers[lane]=setTimeout(()=>el.classList.remove('lane-hit'),450);}
  triggerPad(i,time,velocity=100){return this.press(i,60,velocity);}
  keyDown(n,v=100){return this.press(+this.project.mode>=16?+this.project.mode:16,n,v,'key:'+n);}
  release(n){this.releaseToken('key:'+n);}
  panic(){this.resumeGeneration=(this.resumeGeneration||0)+1;for(const p of this.pendingPresses||[])p.cancelled=true;this.pendingPresses?.clear();this.pressTokens?.clear();if(this.held)for(const token of this.held.keys())this.releaseToken(token,true);super.panic();this.midiPedals?.clear();this.liveHits?.clear();this.sustain=false;this.queueLiveUI();}
  stop(){this.playing=false;this.recording=false;this.scheduled=new Map();this.recordHeld?.forEach((_,token)=>this.releaseToken(token,true));this.panic();this.updateStatus();}
  async start(record=false){if(this.playing){if(record){this.checkpoint();this.recording=!this.recording;}else this.stop();this.updateStatus();return;}
    if(!await this.prepare())return;const ctx=this.context();await ctx.resume();this.app.studio.halt();this.checkpoint();
    this.recording=record;this.playing=true;this.scheduled=new Map();this.origin=ctx.currentTime+.08+(record&&this.project.countIn?4*60/this.project.bpm:0);this.nextCycle=0;this.nextClick=record&&this.project.countIn?-4:0;this.recordHeld=new Map();
    if(record&&!this.project.overdub)this.pattern.events=[];this.changed();this.schedule();this.updateStatus();
  }
  capture(lane,note,velocity,token,time=this.context().currentTime){if(!this.recording||!this.playing)return;const absolute=(time-this.origin-(this.project.latency||0)/1000)*this.project.bpm/60;if(absolute<0)return;
    const pos=((absolute%this.pattern.beats)+this.pattern.beats)%this.pattern.beats,grid=this.project.grid;
    const at=this.project.quantize?(Math.round(pos*grid)/grid)%this.pattern.beats:pos;
    const event={id:uid(),lane,note,velocity,at,len:1/grid,absolute};this.pattern.events.push(event);this.recordHeld.set(token,event);
    const cycle=Math.floor(absolute/this.pattern.beats);if(!this.scheduled.has(cycle))this.scheduled.set(cycle,new Set());this.scheduled.get(cycle).add(event.id);this.queueNoteSave();
  }
  eventTime(e){return e.at+(Math.round(e.at*this.project.grid)%2?this.project.swing/100/this.project.grid:0);}
  schedule(){if(!this.playing)return;const ctx=this.context(),beat=60/this.project.bpm,horizon=ctx.currentTime+.12,pattern=this.pattern;
    // Schedule only the next 120 ms; edits affect the next unscheduled events.
    if(!this.scheduled)this.scheduled=new Map();
    const first=Math.max(0,Math.floor((ctx.currentTime-this.origin)/(pattern.beats*beat))),last=Math.max(first,Math.floor((horizon-this.origin)/(pattern.beats*beat)));
    for(let cycle=first;cycle<=last;cycle++){let seen=this.scheduled.get(cycle);if(!seen){seen=new Set();this.scheduled.set(cycle,seen);}for(const e of [...pattern.events].sort((a,b)=>this.eventTime(a)-this.eventTime(b))){if(e.at>=pattern.beats)continue;const at=this.origin+(cycle*pattern.beats+this.eventTime(e))*beat;if(at>=ctx.currentTime-.01&&at<=horizon&&!seen.has(e.id)){seen.add(e.id);this.voice(e.lane,e.note,e.velocity,Math.max(at,ctx.currentTime),ctx,this.bus,e.len*beat);setTimeout(()=>{this.flashLane(e.lane);const el=this.host?.querySelector('[data-dest="'+e.lane+'"]');el?.classList.add('hit');setTimeout(()=>el?.classList.remove('hit'),90);},Math.max(0,(at-ctx.currentTime)*1000));}}}
    for(const cycle of this.scheduled.keys())if(cycle<first)this.scheduled.delete(cycle);
    while(this.origin+this.nextClick*beat<=horizon){const n=this.nextClick++,time=this.origin+n*beat;if(time<ctx.currentTime-.01)continue;if(this.project.metro||n<0){const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=n%4===0?1200:800;g.gain.setValueAtTime(.08,time);g.gain.exponentialRampToValueAtTime(.001,time+.035);o.connect(g);g.connect(ctx.destination);o.start(time);o.stop(time+.04);o.onended=()=>{o.disconnect();g.disconnect();};}}
  }
  midi(data,meta={}){if(this.app.state.tab!=='packs')return;const [status,a,b=0]=data,type=status&240,channel=status&15;
    if(this.padWalk&&type===144&&b){this.learnPadHit(channel,a);return;}
    if(this.learning&&((type===144&&b)||type===176)){this.checkpoint();this.mapControl(this.learning,{type,channel,number:a});this.learning=null;this.changed();this.draw();return;}
    const mapped=Object.entries(this.project.maps).find(([,m])=>m.channel===channel&&m.number===a&&(m.type===type||(m.type===144&&type===128)));
    const scope='midi:'+(meta.portId!=null?meta.portId+':':'')+channel,token=scope+':'+a;meta={...meta,scope};
    if(type===224){this.bendTo(((b*128+a)-8192)/8192*2);return;}
    if(type===176&&!mapped&&a===1){this.modTo(b/127);return;}
    if(type===176&&!mapped&&a===7){this.volume=b/127;this.applyGain();this.show(b);return;}
    if(type===128||type===144&&!b){this.releaseToken(token,false,meta);return;}
    if(type===176&&a===64){this.midiPedals.set(scope,b>=64);this.sustain=[...this.midiPedals.values()].some(Boolean);if(b<64){
      for(const[t,v]of this.held)if((v.scope===scope||v.scope==null&&!this.sustain)&&v.released)this.releaseToken(t,true,meta);
      for(const[t,p]of this.pressTokens)if((p.scope===scope||p.scope==null&&!this.sustain)&&p.sustained)this.releaseToken(t,true,meta);
    }return;}
    if(type===176&&(a===120||a===123)){this.silenceScope(scope,meta);return;}
    if(type===144&&b)this.heard(channel,a,mapped);
    if(mapped){const action=mapped[0];if(action.startsWith('pad:')){const lane=+action.split(':')[1];if(b){if((lane<8?0:1)!==(this.ui.bank?1:0)){this.ui.bank=lane<8?0:1;this.oxygenDirty=true;}this.press(lane,a,b,token,meta);}else this.releaseToken(token,false,meta);}
      else if(action==='master'){this.volume=b/127;this.applyGain();}else if(b){if(action==='play')this.start();if(action==='record')this.start(true);if(action==='stop')this.stop();}return;}
    if(type===144&&b&&a>=this.project.low&&a<=this.project.high){const drum=a-this.project.octave*12;if(+this.project.mode>=16)this.press(+this.project.mode,a,b,token,meta);else if(drum>=0&&drum<16)this.press(drum,a,b,token,meta);}
  }
  silenceScope(scope,meta){this.midiPedals.delete(scope);this.sustain=[...this.midiPedals.values()].some(Boolean);
    for(const p of this.pendingPresses)if(p.scope===scope){p.cancelled=true;this.pendingPresses.delete(p);if(this.pressTokens.get(p.token)===p)this.pressTokens.delete(p.token);}
    for(const[token,v]of this.held)if(v.scope===scope)this.releaseToken(token,true,meta);
    for(const v of this.voices)if(v.scope===scope)this.endVoice(v,Math.max(v.when,v.ctx.currentTime),.005);
    for(const[token,h]of this.liveHits)if(token.startsWith(scope+':'))this.liveHits.delete(token);this.queueLiveUI();}
  // One physical control = one action. Learning a note for pad 3 removes it from any other pad,
  // otherwise the first (stale) match wins and the wrong pad lights up.
  mapControl(action,m){const same=x=>x.channel===m.channel&&x.number===m.number&&(x.type===m.type||(x.type===144&&m.type===128)||(x.type===128&&m.type===144));
    for(const [k,x] of Object.entries(this.project.maps))if(k!==action&&same(x))delete this.project.maps[k];this.project.maps[action]=m;}
  // LEARN ALL 8 PADS: hit the hardware pads 1→8 in order and each one is tied to the matching pad on screen.
  startPadWalk(){if(this.padWalk){this.padWalk=null;this.draw();this.message('Pad learning stopped. Pads learned so far are kept.');return;}
    this.learning=null;this.checkpoint();this.padWalk={bank:this.ui.bank?1:0,index:0,notes:[]};this.draw();this.message(this.walkPrompt());}
  walkPrompt(){const w=this.padWalk;if(!w)return '';const n=w.bank*8+w.index+1;return `LEARN PADS (bank ${w.bank+1}): hit PAD ${w.index+1} on your Oxygen${w.bank?' (pad '+n+' here)':''}. Pads 1–4 are the bottom row, 5–8 the top row.`;}
  learnPadHit(channel,note){const w=this.padWalk,key=channel+':'+note;
    if(w.notes.includes(key)){this.readout('That pad was already learned. '+this.walkPrompt());return;}
    const lane=w.bank*8+w.index;this.mapControl('pad:'+lane,{type:144,channel,number:note});w.notes.push(key);w.index++;
    this.host?.querySelectorAll('.ox-pad[data-pad="'+lane+'"]').forEach(el=>{el.classList.add('hit');setTimeout(()=>el.classList.remove('hit'),160);});
    if(w.index>=8){this.padWalk=null;this.changed();this.draw();this.message(`All 8 pads learned for bank ${w.bank+1}. Each Oxygen pad now lights and plays the same pad on screen.`);return;}
    this.draw();this.message(this.walkPrompt());}
  readout(text){const el=this.host?.querySelector('[data-readout]');if(el)el.textContent=text;}
  // Live readout of what the keyboard actually sent, so a wrong mapping is visible, not a mystery.
  heard(channel,note,mapped){const action=mapped?.[0];let to;
    if(action?.startsWith('pad:'))to='Pad '+(+action.split(':')[1]+1);else if(action)to=action;
    else if(note>=this.project.low&&note<=this.project.high&&(+this.project.mode>=16||(note-this.project.octave*12>=0&&note-this.project.octave*12<16)))to=+this.project.mode>=16?'Instrument '+(+this.project.mode-15):'Key → Pad '+(note-this.project.octave*12+1);
    else to='nothing (not learned yet: press LEARN ALL 8 PADS)';
    this.lastHeard=`Heard: MIDI ch ${channel+1}, note ${note} (${noteName(note)}) → ${to}`;this.readout(this.lastHeard);}
  computer(e){if(this.app.state.tab!=='packs'||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||e.target.isContentEditable||document.getElementById('sp-clip')?.open||document.getElementById('sp-pack')?.open)return;
    if((e.ctrlKey||e.metaKey)&&e.code==='KeyZ'&&e.type==='keydown'){e.preventDefault();this.undo(e.shiftKey);return;}
    if(e.ctrlKey||e.metaKey||e.altKey)return;const chars='1234qwerasdfzxcv',i=chars.indexOf(e.key.toLowerCase());
    if(e.code==='Space'&&e.type==='keydown'&&!e.repeat){e.preventDefault();this.start();return;}if(i<0)return;e.preventDefault();const token='computer:'+e.code;
    if(e.type==='keyup')this.releaseToken(token);else if(!e.repeat)this.press(+this.project.mode>=16?+this.project.mode:i,this.project.octave*12+i,100,token);
  }
  tick(){if(!this.project)return;const host=document.getElementById('ss-sampler');if(host&&host!==this.host){this.host=host;this.draw();}
    if(this.app.state.tab!=='packs'&&this.wasSampler){this.stop();this.previewAudio?.pause();document.getElementById('sp-clip')?.close();document.getElementById('sp-pack')?.close();}this.wasSampler=this.app.state.tab==='packs';
    if(host){if(Date.now()-this.lastFetch>5000)this.refreshLibrary();this.updateStatus();}
    const library=document.getElementById('ss-sound-library');if(library){if(library!==this.library){this.library=library;super.mountLibrary(library);this.libSignature='';}
      const signature=JSON.stringify([this.app.state.library,this.app.state.allStems,this.folders,this.takes]);if(signature!==this.libSignature){this.libSignature=signature;this.renderLibrary();}if(Date.now()-this.lastFetch>5000)this.refreshLibrary();}
  }
  updateStatus(){if(!this.host?.isConnected)return;const set=(q,t)=>{const el=this.host.querySelector(q);if(el)el.textContent=t;};
    set('[data-status]',this.status);set('[data-midi]',this.app.state.midiDevices?.length?this.app.state.midiDevices.join(', '):this.app.state.midiBlocked?'MIDI blocked: allow MIDI for this site in Chrome, then press MIDI':navigator.requestMIDIAccess?'No MIDI connected: plug in the Oxygen and press MIDI':'MIDI unavailable in this browser — use touch or computer keys');
    set('[data-action="play"]',this.playing?'Stop':'Play');set('[data-action="record"]',this.recording?'Stop Record':'Record');
    if(this.playing){const pos=(this.context().currentTime-this.origin)*this.project.bpm/60;set('[data-position]',pos<0?'Count-in '+Math.ceil(-pos):'Beat '+((pos%this.pattern.beats)+1).toFixed(1));const step=Math.floor(Math.max(0,pos)%this.pattern.beats*this.project.grid);this.host.querySelectorAll('[data-step]').forEach(e=>e.classList.toggle('playhead',+e.dataset.step===step));}
    if(this.meter){this.meter.getFloatTimeDomainData(this.meterData);const peak=this.meterData.reduce((a,b)=>Math.max(a,Math.abs(b)),0);const meter=this.host.querySelector('meter');if(meter)meter.value=peak;if(peak>=.99)this.clipUntil=Date.now()+1500;set('[data-clip]',Date.now()<this.clipUntil?'CLIP':'');}
    this.leds();
  }
  button(action,label,title=label){return `<button data-action="${action}" title="${this.esc(title)}" aria-label="${this.esc(title)}">${label}</button>`;}
  draw(){const h=this.host;if(!h?.isConnected)return;const b=(...a)=>this.button(...a),p=this.project;
    h.innerHTML=`<div class="sp-toolbar" role="toolbar" aria-label="Sampler transport">${b('songs','LOAD FROM SONGS','Load from Songs')}<span data-midi class="sp-midi"></span>${b('midi','MIDI','Connect MIDI')}<label>BPM <input data-project="bpm" type="number" min="30" max="300" value="${p.bpm}"></label>${b('play','Play')}${b('record','Record')}${b('panic','■','All Notes Off')}<label><input data-project="metro" type="checkbox" ${p.metro?'checked':''}>Click</label><label><input data-project="countIn" type="checkbox" ${p.countIn?'checked':''}>Count-in</label><label>Master<input data-master-volume aria-label="Master volume" type="range" min="0" max="1" step=".01" value="${this.volume}"></label><span data-position></span><meter min="0" max="1" value="0" aria-label="Sampler master meter"></meter><strong data-clip></strong>${b('kit','Save Kit')}${b('beat','Save Beat')}${b('send','Send to Studio')}<span data-status role="status"></span></div>
    <nav class="sp-mobile" aria-label="Sampler screens">${['pads','sequence'].map(v=>`<button data-action="view-${v}" class="${this.ui.view===v?'on':''}" aria-pressed="${this.ui.view===v}">${{pads:'Pads / Keys',sequence:'Sequencer'}[v]}</button>`).join('')}</nav>
    <div class="sp-body" data-view="${this.ui.view}" style="grid-template-columns:minmax(0,1fr)">
    <main class="sp-main"><nav class="sp-jump" aria-label="Go to part of the sampler"><span>Songs, splits, packs &amp; saved beats</span>${b('jump-keys','🎹 Keyboard','Scroll up to the Oxygen keyboard and pads')}${b('jump-editor','🎚 Sample editor · '+(this.selected<16?'Pad '+(this.selected+1):'Instrument '+(this.selected-15)),'Show the trim, length and chop controls for the selected pad')}${b('sequence',(this.ui.sequence?'▾ Hide':'▴ Show')+' sequencer','Show or hide the step sequencer at the bottom')}</nav><div class="sp-playing"><div class="sp-actions">${b('undo','↶','Undo')}${b('redo','↷','Redo')}<label>Keys play <select data-mode><option value="pads" ${p.mode==='pads'?'selected':''}>Pads 1–16 (drums / chops)</option><option value="16" ${p.mode==='16'?'selected':''}>Instrument 1</option><option value="17" ${p.mode==='17'?'selected':''}>Instrument 2</option></select></label><span>Repitching changes pitch and duration</span>${b('lyric-clip','✂ Chop → pad','Open the selected pad’s sound as a waveform: highlight a piece and drop it on a pad')}${b('clear','Clear assignment')}${b('copy','Copy')}${b('paste','Paste')}${b('learn','MIDI Learn selected')}${b('learn-pads',this.padWalk?'Stop learning pads':'Learn all 8 pads')}<span data-learn-status>${this.padWalk?'Hit PAD '+(this.padWalk.index+1)+' on the Oxygen…':this.learning?'Waiting for a key/control…':''}</span></div>
    <div class="sp-oxygen">${this.oxygen()}</div><div class="sp-actions"><span>${this.esc(this.slots[p.mode==='17'?17:16]?.name||'Drop a sound on keys for an instrument')}</span><label>Octave <input data-project="octave" type="number" min="0" max="8" value="${p.octave}"></label><label>Root <input data-project="root" type="number" min="0" max="127" value="${this.slots[+p.mode]?.root??p.root}"></label><label>Range <input aria-label="Lowest MIDI note" data-project="low" type="number" min="0" max="127" value="${p.low}"><input aria-label="Highest MIDI note" data-project="high" type="number" min="0" max="127" value="${p.high}"></label></div><section class="sp-editor"></section></div>
    <section class="sp-sequence" style="height:${this.ui.sequence?this.ui.height:38}px"><div class="sp-sequence-inner"></div></section></main></div>`;
    h.onclick=e=>{const a=e.target.closest('[data-action]');if(a)this.run(()=>this.action(a.dataset.action));};
    h.onchange=e=>this.run(()=>this.change(e.target));
    h.ondragstart=e=>{const dest=e.target.closest('[data-pad]');if(dest){e.dataTransfer.setData('application/x-screwshop-assignment',dest.dataset.pad);e.dataTransfer.effectAllowed='copyMove';}};
    h.ondragover=e=>{const target=e.target.closest('[data-dest]');if(target){e.preventDefault();target.classList.add('drop-hover');}};
    h.ondragleave=e=>e.target.closest('[data-dest]')?.classList.remove('drop-hover');
    h.ondrop=e=>{this.dragDone();const dest=e.target.closest('[data-dest]');if(!dest)return;e.preventDefault();dest.classList.remove('drop-hover');this.run(async()=>{const from=e.dataTransfer.getData('application/x-screwshop-assignment'),raw=e.dataTransfer.getData('application/x-screwshop-loop');
      if(from!==''){this.checkpoint();const to=+dest.dataset.dest;if(to===+from)return;this.slots[to]=clone(this.slots[+from]);if(!e.ctrlKey)this.slots[+from]=null;this.changed();this.draw();}else if(raw){const lane=+dest.dataset.dest,item=JSON.parse(raw);await this.assign(lane,lane>=16&&dest.dataset.note?{...item,root:+dest.dataset.note}:item);}});};
    h.querySelectorAll('[data-dest]').forEach(el=>{el.onpointerdown=e=>{if(e.button!==0)return;el.setPointerCapture(e.pointerId);const lane=+el.dataset.dest,note=+(el.dataset.note||60);this.run(()=>this.press(lane,note,100,'pointer:'+e.pointerId));};el.onpointerup=el.onpointercancel=el.onlostpointercapture=e=>this.releaseToken('pointer:'+e.pointerId);});
    h.oncontextmenu=e=>{const d=e.target.closest('[data-dest]');if(!d||this.helpMode)return;e.preventDefault();this.padMenu(+d.dataset.dest,e);};
    this.wireOxygen(h.querySelector('.sp-oxygen'));this.drawEditor();this.drawSequence();this.updateStatus();
  }
  // Plain words for where a sound lives, shown before and after a drop.
  where(lane,note=null){const s=this.slots[lane],m=this.project.maps['pad:'+lane],key=note!=null?'Key '+noteName(note)+' → ':'';
    const place=lane<16?`Pad ${lane+1} (bank ${lane<8?1:2}${m?', MIDI note '+m.number:''})`:`Instrument ${lane-15}`;
    return key+place+' — '+(s?(lane>=16?'loaded: '+s.name+', root '+noteName(s.root??this.project.root):'loaded: '+s.name):'empty');}
  // The drawn Oxygen 25: 8 pads x 2 banks = pads 1-16. Keys play pads 1-16 or one instrument, as the Keys play menu says.
  oxygen(){const p=this.project,bank=this.ui.bank?1:0,drums=p.mode==='pads',lane=drums?null:+p.mode,root=lane!=null?this.slots[lane]?.root??p.root:null;
    const mark=(l,extra='')=>[this.slots[l]?'ox-loaded':'',l===this.selected?'ox-sel':'',extra].filter(Boolean).join(' ');
    const body=this.oxygenBody({low:p.octave*12,volume:this.volume,knobs:Array.from({length:8},(_,i)=>Math.round(p.mix[bank*8+i].volume*127)),knobLabel:i=>`Knob ${i+1} (pad ${bank*8+i+1} volume)`,
      pad:i=>{const l=bank*8+i;return {attrs:`data-pad="${l}" data-dest="${l}" draggable="true"`,cls:mark(l,this.padWalk&&this.padWalk.bank===bank&&this.padWalk.index===i?'ox-learn':''),label:'Pad '+(l+1),title:this.where(l)+(this.slots[l]?' · right-click for options':''),html:`<b>${l+1}</b><span>${this.esc(this.slots[l]?.name||'empty')}</span>`};},
      key:(note,i,name)=>{if(drums)return i<16?{attrs:`data-dest="${i}" data-note="${note}"`,cls:mark(i),label:`Key ${name}: pad ${i+1}`,title:this.where(i,note),text:'P'+(i+1)}:{attrs:'disabled',cls:'ox-off',label:`Key ${name} (not used while keys play pads)`,text:''};
        return {attrs:`data-dest="${lane}" data-note="${note}"`,cls:[this.slots[lane]?'ox-loaded':'',note===root?'ox-root':''].filter(Boolean).join(' '),label:'Key '+name,title:this.where(lane,note),text:note===root?'ROOT':/^C-?\d/.test(name)?name:''};}});
    return `<div class="sp-ox-head"><strong>M-AUDIO <span>OXYGEN 25</span></strong><button data-ox="bank0" class="${bank?'':'on'}">BANK 1 · PADS 1–8</button><button data-ox="bank1" class="${bank?'on':''}">BANK 2 · PADS 9–16</button><span data-readout class="sp-ox-readout" role="status">${this.esc(this.padWalk?this.walkPrompt():this.where(this.selected))}</span><button data-ox="whats">WHAT'S THIS?</button><button data-ox="guide">TRILL GUIDE</button></div>
    <div class="ox-deck"><div class="ox-guide"></div><div class="ox-scroll"><div class="ox-stage"><div class="ox-body${this.helpMode?' ox-helping':''}" role="group" aria-label="Oxygen 25 keyboard">${body.replace(/data-action="/g,'data-ox-action="')}</div></div></div></div>`;
  }
  setBank(bank){this.ui.bank=bank;this.changed();this.draw();this.show('b'+(bank+1));}
  wireOxygen(box){if(!box)return;this.panel=box;const body=box.querySelector('.ox-body'),p=this.project,q=s=>body.querySelector(s);
    const readout=box.querySelector('[data-readout]'),spot=e=>{const d=e.target.closest('[data-dest]');return d&&this.where(+d.dataset.dest,d.dataset.note!=null?+d.dataset.note:null);};
    // WHAT'S THIS? mode: clicks explain a control instead of using it.
    const intercept=e=>{if(!this.helpMode)return;const el=e.target.closest('[data-help]');if(!el)return;e.preventDefault();e.stopPropagation();if(e.type==='click')this.explain(el);};
    ['pointerdown','mousedown','click','input','change','wheel'].forEach(t=>body.addEventListener(t,intercept,{capture:true,passive:false}));
    // SHIFT + pad 1 or 2 picks the pad bank, as on the hardware. SHIFT + anything else explains it.
    body.addEventListener('pointerdown',e=>{if(!this.shift)return;const el=e.target.closest('[data-pad],.ox-key');if(!el)return;e.preventDefault();e.stopPropagation();this.useShift();if(el.dataset.pad!=null&&+el.dataset.pad%8<2)this.setBank(+el.dataset.pad%8);else this.explain(el);},{capture:true});
    body.addEventListener('pointerover',e=>{const t=spot(e);if(t)readout.textContent=t;});
    body.addEventListener('dragover',e=>{const t=spot(e);if(t)readout.textContent='Drop here → '+t;});
    body.addEventListener('pointerleave',()=>{readout.textContent=this.where(this.selected);});
    box.querySelector('[data-ox="bank0"]').onclick=()=>this.setBank(0);box.querySelector('[data-ox="bank1"]').onclick=()=>this.setBank(1);
    body.querySelectorAll('[data-help="padbank"]').forEach((el,i)=>{el.classList.toggle('ox-bank-on',i===(this.ui.bank?1:0));el.onclick=()=>this.setBank(i);});
    box.querySelector('[data-ox="guide"]').onclick=()=>this.guide(0);
    box.querySelector('[data-ox="whats"]').onclick=()=>{this.helpMode=!this.helpMode;body.classList.toggle('ox-helping',this.helpMode);this.leds();this.message(this.helpMode?"WHAT'S THIS? is on: tap any part of the Oxygen to learn it. Tap WHAT'S THIS? again to play.":'Back to playing.');};
    q('[data-master]').oninput=e=>{this.volume=+e.target.value;this.applyGain();const t=this.host.querySelector('[data-master-volume]');if(t)t.value=this.volume;this.show(Math.round(this.volume*127));};
    q('[data-master]').onchange=()=>this.save().catch(()=>{});
    q('[data-pitch]').oninput=e=>this.bendTo(+e.target.value);q('[data-pitch]').onchange=e=>{e.target.value=0;this.bendTo(0);};
    q('[data-mod]').oninput=e=>{this.modTo(+e.target.value/127);this.show(+e.target.value);};
    body.querySelectorAll('[data-knob]').forEach(k=>{const i=+k.dataset.knob,mix=()=>p.mix[(this.ui.bank?8:0)+i],done=()=>{this.changed();this.drawSequence();};
      const set=v=>{v=clamp(Math.round(v),0,127);mix().volume=v/127;k.querySelector('i').style.transform='rotate('+(-135+v/127*270)+'deg)';this.show(v);};
      k.onpointerdown=e=>{e.preventDefault();k.setPointerCapture(e.pointerId);this.checkpoint();const y=e.clientY,start=mix().volume*127;k.onpointermove=m=>set(start+(y-m.clientY)*1.2);};
      k.onpointerup=k.onpointercancel=()=>{if(k.onpointermove){k.onpointermove=null;done();}};
      k.onwheel=e=>{e.preventDefault();set(mix().volume*127-Math.sign(e.deltaY)*4);clearTimeout(this.knobSave);this.knobSave=setTimeout(done,400);};
      k.onkeydown=e=>{const d={ArrowUp:4,ArrowRight:4,ArrowDown:-4,ArrowLeft:-4}[e.key];if(d){e.preventDefault();set(mix().volume*127+d);done();}};});
    q('[data-shift]').onclick=()=>{this.shift=!this.shift;this.leds();};
    q('[data-faderbtn]').onclick=()=>{this.muted=!this.muted;this.applyGain();this.leds();this.show(this.muted?'OFF':'ON');};
    q('[data-tempo]').onclick=()=>{if(this.useShift()){this.message('SHIFT + TEMPO = SYNC on the real keyboard. The sampler keeps its own BPM: tap TEMPO in rhythm to set it.');return;}
      const now=performance.now();this.taps=(this.taps||[]).filter(t=>now-t<2000);this.taps.push(now);this.tempoAt=now;if(this.playing)this.stop();
      if(this.taps.length>1){const gaps=this.taps.slice(1).map((t,i)=>t-this.taps[i]);p.bpm=clamp(Math.round(60000/(gaps.reduce((a,b)=>a+b)/gaps.length)),30,300);const input=this.host.querySelector('[data-project="bpm"]');if(input)input.value=p.bpm;clearTimeout(this.tapSave);this.tapSave=setTimeout(()=>this.changed(),800);}
      this.show(p.bpm);};
    body.querySelectorAll('[data-arrow]').forEach(b=>b.onclick=()=>{const d=+b.dataset.arrow;
      if(this.useShift()){this.message('SHIFT + < or > is MODE SELECT on the real keyboard (Arp, Chord, Scale). Those modes run inside the keyboard; the sampler plays the notes it sends.');return;}
      if(performance.now()-(this.tempoAt||0)<3000){this.tempoAt=performance.now();p.bpm=clamp(p.bpm+d,30,300);this.host.querySelector('[data-project="bpm"]').value=p.bpm;this.changed();this.show(p.bpm);return;}
      this.selected=(this.selected+d+18)%18;if(this.selected<16)this.ui.bank=this.selected<8?0:1;this.draw();this.show(this.selected<16?'P'+(this.selected+1):'In'+(this.selected-15));});
    body.querySelectorAll('[data-octave]').forEach(b=>b.onclick=()=>{this.useShift();this.checkpoint();this.panic();p.octave=clamp(p.octave+ +b.dataset.octave,0,8);this.changed();this.draw();this.show('OC'+p.octave);});
    q('[data-repeat]').onclick=()=>this.message('NOTE REPEAT is not built into the sampler yet. For rolls, click steps in the sequencer below or record at a finer Grid.');
    q('[data-dawpreset]').onclick=()=>this.message('DAW / PRESET: keep the real keyboard in Preset mode for ScrewShop, then use MIDI Learn to map pads and controls.');
    body.querySelectorAll('[data-ox-action]').forEach(b=>b.onclick=()=>this.run(()=>this.action(b.dataset.oxAction)));
    this.leds();if(this.guideIndex!=null)this.guide(this.guideIndex,this.guideCustom);
  }
  leds(){const p=this.panel;if(!p?.isConnected)return;const set=(sel,on)=>p.querySelectorAll(sel).forEach(el=>el.classList.toggle('on',!!on));
    set('[data-shift]',this.shift);set('[data-faderbtn]',this.muted);set('[data-ox-action="record"]',this.recording);set('[data-ox-action="play"]',this.playing);set('[data-ox-action="cycle"]',this.project.overdub);set('[data-ox="whats"]',this.helpMode);}
  bendTo(semitones){this.bend=semitones;for(const v of this.held.values())v.src.playbackRate.setTargetAtTime(v.rate*2**(semitones/12),v.ctx.currentTime,.01);}
  modTo(amount){this.mod=amount;for(const v of this.held.values())v.gain.gain.setTargetAtTime(v.level*(1-amount*.6),v.ctx.currentTime,.03);}
  // Trill's guide, reworded for what each control does in the sampler.
  steps(){const own={
      '':['Your Oxygen 25 (MKV)','This is the sampler drawn as the real keyboard. LOAD FROM SONGS opens your songs, split sounds, packs and saved beats. Press ⋮ on a sound (or right-click it), choose Load onto a sampler pad and select its pad or keyboard instrument. Connect USB, press MIDI and allow browser MIDI access to play it from the hardware. Press NEXT for every control, or tap WHAT\'S THIS? and then any part.'],
      knobs:['Knobs 1-8','Knob N sets the volume of pad N in the current bank (bank 2: pads 9-16). Drag up or down, scroll, or use the arrow keys. The same volumes are the sliders in the sequencer lanes.'],
      cycle:['Loop','Sampler patterns always loop. This button turns overdub on or off: lit means each recording pass layers on top of the notes already there.'],
      stop:['Stop / PANIC','Stops the sampler pattern. SHIFT + STOP = PANIC: silences every sound that is still ringing.'],
      play:['Play','Plays the current sampler pattern (same as Play in the toolbar or the space bar).'],
      record:['Record','Records your pad and key hits as editable notes in the pattern. Nothing is recorded as audio until you press Send to Studio.'],
      pads:['Pads 1-8 (x2 banks)','The real Oxygen 25 has 8 pads: 1-4 on the bottom row, 5-8 on the top row, same as this drawing. Bank 1 is pads 1-8 and bank 2 is pads 9-16, so you get 16 sounds. If a hardware pad lights the wrong pad here, press Learn all 8 pads and hit pads 1 to 8 in order. Drag a sound onto a pad to load it, drag a pad onto another pad to move it (hold Ctrl to copy). Lit pads have a sound; dark pads are empty.'],
      padbank:['PAD BANK 1 / 2','Click PAD BANK 1 or 2 (or the BANK buttons above), or press SHIFT then pad 1 or 2, to switch the 8 pads between pads 1-8 and pads 9-16. On the hardware, bank 2 sends different notes, so learn those pads with MIDI Learn.'],
      arrows:['< > / MODE SELECT','Step to the previous or next pad or instrument so its sample editor shows below. Right after TEMPO, they nudge the BPM by 1. SHIFT + < or > is MODE SELECT on the real keyboard.'],
      octave:['OCTAVE - / +','Moves the 25 keys down or up an octave. When keys play pads, pads 1-16 start on the lowest key.'],
      keys:['25 keys','Follows the Keys play menu. Pads 1-16: the first 16 keys play pads 1-16 (labeled P1-P16), and a sound dropped on a key loads that pad. Instrument: every key plays one sound at a different pitch, and the key you drop it on becomes its ROOT (original pitch).'],
      tempo:['TEMPO / SYNC','Tap TEMPO in rhythm to set the sampler BPM, then < or > nudges it by 1. SYNC (SHIFT + TEMPO) follows a DAW clock on the real keyboard; ScrewShop does not send MIDI clock.'],
      noterepeat:['NOTE REPEAT / LATCH','Not built into the sampler yet. For rolls, click steps in the sequencer or record with a finer Grid.'],
      pitch:['PITCH wheel','Bends every sound that is held down by up to 2 semitones, and snaps back when you let go. The hardware wheel does the same.'],
      mod:['MOD wheel','Turns held sounds down by up to 60% for swells. The hardware wheel does the same.']};
    return super.steps().map((s,i)=>{const o=s[0]===''?(i===0?own['']:null):own[s[0]];return o?[s[0],...o]:s;});}
  itemHelp(item){const [kind,a]=item.split(':'),i=+a,bank=this.ui.bank?8:0;
    if(kind==='knob')return ['Knob '+(i+1),'Sets the volume of pad '+(bank+i+1)+' ('+(this.slots[bank+i]?.name||'empty')+'). Drag up or down or scroll it.'];
    if(kind==='pad')return ['Pad '+(bank+i+1),this.where(bank+i)+'. Drag a sound onto it to load it; tap it to play it.'+(i<2?' SHIFT + this pad switches to PAD BANK '+(i+1)+'.':'')];
    if(kind==='key'){const note=this.project.octave*12+i,drums=this.project.mode==='pads';return ['Key '+noteName(note),drums?(i<16?this.where(i,note)+'. Drop a sound here to load pad '+(i+1)+'.':'Not used while keys play pads. Choose an instrument in Keys play to use all 25 keys.'):this.where(+this.project.mode,note)+'. Drop a sound here to make this key its root pitch.'];}
    return super.itemHelp(item);}
  run(fn){Promise.resolve().then(fn).catch(e=>this.message(e.message,true));}
  async action(a){
    if(a==='play'){this.scheduled=new Map();return this.start();}if(a==='record'){if(!this.playing)this.scheduled=new Map();return this.start(true);}if(a==='panic')return this.panic();
    if(a==='stop'){if(this.useShift()){this.panic();return this.show('PAN');}return this.stop();}
    if(a==='cycle'){this.checkpoint();this.project.overdub=!this.project.overdub;this.changed();this.drawSequence();this.leds();return this.show(this.project.overdub?'OdB':'OFF');}
    if(a==='midi')return this.app.initMidi();if(a==='undo'||a==='redo')return this.undo(a==='redo');
    if(a==='jump-keys'){if(this.ui.view==='sequence'||this.ui.view==='library'){this.ui.view='pads';this.draw();}this.host.querySelector('.sp-playing').scrollTo({top:0,behavior:'smooth'});return;}
    if(a==='jump-editor'){if(this.ui.view!=='pads'){this.ui.view='pads';this.changed();this.draw();}const ed=this.host.querySelector('.sp-editor');ed.scrollIntoView({block:'start',behavior:'smooth'});ed.classList.remove('flash');void ed.offsetWidth;ed.classList.add('flash');return;}
    if(a==='songs'||a==='library'||a==='view-library'){this.stop();this.previewAudio?.pause();this.app.setState({tab:'songs'});return;}
    if(a.startsWith('view-')){this.ui.view=a.slice(5);this.changed();return this.draw();}
    if(a==='clear'){this.checkpoint();this.panic();this.slots[this.selected]=null;this.changed();return this.draw();}
    if(a==='copy'){this.clipboard=clone(this.slots[this.selected]);return this.message('Assignment copied');}
    if(a==='paste'&&!this.clipboard)return this.message('Nothing copied yet. Select a pad and press Copy first.');if(a==='paste'&&this.clipboard){this.checkpoint();this.slots[this.selected]=clone(this.clipboard);await this.prepare();this.changed();return this.draw();}
    if(a==='learn'){this.padWalk=null;this.learning=this.learning?null:'pad:'+this.selected;return this.draw();}
    if(a==='learn-pads')return this.startPadWalk();
    if(a==='kit')return this.saveNamed('kit');if(a==='beat')return this.saveNamed('beat');if(a==='send')return this.handoff(false);if(a==='update')return this.handoff(true);
    if(a==='new-beat'){
      await this.checked(this.app.sb.from('settings').upsert({id:'sampler-beat-'+this.project.id,kind:'sampler-beat',name:this.project.name,project:this.snapshot(),render:this.lastRender||null}));
      this.checkpoint();const previous=this.project,next=defaults();for(const key of ['slots','maps','mix','bpm','root','low','high','kitId','mode'])next[key]=clone(previous[key]);await this.restore(next);await this.refreshLibrary();return this.message('New beat ready. Previous beat saved in the library; current kit retained.');
    }
    if(a==='retry')return this.save();if(a==='export')return this.exportBeat();if(a==='export-mp3')return this.exportBeat('mp3');if(a==='import')return this.importFiles(false);if(a==='folder')return this.importFiles(true);
    if(a==='sequence'){this.ui.sequence=!this.ui.sequence;this.changed();return this.draw();}
    if(a==='roll'){this.ui.roll=!this.ui.roll;this.changed();return this.drawSequence();}
    if(a==='edit-events'){this.editNotes=!this.editNotes;return this.drawSequence();}
    if(a==='previous'||a==='next'){this.ui.page=clamp(this.ui.page+(a==='next'?1:-1),0,Math.ceil(this.pattern.beats*this.project.grid/this.ui.steps)-1);return this.drawSequence();}
    if(['add-pattern','duplicate-pattern','delete-pattern','rename-pattern'].includes(a)){this.stop();this.checkpoint();
      if(a==='delete-pattern'){if(this.project.patterns.length===1)throw Error('Keep at least one pattern.');this.project.patterns.splice(this.project.pattern,1);this.project.pattern=0;}
      else {const name=prompt('Pattern name',this.pattern.name);if(!name?.trim())return;
        if(a==='rename-pattern')this.pattern.name=name.trim();else {const p=a==='duplicate-pattern'?clone(this.pattern):{beats:this.pattern.beats,events:[]};p.id=uid();p.name=name.trim();p.events.forEach(e=>e.id=uid());this.project.patterns.push(p);this.project.pattern=this.project.patterns.length-1;}}
      this.ui.page=0;this.changed();return this.drawSequence();}
    if(a==='lyric-clip')return this.openClip();
    if(a==='slice')return this.slice();if(a==='save-chop'){const s=this.slots[this.selected];if(!s)throw Error('Assign a sound first.');const name=prompt('Chop name',s.name);if(name){this.chops.push({...clone(s),name,id:uid(),type:'Chops'});this.changed();this.drawLibrary();}}
  }
  async change(el){
    if(el.matches('[data-master-volume]')){this.volume=clamp(el.value,0,1);this.applyGain();return this.save();}
    if(el.dataset.project==='root'&&+this.project.mode>=16&&this.slots[+this.project.mode]){this.checkpoint();this.slots[+this.project.mode].root=clamp(el.value,0,127);this.changed();return;}
    if(el.dataset.project){const key=el.dataset.project;this.checkpoint();if(['bpm','grid','swing'].includes(key))this.stop();const ranges={bpm:[30,300],grid:[1,8],swing:[0,75],octave:[0,8],root:[0,127],low:[0,127],high:[0,127],latency:[-250,250]};this.project[key]=el.type==='checkbox'?el.checked:clamp(el.value,...(ranges[key]||[0,1000]));this.changed();if(key==='bpm')this.drawEditor();if(['octave','grid'].includes(key))this.draw();return;}
    if(el.matches('[data-mode]')){this.panic();this.project.mode=el.value;this.selected=el.value==='pads'?0:+el.value;this.changed();return this.draw();}
    if(el.dataset.sample){const slot=this.slots[this.selected];if(!slot)return;this.checkpoint();slot[el.dataset.sample]=el.type==='checkbox'?el.checked:clamp(el.value,+el.min,+el.max);
      const b=this.buffers.get(slot.url);if(!b){this.message('This pad\'s sound file is missing, so it can\'t be trimmed. Load a sound onto the pad again.',true);return;}slot.start=clamp(slot.start,0,b.duration-.001);slot.end=clamp(slot.end,slot.start+.001,b.duration);await this.prepareSlot(slot);this.changed();this.drawEditor();return;}
    if(el.dataset.mix){this.checkpoint();const [lane,key]=el.dataset.mix.split(':');this.project.mix[+lane][key]=el.type==='checkbox'?el.checked:clamp(el.value,0,1);this.changed();return;}
    if(el.matches('[data-pattern]')){this.stop();this.project.pattern=+el.value;this.ui.page=0;this.changed();return this.drawSequence();}
    if(el.matches('[data-length]')){this.stop();this.checkpoint();this.pattern.beats=clamp(el.value,1,64);this.ui.page=0;this.changed();return this.drawSequence();}
    if(el.matches('[data-steps]')){this.ui.steps=+el.value;this.ui.page=0;this.changed();return this.drawSequence();}
    if(el.matches('[data-height]')){this.ui.height=+el.value;this.changed();return this.draw();}
    if(el.matches('[data-learn-action]')){this.learning=el.value||null;this.draw();}
    if(el.dataset.event){this.checkpoint();const event=this.pattern.events.find(x=>x.id===this.editEvent);if(event){const key=el.dataset.event;event[key]=clamp(el.value,...(key==='velocity'?[1,127]:[1/64,64]));this.changed();this.drawSequence();}}
  }
  drawLibrary(){const host=this.host?.querySelector('.sp-library-inner');if(!host)return;
    const oldSearch=host.querySelector('[data-search]'),typing=oldSearch&&document.activeElement===oldSearch?[oldSearch.selectionStart,oldSearch.selectionEnd]:null;
    this.openActions=this.openActions||new Set();
    const search=oldSearch?.value??this.search??'',filter=this.filter||'All';this.ui.groups=this.ui.groups||{};
    if(!this.renderedSamplerSearch)host.querySelectorAll('details[data-group]').forEach(el=>{this.ui.groups[el.dataset.group]=el.open;});
    this.renderedSamplerSearch=search;
    this.libraryItems=[];const seen=new Set();
    const push=(raw,type,group)=>{let item;try{item=this.item(raw);}catch(_){return;}item.name=item.name||item.kind||item.label||'Untitled';const key=item.url+':'+(item.start||0)+':'+(item.end||'');if(seen.has(key))return;seen.add(key);this.libraryItems.push({...item,type:raw.type||type,group});};
    for(const f of this.folders||[])for(const raw of f.files||[])push(raw,f.folder_type==='pack'?'Packs':raw.sample?'Chops':'Stems',f.name);
    for(const s of this.app.state.allStems||[])push({...s,name:s.name||s.kind},'Stems',s.trackName||'Separated stems');
    for(const raw of this.chops)push(raw,'Chops','Saved chops');
    for(const raw of this.app.state.library||[]){const version=raw.source_kind==='screw-version'||/\/[a-f0-9-]{25,}\.(wav|webm|m4a|mp3)$/i.test(raw.storage_path||'');push({...raw,librarySource:true},version?'Versions':'Samples',version?'Saved versions':'Imported sounds');}
    for(const t of this.takes||[])push({...t,name:t.label||'Recording',bucket:'takes'},'Recordings','Recordings');
    for(const beat of this.beats||[])this.libraryItems.push({name:beat.name,type:'Beats',group:'Saved beats',beat,url:beat.render?.url});
    const visible=this.libraryItems.map((x,i)=>({...x,index:i})).filter(x=>[x.name,x.group,x.type,x.kind].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase())&&(filter==='All'||filter===x.type||filter==='Favorites'&&this.favorites.includes(x.url||x.beat?.id)));
    const sort=this.ui.soundSort||'name';visible.sort((a,b)=>sort==='newest'?String(b.created_at||'').localeCompare(String(a.created_at||'')):sort==='type'?a.type.localeCompare(b.type)||a.name.localeCompare(b.name):a.name.localeCompare(b.name,undefined,{numeric:true}));
    const kits=(this.kits||[]).map((x,i)=>({...x,index:i})).filter(x=>(filter==='All'||filter==='Kits')&&x.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a,b)=>sort==='newest'?String(b.created_at||'').localeCompare(String(a.created_at||'')):a.name.localeCompare(b.name,undefined,{numeric:true}));
    // Sort inside folders while keeping playable sound folders ahead of editable beat projects.
    const visibleGroups=new Set(visible.map(x=>x.group)),groups=[...new Set(this.libraryItems.map(x=>x.group))].filter(g=>visibleGroups.has(g));
    host.innerHTML=`<div class="sp-actions">${this.button('import','Import')}${this.button('folder','Folder')}</div><input data-search aria-label="Search sounds" placeholder="Search sounds" value="${this.esc(search)}"><select data-filter aria-label="Sound filter">${['All','Packs','Samples','Versions','Recordings','Stems','Chops','Beats','Kits','Favorites'].map(f=>`<option ${f===filter?'selected':''}>${f}</option>`).join('')}</select><select data-sound-sort aria-label="Sort sampler sounds">${[['name','Name A–Z'],['newest','Newest first'],['type','Type']].map(([value,label])=>`<option value="${value}" ${value===sort?'selected':''}>${label}</option>`).join('')}</select><label>Preview <input data-preview-volume aria-label="Preview volume" type="range" min="0" max="1" step=".01" value="${this.previewVolume??.5}"></label><p class="sp-hint">Drag a sound, or select it then tap a pad/key.</p><p class="sp-library-summary" role="status">${visible.length} sounds · ${kits.length} kits</p>${groups.map(g=>`<details data-group="${this.esc(g)}" ${search||this.ui.groups[g]!==false?'open':''}><summary>${this.esc(g)} <small class="sl-heading-count">${visible.filter(x=>x.group===g).length}</small></summary>${visible.filter(x=>x.group===g).map(x=>`<div class="sp-sound" data-sound="${x.index}" draggable="${!!x.url}"><button data-preview="${x.index}" title="Preview" aria-label="Preview ${this.esc(x.name)}" ${x.url?'':'disabled'}>▶</button><button data-select="${x.index}" title="Select sound for assignment" ${x.url?'':'disabled'}>${this.esc(x.name)}<small>${x.type} · ${Number.isFinite(x.end)?(x.end-(x.start||0)).toFixed(1)+'s':x.duration?Number(x.duration).toFixed(1)+'s':'—'}</small></button>${x.url&&!x.beat?`<button data-chop="${x.index}" title="Chop: open as a waveform and drop pieces on pads" aria-label="Chop ${this.esc(x.name)}">✂</button>`:'<span></span>'}<button data-favorite="${x.index}" aria-label="Favorite ${this.esc(x.name)}">${this.favorites.includes(x.url||x.beat?.id)?'★':'☆'}</button>${x.beat?`<button data-open-beat="${x.index}">Open Beat</button><button data-send-beat="${x.index}">Send to Studio</button>`:''}${x.librarySource?`<div class="sp-actions"><button data-split="${x.index}:quick">Quick split</button><button data-split="${x.index}:full">Full split</button></div>`:''}</div>`).join('')}</details>`).join('')||(!kits.length?'<p>No matching sounds. Try another search or import audio to begin.</p>':'')}${kits.length?`<details data-group="sampler-kits" ${this.ui.groups['sampler-kits']?'open':''}><summary>Kits <small class="sl-heading-count">${kits.length}</small></summary>${kits.map(k=>`<button data-kit="${k.index}">${this.esc(k.name)}</button>`).join('')}</details>`:''}<p>${this.pendingSound?'Selected: '+this.esc(this.pendingSound.name):''}</p>`;
    host.querySelector('[data-search]').oninput=e=>{this.search=e.target.value;this.drawLibrary();};
    if(typing!=null){const input=host.querySelector('[data-search]');input.focus();input.setSelectionRange(...typing);}
    host.querySelector('[data-sound-sort]').onchange=e=>{this.ui.soundSort=e.target.value;this.drawLibrary();this.save().catch(()=>{});};
    host.querySelector('[data-filter]').onchange=e=>{this.filter=e.target.value;this.drawLibrary();};host.querySelector('[data-preview-volume]').oninput=e=>{this.previewVolume=+e.target.value;if(this.previewAudio)this.previewAudio.volume=this.previewVolume;};
    host.ondragend=()=>this.dragDone();
    host.ondragstart=e=>{const row=e.target.closest('[data-sound]');if(!row)return;e.stopPropagation();this.dragging=true;e.dataTransfer.setData('application/x-screwshop-loop',JSON.stringify(this.libraryItems[+row.dataset.sound]));e.dataTransfer.effectAllowed='copy';};
    host.onclick=e=>{const t=e.target.closest('button');if(!t)return;this.run(async()=>{if(t.dataset.preview!=null)this.preview(this.libraryItems[+t.dataset.preview]);if(t.dataset.chop!=null)return this.openClip(this.libraryItems[+t.dataset.chop]);
      if(t.dataset.select!=null){this.pendingSound=this.libraryItems[+t.dataset.select];this.message('Tap a pad or key to assign '+this.pendingSound.name);}
      if(t.dataset.favorite!=null){const x=this.libraryItems[+t.dataset.favorite],key=x.url||x.beat.id;this.favorites=this.favorites.includes(key)?this.favorites.filter(f=>f!==key):[...this.favorites,key];this.changed();this.drawLibrary();}
      if(t.dataset.openBeat!=null||t.dataset.sendBeat!=null){const x=this.libraryItems[+(t.dataset.openBeat??t.dataset.sendBeat)];await this.checked(this.app.sb.from('settings').upsert({id:'sampler-beat-'+this.project.id,kind:'sampler-beat',name:this.project.name,project:this.snapshot(),render:this.lastRender||null}));this.checkpoint();await this.restore(x.beat.project);if(t.dataset.sendBeat!=null)await this.handoff(false,{mode:'beat'});}
      if(t.dataset.kit!=null){const k=this.kits[+t.dataset.kit];this.checkpoint();this.stop();Object.assign(this.project,clone(k.kit));this.project.kitId=k.id;this.syncLegacy();await this.prepare();this.changed();this.draw();this.prune();}
      if(t.dataset.split){const [i,mode]=t.dataset.split.split(':');const x=this.libraryItems[+i];await this.app.requestSplit(x,mode);this.message('Split requested. Progress appears in the sound browser.');}
    });};
    host.querySelectorAll('details[data-group]').forEach(el=>{el.querySelector('summary').onclick=()=>{if(this.search)return;this.ui.groups[el.dataset.group]=!el.open;this.save().catch(()=>{});};el.ontoggle=()=>{const name=el.dataset.group;if(!el.isConnected||this.search)return;if((this.ui.groups[name]!==false)!==el.open){this.ui.groups[name]=el.open;this.save().catch(()=>{});}};});
    host.querySelector('[data-preview-volume]').onchange=()=>this.save().catch(()=>{});
    // Keep the existing pack export workflow beside its source folder.
    for(const el of host.querySelectorAll('details[data-group]')){
      const folder=(this.folders||[]).find(f=>f.name===el.dataset.group);if(!folder)continue;
      if(folder.files?.length){const button=document.createElement('button');button.className='sp-load-pack';button.dataset.loadPack=folder.id;button.textContent='🎹 Load onto Oxygen ('+folder.files.length+')';button.onclick=e=>{e.stopPropagation();this.run(()=>this.openPack(folder.id));};el.querySelector('summary').after(button);}
      if(folder.folder_type==='split'){const button=document.createElement('button');button.textContent='Name & Save Pack';button.onclick=()=>this.run(()=>this.namePack(folder.id));el.querySelector('summary').after(button);}
      if(folder.mode==='full'&&folder.beat_id){const button=document.createElement('button');button.textContent='Download Pack ZIP';button.onclick=()=>this.app.exportFile({kind:'pack',beat_id:folder.beat_id});el.querySelector('summary').after(button);}
    }
    for(const el of host.querySelectorAll('.sp-sound')){
      const x=this.libraryItems[+el.dataset.sound],job=this.app.state.splitJobs[x.id];
      if(job){const status=document.createElement('small');status.textContent=job.error||job.status;status.className='sp-job';el.append(status);}
      if(x.url&&!x.beat){const duration=this.buffers.get(x.url)?.duration;if(duration!=null){const small=el.querySelector('[data-select] small');if(small)small.textContent=x.type+' · '+((x.end??duration)-(x.start||0)).toFixed(1)+'s';}}
      if(x.url){const actions=document.createElement('details');actions.className='sp-audio-actions';actions.open=this.openActions.has(x.url);actions.draggable=false;
        actions.innerHTML='<summary>Audio actions</summary><div class="sp-actions"><button data-clip-words>✂ Chop → pad</button><button data-to-pad>Put on selected pad</button><button data-to-studio>Add to Studio</button><a download href="'+this.esc(x.url)+'">Download</a></div>';
        actions.ontoggle=()=>{if(!actions.isConnected)return;if(actions.open)this.openActions.add(x.url);else this.openActions.delete(x.url);};
        actions.querySelector('[data-clip-words]').onclick=e=>{e.stopPropagation();this.run(()=>this.openClip(x));};
        actions.querySelector('[data-to-pad]').onclick=e=>{e.stopPropagation();this.run(()=>this.assign(this.selected,x));};
        actions.querySelector('[data-to-studio]').onclick=e=>{e.stopPropagation();this.run(async()=>{const at=this.app.studio.cursor,clip=await this.app.studio.addClip(null,x,at);if(clip)this.message(`Added ${x.name} to Studio at ${clip.start.toFixed(1)} s. Open the STUDIO tab to arrange it.`);});};
        el.append(actions);}
    }
  }
  dragDone(){this.dragging=false;if(this.libraryStale){this.libraryStale=false;this.drawLibraryIfChanged();}}
  preview(item){if(this.previewAudio){const stop=this.previewItem===item.url&&!this.previewAudio.paused;this.previewAudio.pause();if(stop)return;}this.previewItem=item.url;const audio=this.previewAudio=new Audio(item.url);audio.volume=this.previewVolume??.5;audio.currentTime=item.start||0;if(item.end)audio.ontimeupdate=()=>{if(audio.currentTime>=item.end)audio.pause();};audio.play().catch(e=>this.message('Preview unavailable: '+e.message,true));}
  drawEditor(){const inline=this.host?.querySelector('.sp-editor');if(inline){this.editorLane=this.selected;this.editorSlot=this.slots[this.selected];const jump=this.host.querySelector('[data-action=jump-editor]');if(jump)jump.textContent='🎚 Sample editor · '+(this.selected<16?'Pad '+(this.selected+1):'Instrument '+(this.selected-15));this.drawEditorInto(inline,this.selected);}
    const win=this.soundWindow?.isConnected&&this.soundWindow.querySelector('.sp-editor');if(win)this.drawEditorInto(win,this.soundLane);}
  drawEditorInto(host,lane){const s=this.slots[lane];if(!s){host.innerHTML='<p>Select a pad or instrument and drop a sound to edit it.</p>';return;}
    const num=(key,label,min,max,step)=>`<label>${label}<input data-sample="${key}" aria-label="${label}" type="number" min="${min}" max="${max}" step="${step}" value="${s[key]??({volume:1,end:1,attack:.003,release:.03}[key]||0)}"></label>`;
    const check=(key,label)=>`<label><input data-sample="${key}" type="checkbox" ${s[key]?'checked':''}>${label}</label>`;
    host.innerHTML=`<strong>${lane<16?'Pad '+(lane+1):'Instrument '+(lane-15)} · ${this.esc(s.name)}</strong><canvas width="900" height="50" aria-label="Selected sound waveform"></canvas><div class="sp-actions">${num('start','Start',0,99999,.001)}${num('end','End',.001,99999,.001)}${num('volume','Volume',0,2,.05)}${num('pan','Pan',-1,1,.1)}${num('pitch','Pitch (semitones)',-36,36,.01)}${check('reverse','Reverse')}${check('gate','Hold / gate')}${check('loop','Loop trim')}${lane<16?`<label title="On: hitting this pad again stops the last hit, so long sounds never pile up. Off: hits overlap."><input data-sample="mono" type="checkbox" ${s.mono!==false?'checked':''}>Cut itself</label>`:''}</div>
    <div class="sp-actions sp-length"><span data-length-readout>${this.lengthText(s)}</span>${[1,2,4].map(n=>`<button data-bars="${n}">${n} bar${n>1?'s':''}</button>`).join('')}<button data-bars="whole">Whole sound</button></div><div class="sp-actions sp-lyric-entry">${this.button('lyric-clip','✂ Chop this sound → pad','Open this sound as a waveform: highlight a piece and drop it on a pad')}<small>Highlight on the waveform or tap the words; the pad plays just that piece. A Quick split vocals stem works best.</small></div><details class="sp-advanced" ${this.ui.advanced?'open':''}><summary>Advanced sample controls</summary><div class="sp-actions">${num('attack','Attack / fade in',.001,2,.001)}${num('release','Release / fade out',.003,3,.001)}${num('choke','Choke group',0,16,1)}${this.button('slice','Slice to pads')}${this.button('save-chop','Save Chop')}<label>Slice points (seconds)<input data-slice-points placeholder="0.2, 0.5, 0.8"></label></div></details>`;
    host.querySelectorAll('[data-bars]').forEach(b=>b.onclick=()=>this.run(()=>this.setBars(b.dataset.bars)));
    host.querySelector('.sp-advanced').ontoggle=e=>{if(this.ui.advanced!==e.target.open){this.ui.advanced=e.target.open;this.changed();}};
    const canvas=host.querySelector('canvas'),ctx=canvas.getContext('2d'),buffer=this.buffers.get(s.url);if(!buffer){ctx.fillStyle='#ddd';ctx.fillText('Missing sound. Reassign to retry.',8,25);return;}
    const data=buffer.getChannelData(0),stride=Math.max(1,Math.floor(data.length/900));ctx.fillStyle='#261a3f';ctx.fillRect(0,0,900,50);ctx.strokeStyle='#c9a4ff';ctx.beginPath();for(let x=0;x<900;x++){let peak=0;for(let i=x*stride;i<Math.min(data.length,(x+1)*stride);i+=Math.max(1,Math.floor(stride/20)))peak=Math.max(peak,Math.abs(data[i]));ctx.moveTo(x,25-peak*24);ctx.lineTo(x,25+peak*24);}ctx.stroke();ctx.fillStyle='#b784ff55';ctx.fillRect(s.start/buffer.duration*900,0,(s.end-s.start)/buffer.duration*900,50);
    canvas.onclick=e=>{const time=clamp((e.clientX-canvas.getBoundingClientRect().left)/canvas.getBoundingClientRect().width*buffer.duration,0,buffer.duration);this.checkpoint();if(e.shiftKey)s.end=Math.max(s.start+.001,time);else s.start=Math.min(s.end-.001,time);this.changed();this.drawEditor();};canvas.title='Click to set start; Shift-click to set end. Numeric fields also work on touch.';
  }
  padName(lane){return lane<16?'Pad '+(lane+1):'Instrument '+(lane-15);}
  // Right-click a pad: everything about the sound on it.
  padMenu(lane,at){const s=this.slots[lane],empty=!s,why='This pad is empty. Load a sound onto it first.';
    const pick=fn=>()=>{this.selected=lane;this.draw();return this.run(fn);};
    window.ItemMenu.show(at,[
      {id:'play',label:'Play',disabled:empty,why,run:()=>this.audition(lane)},
      {id:'edit',label:'Edit sound… (trim, pitch, volume, fades)',disabled:empty,why,run:()=>this.openSoundWindow(lane)},
      {id:'chop',label:'Chop a piece of this sound…',disabled:empty,why,run:pick(()=>this.openClip())},
      {id:'rename',label:'Rename sound',disabled:empty,why,run:()=>{const n=prompt('Sound name',s.name);if(n&&n.trim()){this.checkpoint();s.name=n.trim().slice(0,160);this.changed();this.draw();}}},
      '-',
      {id:'load',label:empty?'Load a sound from SONGS…':'Replace with a sound from SONGS…',run:pick(()=>this.action('songs'))},
      {id:'copy',label:'Copy sound',disabled:empty,why,run:()=>{this.clipboard=clone(s);this.message('Copied '+s.name+'. Right-click another pad → Paste sound here.');}},
      {id:'paste',label:'Paste sound here',disabled:!this.clipboard,why:'Copy a pad first (right-click it → Copy sound).',run:pick(()=>this.action('paste'))},
      {id:'save-chop',label:'Save as a chop in SONGS…',disabled:empty,why,run:pick(()=>this.action('save-chop'))},
      '-',
      {id:'clear',label:'Clear pad',danger:true,disabled:empty,why,run:()=>this.clearPad(lane)},
    ],{title:this.padName(lane)+(s?' · '+s.name:' · empty'),label:'Pad actions'});}
  clearPad(lane){const s=this.slots[lane];if(!s)return;this.checkpoint();this.panic();this.slots[lane]=null;this.changed();this.draw();
    // The sound file stays in SONGS; UNDO puts this exact sound and its settings back.
    window.ItemMenu.undoable('Cleared '+this.padName(lane)+' ('+s.name+').',()=>this.run(async()=>{if(this.slots[lane])return this.message(this.padName(lane)+' has a new sound now, so the old one was not put back.',true);this.checkpoint();this.slots[lane]=s;await this.prepareSlot(s);this.changed();this.draw();}));}
  audition(lane){const s=this.slots[lane];if(!s)return;const note=lane>=16?(s.root??this.project.root):60;
    this.releaseToken('menu-audition',true);this.run(()=>this.press(lane,note,100,'menu-audition'));
    const secs=Math.min(4,Math.max(.15,(s.end-s.start)/2**((s.pitch||0)/12)));clearTimeout(this.auditionTimer);this.auditionTimer=setTimeout(()=>this.releaseToken('menu-audition'),secs*1000);}
  // EDIT SOUND: a small window with every setting of the sound on one pad.
  openSoundWindow(lane){const start=this.slots[lane];if(!start)throw Error('This pad is empty.');const before=clone(start);
    this.selected=lane;this.draw();
    const dialog=window.ItemMenu.panel({title:'Edit sound · '+this.padName(lane)+' · '+start.name,className:'sp-sound-window',onClose:()=>{this.soundWindow=null;this.soundLane=null;this.releaseToken('menu-audition',true);}});
    dialog.id='sp-sound';this.soundWindow=dialog;this.soundLane=lane;
    dialog.querySelector('.im-panel-body').innerHTML=`<div class="sp-sound-quick" role="group" aria-label="Pitch"><strong>Pitch</strong><button type="button" data-pitch-step="-12">− Octave</button><button type="button" data-pitch-step="-1">− Semitone</button><output data-pitch-readout aria-live="polite"></output><button type="button" data-pitch-step="1">+ Semitone</button><button type="button" data-pitch-step="12">+ Octave</button><label>Fine tune <input data-fine type="range" min="-50" max="50" step="1" aria-label="Fine tune in cents"> <output data-fine-readout></output></label></div>
      <div class="sp-sound-quick"><button type="button" data-sound="audition" class="sp-sound-play">▶ AUDITION</button><button type="button" data-sound="reset">Reset all changes</button><span class="sp-sound-note">Click the waveform to set Start, Shift-click to set End. Changes apply right away and save with the beat; pitch also changes length, like a turntable.</span></div>
      <div class="sp-editor"></div><div class="sp-sound-done"><button type="button" data-sound="done">DONE</button></div>`;
    const q=sel=>dialog.querySelector(sel),fine=q('[data-fine]');
    const quick=()=>{const p=this.slots[lane]?.pitch||0,semis=Math.round(p),cents=Math.round((p-semis)*100);q('[data-pitch-readout]').textContent=(semis>0?'+':'')+semis+' st';fine.value=cents;q('[data-fine-readout]').textContent=(cents>0?'+':'')+cents+' ¢';};
    const setPitch=async v=>{const slot=this.slots[lane];if(!slot)return;this.checkpoint();slot.pitch=clamp(Math.round(v*100)/100,-36,36);await this.prepareSlot(slot);this.changed();this.drawEditor();quick();};
    dialog.addEventListener('click',e=>{const t=e.target.closest('button');if(!t||!dialog.contains(t))return;
      if(t.dataset.pitchStep)return this.run(()=>setPitch((this.slots[lane]?.pitch||0)+ +t.dataset.pitchStep));
      if(t.dataset.sound==='audition')return this.audition(lane);
      if(t.dataset.sound==='done')return dialog.close();
      if(t.dataset.sound==='reset')return this.run(async()=>{this.checkpoint();this.slots[lane]=clone(before);await this.prepareSlot(this.slots[lane]);this.changed();this.draw();this.drawEditor();quick();});
      if(t.dataset.action){this.selected=lane;this.run(()=>this.action(t.dataset.action));}});
    fine.oninput=()=>this.run(()=>setPitch(Math.round(this.slots[lane]?.pitch||0)+ +fine.value/100));
    dialog.addEventListener('change',e=>{if(e.target===fine)return;this.selected=lane;this.run(async()=>{await this.change(e.target);quick();});});
    this.drawEditor();quick();q('[data-sound="audition"]').focus();return dialog;}
  lengthText(s){const rate=2**((s.pitch||0)/12),secs=(s.end-s.start)/rate,bars=secs/this.barSeconds(1);
    return `Plays ${secs.toFixed(2)} s = ${bars<10?bars.toFixed(2):bars.toFixed(0)} bars at ${this.project.bpm} BPM${s.gate||s.loop?' (stops when you let go)':''}`;}
  // LOAD ONTO OXYGEN: preview a split or pack, tick up to 16 sounds, and fill the pads in one go.
  // Short hits and phrases are listed (and ticked) first because they suit pads; long stems land as 4-bar pieces.
  openPack(folderId){const folder=(this.folders||[]).find(f=>f.id===folderId);if(!folder)throw Error('That pack is no longer in the library.');
    const items=(folder.files||[]).map((raw,index)=>({...this.item(raw),index})).sort((a,b)=>(b.sample?1:0)-(a.sample?1:0));
    this.pack={folder,items,checked:new Set(items.slice(0,16).map(x=>x.index)),emptyOnly:false,status:''};
    let dialog=document.getElementById('sp-pack');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='sp-pack';dialog.className='sp-clip sp-pack';dialog.setAttribute('aria-label','Load a pack onto the Oxygen');document.body.append(dialog);
      dialog.onclose=()=>{this.packAudio?.pause();this.packAudio=null;};
      dialog.onclick=e=>{const t=e.target.closest('button');if(t)Promise.resolve().then(()=>this.packAction(t)).catch(err=>this.packStatus(err.message,true));};
      dialog.onchange=e=>{const p=this.pack;if(!p)return;if(e.target.dataset.packCheck!=null){const i=+e.target.dataset.packCheck;if(e.target.checked)p.checked.add(i);else p.checked.delete(i);this.drawPack();}
        if(e.target.matches('[data-pack-empty]')){p.emptyOnly=e.target.checked;this.drawPack();}};}
    this.drawPack();if(!dialog.open)dialog.showModal();}
  packStatus(text,error=false){if(this.pack){this.pack.status=text;this.pack.error=error;}const el=document.querySelector('#sp-pack [data-pack-status]');if(el){el.textContent=text;el.classList.toggle('error',error);}}
  packLanes(){const lanes=[];for(let i=0;i<16;i++)if(!this.pack.emptyOnly||!this.slots[i])lanes.push(i);return lanes;}
  async packAction(t){const p=this.pack;if(!p)return;
    if(t.dataset.pack==='close')return document.getElementById('sp-pack').close();
    if(t.dataset.packPlay!=null){const x=p.items.find(i=>i.index===+t.dataset.packPlay),same=this.packAudio&&this.packPlaying===x.index&&!this.packAudio.paused;
      this.packAudio?.pause();this.packAudio=null;this.packPlaying=null;
      if(!same){const audio=this.packAudio=new Audio(x.url);this.packPlaying=x.index;audio.volume=this.previewVolume??.5;audio.onended=audio.onpause=()=>{if(this.packAudio===audio){this.packPlaying=null;this.drawPack();}};this.drawPack();await audio.play().catch(e=>{this.packPlaying=null;this.drawPack();throw Error('Preview unavailable: '+e.message);});}
      return this.drawPack();}
    if(t.dataset.packRemove!=null){const x=p.items.find(i=>i.index===+t.dataset.packRemove);
      if(!confirm(`Remove "${x.name}" from ${p.folder.name}? The audio file stays on this computer; it just leaves this pack.`))return;
      if(this.packPlaying===x.index){this.packAudio?.pause();}
      const files=p.folder.files.filter((_,i)=>i!==x.index);await this.checked(this.app.sb.from('settings').upsert({...p.folder,files}));
      await this.refreshLibrary();this.openPack(p.folder.id);return this.packStatus(`Removed ${x.name} from the pack.`);}
    if(t.dataset.pack==='first'){const max=this.packLanes().length;p.checked=new Set(p.items.slice(0,max).map(x=>x.index));return this.drawPack();}
    if(t.dataset.pack==='none'){p.checked.clear();return this.drawPack();}
    if(t.dataset.pack==='load')return this.loadPack();}
  async loadPack(){const p=this.pack,lanes=this.packLanes(),chosen=p.items.filter(x=>p.checked.has(x.index));
    if(!chosen.length)throw Error('Tick at least one sound to load.');if(chosen.length>lanes.length)throw Error(`Only ${lanes.length} pads are available; untick ${chosen.length-lanes.length}.`);
    this.packAudio?.pause();this.stop();const before=this.history.length;this.quietAssign=true;let done=0;
    try{for(const [n,x] of chosen.entries()){this.packStatus(`Loading ${n+1} of ${chosen.length}: ${x.name}…`);const {index,...raw}=x;await this.assign(lanes[n],raw);done++;}}
    finally{this.quietAssign=false;this.history.splice(before+1);}// one Undo puts every pad back
    if(this.project.mode!=='pads'){this.project.mode='pads';}this.selected=lanes[0];this.ui.bank=0;this.changed();this.draw();
    const used=lanes.slice(0,done);this.packStatus(`Loaded ${done} sound${done>1?'s':''} onto Pads ${used.map(i=>i+1).join(', ')}. Keys play pads 1–16 too. Undo (↶) puts the old pads back.`);this.drawPack();
    this.message(`Loaded ${done} sounds from ${p.folder.name} onto the Oxygen.`);}
  drawPack(){const d=document.getElementById('sp-pack'),p=this.pack;if(!d||!p)return;const lanes=this.packLanes(),max=lanes.length,count=p.checked.size,full=count>=max;
    const rows=p.items.map(x=>{const on=p.checked.has(x.index),lane=on?lanes[p.items.filter(y=>p.checked.has(y.index)).indexOf(x)]:null,playing=this.packPlaying===x.index;
      return `<div class="sp-pack-row${on?' on':''}"><label><input type="checkbox" data-pack-check="${x.index}" ${on?'checked':''} ${!on&&full?'disabled':''} aria-label="Load ${this.esc(x.name)} onto a pad"></label><button data-pack-play="${x.index}" aria-label="${playing?'Stop':'Play'} ${this.esc(x.name)}">${playing?'■':'▶'}</button><span><b>${this.esc(x.name)}</b><small>${x.sample?'Hit / phrase':'Full stem (lands as 4 bars)'}${x.duration?' · '+Number(x.duration).toFixed(1)+' s':''}${lane!=null&&lane!==undefined?' → Pad '+(lane+1):''}</small></span><button data-pack-remove="${x.index}" aria-label="Remove ${this.esc(x.name)} from the pack">🗑</button></div>`;}).join('');
    d.innerHTML=`<header><strong>🎹 Load onto Oxygen</strong><span>${this.esc(p.folder.name)}</span><button data-pack="close" aria-label="Close">×</button></header>
    <p class="sp-clip-help">▶ previews a sound (■ stops it). Tick the sounds you want, up to ${max} (one per pad), then load them. ${p.emptyOnly?'Only empty pads are used.':'Pads fill from Pad 1; loaded pads are replaced and Undo puts them back.'}</p>
    <div class="sp-clip-save"><strong data-pack-count class="${full?'full':''}">${count} of ${max} pads</strong><button data-pack="first">Tick first ${max}</button><button data-pack="none">Untick all</button><label><input type="checkbox" data-pack-empty ${p.emptyOnly?'checked':''}> Only fill empty pads</label></div>
    <div class="sp-pack-list">${rows||'<p>This pack has no sounds.</p>'}</div>
    <div class="sp-clip-save"><button data-pack="load" class="primary" ${count?'':'disabled'}>Load ${count} onto the Oxygen</button></div>
    <p data-pack-status role="status" class="${p.error?'error':''}">${this.esc(p.status||'')}</p>`;}
  // CHOP → PAD. The sound opens as a zoomable waveform track. Drag across it (or tap words) to highlight
  // a piece, listen, then tap or drop it on a pad. Words come from Whisper on this computer, once per
  // sound (cached in data/transcripts), only when Load words is requested.
  async transcript(item){this.transcripts=this.transcripts||new Map();if(this.transcripts.has(item.url))return this.transcripts.get(item.url);
    const words=(await this.lyricRequest('/api/transcript',{url:item.url})).words;this.transcripts.set(item.url,words);return words;}
  async lyricRequest(path,body){const response=await fetch(path,{method:'POST',headers:{'X-ScrewShop':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
    if(response.status===404)throw Error('This ScrewShop server is out of date. Close it and run Restart ScrewShop.cmd, then try again.');
    const result=await response.json().catch(()=>({error:{message:'The computer did not answer. Make sure ScrewShop is running, then try again.'}}));
    if(result.error)throw Error(result.error.message);return result.data;}
  nextEmptyPad(from=0){for(let i=0;i<16;i++){const lane=(Math.max(0,from)+i)%16;if(!this.slots[lane])return lane;}return Math.min(15,Math.max(0,from));}
  async openClip(source){
    source=source||this.slots[this.selected]||this.pendingSound;
    if(!source?.url)throw Error('Pick a sound first: select a pad with a song or vocal on it, or press ✂ beside a sound in the library.');
    const item={name:source.name,url:source.url,bucket:source.bucket,storage_path:source.storage_path,type:source.type,pitch:source.pitch||0,volume:source.volume??1};
    this.pendingSound=null;// otherwise the next pad hit would load that sound instead of playing the chop
    let dialog=document.getElementById('sp-clip');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='sp-clip';dialog.className='sp-clip';dialog.setAttribute('aria-label','Chop to a pad');document.body.append(dialog);
      dialog.onclose=()=>{if(dialog.open)return;this.stopClipPreview();clearInterval(this.clipTimer);if(this.clip)this.clip.closed=true;};
      dialog.onclick=e=>{const t=e.target.closest('button');if(t)this.clipRun(()=>this.clipAction(t,e));};
      dialog.oninput=e=>{if(e.target.matches('[data-clip-find]')&&this.clip)this.clip.find=e.target.value;};
      dialog.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&e.target.matches('[data-clip-find]')){e.preventDefault();this.clipRun(()=>this.findClip(false));}};
      dialog.ondragstart=e=>{if(e.target.closest('[data-clip-chip]')){e.dataTransfer.setData('text/plain','chop');e.dataTransfer.effectAllowed='copy';}};
      dialog.ondragover=e=>{const pad=e.target.closest('[data-clip-pad]');if(pad){e.preventDefault();pad.classList.add('drop-hover');}};
      dialog.ondragleave=e=>e.target.closest('[data-clip-pad]')?.classList.remove('drop-hover');
      dialog.ondrop=e=>{const pad=e.target.closest('[data-clip-pad]');if(!pad)return;e.preventDefault();this.clipRun(()=>this.saveClip(+pad.dataset.clipPad));};}
    const fromPad=this.slots.indexOf(source);
    this.clip={item,words:null,a:-1,b:-1,anchor:null,has:false,start:0,end:0,zoom:0,target:this.nextEmptyPad(fromPad>=0&&fromPad<16?fromPad+1:this.selected<16?this.selected:0),saved:null,find:this.clip?.item.url===item.url?this.clip.find:''};
    const clip=this.clip;clip.status='Loading the waveform…';this.drawClip();if(!dialog.open)dialog.showModal();
    try{await this.decode(item);}catch(e){if(this.clip===clip){clip.words=[];this.clipStatus('Could not load this sound: '+e.message,true);}throw e;}
    if(this.clip!==clip||clip.closed)return;
    clip.words=this.transcripts?.get(item.url)??null;
    this.clipStatus('Drag across the waveform to highlight a piece, listen, then tap a pad to save it. Load words only if you want to chop by lyrics.');this.drawClip();
  }
  async loadClipWords(){const clip=this.clip;if(!clip||clip.loadingWords||clip.closed)return;
    clip.loadingWords=true;const began=Date.now();this.drawClip();
    this.clipStatus('Listening for words on this computer. You can keep chopping the waveform.');
    const timer=setInterval(()=>{const p=document.querySelector('#sp-clip .sp-clip-words p');if(this.clip!==clip||clip.closed)return clearInterval(timer);if(p)p.textContent=`Listening for words... ${Math.round((Date.now()-began)/1000)} s. You can keep using the waveform.`;},1000);this.clipTimer=timer;
    try{const words=await this.transcript(clip.item);if(this.clip!==clip||clip.closed)return;clip.words=words;if(clip.has)this.wordsInClip();
      this.clipStatus(words.length?'Words ready. Tap the first and last word, or keep using the waveform.':'No words were heard. You can still highlight on the waveform.');}
    catch(e){if(this.clip===clip&&!clip.closed)this.clipStatus('Words unavailable ('+e.message+'). You can still highlight on the waveform.',true);}
    finally{clearInterval(timer);clip.loadingWords=false;if(this.clip===clip&&!clip.closed)this.drawClip();}
  }
  // Problems inside the chop window are shown in the window, not in the status bar hidden behind it.
  clipRun(fn){Promise.resolve().then(fn).catch(e=>this.clipStatus(e.message,true));}
  clipStatus(text,error=false){if(this.clip){this.clip.status=text;this.clip.error=error;}const el=document.querySelector('#sp-clip [data-clip-status]');if(el){el.textContent=text;el.classList.toggle('error',error);}}
  clipDuration(){return this.buffers.get(this.clip.item.url)?.duration||0;}
  // Word edges: a little before the first word and a little after the last, never into the neighbouring words.
  setClipRange(a,b){const c=this.clip,w=c.words,duration=this.clipDuration()||Infinity;c.a=a;c.b=b;c.has=true;
    c.start=Math.max(0,Math.min(w[a].start,Math.max(w[a].start-.04,a>0?w[a-1].end:0)));
    c.end=Math.min(duration,Math.max(w[b].end,Math.min(w[b].end+.12,b+1<w.length?w[b+1].start:Infinity)));}
  // A highlight drawn on the waveform lights up the words it covers (mostly).
  wordsInClip(){const c=this.clip,w=c.words||[];let a=-1,b=-1;w.forEach((x,i)=>{const mid=(x.start+x.end)/2;if(mid>=c.start&&mid<=c.end){if(a<0)a=i;b=i;}});c.a=a;c.b=b;}
  clipText(){const c=this.clip;if(c.a>=0)return c.words.slice(c.a,c.b+1).map(x=>x.word).join(' ').replace(/\s+/g,' ').trim();return c.item.name.replace(/\.[a-z0-9]+$/i,'')+' @ '+c.start.toFixed(2)+' s';}
  async clipAction(t,e){const c=this.clip;if(!c)return;
    if(t.dataset.word!=null){if(!c.words?.length)return;const i=+t.dataset.word;
      if(e.shiftKey&&c.a>=0){this.setClipRange(Math.min(c.a,i),Math.max(c.b,i));c.anchor=null;}
      else if(c.anchor==null){this.setClipRange(i,i);c.anchor=i;}
      else{this.setClipRange(Math.min(c.anchor,i),Math.max(c.anchor,i));c.anchor=null;}
      this.clipStatus(c.anchor!=null?`First word: "${c.words[i].word}". Now tap the last word (or use just this word).`:`Highlighted "${this.clipText()}". Tap a pad to drop it there.`);
      this.showSelection();this.drawClip();if(c.anchor==null)await this.playClip();return;}
    if(t.dataset.clipPad!=null)return this.saveClip(+t.dataset.clipPad);
    const a=t.dataset.clip;
    if(a==='close')return document.getElementById('sp-clip')?.close();
    if(a==='words')return this.loadClipWords();
    if(a==='play')return this.playClip();
    if(a==='stop')return this.stopClipPreview();
    if(a==='zoom-in'||a==='zoom-out')return this.zoomClip((c.zoom||this.fitZoom())*(a==='zoom-in'?2:.5));
    if(a==='fit')return this.zoomClip(0);
    if(a==='zoom-sel'){if(!c.has)throw Error('Highlight a piece first.');const box=this.waveBox();this.zoomClip(box.clientWidth/Math.max(.05,(c.end-c.start)*1.3));return this.showSelection(true);}
    if(t.dataset.nudge){if(!c.has)return;const [edge,dir]=t.dataset.nudge.split(':');
      if(edge==='start')c.start=clamp(c.start+dir*.03,0,c.end-.05);else c.end=clamp(c.end+dir*.03,c.start+.05,this.clipDuration());this.wordsInClip();this.drawClip();return this.playClip();}
    if(a==='find'||a==='next')return this.findClip(a==='next');
    if(a==='save')return this.saveClip(c.target);
    if(a==='lines')return this.clipLines();
    if(a==='undo'){await this.undo();c.target=this.nextEmptyPad(c.saved??0);this.drawClip();return this.clipStatus('Undone.');}
    if(a==='test'&&c.saved!=null){await this.press(c.saved,60,110,'clip-test');setTimeout(()=>this.releaseToken('clip-test'),50);}
  }
  async findClip(next){const c=this.clip;if(!c?.words?.length)throw Error('Wait for the words to load first.');const text=(c.find||'').trim();if(!text)throw Error('Type some of the words you want, then press Find.');
    if(!next||c.findKey!==text){c.matches=c.findKey=null;this.drawClip();c.matches=(await this.lyricRequest('/api/lyrics',{url:c.item.url,text})).matches;c.findKey=text;c.match=0;}else c.match=(c.match+1)%c.matches.length;
    const m=c.matches[c.match],a=c.words.findIndex(w=>w.start===m.start),b=c.words.findLastIndex(w=>w.end===m.end);if(a<0||b<a)throw Error('Could not line up that match. Tap the words instead.');
    this.setClipRange(a,b);c.anchor=null;this.clipStatus(`Found "${m.heard}" (match ${c.match+1} of ${c.matches.length}). Tap a pad to drop it there.`);this.showSelection(true);this.drawClip(true);await this.playClip();}
  clipSlot(start,end,name,lyric){const c=this.clip,duration=this.clipDuration();start=clamp(start,0,duration-.01);
    return {name,lyric,url:c.item.url,bucket:c.item.bucket,storage_path:c.item.storage_path,type:c.item.type,start,end:clamp(end,start+.01,duration),volume:c.item.volume??1,pan:0,pitch:c.item.pitch||0,gate:false,loop:false,attack:.005,release:.03,choke:0,mono:true};}
  clipName(text){const words=text.split(' ');return words.length>5?words.slice(0,5).join(' ')+'…':text;}
  async saveClip(lane){const c=this.clip;if(!c.has)throw Error('Highlight a piece first: drag across the waveform or tap the words.');lane=clamp(Math.round(lane),0,15);
    const text=this.clipText(),replaced=this.slots[lane]?.name;
    this.checkpoint();this.panic();this.slots[lane]=this.clipSlot(c.start,c.end,this.clipName(text),c.a>=0?text:null);await this.prepareSlot(this.slots[lane]);
    this.selected=lane;this.ui.bank=lane<8?0:1;this.changed();this.draw();c.saved=lane;c.target=this.nextEmptyPad(lane+1);
    this.clipStatus(`${replaced?'Replaced '+replaced+' on':'Saved "'+text+'" to'} Pad ${lane+1}. Hit the pad to hear it${replaced?' (↶ Undo puts it back)':''}, or highlight the next piece.`);this.drawClip();await this.saving?.catch(()=>{});}
  // Typed several lines? Put each line on its own pad, in order, starting at the next empty pad.
  async clipLines(){const c=this.clip;if(!c.matches?.length)throw Error('Type the lines and press Find first.');const m=c.matches[c.match],first=c.target;
    if(first+m.lines.length>16)throw Error(`That is ${m.lines.length} lines; there are not enough pads after Pad ${first+1}.`);this.checkpoint();this.panic();
    m.lines.forEach((line,i)=>{const a=c.words.findIndex(w=>w.start===line.start),b=c.words.findLastIndex(w=>w.end===line.end);
      if(a>=0&&b>=a)this.setClipRange(a,b);else{c.start=line.start;c.end=line.end;}this.slots[first+i]=this.clipSlot(c.start,c.end,this.clipName(line.heard),line.heard);});
    for(let i=0;i<m.lines.length;i++)await this.prepareSlot(this.slots[first+i]);
    this.selected=first;this.ui.bank=first<8?0:1;this.changed();this.draw();c.saved=first;c.target=this.nextEmptyPad(first+m.lines.length);
    this.clipStatus(`Put ${m.lines.length} line${m.lines.length>1?'s':''} on Pads ${first+1}–${first+m.lines.length}.`);this.drawClip();await this.saving?.catch(()=>{});}
  stopClipPreview(){try{this.clipVoice?.stop();}catch(_){}this.clipVoice=null;this.clipPlayhead=null;}
  // Plays the highlight (or `from`..`to` when scrubbing). The moving line on the waveform shows where it is.
  async playClip(from,to){const c=this.clip;if(!c)return;if(from==null){if(!c.has)return;from=c.start;to=c.end;}
    const buffer=await this.decode(c.item),ctx=this.context();await ctx.resume();this.stopClipPreview();
    const src=ctx.createBufferSource(),gain=ctx.createGain(),rate=2**((c.item.pitch||0)/12),length=(to-from)/rate,now=ctx.currentTime,level=c.item.volume??1;src.buffer=buffer;src.playbackRate.value=rate;
    gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(level,now+.005);gain.gain.setValueAtTime(level,now+Math.max(.006,length-.03));gain.gain.linearRampToValueAtTime(0,now+length);
    src.connect(gain);gain.connect(this.bus);src.start(now,from,to-from);this.clipVoice=src;this.clipPlays=(this.clipPlays||0)+1;
    const head={from,rate,began:now,end:now+length};this.clipPlayhead=head;src.onended=()=>{src.disconnect();gain.disconnect();if(this.clipPlayhead===head)this.clipPlayhead=null;this.drawWave();};
    const frame=()=>{if(this.clipPlayhead!==head)return;this.drawWave();requestAnimationFrame(frame);};requestAnimationFrame(frame);}
  // Waveform track: a scroll box whose spacer is as wide as the sound at the current zoom (px per second).
  waveBox(){return document.querySelector('#sp-clip .sp-wave-scroll');}
  fitZoom(){const box=this.waveBox();return Math.max(1,(box?.clientWidth||600)/Math.max(.1,this.clipDuration()));}
  zoomClip(zoom,anchorX=null){const c=this.clip,box=this.waveBox();if(!box)return;const fit=this.fitZoom(),old=c.zoom||fit;
    const x=anchorX??box.clientWidth/2,time=(box.scrollLeft+x)/old;c.zoom=clamp(zoom||fit,fit,8000);if(c.zoom<=fit*1.0001)c.zoom=0;
    const now=c.zoom||fit;box.querySelector('.sp-wave-space').style.width=Math.ceil(this.clipDuration()*now)+'px';box.scrollLeft=time*now-x;this.drawWave();
    const label=document.querySelector('#sp-clip [data-zoom-label]');if(label)label.textContent=this.zoomText();}
  zoomText(){const z=this.clip.zoom||this.fitZoom();return z>=1000?(z/1000).toFixed(1)+'k px/s':Math.round(z)+' px/s';}
  showSelection(center=false){const c=this.clip,box=this.waveBox();if(!box||!c.has)return;const z=c.zoom||this.fitZoom(),a=c.start*z,b=c.end*z;
    if(center||a<box.scrollLeft||b>box.scrollLeft+box.clientWidth)box.scrollLeft=(a+b)/2-box.clientWidth/2;this.drawWave();}
  // Min/max peaks per 256 samples, built once per sound, so drawing a whole song stays quick.
  wavePeaks(buffer){this.peakCache=this.peakCache||new WeakMap();let p=this.peakCache.get(buffer);if(p)return p;
    const chans=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i)),n=Math.ceil(buffer.length/256),min=new Float32Array(n),max=new Float32Array(n);
    for(let k=0;k<n;k++){let lo=0,hi=0;const end=Math.min(buffer.length,(k+1)*256);for(const d of chans)for(let i=k*256;i<end;i++){const v=d[i];if(v<lo)lo=v;else if(v>hi)hi=v;}min[k]=lo;max[k]=hi;}
    p={min,max};this.peakCache.set(buffer,p);return p;}
  drawWave(){const c=this.clip,box=this.waveBox(),canvas=box?.querySelector('canvas'),buffer=c&&this.buffers.get(c.item.url);if(!canvas||!buffer||!document.getElementById('sp-clip')?.open||!box.clientWidth)return;
    const dpr=window.devicePixelRatio||1,W=box.clientWidth,H=canvas.clientHeight||120;if(canvas.width!==Math.round(W*dpr)||canvas.height!==Math.round(H*dpr)){canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);}canvas.style.width=W+'px';
    const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const z=c.zoom||this.fitZoom(),left=box.scrollLeft,t=x=>(left+x)/z,X=time=>time*z-left,sr=buffer.sampleRate,top=16,mid=top+(H-top-16)/2,amp=(H-top-16)/2;
    g.fillStyle='#120c19';g.fillRect(0,0,W,H);
    // Ruler: a tick every "nice" step for the zoom.
    const step=[.01,.02,.05,.1,.2,.5,1,2,5,10,15,30,60].find(s=>s*z>=70)||120;g.fillStyle='#1d1428';g.fillRect(0,0,W,top);g.font='10px system-ui';g.fillStyle='#a993c4';g.strokeStyle='#3a2a4f';g.beginPath();
    for(let s=Math.floor(t(0)/step)*step;s<=t(W);s+=step){const x=Math.round(X(s))+.5;g.moveTo(x,top-5);g.lineTo(x,H);const m=Math.floor(s/60),sec=s-m*60;g.fillText((m?m+':'+(sec<10?'0':''):'')+sec.toFixed(step<.1?2:step<1?1:0),x+3,11);}g.stroke();
    if(c.has){g.fillStyle='#b784ff40';g.fillRect(X(c.start),top,(c.end-c.start)*z,H-top);}
    const peaks=this.wavePeaks(buffer),spp=sr/z,chans=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));g.strokeStyle='#c9a4ff';g.beginPath();
    for(let x=0;x<W;x++){const i0=Math.floor(t(x)*sr),i1=Math.max(i0+1,Math.floor(t(x+1)*sr));if(i0>=buffer.length)break;if(i1<=0)continue;let lo=0,hi=0;
      if(spp>=256){for(let k=Math.max(0,Math.floor(i0/256)),e=Math.min(peaks.min.length,Math.ceil(i1/256));k<e;k++){if(peaks.min[k]<lo)lo=peaks.min[k];if(peaks.max[k]>hi)hi=peaks.max[k];}}
      else for(const d of chans)for(let i=Math.max(0,i0),e=Math.min(buffer.length,i1);i<e;i++){const v=d[i];if(v<lo)lo=v;else if(v>hi)hi=v;}
      g.moveTo(x+.5,mid-hi*amp);g.lineTo(x+.5,mid-lo*amp+1);}g.stroke();
    if(c.has){g.fillStyle='#ffe066';for(const e of [c.start,c.end]){const x=X(e);g.fillRect(x-1,top,2,H-top);g.fillRect(x-4,top,8,6);}}
    // Words under the waveform, where they are heard.
    if(c.words?.length){g.font='11px system-ui';let lastX=-1e9;for(const [i,w] of c.words.entries()){const x=X(w.start);if(x>W)break;if(X(w.end)<0||x<lastX+4)continue;
      g.fillStyle=i>=c.a&&i<=c.b?'#ffe066':'#cbb7e6';g.fillText(w.word.trim(),Math.max(0,x),H-4);lastX=x+g.measureText(w.word.trim()).width;}}
    const head=this.clipPlayhead;if(head){const now=this.context().currentTime;if(now<=head.end){g.fillStyle='#fff';g.fillRect(X(head.from+(now-head.began)*head.rate)-1,top,2,H-top);}}}
  wireWave(){const c=this.clip,box=this.waveBox();if(!box)return;const canvas=box.querySelector('canvas'),z=()=>c.zoom||this.fitZoom(),time=e=>clamp((box.scrollLeft+e.clientX-box.getBoundingClientRect().left)/z(),0,this.clipDuration());
    box.querySelector('.sp-wave-space').style.width=Math.ceil(this.clipDuration()*z())+'px';
    box.onscroll=()=>{if(!this.waveFrame)this.waveFrame=requestAnimationFrame(()=>{this.waveFrame=null;this.drawWave();});};
    box.onwheel=e=>{if(!(e.ctrlKey||e.metaKey||e.shiftKey))return;const delta=e.deltaY||e.deltaX;if(!delta)return;e.preventDefault();this.zoomClip(z()*Math.pow(1.0025,-clamp(delta,-120,120)),e.clientX-box.getBoundingClientRect().left);};
    canvas.onpointerdown=e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);const t0=time(e),near=x=>c.has&&Math.abs((x-t0)*z())<=8;
      const drag={mode:near(c.start)?'start':near(c.end)?'end':'new',t0,x0:e.clientX,moved:false};
      canvas.onpointermove=m=>{if(!drag.moved&&Math.abs(m.clientX-drag.x0)<4)return;drag.moved=true;const t1=time(m);
        if(drag.mode==='start')c.start=Math.min(t1,c.end-.02);else if(drag.mode==='end')c.end=Math.max(t1,c.start+.02);else{c.start=Math.min(drag.t0,t1);c.end=Math.max(drag.t0,t1);c.has=true;}
        c.anchor=null;this.wordsInClip();this.drawWave();};
      canvas.onpointerup=canvas.onpointercancel=()=>{canvas.onpointermove=canvas.onpointerup=canvas.onpointercancel=null;
        if(drag.moved){if(c.end-c.start<.02){c.has=false;this.drawClip();return;}this.clipStatus(`Highlighted ${(c.end-c.start).toFixed(2)} s${c.a>=0?': "'+this.clipText()+'"':''}. Tap a pad to drop it there, or drag the yellow edges.`);this.drawClip();this.clipRun(()=>this.playClip());}
        else this.clipRun(()=>this.playClip(t0,Math.min(this.clipDuration(),t0+3)));};};
    canvas.ondblclick=()=>{if(c.has)this.clipRun(()=>this.playClip());};}
  drawClip(scroll=false){const d=document.getElementById('sp-clip'),c=this.clip;if(!d||!c)return;const w=c.words,list=d.querySelector('.sp-clip-words'),top=list?.scrollTop||0,oldBox=this.waveBox(),scrollLeft=oldBox?.scrollLeft||0,picked=c.has,ready=!!this.buffers.get(c.item.url);
    const words=w?w.map((x,i)=>`${i&&x.start-w[i-1].end>.7?'<br>':''}<button data-word="${i}" class="${i>=c.a&&i<=c.b?'on':''}${i===c.anchor?' anchor':''}" title="${x.start.toFixed(2)} s">${this.esc(x.word)}</button>`).join(''):'';
    const pads=Array.from({length:16},(_,i)=>`<button data-clip-pad="${i}" class="${this.slots[i]?'full':''}${i===c.target?' next':''}${i===c.saved?' saved':''}" title="${this.esc(this.where(i))}"><b>${i+1}</b><span>${this.esc(this.slots[i]?.name||'empty')}</span></button>`).join('');
    const lines=(c.findKey||'').includes('\n')&&c.matches?.length,length=((c.end-c.start)/2**((c.item.pitch||0)/12)).toFixed(2);
    d.innerHTML=`<header><strong>✂ Chop → pad</strong><span>${this.esc(c.item.name)}</span><button data-clip="close" aria-label="Close">×</button></header>
    <p class="sp-clip-help"><b>1.</b> Drag across the waveform to highlight a piece (or tap words below). <b>2.</b> Listen; drag the yellow edges to fine-tune. <b>3.</b> Tap a pad, or drag the highlight onto one. Zoom with the buttons or Ctrl/Shift + mouse wheel.</p>
    <div class="sp-wave-tools"><button data-clip="zoom-out" aria-label="Zoom out" ${ready?'':'disabled'}>−</button><button data-clip="zoom-in" aria-label="Zoom in" ${ready?'':'disabled'}>+</button><button data-clip="fit" ${ready?'':'disabled'}>Fit</button><button data-clip="zoom-sel" ${picked?'':'disabled'}>Zoom to highlight</button><small data-zoom-label></small><span></span><button data-clip="play" ${picked?'':'disabled'}>▶ Hear highlight</button><button data-clip="stop" aria-label="Stop preview">■</button></div>
    <div class="sp-wave-scroll" aria-label="Waveform: drag to highlight, click to listen from there"><canvas></canvas><div class="sp-wave-space"></div></div>
    <div class="sp-clip-edit"><span>Start</span><button data-nudge="start:-1" ${picked?'':'disabled'} aria-label="Start earlier">◀</button><output>${picked?c.start.toFixed(2):'–'} s</output><button data-nudge="start:1" ${picked?'':'disabled'} aria-label="Start later">▶</button>
      <span>End</span><button data-nudge="end:-1" ${picked?'':'disabled'} aria-label="End earlier">◀</button><output>${picked?c.end.toFixed(2):'–'} s</output><button data-nudge="end:1" ${picked?'':'disabled'} aria-label="End later">▶</button>
      ${picked?`<div data-clip-chip draggable="true" title="Drag onto a pad">⠿ "${this.esc(this.clipName(this.clipText()))}" · ${length} s</div>`:''}</div>
    <div class="sp-clip-pads" role="group" aria-label="Pads: tap or drop to save the highlight">${pads}</div>
    <div class="sp-clip-save"><button data-clip="save" class="primary" ${picked?'':'disabled'}>Save to next empty: Pad ${c.target+1}</button>${c.saved!=null?`<button data-clip="test">▶ Hit Pad ${c.saved+1}</button><button data-clip="undo">↶ Undo</button>`:''}</div>
    <p data-clip-status role="status" class="${c.error?'error':''}">${this.esc(c.status||'')}</p>
    <details class="sp-clip-wordbox" open><summary>Words heard (tap the first and last word)</summary>
    <div class="sp-clip-find"><textarea data-clip-find rows="1" aria-label="Type words to find" placeholder="Or type some of the words and press Find">${this.esc(c.find||'')}</textarea><button data-clip="find">Find</button><button data-clip="next" ${c.matches?.length>1?'':'disabled'}>Next match</button>${lines?'<button data-clip="lines">Each typed line → its own pad</button>':''}</div>
    <div class="sp-clip-words" role="group" aria-label="Words heard in this sound">${w?words||'<p>No words heard.</p>':`<p>${c.loadingWords?'Listening for words… You can keep using the waveform.':'Word recognition is optional and may take a few minutes.'}</p><button data-clip="words" ${c.loadingWords?'disabled':''}>${c.loadingWords?'Loading words…':'Load words'}</button>`}</div></details>`;
    if(ready){this.wireWave();const box=this.waveBox();box.scrollLeft=scrollLeft;const label=d.querySelector('[data-zoom-label]');if(label)label.textContent=this.zoomText();requestAnimationFrame(()=>this.drawWave());}
    const next=d.querySelector('.sp-clip-words');if(scroll)next.querySelector('.on')?.scrollIntoView({block:'nearest'});else next.scrollTop=top;}
  slice(){const s=this.slots[this.selected];if(!s)throw Error('Select a sound to slice.');const value=this.host.querySelector('[data-slice-points]').value;const points=value.split(',').map(x=>Number(x.trim())).filter(x=>Number.isFinite(x)&&x>s.start&&x<s.end);const cuts=[s.start,...new Set(points.sort((a,b)=>a-b)),s.end];if(cuts.length<3)throw Error('Enter one or more slice points inside the trim range.');if(cuts.length>17)throw Error('Use at most 15 slice points for 16 pads.');this.checkpoint();for(let i=0;i<cuts.length-1;i++)this.slots[i]={...clone(s),name:s.name+' chop '+(i+1),start:cuts[i],end:cuts[i+1],gate:false};this.changed();this.draw();}
  drawSequence(){const host=this.host?.querySelector('.sp-sequence-inner');if(!host)return;const b=(...a)=>this.button(...a),p=this.project,pattern=this.pattern;
    const count=Math.min(this.ui.steps,pattern.beats*p.grid-this.ui.page*this.ui.steps),offset=this.ui.page*this.ui.steps;
    const lanes=this.ui.roll?Array.from({length:25},(_,i)=>({lane:+p.mode>=16?+p.mode:16,note:p.octave*12+24-i})):Array.from({length:18},(_,lane)=>({lane,note:lane>=16?(this.slots[lane]?.root??p.root):60}));
    host.innerHTML=`<div class="sp-actions sp-seq-toolbar">${b('sequence',this.ui.sequence?'▾':'▸','Toggle sequencer')}<select data-pattern aria-label="Pattern">${p.patterns.map((x,i)=>`<option value="${i}" ${i===p.pattern?'selected':''}>${this.esc(x.name)}</option>`).join('')}</select>${b('add-pattern','+','Add pattern')}${b('duplicate-pattern','Duplicate')}${b('rename-pattern','Rename')}${b('delete-pattern','Delete')}<label>Beats<input data-length type="number" min="1" max="64" value="${pattern.beats}"></label>${b('roll',this.ui.roll?'Drum steps':'Piano roll')}<label>View<select data-steps>${[16,32,64].map(n=>`<option ${n===this.ui.steps?'selected':''}>${n}</option>`).join('')}</select></label>${b('previous','‹','Previous steps')}<span>${offset+1}–${offset+count}</span>${b('next','›','Next steps')}</div>${this.ui.sequence?`<div class="sp-actions"><label>Grid<select data-project="grid">${[1,2,4,8].map(n=>`<option value="${n}" ${n===p.grid?'selected':''}>1/${n*4}</option>`).join('')}</select></label><label>Swing<input data-project="swing" type="number" min="0" max="75" value="${p.swing}"></label><label><input data-project="quantize" type="checkbox" ${p.quantize?'checked':''}>Quantize</label><label><input data-project="overdub" type="checkbox" ${p.overdub?'checked':''}>Overdub</label><label>Velocity<input data-new-velocity type="number" min="1" max="127" value="${this.newVelocity||100}"></label><label>Note beats<input data-new-length type="number" min=".0625" max="64" step=".25" value="${this.newLength||1/p.grid}"></label></div><div class="sp-grid" style="--steps:${count}">${lanes.map(({lane,note})=>{const mix=p.mix[lane];return `<div class="sp-lane"><div class="sp-lane-label"><button data-lane-select="${lane}" class="${!this.ui.roll&&lane===this.selected?'sel':''}">${this.ui.roll?'Note '+note:this.esc(this.slots[lane]?.name||(lane<16?'Pad '+(lane+1):'Instrument '+(lane-15)))}</button>${this.ui.roll?'':`<label title="Mute"><input aria-label="Mute lane ${lane+1}" data-mix="${lane}:mute" type="checkbox" ${mix.mute?'checked':''}>M</label><label title="Solo"><input aria-label="Solo lane ${lane+1}" data-mix="${lane}:solo" type="checkbox" ${mix.solo?'checked':''}>S</label><input aria-label="Lane ${lane+1} volume" data-mix="${lane}:volume" type="range" min="0" max="1" step=".01" value="${mix.volume}">`}</div><div class="sp-cells">${Array.from({length:count},(_,j)=>{const at=(offset+j)/p.grid,e=pattern.events.find(x=>x.lane===lane&&(!this.ui.roll||x.note===note)&&Math.floor(x.at*p.grid)===offset+j),tail=this.ui.roll&&pattern.events.some(x=>x.lane===lane&&x.note===note&&x.at<at&&x.at+x.len>at);return `<button data-cell="${lane}:${note}:${offset+j}" data-step="${offset+j}" class="${e?'on':tail?'tail':''}" aria-label="${this.ui.roll?'Note '+note:'Lane '+(lane+1)} step ${offset+j+1}" aria-pressed="${!!e}" title="Click toggles. Right-click edits velocity and length.">${e?e.velocity:''}</button>`;}).join('')}</div></div>`;}).join('')}</div><div class="sp-event-editor"></div><details ${this.ui.tools?'open':''} class="sp-tools"><summary>Project, transfer & export</summary><div class="sp-actions">${b('export','Export WAV')}${b('update','Update Studio render')}${b('retry','Retry Save')}<label>Transfer<select data-transfer><option value="pattern">Current pattern</option><option value="beat">All patterns in order</option></select></label><label><input data-separate type="checkbox">Separate lanes</label><label>Tempo<select data-tempo-policy><option value="studio">Render at Studio tempo</option><option value="sampler">Use sampler tempo (empty Studio only)</option></select></label><label>Recording offset ms<input data-project="latency" type="number" min="-250" max="250" value="${p.latency}"></label><label>Panel height<input data-height type="range" min="180" max="600" value="${this.ui.height}"></label><label>Learn control<select data-learn-action><option value="">Choose…</option>${['play','stop','record','master'].map(v=>`<option>${v}</option>`).join('')}</select></label></div><p>Studio receives WAV clips. Patterns remain editable here. Update replaces audio only on matching sampler clips and preserves their placement and lengths. WAV keeps high-quality audio; MP3 sharing is available when this computer has an encoder.</p></details>`:''}`;
    host.querySelectorAll('[data-cell]').forEach(el=>{el.onclick=()=>{if(this.editNotes)return el.oncontextmenu({preventDefault(){}});this.checkpoint();const [lane,note,step]=el.dataset.cell.split(':').map(Number);const index=pattern.events.findIndex(x=>x.lane===lane&&(!this.ui.roll||x.note===note)&&Math.floor(x.at*p.grid)===step);if(index>=0)pattern.events.splice(index,1);else pattern.events.push({id:uid(),lane,note,at:step/p.grid,len:clamp(host.querySelector('[data-new-length]').value,1/64,64),velocity:clamp(host.querySelector('[data-new-velocity]').value,1,127)});this.newLength=+host.querySelector('[data-new-length]').value;this.newVelocity=+host.querySelector('[data-new-velocity]').value;this.changed();this.drawSequence();};
      el.oncontextmenu=e=>{e.preventDefault();const [lane,note,step]=el.dataset.cell.split(':').map(Number),event=pattern.events.find(x=>x.lane===lane&&(!this.ui.roll||x.note===note)&&Math.floor(x.at*p.grid)===step);if(!event)return;this.editEvent=event.id;host.querySelector('.sp-event-editor').innerHTML=`<label>Event velocity<input data-event="velocity" type="number" min="1" max="127" value="${event.velocity}"></label><label>Length in beats<input data-event="len" type="number" min=".015625" max="64" step=".25" value="${event.len}"></label>`;};});
    host.querySelectorAll('[data-lane-select]').forEach(el=>el.onclick=()=>{this.selected=+el.dataset.laneSelect;this.drawEditor();this.flashLane(this.selected,true);});
    const edit=document.createElement('button');edit.dataset.action='edit-events';edit.textContent=this.editNotes?'Editing notes':'Edit notes';edit.title='Enable, then tap a note to edit velocity and length';host.querySelector('.sp-seq-toolbar').appendChild(edit);
    if(this.mp3Available)host.querySelector('.sp-tools .sp-actions')?.insertAdjacentHTML('afterbegin',b('export-mp3','Export MP3'));
    host.querySelector('.sp-tools .sp-actions')?.insertAdjacentHTML('afterbegin',b('new-beat','New Beat'));
    const tools=host.querySelector('.sp-tools');if(tools)tools.ontoggle=()=>{if(this.ui.tools!==tools.open){this.ui.tools=tools.open;this.changed();}};
  }
  async saveNamed(kind){const name=prompt(kind==='kit'?'Kit name':'Beat name',this.project.name);if(!name?.trim())return;
    if(kind==='kit'){const id='sampler-kit-'+uid();this.project.kitId=id;await this.checked(this.app.sb.from('settings').upsert({id,kind:'sampler-kit',name:name.trim(),kit:clone({slots:this.slots,maps:this.project.maps,root:this.project.root,low:this.project.low,high:this.project.high})}));}
    else {this.project.name=name.trim();await this.checked(this.app.sb.from('settings').upsert({id:'sampler-beat-'+this.project.id,kind:'sampler-beat',name:name.trim(),project:this.snapshot(),render:this.lastRender||null}));}
    await this.save();await this.refreshLibrary();this.message('Saved '+kind+' locally.');
  }
  async renderAudio(patterns,bpm,lane=null){if(!await this.prepare())throw Error('Replace missing sounds before rendering.');const beats=patterns.reduce((n,p)=>n+p.beats,0),seconds=beats*60/bpm;
    if(seconds>600)throw Error('Render up to ten minutes at a time.');const ctx=new OfflineAudioContext(2,Math.ceil(seconds*44100),44100),master=ctx.createGain();master.gain.value=this.volume;master.connect(ctx.destination);const voices=new Set();let offset=0;
    for(const p of patterns){for(const e of [...p.events].sort((a,b)=>this.eventTime(a)-this.eventTime(b))){if(e.at>=p.beats||lane!=null&&e.lane!==lane)continue;this.voice(e.lane,e.note,e.velocity,(offset+this.eventTime(e))*60/bpm,ctx,master,e.len*60/bpm,voices);}offset+=p.beats;}
    return ctx.startRendering();
  }
  wav(buffer){const channels=buffer.numberOfChannels,frames=buffer.length,bytes=new ArrayBuffer(44+frames*channels*2),v=new DataView(bytes),str=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
    str(0,'RIFF');v.setUint32(4,bytes.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,buffer.sampleRate,true);v.setUint32(28,buffer.sampleRate*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,frames*channels*2,true);
    const data=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){const x=clamp(data[c][i],-1,1);v.setInt16(44+(i*channels+c)*2,Math.round(x*(x<0?32768:32767)),true);}return new Blob([bytes],{type:'audio/wav'});
  }
  download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  async finishExport(blob,name,format){
    if(format!=='mp3'){this.download(blob,name+'.wav');return;}
    const path='local/sampler/'+uid()+'.wav';await this.checked(this.app.sb.storage.from('beats').upload(path,blob));
    const result=await window.ScrewShop.export({kind:'mp3',storage_path:path,name});if(result.error)throw Error(result.error.message);
    const link=document.createElement('a');link.href=result.data.download_url;link.download=name+'.mp3';link.click();
  }
  async exportBeat(format='wav'){this.message('Rendering '+format.toUpperCase()+'…');const blob=this.wav(await this.renderAudio([this.pattern],this.project.bpm));await this.finishExport(blob,this.project.name,format);this.message(format.toUpperCase()+' exported');}
  async handoff(update,options={}){if(this.transferring)return;const studio=this.app.studio;if(studio.recording||studio.playing)throw Error('Stop Studio playback/recording before transferring.');
    const revision=JSON.stringify(this.snapshot());
    const mode=options.mode||this.host?.querySelector('[data-transfer]')?.value||'pattern',separate=this.host?.querySelector('[data-separate]')?.checked||false,policy=this.host?.querySelector('[data-tempo-policy]')?.value||'studio';
    const patterns=mode==='beat'?this.project.patterns:[this.pattern],key=this.project.id+':'+(mode==='beat'?'all':this.pattern.id),existing=studio.tracks.flatMap(t=>t.clips).filter(c=>c.samplerSource===key);
    if(existing.length&&!update){this.message('Already in Studio. Use Update Studio render to refresh audio without adding tracks.');return;}
    if(update&&!existing.length)throw Error('Send this pattern/beat to Studio first.');
    if(policy==='sampler'&&studio.tracks.some(t=>t.clips.length)&&studio.bpm!==this.project.bpm)throw Error('Studio already has an arrangement. Choose Render at Studio tempo.');
    const bpm=policy==='sampler'?this.project.bpm:studio.bpm;
    if(update&&existing.some(c=>c.samplerBpm!==bpm))throw Error('Tempo changed since transfer. Keep the original Studio tempo for updates, or send a duplicate pattern as a new source.');
    const lanes=update?[...new Set(existing.map(c=>c.samplerLane??null))]:separate?[...new Set(patterns.flatMap(p=>p.events.map(e=>e.lane)))]:[null];if(!lanes.length)throw Error('Add notes before transferring.');
    this.transferring=true;this.message('Rendering lossless WAV at '+bpm+' BPM…');
    try{const rendered=[];for(const lane of lanes){const blob=this.wav(await this.renderAudio(patterns,bpm,lane)),path='local/sampler/'+uid()+'.wav';await this.checked(this.app.sb.storage.from('beats').upload(path,blob));const item={name:this.project.name+' / '+(mode==='beat'?'Beat':this.pattern.name)+(lane!=null?' / '+(this.slots[lane]?.name||'Lane '+lane):''),url:studio.url('beats',path)};await studio.decode(item);rendered.push({lane,item});}
      if(revision!==JSON.stringify(this.snapshot()))throw Error('Sampler changed during rendering. Send again to use the latest version.');
      studio.checkpoint();if(policy==='sampler')studio.bpm=bpm;
      if(update){for(const {lane,item}of rendered)for(const c of existing.filter(c=>(c.samplerLane??null)===lane)){c.url=item.url;c.dur=item.dur;}}
      else {const at=studio.snap(studio.cursor);for(const {lane,item}of rendered){const track=studio.addTrack(item.name,false);track.volume=1;track.clips.push({id:uid(),name:item.name,url:item.url,start:at,length:item.dur,dur:item.dur,samplerSource:key,samplerLane:lane,samplerBpm:bpm});}}
      await studio.save();studio.refresh();this.lastRender=rendered.length===1?rendered[0].item:null;
      await this.checked(this.app.sb.from('settings').upsert({id:'sampler-beat-'+this.project.id,kind:'sampler-beat',name:this.project.name,project:this.snapshot(),render:this.lastRender}));await this.save();this.message((update?'Updated':'Sent')+' at '+bpm+' BPM. Studio clips retain their arrangement; future changes require Update Studio render.');
    }finally{this.transferring=false;}
  }
  async renderStudio({maxBytes=Infinity}={}){
    const studio=this.app.studio;if(!studio?.ready)throw Error('Wait for Studio to finish loading.');
    if(studio.recording||studio.busy)throw Error('Stop recording or loading audio before saving a Studio mix.');
    // Capture the arrangement and audible controls before asynchronous decoding.
    const tracks=clone(studio.tracks),rate=studio.rate,masterLevel=studio.master?.gain.value??1;
    const clips=tracks.flatMap(t=>t.clips);if(!clips.length)throw Error('Studio has no clips to export.');
    if(!Number.isFinite(rate)||rate<=0)throw Error('Choose a valid Studio playback speed.');
    const solo=tracks.some(t=>t.solo),level=t=>t.muted||(solo&&!t.solo)?0:(t.volume??.8);
    const audible=tracks.filter(t=>level(t)>0&&t.clips.length);
    if(!audible.length||masterLevel<=0)throw Error('Studio has no audible clips. Unmute a track or raise its volume before saving.');
    const lengthFor=c=>c.length??studio.buffers.get(c.url)?.duration??c.dur??0;
    const preflight=()=>{
      const seconds=Math.max(...clips.map(c=>c.start+lengthFor(c)))/rate;
      if(seconds>1800)throw Error('Export up to 30 minutes at a time.');
      if(44+Math.ceil(seconds*44100)*4>maxBytes)throw Error('Studio mix exceeds the 300 MB local upload limit. Shorten the arrangement or increase playback speed.');
      return seconds;
    };
    preflight();
    await Promise.all(audible.flatMap(t=>t.clips).map(c=>studio.decode(c)));
    const seconds=preflight();if(!Number.isFinite(seconds)||seconds<=0)throw Error('Studio has no audio duration to export.');
    // Same channel strips and master bus as live playback (mix-engine.js), plus room for reverb/delay tails.
    const tail=4,ctx=new OfflineAudioContext(2,Math.ceil((seconds+tail)*44100),44100),master=ctx.createGain();master.gain.value=masterLevel;master.connect(ctx.destination);
    await window.ScrewMix.ready(ctx);const bus=window.ScrewMix.master(ctx,studio.mixMaster,master,studio.beat()/rate);
    let segments=0;
    for(const track of audible){const strip=window.ScrewMix.track(ctx,track.mix,bus);strip.fader.gain.value=level(track);const gain=strip.input;
      for(const c of track.clips){const buffer=studio.buffers.get(c.url),duration=lengthFor(c),offset=c.sourceOffset||0;
        if(!buffer?.duration||!Number.isFinite(duration)||duration<=0||!Number.isFinite(c.start)||c.start<0||!Number.isFinite(offset)||offset<0)throw Error('Studio contains an invalid clip. Check its position and trim.');
        let at=0;while(at<duration-.00001){
          if(++segments>100000)throw Error('This arrangement repeats too many short clips. Render a smaller section.');
          const start=(offset+at)%buffer.duration,n=Math.min(duration-at,buffer.duration-start);
          const source=ctx.createBufferSource();source.buffer=buffer;source.playbackRate.value=rate;source.connect(gain);source.start((c.start+at)/rate,start,n);at+=n;
        }
      }
    }
    const full=await ctx.startRendering();
    // Remove the compressor look-ahead at the start, and keep effect tails only while they are audible.
    const skip=Math.round(window.ScrewMix.LATENCY*44100),minEnd=Math.ceil(seconds*44100);let end=full.length;
    const chans=[...Array(full.numberOfChannels)].map((_,c)=>full.getChannelData(c));
    // Exact arrangement length unless reverb/delay is in use; then keep the tail until it falls below -80 dB.
    const tails=audible.some(t=>{const m=window.ScrewMix.trackSettings(t.mix);return m.reverb>0||m.delay>0;});
    if(!tails)end=Math.min(end,minEnd+skip);else while(end>minEnd+skip&&chans.every(d=>Math.abs(d[end-1])<1e-4))end--;
    const rendered=new AudioBuffer({numberOfChannels:full.numberOfChannels,length:Math.max(1,end-skip),sampleRate:44100});
    chans.forEach((d,c)=>rendered.copyToChannel(d.subarray(skip,end),c));
    let peak=0;
    for(let channel=0;channel<rendered.numberOfChannels;channel++){
      const samples=rendered.getChannelData(channel);for(let i=0;i<samples.length;i++)peak=Math.max(peak,Math.abs(samples[i]));
    }
    // Leave quiet mixes alone; prevent PCM clipping when tracks sum above full scale.
    const headroom=peak>.999?.98/peak:1;
    if(headroom<1)for(let channel=0;channel<rendered.numberOfChannels;channel++){
      const samples=rendered.getChannelData(channel);for(let i=0;i<samples.length;i++)samples[i]*=headroom;
    }
    rendered.studioMixStats={input_peak:peak,audio_peak:peak*headroom,headroom_gain:headroom};return rendered;
  }
  async saveStudioToSongs(name){
    if(this.savingStudioMix)throw Error('A Studio mix is already saving.');
    const title=(name??'ScrewShop Studio mix').trim();if(!title)throw Error('Give your Studio mix a name.');
    if(title.length>160)throw Error('Keep the mix name within 160 characters.');
    this.savingStudioMix=true;this.notify('Rendering Studio mix…');
    try{
      const buffer=await this.renderStudio({maxBytes:300*1024*1024}),blob=this.wav(buffer),id=uid(),path='local/studio-mixes/'+id+'.wav';
      await this.checked(this.app.sb.storage.from('beats').upload(path,blob));
      const row={id,user_id:'local',name:title,storage_path:path,bucket:'beats',source_kind:'studio-mix',source_session_id:'recording-session',source_song_id:this.app.SONG_UUID,duration:buffer.duration,created_at:new Date().toISOString(),...buffer.studioMixStats};
      await this.checked(this.app.sb.from('library').insert(row));await this.app.loadLibrary();await this.refreshLibrary();
      this.notify('Saved '+title+' in SONGS.'+(row.headroom_gain<1?' Reduced mix gain to prevent clipping.':''));return {...row,url:this.app.studio.url('beats',path)};
    }finally{this.savingStudioMix=false;}
  }
  // EXPORT MIX MP3: finished at -14 LUFS, added to SONGS like an imported song, and copied to ScrewShop/mp3s.
  async exportStudioMp3(name){
    if(this.savingStudioMix)throw Error('A Studio mix is already saving.');
    const title=(name??'').trim();if(!title)return null;
    if(title.length>160)throw Error('Keep the song name within 160 characters.');
    this.savingStudioMix=true;this.notify('Rendering '+title+'…');
    try{
      const buffer=await this.renderStudio({maxBytes:300*1024*1024}),path='local/studio-mixes/'+uid()+'.wav';
      await this.checked(this.app.sb.storage.from('beats').upload(path,this.wav(buffer)));
      this.notify('Finishing loudness and encoding MP3…');
      const result=await window.ScrewShop.export({kind:'song-mp3',storage_path:path,name:title});if(result.error)throw Error(result.error.message);
      await this.app.loadLibrary();await this.refreshLibrary();
      const lufs=result.data.report?.after?.integrated_lufs;
      this.notify('Saved "'+title+'" to SONGS (Imported) and to ScrewShop\\'+result.data.saved_to.replace('/','\\')+(lufs!=null?' · '+lufs.toFixed(1)+' LUFS':''));
      return result.data;
    }finally{this.savingStudioMix=false;}
  }
  async exportStudio(format='wav'){
    this.notify('Rendering Studio '+format.toUpperCase()+'…');
    const buffer=await this.renderStudio();await this.finishExport(this.wav(buffer),'ScrewShop Studio mix',format);this.notify('Studio '+format.toUpperCase()+' mix exported.'+(buffer.studioMixStats.headroom_gain<1?' Reduced mix gain to prevent clipping.':''));
  }
  dispose(){this.disposed=true;clearInterval(this.scheduler);clearInterval(this.clipTimer);clearTimeout(this.noteSaveTimer);clearTimeout(this.liveUITimer);cancelAnimationFrame(this.liveFrame);document.getElementById('sp-clip')?.remove();document.getElementById('sp-pack')?.remove();document.removeEventListener('keydown',this.onComputer);document.removeEventListener('keyup',this.onComputer);window.removeEventListener('blur',this.onBlur);super.dispose();}
};
})();
