/* Editable sampler projects. Audio references remain in the existing local store. */
(() => {
const clone = x => JSON.parse(JSON.stringify(x));
const clamp = (x,a,b) => Number.isFinite(+x)?Math.max(a,Math.min(b,+x)):a;
const uid = () => window.ScrewShop.id();
const defaults = () => ({id:uid(),name:'Untitled beat',bpm:82,swing:0,grid:4,quantize:true,countIn:true,metro:false,overdub:true,latency:0,octave:4,root:60,low:36,high:96,mode:'pads',
  slots:Array(18).fill(null),maps:{},mix:Array.from({length:18},()=>({volume:.8,mute:false,solo:false})),patterns:[{id:uid(),name:'Pattern 1',beats:4,events:[]}],pattern:0,kitId:null});
window.StudioWorkspace = class SamplerWorkspace extends window.StudioWorkspace {
  constructor(app) {
    super(app); this.project=defaults();this.history=[];this.future=[];this.held=new Map();this.inflight=new Map();this.prepared=new Map();this.assignmentTokens=new Map();
    this.ui={width:240,library:true,sequence:true,height:250,view:'pads',steps:16,page:0,roll:false};this.favorites=[];this.chops=[];this.beats=[];this.kits=[];this.selected=0;this.status='Loading…';
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
    this.syncLegacy();this.ready=true;const prepared=await this.prepare();if(prepared)this.status='Ready';this.draw();
  }
  async refreshLibrary(){await super.refreshLibrary();if(!this.app.sb)return;try{const rows=await this.checked(this.app.sb.from('settings').select('*'));this.beats=rows.filter(x=>x.kind==='sampler-beat');this.kits=rows.filter(x=>x.kind==='sampler-kit');this.drawLibrary();}catch(e){this.message(e.message,true);}}
  save(){
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
      this.checkpoint();this.panic();this.slots[lane]={...item,start:raw.start??0,end:raw.end??buffer.duration,volume:1,pan:0,pitch:0,gate:lane>=16,loop:false,attack:.003,release:.03,choke:0,...raw,url:item.url};
      await this.prepareSlot(this.slots[lane]);this.selected=lane;this.pendingSound=null;this.changed();this.draw();this.message('Ready: '+item.name);this.prune();
    }catch(e){this.message('Could not load '+item.name+': '+e.message+'. Choose another file or retry.',true);throw e;}
    finally{this.host?.querySelector('[data-dest="'+lane+'"]')?.classList.remove('loading');}
  }
  laneAudible(lane){const m=this.project.mix[lane];return !m.mute&&(!this.project.mix.some(x=>x.solo)||m.solo);}
  voice(lane,note,velocity,when,ctx=this.context(),destination=this.bus,duration=null,registry=this.voices){
    const s=this.slots[lane];if(!s||!this.laneAudible(lane))return null;
    const original=this.buffers.get(s.url),buffer=s.reverse?this.prepared.get(s.url):original;if(!buffer){this.message('Sound not ready: '+s.name+'. Reassign to retry.');return null;}
    const start=clamp(s.start||0,0,original.duration-.001),end=clamp(s.end||original.duration,start+.001,original.duration);
    const source=ctx.createBufferSource(),gain=ctx.createGain(),pan=ctx.createStereoPanner();source.buffer=buffer;
    const rate=2**(((s.pitch||0)+(lane>=16?note-(s.root??this.project.root):0))/12);source.playbackRate.value=rate;
    const offset=s.reverse?original.duration-end:start,tail=s.reverse?original.duration-start:end;
    source.loop=!!s.loop;source.loopStart=offset;source.loopEnd=tail;
    const level=velocity/127*(s.volume??1)*this.project.mix[lane].volume;
    gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(level,when+Math.max(.001,s.attack||.003));pan.pan.value=s.pan||0;
    source.connect(gain);gain.connect(pan);pan.connect(destination);
    const v={src:source,gain,pan,lane,choke:s.choke||0,when,ctx,released:false};
    if(v.choke)for(const old of registry)if(old.choke===v.choke&&old.when<=when)this.endVoice(old,when,.005);
    registry.add(v);source.onended=()=>{registry.delete(v);source.disconnect();gain.disconnect();pan.disconnect();};
    source.start(when,offset);
    const natural=(end-start)/rate;
    if(duration!=null||!source.loop&&!s.gate){let length=s.gate||s.loop?(duration??natural):natural;if(!source.loop)length=Math.min(length,natural);const fade=Math.min(s.release||.005,.04,length/2);this.endVoice(v,when+length-fade,fade);}
    else if(!source.loop)this.endVoice(v,when+natural-.003,.003);
    return v;
  }
  endVoice(v,time,release){if(!v||v.stopTime!=null&&v.stopTime<=time)return;v.stopTime=time;const p=v.gain.gain;try{if(p.cancelAndHoldAtTime)p.cancelAndHoldAtTime(time);else p.cancelScheduledValues(time);p.setTargetAtTime(.00001,time,Math.max(.001,release/4));v.src.stop(time+release);}catch(_){}}
  async press(lane,note=60,velocity=100,token='pad:'+lane){
    if(this.pendingSound){await this.assign(lane,this.pendingSound);return;}
    this.selected=lane;const ctx=this.context();this.releaseToken(token,true);const pending={};this.pressTokens=this.pressTokens||new Map();this.pressTokens.set(token,pending);await ctx.resume();if(this.pressTokens.get(token)!==pending)return;
    const v=this.voice(lane,note,velocity,ctx.currentTime);if(v)this.held.set(token,v);
    this.host?.querySelector('[data-dest="'+lane+'"]')?.classList.add('hit');
    this.capture(lane,note,velocity,token);this.drawEditor();
  }
  releaseToken(token,force=false){
    this.pressTokens?.delete(token);
    const v=this.held.get(token);if(v){if(this.sustain&&!force){v.released=true;return;}if(this.slots[v.lane]?.gate||this.slots[v.lane]?.loop)this.endVoice(v,v.ctx.currentTime,this.slots[v.lane]?.release||.03);this.held.delete(token);}
    const held=this.recordHeld?.get(token);if(held){held.len=Math.max(1/64,Math.min(this.pattern.beats,((this.context().currentTime-this.origin)*this.project.bpm/60)-held.absolute));delete held.absolute;this.recordHeld.delete(token);this.changed();this.drawSequence();}
    this.host?.querySelectorAll('.hit').forEach(e=>e.classList.remove('hit'));
  }
  triggerPad(i,time,velocity=100){return this.press(i,60,velocity);}
  keyDown(n,v=100){return this.press(+this.project.mode>=16?+this.project.mode:16,n,v,'key:'+n);}
  release(n){this.releaseToken('key:'+n);}
  panic(){this.pressTokens?.clear();if(this.held)for(const token of this.held.keys())this.releaseToken(token,true);super.panic();this.sustain=false;}
  stop(){this.playing=false;this.recording=false;this.scheduled=new Map();this.recordHeld?.forEach((_,token)=>this.releaseToken(token,true));this.panic();this.updateStatus();}
  async start(record=false){if(this.playing){if(record){this.checkpoint();this.recording=!this.recording;}else this.stop();this.updateStatus();return;}
    if(!await this.prepare())return;const ctx=this.context();await ctx.resume();this.app.studio.halt();this.checkpoint();
    this.recording=record;this.playing=true;this.scheduled=new Map();this.origin=ctx.currentTime+.08+(record&&this.project.countIn?4*60/this.project.bpm:0);this.nextCycle=0;this.nextClick=record&&this.project.countIn?-4:0;this.recordHeld=new Map();
    if(record&&!this.project.overdub)this.pattern.events=[];this.changed();this.schedule();this.updateStatus();
  }
  capture(lane,note,velocity,token){if(!this.recording||!this.playing)return;const absolute=(this.context().currentTime-this.origin-(this.project.latency||0)/1000)*this.project.bpm/60;if(absolute<0)return;
    const pos=((absolute%this.pattern.beats)+this.pattern.beats)%this.pattern.beats,grid=this.project.grid;
    const at=this.project.quantize?(Math.round(pos*grid)/grid)%this.pattern.beats:pos;
    const event={id:uid(),lane,note,velocity,at,len:1/grid,absolute};this.pattern.events.push(event);this.recordHeld.set(token,event);
    const cycle=Math.floor(absolute/this.pattern.beats);if(!this.scheduled.has(cycle))this.scheduled.set(cycle,new Set());this.scheduled.get(cycle).add(event.id);this.changed();this.drawSequence();
  }
  eventTime(e){return e.at+(Math.round(e.at*this.project.grid)%2?this.project.swing/100/this.project.grid:0);}
  schedule(){if(!this.playing)return;const ctx=this.context(),beat=60/this.project.bpm,horizon=ctx.currentTime+.12,pattern=this.pattern;
    // Schedule only the next 120 ms; edits affect the next unscheduled events.
    if(!this.scheduled)this.scheduled=new Map();
    const first=Math.max(0,Math.floor((ctx.currentTime-this.origin)/(pattern.beats*beat))),last=Math.max(first,Math.floor((horizon-this.origin)/(pattern.beats*beat)));
    for(let cycle=first;cycle<=last;cycle++){let seen=this.scheduled.get(cycle);if(!seen){seen=new Set();this.scheduled.set(cycle,seen);}for(const e of pattern.events){if(e.at>=pattern.beats)continue;const at=this.origin+(cycle*pattern.beats+this.eventTime(e))*beat;if(at>=ctx.currentTime-.01&&at<=horizon&&!seen.has(e.id)){seen.add(e.id);this.voice(e.lane,e.note,e.velocity,Math.max(at,ctx.currentTime),ctx,this.bus,e.len*beat);setTimeout(()=>{const el=this.host?.querySelector('[data-dest="'+e.lane+'"]');el?.classList.add('hit');setTimeout(()=>el?.classList.remove('hit'),90);},Math.max(0,(at-ctx.currentTime)*1000));}}}
    for(const cycle of this.scheduled.keys())if(cycle<first)this.scheduled.delete(cycle);
    while(this.origin+this.nextClick*beat<=horizon){const n=this.nextClick++,time=this.origin+n*beat;if(time<ctx.currentTime-.01)continue;if(this.project.metro||n<0){const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=n%4===0?1200:800;g.gain.setValueAtTime(.08,time);g.gain.exponentialRampToValueAtTime(.001,time+.035);o.connect(g);g.connect(ctx.destination);o.start(time);o.stop(time+.04);o.onended=()=>{o.disconnect();g.disconnect();};}}
  }
  midi(data){if(this.app.state.tab!=='packs')return;const [status,a,b=0]=data,type=status&240,channel=status&15;
    if(this.learning&&((type===144&&b)||type===176)){this.checkpoint();this.project.maps[this.learning]={type,channel,number:a};this.learning=null;this.changed();this.draw();return;}
    const mapped=Object.entries(this.project.maps).find(([,m])=>m.channel===channel&&m.number===a&&(m.type===type||(m.type===144&&type===128)));
    const token='midi:'+channel+':'+a;
    if(type===128||type===144&&!b){this.releaseToken(token);return;}
    if(type===176&&a===64){this.sustain=b>=64;if(!this.sustain)for(const[t,v]of this.held)if(v.released)this.releaseToken(t,true);return;}
    if(type===176&&(a===120||a===123)){this.panic();return;}
    if(mapped){const action=mapped[0];if(action.startsWith('pad:')){if(b)this.press(+action.split(':')[1],a,b,token);else this.releaseToken(token);}
      else if(action==='master'){this.volume=b/127;this.applyGain();}else if(b){if(action==='play')this.start();if(action==='record')this.start(true);if(action==='stop')this.stop();}return;}
    if(type===144&&b&&a>=this.project.low&&a<=this.project.high){const drum=a-this.project.octave*12;if(+this.project.mode>=16)this.press(+this.project.mode,a,b,token);else if(drum>=0&&drum<16)this.press(drum,a,b,token);}
  }
  computer(e){if(this.app.state.tab!=='packs'||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||e.target.isContentEditable)return;
    if((e.ctrlKey||e.metaKey)&&e.code==='KeyZ'&&e.type==='keydown'){e.preventDefault();this.undo(e.shiftKey);return;}
    if(e.ctrlKey||e.metaKey||e.altKey)return;const chars='1234qwerasdfzxcv',i=chars.indexOf(e.key.toLowerCase());
    if(e.code==='Space'&&e.type==='keydown'&&!e.repeat){e.preventDefault();this.start();return;}if(i<0)return;e.preventDefault();const token='computer:'+e.code;
    if(e.type==='keyup')this.releaseToken(token);else if(!e.repeat)this.press(+this.project.mode>=16?+this.project.mode:i,this.project.octave*12+i,100,token);
  }
  tick(){if(!this.project)return;const host=document.getElementById('ss-sampler');if(host&&host!==this.host){this.host=host;this.draw();}
    if(this.app.state.tab!=='packs'&&this.wasSampler){this.stop();this.previewAudio?.pause();}this.wasSampler=this.app.state.tab==='packs';
    if(host){if(Date.now()-this.lastFetch>5000)this.refreshLibrary();this.updateStatus();}
    const library=document.getElementById('ss-sound-library');if(library){if(library!==this.library){this.library=library;super.mountLibrary(library);this.libSignature='';}
      const signature=JSON.stringify([this.app.state.library,this.app.state.allStems,this.folders,this.takes]);if(signature!==this.libSignature){this.libSignature=signature;this.renderLibrary();}if(Date.now()-this.lastFetch>5000)this.refreshLibrary();}
  }
  updateStatus(){if(!this.host?.isConnected)return;const set=(q,t)=>{const el=this.host.querySelector(q);if(el)el.textContent=t;};
    set('[data-status]',this.status);set('[data-midi]',this.app.state.midiDevices?.length?this.app.state.midiDevices.join(', '):navigator.requestMIDIAccess?'No MIDI connected':'MIDI unavailable in this browser — use touch or computer keys');
    set('[data-action="play"]',this.playing?'Stop':'Play');set('[data-action="record"]',this.recording?'Stop Record':'Record');
    if(this.playing){const pos=(this.context().currentTime-this.origin)*this.project.bpm/60;set('[data-position]',pos<0?'Count-in '+Math.ceil(-pos):'Beat '+((pos%this.pattern.beats)+1).toFixed(1));const step=Math.floor(Math.max(0,pos)%this.pattern.beats*this.project.grid);this.host.querySelectorAll('[data-step]').forEach(e=>e.classList.toggle('playhead',+e.dataset.step===step));}
    if(this.meter){this.meter.getFloatTimeDomainData(this.meterData);const peak=this.meterData.reduce((a,b)=>Math.max(a,Math.abs(b)),0);const meter=this.host.querySelector('meter');if(meter)meter.value=peak;if(peak>=.99)this.clipUntil=Date.now()+1500;set('[data-clip]',Date.now()<this.clipUntil?'CLIP':'');}
  }
  button(action,label,title=label){return `<button data-action="${action}" title="${this.esc(title)}" aria-label="${this.esc(title)}">${label}</button>`;}
  draw(){const h=this.host;if(!h?.isConnected)return;const b=(...a)=>this.button(...a),p=this.project;
    h.innerHTML=`<div class="sp-toolbar" role="toolbar" aria-label="Sampler transport">${b('library','☰','Toggle library')}<span data-midi class="sp-midi"></span>${b('midi','MIDI','Connect MIDI')}<label>BPM <input data-project="bpm" type="number" min="30" max="300" value="${p.bpm}"></label>${b('play','Play')}${b('record','Record')}${b('panic','■','All Notes Off')}<label><input data-project="metro" type="checkbox" ${p.metro?'checked':''}>Click</label><label><input data-project="countIn" type="checkbox" ${p.countIn?'checked':''}>Count-in</label><label>Master<input data-master-volume aria-label="Master volume" type="range" min="0" max="1" step=".01" value="${this.volume}"></label><span data-position></span><meter min="0" max="1" value="0" aria-label="Sampler master meter"></meter><strong data-clip></strong>${b('kit','Save Kit')}${b('beat','Save Beat')}${b('send','Send to Studio')}<span data-status role="status"></span></div>
    <nav class="sp-mobile">${b('view-library','Library')}${b('view-pads','Pads / Keys')}${b('view-sequence','Sequencer')}</nav>
    <div class="sp-body" data-view="${this.ui.view}" style="--library-width:${this.ui.library?this.ui.width:0}px"><aside class="sp-library" ${this.ui.library?'':'hidden'}><div class="sp-library-inner"></div></aside><div class="sp-resizer" role="separator" tabindex="0" aria-label="Resize library" aria-orientation="vertical"></div>
    <main class="sp-main"><div class="sp-playing"><div class="sp-actions">${b('undo','↶','Undo')}${b('redo','↷','Redo')}<label>Play <select data-mode><option value="pads" ${p.mode==='pads'?'selected':''}>Drums / chops</option><option value="16" ${p.mode==='16'?'selected':''}>Instrument 1</option><option value="17" ${p.mode==='17'?'selected':''}>Instrument 2</option></select></label><span>Repitching changes pitch and duration</span>${b('clear','Clear assignment')}${b('copy','Copy')}${b('paste','Paste')}${b('learn','MIDI Learn selected')}<span>${this.learning?'Waiting for a key/control…':''}</span></div><div class="sp-pads">${Array.from({length:16},(_,i)=>`<button data-dest="${i}" data-pad="${i}" draggable="true" class="sp-pad ${i===this.selected?'selected':''}" aria-label="Pad ${i+1}"><b>${i+1} <small>${'1234QWERASDFZXCV'[i]}</small></b><span>${this.esc(this.slots[i]?.name||'Drop sound')}</span><small>${this.project.maps['pad:'+i]?'MIDI '+this.project.maps['pad:'+i].number:'Learn MIDI'}</small></button>`).join('')}</div>
    <div class="sp-keys">${Array.from({length:p.mode==='pads'?16:25},(_,i)=>{const note=p.octave*12+i;return `<button data-dest="${p.mode==='pads'?i:+p.mode}" data-note="${note}" class="${[1,3,6,8,10].includes(note%12)?'black':''}" aria-label="Key ${note}" title="${this.esc(this.slots[p.mode==='pads'?i:+p.mode]?.name||'Drop sound')}">${note}</button>`;}).join('')}</div><div class="sp-actions"><span>${this.esc(this.slots[p.mode==='17'?17:16]?.name||'Drop a sound on keys for an instrument')}</span><label>Octave <input data-project="octave" type="number" min="0" max="8" value="${p.octave}"></label><label>Root <input data-project="root" type="number" min="0" max="127" value="${this.slots[+p.mode]?.root??p.root}"></label><label>Range <input aria-label="Lowest MIDI note" data-project="low" type="number" min="0" max="127" value="${p.low}"><input aria-label="Highest MIDI note" data-project="high" type="number" min="0" max="127" value="${p.high}"></label></div><section class="sp-editor"></section></div>
    <section class="sp-sequence" style="height:${this.ui.sequence?this.ui.height:38}px"><div class="sp-sequence-inner"></div></section></main></div>`;
    h.onclick=e=>{const a=e.target.closest('[data-action]');if(a)this.run(()=>this.action(a.dataset.action));};
    h.onchange=e=>this.run(()=>this.change(e.target));
    h.ondragstart=e=>{const dest=e.target.closest('[data-pad]');if(dest){e.dataTransfer.setData('application/x-screwshop-assignment',dest.dataset.pad);e.dataTransfer.effectAllowed='copyMove';}};
    h.ondragover=e=>{const target=e.target.closest('[data-dest]');if(target){e.preventDefault();target.classList.add('drop-hover');}};
    h.ondragleave=e=>e.target.closest('[data-dest]')?.classList.remove('drop-hover');
    h.ondrop=e=>{const dest=e.target.closest('[data-dest]');if(!dest)return;e.preventDefault();dest.classList.remove('drop-hover');this.run(async()=>{const from=e.dataTransfer.getData('application/x-screwshop-assignment'),raw=e.dataTransfer.getData('application/x-screwshop-loop');
      if(from!==''){this.checkpoint();const to=+dest.dataset.dest;if(to===+from)return;this.slots[to]=clone(this.slots[+from]);if(!e.ctrlKey)this.slots[+from]=null;this.changed();this.draw();}else if(raw)await this.assign(+dest.dataset.dest,JSON.parse(raw));});};
    h.querySelectorAll('[data-dest]').forEach(el=>{el.onpointerdown=e=>{if(e.button!==0)return;el.setPointerCapture(e.pointerId);const lane=+el.dataset.dest,note=+(el.dataset.note||60);this.run(()=>this.press(lane,note,100,'pointer:'+e.pointerId));};el.onpointerup=el.onpointercancel=el.onlostpointercapture=e=>this.releaseToken('pointer:'+e.pointerId);});
    const resizer=h.querySelector('.sp-resizer');resizer.onpointerdown=e=>{resizer.setPointerCapture(e.pointerId);resizer.onpointermove=ev=>{this.ui.width=clamp(ev.clientX-h.getBoundingClientRect().left,170,420);h.querySelector('.sp-body').style.setProperty('--library-width',this.ui.width+'px');};};resizer.onpointerup=()=>{resizer.onpointermove=null;this.changed();};resizer.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){this.ui.width=clamp(this.ui.width+(e.key==='ArrowLeft'?-20:20),170,420);this.changed();this.draw();}};
    this.drawLibrary();this.drawEditor();this.drawSequence();this.updateStatus();
  }
  run(fn){Promise.resolve().then(fn).catch(e=>this.message(e.message,true));}
  async action(a){
    if(a==='play'){this.scheduled=new Map();return this.start();}if(a==='record'){if(!this.playing)this.scheduled=new Map();return this.start(true);}if(a==='panic')return this.panic();
    if(a==='midi')return this.app.initMidi();if(a==='undo'||a==='redo')return this.undo(a==='redo');
    if(a==='library'){this.ui.library=!this.ui.library;this.changed();return this.draw();}
    if(a.startsWith('view-')){this.ui.view=a.slice(5);if(this.ui.view==='library')this.ui.library=true;this.changed();return this.draw();}
    if(a==='clear'){this.checkpoint();this.panic();this.slots[this.selected]=null;this.changed();return this.draw();}
    if(a==='copy'){this.clipboard=clone(this.slots[this.selected]);return this.message('Assignment copied');}
    if(a==='paste'&&this.clipboard){this.checkpoint();this.slots[this.selected]=clone(this.clipboard);await this.prepare();this.changed();return this.draw();}
    if(a==='learn'){this.learning=this.learning?null:'pad:'+this.selected;return this.draw();}
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
    if(a==='slice')return this.slice();if(a==='save-chop'){const s=this.slots[this.selected];if(!s)throw Error('Assign a sound first.');const name=prompt('Chop name',s.name);if(name){this.chops.push({...clone(s),name,id:uid(),type:'Chops'});this.changed();this.drawLibrary();}}
  }
  async change(el){
    if(el.matches('[data-master-volume]')){this.volume=clamp(el.value,0,1);this.applyGain();return this.save();}
    if(el.dataset.project==='root'&&+this.project.mode>=16&&this.slots[+this.project.mode]){this.checkpoint();this.slots[+this.project.mode].root=clamp(el.value,0,127);this.changed();return;}
    if(el.dataset.project){const key=el.dataset.project;this.checkpoint();if(['bpm','grid','swing'].includes(key))this.stop();const ranges={bpm:[30,300],grid:[1,8],swing:[0,75],octave:[0,8],root:[0,127],low:[0,127],high:[0,127],latency:[-250,250]};this.project[key]=el.type==='checkbox'?el.checked:clamp(el.value,...(ranges[key]||[0,1000]));this.changed();if(['octave','grid'].includes(key))this.draw();return;}
    if(el.matches('[data-mode]')){this.panic();this.project.mode=el.value;this.selected=el.value==='pads'?0:+el.value;this.changed();return this.draw();}
    if(el.dataset.sample){const slot=this.slots[this.selected];if(!slot)return;this.checkpoint();slot[el.dataset.sample]=el.type==='checkbox'?el.checked:clamp(el.value,+el.min,+el.max);
      const b=this.buffers.get(slot.url);slot.start=clamp(slot.start,0,b.duration-.001);slot.end=clamp(slot.end,slot.start+.001,b.duration);await this.prepareSlot(slot);this.changed();this.drawEditor();return;}
    if(el.dataset.mix){this.checkpoint();const [lane,key]=el.dataset.mix.split(':');this.project.mix[+lane][key]=el.type==='checkbox'?el.checked:clamp(el.value,0,1);this.changed();return;}
    if(el.matches('[data-pattern]')){this.stop();this.project.pattern=+el.value;this.ui.page=0;this.changed();return this.drawSequence();}
    if(el.matches('[data-length]')){this.stop();this.checkpoint();this.pattern.beats=clamp(el.value,1,64);this.ui.page=0;this.changed();return this.drawSequence();}
    if(el.matches('[data-steps]')){this.ui.steps=+el.value;this.ui.page=0;this.changed();return this.drawSequence();}
    if(el.matches('[data-height]')){this.ui.height=+el.value;this.changed();return this.draw();}
    if(el.matches('[data-learn-action]')){this.learning=el.value||null;this.draw();}
    if(el.dataset.event){this.checkpoint();const event=this.pattern.events.find(x=>x.id===this.editEvent);if(event){const key=el.dataset.event;event[key]=clamp(el.value,...(key==='velocity'?[1,127]:[1/64,64]));this.changed();this.drawSequence();}}
  }
  drawLibrary(){const host=this.host?.querySelector('.sp-library-inner');if(!host)return;
    const search=host.querySelector('[data-search]')?.value??this.search??'',filter=this.filter||'All';this.ui.groups=this.ui.groups||{};
    this.libraryItems=[];const seen=new Set();
    const push=(raw,type,group)=>{let item;try{item=this.item(raw);}catch(_){return;}const key=item.url+':'+(item.start||0)+':'+(item.end||'');if(seen.has(key))return;seen.add(key);this.libraryItems.push({...item,type:raw.type||type,group});};
    for(const f of this.folders||[])for(const raw of f.files||[])push(raw,f.folder_type==='pack'?'Packs':raw.sample?'Chops':'Stems',f.name);
    for(const s of this.app.state.allStems||[])push({...s,name:s.name||s.kind},'Stems',s.trackName||'Separated stems');
    for(const raw of this.chops)push(raw,'Chops','Saved chops');
    for(const raw of this.app.state.library||[])push(raw,'Samples','Imported sounds');
    for(const t of this.takes||[])push({name:t.label||'Recording',bucket:'takes',storage_path:t.storage_path},'Samples','Recordings');
    for(const beat of this.beats||[])this.libraryItems.push({name:beat.name,type:'Beats',group:'Saved beats',beat,url:beat.render?.url});
    const visible=this.libraryItems.map((x,i)=>({...x,index:i})).filter(x=>x.name.toLowerCase().includes(search.toLowerCase())&&(filter==='All'||filter===x.type||filter==='Favorites'&&this.favorites.includes(x.url||x.beat?.id)));
    const groups=[...new Set(visible.map(x=>x.group))];
    host.innerHTML=`<div class="sp-actions">${this.button('import','Import')}${this.button('folder','Folder')}</div><input data-search aria-label="Search sounds" placeholder="Search sounds" value="${this.esc(search)}"><select data-filter aria-label="Sound filter">${['All','Packs','Samples','Stems','Chops','Beats','Favorites'].map(f=>`<option ${f===filter?'selected':''}>${f}</option>`).join('')}</select><label>Preview <input data-preview-volume aria-label="Preview volume" type="range" min="0" max="1" step=".01" value="${this.previewVolume??.5}"></label><p class="sp-hint">Drag a sound, or select it then tap a pad/key.</p>${groups.map(g=>`<details data-group="${this.esc(g)}" ${search||this.ui.groups[g]!==false?'open':''}><summary>${this.esc(g)}</summary>${visible.filter(x=>x.group===g).map(x=>`<div class="sp-sound" data-sound="${x.index}" draggable="${!!x.url}"><button data-preview="${x.index}" title="Preview" aria-label="Preview ${this.esc(x.name)}" ${x.url?'':'disabled'}>▶</button><button data-select="${x.index}" title="Select sound for assignment" ${x.url?'':'disabled'}>${this.esc(x.name)}<small>${x.type} · ${Number.isFinite(x.end)?(x.end-(x.start||0)).toFixed(1)+'s':x.duration?Number(x.duration).toFixed(1)+'s':'—'}</small></button><button data-favorite="${x.index}" aria-label="Favorite ${this.esc(x.name)}">${this.favorites.includes(x.url||x.beat?.id)?'★':'☆'}</button>${x.beat?`<button data-open-beat="${x.index}">Open Beat</button><button data-send-beat="${x.index}">Send to Studio</button>`:''}${x.type==='Samples'&&x.id?`<div class="sp-actions"><button data-split="${x.index}:quick">Quick split</button><button data-split="${x.index}:full">Full split</button></div>`:''}</div>`).join('')}</details>`).join('')||'<p>No matching sounds. Import audio to begin.</p>'}<details><summary>Kits</summary>${(this.kits||[]).map((k,i)=>`<button data-kit="${i}">${this.esc(k.name)}</button>`).join('')}</details><p>${this.pendingSound?'Selected: '+this.esc(this.pendingSound.name):''}</p>`;
    host.querySelector('[data-search]').oninput=e=>{this.search=e.target.value;const start=e.target.selectionStart;this.drawLibrary();const input=host.querySelector('[data-search]');input.focus();input.setSelectionRange(start,start);};
    host.querySelector('[data-filter]').onchange=e=>{this.filter=e.target.value;this.drawLibrary();};host.querySelector('[data-preview-volume]').oninput=e=>{this.previewVolume=+e.target.value;if(this.previewAudio)this.previewAudio.volume=this.previewVolume;};
    host.ondragstart=e=>{const row=e.target.closest('[data-sound]');if(!row)return;e.stopPropagation();e.dataTransfer.setData('application/x-screwshop-loop',JSON.stringify(this.libraryItems[+row.dataset.sound]));e.dataTransfer.effectAllowed='copy';};
    host.onclick=e=>{const t=e.target.closest('button');if(!t)return;this.run(async()=>{if(t.dataset.preview!=null)this.preview(this.libraryItems[+t.dataset.preview]);
      if(t.dataset.select!=null){this.pendingSound=this.libraryItems[+t.dataset.select];this.message('Tap a pad or key to assign '+this.pendingSound.name);}
      if(t.dataset.favorite!=null){const x=this.libraryItems[+t.dataset.favorite],key=x.url||x.beat.id;this.favorites=this.favorites.includes(key)?this.favorites.filter(f=>f!==key):[...this.favorites,key];this.changed();this.drawLibrary();}
      if(t.dataset.openBeat!=null||t.dataset.sendBeat!=null){const x=this.libraryItems[+(t.dataset.openBeat??t.dataset.sendBeat)];await this.checked(this.app.sb.from('settings').upsert({id:'sampler-beat-'+this.project.id,kind:'sampler-beat',name:this.project.name,project:this.snapshot(),render:this.lastRender||null}));this.checkpoint();await this.restore(x.beat.project);if(t.dataset.sendBeat!=null)await this.handoff(false,{mode:'beat'});}
      if(t.dataset.kit!=null){const k=this.kits[+t.dataset.kit];this.checkpoint();this.stop();Object.assign(this.project,clone(k.kit));this.project.kitId=k.id;this.syncLegacy();await this.prepare();this.changed();this.draw();this.prune();}
      if(t.dataset.split){const [i,mode]=t.dataset.split.split(':');const x=this.libraryItems[+i];await this.app.requestSplit(x,mode);this.message('Split requested. Progress appears in the sound browser.');}
    });};
    host.querySelectorAll('details[data-group]').forEach(el=>{el.ontoggle=()=>{const name=el.dataset.group;if(!el.isConnected||this.search)return;if((this.ui.groups[name]!==false)!==el.open){this.ui.groups[name]=el.open;this.save().catch(()=>{});}};});
    host.querySelector('[data-preview-volume]').onchange=()=>this.save().catch(()=>{});
    // Keep the existing pack export workflow beside its source folder.
    for(const el of host.querySelectorAll('details[data-group]')){
      const folder=(this.folders||[]).find(f=>f.name===el.dataset.group);if(!folder)continue;
      if(folder.folder_type==='split'){const button=document.createElement('button');button.textContent='Name & Save Pack';button.onclick=()=>this.run(()=>this.namePack(folder.id));el.querySelector('summary').after(button);}
      if(folder.mode==='full'&&folder.beat_id){const button=document.createElement('button');button.textContent='Download Pack ZIP';button.onclick=()=>this.app.exportFile({kind:'pack',beat_id:folder.beat_id});el.querySelector('summary').after(button);}
    }
    for(const el of host.querySelectorAll('.sp-sound')){
      const x=this.libraryItems[+el.dataset.sound],job=this.app.state.splitJobs[x.id];
      if(job){const status=document.createElement('small');status.textContent=job.error||job.status;status.className='sp-job';el.append(status);}
      if(x.url&&!x.beat){const duration=this.buffers.get(x.url)?.duration;if(duration!=null){const small=el.querySelector('[data-select] small');if(small)small.textContent=x.type+' · '+((x.end??duration)-(x.start||0)).toFixed(1)+'s';}}
      if(x.url){const actions=document.createElement('details');actions.className='sp-audio-actions';actions.innerHTML='<summary>Audio actions</summary><a download href="'+this.esc(x.url)+'">Download audio</a><button>Add audio to Studio</button>';actions.querySelector('button').onclick=()=>this.run(()=>this.app.studio.addClip(null,x,this.app.studio.cursor));el.append(actions);}
    }
  }
  preview(item){if(this.previewAudio){const stop=this.previewItem===item.url&&!this.previewAudio.paused;this.previewAudio.pause();if(stop)return;}this.previewItem=item.url;const audio=this.previewAudio=new Audio(item.url);audio.volume=this.previewVolume??.5;audio.currentTime=item.start||0;if(item.end)audio.ontimeupdate=()=>{if(audio.currentTime>=item.end)audio.pause();};audio.play().catch(e=>this.message('Preview unavailable: '+e.message,true));}
  drawEditor(){const host=this.host?.querySelector('.sp-editor');if(!host)return;const s=this.slots[this.selected];if(!s){host.innerHTML='<p>Select a pad or instrument and drop a sound to edit it.</p>';return;}
    const num=(key,label,min,max,step)=>`<label>${label}<input data-sample="${key}" aria-label="${label}" type="number" min="${min}" max="${max}" step="${step}" value="${s[key]??({volume:1,end:1,attack:.003,release:.03}[key]||0)}"></label>`;
    const check=(key,label)=>`<label><input data-sample="${key}" type="checkbox" ${s[key]?'checked':''}>${label}</label>`;
    host.innerHTML=`<strong>${this.selected<16?'Pad '+(this.selected+1):'Instrument '+(this.selected-15)} · ${this.esc(s.name)}</strong><canvas width="900" height="50" aria-label="Selected sound waveform"></canvas><div class="sp-actions">${num('start','Start',0,99999,.001)}${num('end','End',.001,99999,.001)}${num('volume','Volume',0,2,.05)}${num('pan','Pan',-1,1,.1)}${num('pitch','Pitch',-36,36,1)}${check('reverse','Reverse')}${check('gate','Hold / gate')}${check('loop','Loop trim')}</div><details ${this.ui.advanced?'open':''}><summary>Advanced sample controls</summary><div class="sp-actions">${num('attack','Attack / fade in',.001,2,.001)}${num('release','Release / fade out',.003,3,.001)}${num('choke','Choke group',0,16,1)}${this.button('slice','Slice to pads')}${this.button('save-chop','Save Chop')}<label>Slice points (seconds)<input data-slice-points placeholder="0.2, 0.5, 0.8"></label></div></details>`;
    host.querySelector('details').ontoggle=e=>{if(this.ui.advanced!==e.target.open){this.ui.advanced=e.target.open;this.changed();}};
    const canvas=host.querySelector('canvas'),ctx=canvas.getContext('2d'),buffer=this.buffers.get(s.url);if(!buffer){ctx.fillStyle='#ddd';ctx.fillText('Missing sound. Reassign to retry.',8,25);return;}
    const data=buffer.getChannelData(0),stride=Math.max(1,Math.floor(data.length/900));ctx.fillStyle='#261a3f';ctx.fillRect(0,0,900,50);ctx.strokeStyle='#c9a4ff';ctx.beginPath();for(let x=0;x<900;x++){let peak=0;for(let i=x*stride;i<Math.min(data.length,(x+1)*stride);i+=Math.max(1,Math.floor(stride/20)))peak=Math.max(peak,Math.abs(data[i]));ctx.moveTo(x,25-peak*24);ctx.lineTo(x,25+peak*24);}ctx.stroke();ctx.fillStyle='#b784ff55';ctx.fillRect(s.start/buffer.duration*900,0,(s.end-s.start)/buffer.duration*900,50);
    canvas.onclick=e=>{const time=clamp((e.clientX-canvas.getBoundingClientRect().left)/canvas.getBoundingClientRect().width*buffer.duration,0,buffer.duration);this.checkpoint();if(e.shiftKey)s.end=Math.max(s.start+.001,time);else s.start=Math.min(s.end-.001,time);this.changed();this.drawEditor();};canvas.title='Click to set start; Shift-click to set end. Numeric fields also work on touch.';
  }
  slice(){const s=this.slots[this.selected];if(!s)throw Error('Select a sound to slice.');const value=this.host.querySelector('[data-slice-points]').value;const points=value.split(',').map(x=>Number(x.trim())).filter(x=>Number.isFinite(x)&&x>s.start&&x<s.end);const cuts=[s.start,...new Set(points.sort((a,b)=>a-b)),s.end];if(cuts.length<3)throw Error('Enter one or more slice points inside the trim range.');if(cuts.length>17)throw Error('Use at most 15 slice points for 16 pads.');this.checkpoint();for(let i=0;i<cuts.length-1;i++)this.slots[i]={...clone(s),name:s.name+' chop '+(i+1),start:cuts[i],end:cuts[i+1],gate:false};this.changed();this.draw();}
  drawSequence(){const host=this.host?.querySelector('.sp-sequence-inner');if(!host)return;const b=(...a)=>this.button(...a),p=this.project,pattern=this.pattern;
    const count=Math.min(this.ui.steps,pattern.beats*p.grid-this.ui.page*this.ui.steps),offset=this.ui.page*this.ui.steps;
    const lanes=this.ui.roll?Array.from({length:25},(_,i)=>({lane:+p.mode>=16?+p.mode:16,note:p.octave*12+24-i})):Array.from({length:18},(_,lane)=>({lane,note:lane>=16?(this.slots[lane]?.root??p.root):60}));
    host.innerHTML=`<div class="sp-actions sp-seq-toolbar">${b('sequence',this.ui.sequence?'▾':'▸','Toggle sequencer')}<select data-pattern aria-label="Pattern">${p.patterns.map((x,i)=>`<option value="${i}" ${i===p.pattern?'selected':''}>${this.esc(x.name)}</option>`).join('')}</select>${b('add-pattern','+','Add pattern')}${b('duplicate-pattern','Duplicate')}${b('rename-pattern','Rename')}${b('delete-pattern','Delete')}<label>Beats<input data-length type="number" min="1" max="64" value="${pattern.beats}"></label>${b('roll',this.ui.roll?'Drum steps':'Piano roll')}<label>View<select data-steps>${[16,32,64].map(n=>`<option ${n===this.ui.steps?'selected':''}>${n}</option>`).join('')}</select></label>${b('previous','‹','Previous steps')}<span>${offset+1}–${offset+count}</span>${b('next','›','Next steps')}</div>${this.ui.sequence?`<div class="sp-actions"><label>Grid<select data-project="grid">${[1,2,4,8].map(n=>`<option value="${n}" ${n===p.grid?'selected':''}>1/${n*4}</option>`).join('')}</select></label><label>Swing<input data-project="swing" type="number" min="0" max="75" value="${p.swing}"></label><label><input data-project="quantize" type="checkbox" ${p.quantize?'checked':''}>Quantize</label><label><input data-project="overdub" type="checkbox" ${p.overdub?'checked':''}>Overdub</label><label>Velocity<input data-new-velocity type="number" min="1" max="127" value="${this.newVelocity||100}"></label><label>Note beats<input data-new-length type="number" min=".0625" max="64" step=".25" value="${this.newLength||1/p.grid}"></label></div><div class="sp-grid" style="--steps:${count}">${lanes.map(({lane,note})=>{const mix=p.mix[lane];return `<div class="sp-lane"><div class="sp-lane-label"><button data-lane-select="${lane}">${this.ui.roll?'Note '+note:this.esc(this.slots[lane]?.name||(lane<16?'Pad '+(lane+1):'Instrument '+(lane-15)))}</button>${this.ui.roll?'':`<label title="Mute"><input aria-label="Mute lane ${lane+1}" data-mix="${lane}:mute" type="checkbox" ${mix.mute?'checked':''}>M</label><label title="Solo"><input aria-label="Solo lane ${lane+1}" data-mix="${lane}:solo" type="checkbox" ${mix.solo?'checked':''}>S</label><input aria-label="Lane ${lane+1} volume" data-mix="${lane}:volume" type="range" min="0" max="1" step=".01" value="${mix.volume}">`}</div><div class="sp-cells">${Array.from({length:count},(_,j)=>{const at=(offset+j)/p.grid,e=pattern.events.find(x=>x.lane===lane&&(!this.ui.roll||x.note===note)&&Math.floor(x.at*p.grid)===offset+j),tail=this.ui.roll&&pattern.events.some(x=>x.lane===lane&&x.note===note&&x.at<at&&x.at+x.len>at);return `<button data-cell="${lane}:${note}:${offset+j}" data-step="${offset+j}" class="${e?'on':tail?'tail':''}" aria-label="${this.ui.roll?'Note '+note:'Lane '+(lane+1)} step ${offset+j+1}" aria-pressed="${!!e}" title="Click toggles. Right-click edits velocity and length.">${e?e.velocity:''}</button>`;}).join('')}</div></div>`;}).join('')}</div><div class="sp-event-editor"></div><details ${this.ui.tools?'open':''} class="sp-tools"><summary>Project, transfer & export</summary><div class="sp-actions">${b('export','Export WAV')}${b('update','Update Studio render')}${b('retry','Retry Save')}<label>Transfer<select data-transfer><option value="pattern">Current pattern</option><option value="beat">All patterns in order</option></select></label><label><input data-separate type="checkbox">Separate lanes</label><label>Tempo<select data-tempo-policy><option value="studio">Render at Studio tempo</option><option value="sampler">Use sampler tempo (empty Studio only)</option></select></label><label>Recording offset ms<input data-project="latency" type="number" min="-250" max="250" value="${p.latency}"></label><label>Panel height<input data-height type="range" min="180" max="600" value="${this.ui.height}"></label><label>Learn control<select data-learn-action><option value="">Choose…</option>${['play','stop','record','master'].map(v=>`<option>${v}</option>`).join('')}</select></label></div><p>Studio receives WAV clips. Patterns remain editable here. Update replaces audio only on matching sampler clips and preserves their placement and lengths. WAV keeps high-quality audio; MP3 sharing is available when this computer has an encoder.</p></details>`:''}`;
    host.querySelectorAll('[data-cell]').forEach(el=>{el.onclick=()=>{if(this.editNotes)return el.oncontextmenu({preventDefault(){}});this.checkpoint();const [lane,note,step]=el.dataset.cell.split(':').map(Number);const index=pattern.events.findIndex(x=>x.lane===lane&&(!this.ui.roll||x.note===note)&&Math.floor(x.at*p.grid)===step);if(index>=0)pattern.events.splice(index,1);else pattern.events.push({id:uid(),lane,note,at:step/p.grid,len:clamp(host.querySelector('[data-new-length]').value,1/64,64),velocity:clamp(host.querySelector('[data-new-velocity]').value,1,127)});this.newLength=+host.querySelector('[data-new-length]').value;this.newVelocity=+host.querySelector('[data-new-velocity]').value;this.changed();this.drawSequence();};
      el.oncontextmenu=e=>{e.preventDefault();const [lane,note,step]=el.dataset.cell.split(':').map(Number),event=pattern.events.find(x=>x.lane===lane&&(!this.ui.roll||x.note===note)&&Math.floor(x.at*p.grid)===step);if(!event)return;this.editEvent=event.id;host.querySelector('.sp-event-editor').innerHTML=`<label>Event velocity<input data-event="velocity" type="number" min="1" max="127" value="${event.velocity}"></label><label>Length in beats<input data-event="len" type="number" min=".015625" max="64" step=".25" value="${event.len}"></label>`;};});
    host.querySelectorAll('[data-lane-select]').forEach(el=>el.onclick=()=>{this.selected=+el.dataset.laneSelect;this.drawEditor();});
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
      else {const at=studio.snap(studio.cursor);for(const {lane,item}of rendered){const track=studio.addTrack(item.name);track.volume=1;track.clips.push({id:uid(),name:item.name,url:item.url,start:at,length:item.dur,dur:item.dur,samplerSource:key,samplerLane:lane,samplerBpm:bpm});}}
      await studio.save();studio.refresh();this.lastRender=rendered.length===1?rendered[0].item:null;
      await this.checked(this.app.sb.from('settings').upsert({id:'sampler-beat-'+this.project.id,kind:'sampler-beat',name:this.project.name,project:this.snapshot(),render:this.lastRender}));await this.save();this.message((update?'Updated':'Sent')+' at '+bpm+' BPM. Studio clips retain their arrangement; future changes require Update Studio render.');
    }finally{this.transferring=false;}
  }
  async exportStudio(format='wav'){const studio=this.app.studio,clips=studio.tracks.flatMap(t=>t.clips);if(!clips.length)throw Error('Studio has no clips to export.');this.notify('Rendering Studio '+format.toUpperCase()+'…');await Promise.all(clips.map(c=>studio.decode(c)));const length=Math.max(...clips.map(c=>c.start+studio.clipLen(c)));if(length>1800)throw Error('Export up to 30 minutes at a time.');
    const ctx=new OfflineAudioContext(2,Math.ceil(length*44100),44100);for(const track of studio.tracks){const gain=ctx.createGain();gain.gain.value=studio.level(track);gain.connect(ctx.destination);for(const c of track.clips){const buffer=studio.buffers.get(c.url),duration=studio.clipLen(c),offset=c.sourceOffset||0;let at=0;while(at<duration-.00001){const source=ctx.createBufferSource();source.buffer=buffer;source.connect(gain);const start=(offset+at)%buffer.duration,n=Math.min(duration-at,buffer.duration-start);source.start(c.start+at,start,n);at+=n;}}}
    await this.finishExport(this.wav(await ctx.startRendering()),'ScrewShop Studio mix',format);this.notify('Studio '+format.toUpperCase()+' mix exported.');
  }
  dispose(){clearInterval(this.scheduler);document.removeEventListener('keydown',this.onComputer);document.removeEventListener('keyup',this.onComputer);window.removeEventListener('blur',this.onBlur);super.dispose();}
};
})();
