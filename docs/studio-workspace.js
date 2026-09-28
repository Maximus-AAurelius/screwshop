/* One local workspace: folder browser, Oxygen sampler, and MIDI-to-audio recording. */
window.StudioWorkspace = class {
  constructor(app) {
    this.app=app; this.slots=Array(8).fill(null); this.keySample=null; this.rootNote=60; this.octave=0;
    this.padNotes=[36,38,42,46,49,45,41,39]; this.maps={}; this.folders=[]; this.takes=[]; this.selected=0;
    this.buffers=new Map(); this.active=new Map(); this.voices=new Set(); this.volume=.8; this.bend=0; this.mod=0; this.transpose=0; this.knobs=Array(8).fill(102);
    this.timer=setInterval(()=>this.tick(),200); this.lastFetch=0;
  }
  esc(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async checked(q) { return this.app.studio.checked(q); }
  notify(s) { this.app.setState({notice:s}); }
  async load() {
    const saved=await this.checked(this.app.sb.from('settings').select('*').eq('id','oxygen-workspace').maybeSingle());
    if(saved) { this.slots=saved.slots||this.slots; this.keySample=saved.keySample; this.rootNote=saved.rootNote??60; this.padNotes=saved.padNotes||this.padNotes; this.maps=saved.maps||{}; }
    await this.refreshLibrary(); this.panel=null;
  }
  save() {
    const body=JSON.parse(JSON.stringify({id:'oxygen-workspace',slots:this.slots,keySample:this.keySample,rootNote:this.rootNote,padNotes:this.padNotes,maps:this.maps}));
    this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>this.checked(this.app.sb.from('settings').upsert(body))).catch(e=>this.notify('Sampler not saved: '+e.message));
    return this.saving;
  }
  async refreshLibrary() {
    if(!this.app.sb || this.fetching) return;
    this.fetching=true;
    try { const [settings,takes]=await Promise.all([this.checked(this.app.sb.from('settings').select('*')),this.checked(this.app.sb.from('takes').select('*'))]);
      this.folders=settings.filter(r=>['split','pack'].includes(r.folder_type)); this.takes=takes; this.libSignature='';
    } catch(e) { this.notify('Library could not refresh: '+e.message); }
    finally {this.fetching=false;this.lastFetch=Date.now();}
  }
  item(item) {
    return {...item,url:item.url||this.app.studio.url(item.bucket||'stems',item.storage_path)};
  }
  tick() {
    const host=document.getElementById('ss-sound-library');
    if(host) {
      if(this.library!==host) {this.library=host;this.mountLibrary(host);this.libSignature='';}
      const signature=JSON.stringify([this.app.state.library,this.app.state.allStems,this.app.state.splitJobs,this.folders,this.takes]);
      if(signature!==this.libSignature) {this.libSignature=signature;this.renderLibrary();}
      if(Date.now()-this.lastFetch>5000) this.refreshLibrary();
    }
    const panel=document.getElementById('ss-oxygen');
    if(panel && this.panel!==panel) {this.panel=panel;this.mountPanel();}
    if(panel) {
      panel.querySelector('.ox-record').textContent=this.app.studio.recording?'STOP TAKE':'RECORD MIDI AUDIO';
      panel.querySelector('.ox-midi-status').textContent=this.app.state.midiDevices?.join(', ')||'USB MIDI: connect your Oxygen 25';
      if(this.guideIndex!=null && !panel.querySelector('.ox-guide').innerHTML) this.guide(this.guideIndex,this.guideCustom);
      this.leds();
    }
  }
  mountLibrary(host) {
    host.innerHTML='<header class="sl-heading"><h3>SOUND LIBRARY</h3><button data-close-library aria-label="Close sound library">&times;</button></header><p>Local files &middot; drag onto a track, pad, or key</p><div class="sl-actions"><button data-import>IMPORT FILES</button><button data-folder>IMPORT FOLDER</button></div><input class="sl-search" aria-label="Search sound library" placeholder="Search your sounds..."><div class="sl-tree"></div>';
    host.querySelector('[data-close-library]').onclick=()=>this.app.setState({studioShowSources:false});
    host.querySelector('[data-import]').onclick=()=>this.importFiles(false);
    host.querySelector('[data-folder]').onclick=()=>this.importFiles(true);
    host.querySelector('.sl-search').oninput=()=>this.renderLibrary();
    host.addEventListener('dragstart',e=>{const row=e.target.closest('[data-sound]');if(!row)return; e.dataTransfer.setData('application/x-screwshop-loop',JSON.stringify(this.items[+row.dataset.sound]));e.dataTransfer.effectAllowed='copy';});
    host.addEventListener('click',e=>{
      const button=e.target.closest('button');if(!button)return;
      if(button.dataset.preview!=null) this.preview(this.items[+button.dataset.preview]);
      if(button.dataset.addSound!=null) this.app.studio.addClip(null,this.items[+button.dataset.addSound],this.app.studio.cursor);
      if(button.dataset.quick!=null) this.app.requestSplit(this.app.state.library[+button.dataset.quick],'quick');
      if(button.dataset.full!=null) this.app.requestSplit(this.app.state.library[+button.dataset.full],'full');
      if(button.dataset.pack) this.namePack(button.dataset.pack);
    });
  }
  renderLibrary() {
    const host=this.library;if(!host?.isConnected)return;
    const tree=host.querySelector('.sl-tree'), opened=new Set([...tree.querySelectorAll('details[open]')].map(d=>d.dataset.folder));
    const first=!tree.children.length, filter=host.querySelector('.sl-search').value.toLowerCase();this.items=[];
    const row=(raw,extra='')=>{const item=this.item(raw);if(filter&&!item.name.toLowerCase().includes(filter))return '';const i=this.items.push(item)-1;
      return '<div class="sl-file" draggable="true" data-sound="'+i+'" data-loop-url="'+this.esc(item.url)+'" data-loop-name="'+this.esc(item.name)+'"><button data-preview="'+i+'" aria-label="Preview '+this.esc(item.name)+'">&#9654;</button><span title="'+this.esc(item.note||item.name)+'">'+this.esc(item.name)+(item.sample?'<small>sample candidate</small>':'')+'</span><button data-add-sound="'+i+'" aria-label="Add '+this.esc(item.name)+' to track">+</button>'+extra+'</div>';};
    const folder=(id,name,body,extra='')=>'<details data-folder="'+this.esc(id)+'" '+(first||filter||opened.has(id)?'open':'')+'><summary>'+this.esc(name)+'</summary>'+extra+(body||'<p class="sl-empty">No sounds here yet.</p>')+'</details>';
    const imports=this.app.state.library||[];
    let html=folder('imports','BEATS & IMPORTS',imports.map((f,i)=>row(f,'<div class="sl-split"><button data-quick="'+i+'">QUICK</button><button data-full="'+i+'">FULL</button><small>'+this.esc(this.app.state.splitJobs[f.id]?.error||this.app.state.splitJobs[f.id]?.status||'')+'</small></div>')).join(''));
    for(const type of ['split','pack']) {
      let contents=this.folders.filter(f=>f.folder_type===type).map(f=>folder(f.id,f.name+(f.mode?' / '+f.mode.toUpperCase():''),
        f.files.filter(x=>!x.sample).map(x=>row(x)).join('')+(f.files.some(x=>x.sample)?folder(f.id+'samples','SAMPLES',f.files.filter(x=>x.sample).map(x=>row(x)).join('')):''),type==='split'?'<button class="sl-save-pack" data-pack="'+this.esc(f.id)+'">NAME & SAVE PACK</button>':'' )).join('');
      // Existing split revisions remain available even if created before folder indexing.
      if(type==='split') {const indexed=new Set(this.folders.map(f=>f.beat_id));const legacy=(this.app.state.allStems||[]).filter(x=>!indexed.has(x.beatId));const ids=[...new Set(legacy.map(x=>x.beatId))];contents+=ids.map(id=>folder('legacy-'+id,legacy.find(x=>x.beatId===id).trackName,legacy.filter(x=>x.beatId===id).map(x=>row({...x,name:x.kind})).join(''))).join('');}
      html+=folder(type,type==='split'?'SPLITZ':'PACKS',contents);
    }
    html+=folder('takes','RECORDINGS',this.takes.map(t=>row({name:t.label||'Recording',bucket:'takes',storage_path:t.storage_path})).join(''));
    tree.innerHTML=html;
  }
  async importFiles(directory) {
    const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='audio/*,.wav,.mp3,.m4a,.flac';if(directory)input.webkitdirectory=true;
    input.onchange=async()=>{try{const files=[...input.files].filter(f=>/\.(wav|mp3|m4a|flac|ogg|aac|webm|aiff?)$/i.test(f.name));const items=[];
      for(const file of files)items.push(await this.app.studio.uploadFile(file));
      if(directory&&items.length)await this.checked(this.app.sb.from('settings').upsert({id:'sound-pack-'+window.ScrewShop.id(),folder_type:'pack',name:input.files[0].webkitRelativePath.split('/')[0],files:items}));
      await this.app.loadLibrary();await this.refreshLibrary();this.notify('Imported '+items.length+' audio files locally.');
    }catch(e){this.notify('Import failed: '+e.message);}};input.click();
  }
  async namePack(id) {
    const name=prompt('Name this sound pack:',this.folders.find(f=>f.id===id)?.name||'My pack');if(!name?.trim())return;
    const result=await window.ScrewShop.export({kind:'library-pack',folder_id:id,name:name.trim()});
    if(result.error){this.notify(result.error.message);return;}await this.refreshLibrary();this.notify('Saved '+name+' in your local PACKS folder.');
  }
  preview(item) { if(this.previewAudio){this.previewAudio.pause();this.previewAudio=null;} const audio=this.previewAudio=new Audio(item.url);audio.play().catch(e=>this.notify('Preview failed: '+e.message)); }
  context() {
    const ctx=this.app.studio.context();
    if(!this.bus){this.bus=ctx.createGain();this.bus.gain.value=this.volume;this.bus.connect(ctx.destination);}
    return ctx;
  }
  recordStream() {const ctx=this.context();if(this.destination)this.bus.disconnect(this.destination);this.destination=ctx.createMediaStreamDestination();this.bus.connect(this.destination);return this.destination.stream;}
  async decode(item) {
    if(this.buffers.has(item.url))return this.buffers.get(item.url);
    const res=await fetch(item.url);if(!res.ok)throw new Error('Sound file unavailable');
    const buffer=await this.context().decodeAudioData(await res.arrayBuffer());this.buffers.set(item.url,buffer);return buffer;
  }
  async assign(target,raw,note) {
    const item=this.item(raw);if(!/^\/audio\/(beats|takes|stems)\//.test(item.url))throw new Error('Choose a local audio file');
    const buffer=await this.decode(item);const slot={...item,start:0,end:buffer.duration};
    if(target==='keys'){this.keySample=slot;this.rootNote=note??60;}else{this.slots[+target]=slot;this.selected=+target;const pads=this.app.state.pads.slice();pads[+target]={name:slot.name,loaded:true,hit:false};this.app.setState({pads});}
    await this.save();this.panel=null;this.notify('Loaded '+item.name+' onto '+(target==='keys'?'the keyboard':'pad '+(+target+1))+'.');
  }
  async triggerPad(i,time,velocity=100) {
    const slot=this.slots[i], fallback=this.app._pads?.[i];if(!slot&&!fallback)return;
    try {const ctx=this.context();await ctx.resume();const buffer=slot?await this.decode(slot):fallback;
      const delay=time&&this.app._Tone?Math.max(0,time-this.app._Tone.getContext().rawContext.currentTime):0;
      this.sound(buffer,slot||{start:0,end:buffer.duration},1,velocity,ctx.currentTime+delay);
      this.flash('[data-pad="'+i+'"]');
    }catch(e){this.notify(e.message);}
  }
  sound(buffer,slot,rate,velocity,when) {
    const ctx=this.context(),src=ctx.createBufferSource(),gain=ctx.createGain();src.buffer=buffer;src.playbackRate.value=rate;
    gain.gain.value=Math.max(.001,velocity/127);src.connect(gain);gain.connect(this.bus);
    const start=Math.max(0,Math.min(slot.start||0,buffer.duration-.001)),end=Math.min(buffer.duration,slot.end||buffer.duration);
    src.start(when??ctx.currentTime,start,Math.max(.001,end-start));const voice={src,gain,rate};this.voices.add(voice);
    src.onended=()=>{this.voices.delete(voice);src.disconnect();gain.disconnect();};return voice;
  }
  async keyDown(note,velocity=100) {
    if(!this.keySample)return;
    const token={};this.keyTokens=this.keyTokens||new Map();this.keyTokens.set(note,token);
    try{const ctx=this.context();await ctx.resume();const buffer=await this.decode(this.keySample);if(this.keyTokens.get(note)!==token)return;
      this.release(note,true);this.keyTokens.set(note,token);
      const voice=this.sound(buffer,this.keySample,2**((note-this.rootNote+this.bend+this.transpose)/12),velocity);voice.note=note;this.active.set(note,voice);this.flash('[data-key="'+note+'"]');
    }catch(e){this.notify(e.message);}
  }
  release(note,force=false) {
    this.keyTokens?.delete(note);const voice=this.active.get(note);if(!voice)return;
    if(this.sustain&&!force){voice.released=true;return;}const ctx=this.context();voice.gain.gain.setTargetAtTime(.0001,ctx.currentTime,.015);try{voice.src.stop(ctx.currentTime+.08);}catch(_){}this.active.delete(note);
  }
  applyGain() {this.context();this.bus.gain.setTargetAtTime(this.muted?0:this.volume,this.context().currentTime,.01);}
  panic() {clearInterval(this.repeatTimer);this.repeatTimer=null;this.latch=false;this.active.clear();this.keyTokens?.clear();for(const v of this.voices){try{v.src.stop();}catch(_){}}this.sustain=false;}
  flash(selector) {const el=this.panel?.querySelector(selector);el?.classList.add('hit');setTimeout(()=>el?.classList.remove('hit'),140);}
  midi(data) {
    if(this.app.state.tab!=='studio')return;
    const [status,a,b]=data,type=status&240,ch=status&15;
    if(this.learning && ((type===144&&b>0)||type===176)) {
      if(this.learning.startsWith('pad')){if(type!==144)return;this.padNotes[+this.learning.slice(3)]={note:a,channel:ch};}
      else this.maps[this.learning]={type,channel:ch,number:a};
      this.learning=null;this.save();this.panel=null;this.notify('MIDI assignment saved.');return;
    }
    for(const [action,map] of Object.entries(this.maps)){if(map.type===type&&map.channel===ch&&map.number===a){this.action(action,b);return;}}
    if(type===144&&b>0){const pad=this.padNotes.findIndex(n=>typeof n==='number'?ch===9&&n===a:n.channel===ch&&n.note===a);if(pad>=0)this.triggerPad(pad,null,b);else if(ch!==9)this.keyDown(a,b);}
    else if(type===128||(type===144&&b===0))this.release(a);
    else if(type===224){this.bend=((b*128+a)-8192)/8192*2;for(const v of this.active.values())v.src.playbackRate.setTargetAtTime(2**((v.note-this.rootNote+this.bend+this.transpose)/12),this.context().currentTime,.01);}
    else if(type===176&&a===64){this.sustain=b>=64;if(!this.sustain)for(const[n,v]of this.active)if(v.released)this.release(n,true);}
    else if(type===176&&a===7)this.action('volume',b);
    else if(type===176&&a===1)this.action('mod',b);
  }
  action(action,value) {
    if(action==='volume'){this.volume=value/127;this.applyGain();const fader=this.panel?.querySelector('[data-master]');if(fader)fader.value=this.volume;this.show(Math.round(value));return;}
    if(action==='faderbtn'){if(value){this.muted=!this.muted;this.applyGain();this.leds();this.show(this.muted?'OFF':'ON');}return;}
    if(action==='mod'){this.mod=value/127;for(const v of this.active.values())v.gain.gain.setTargetAtTime(1-this.mod*.6,this.context().currentTime,.03);return;}
    if(action.startsWith('level')){const i=+action.slice(5);if(this.app.studio.tracks[i])this.app.studio.change(this.app.studio.tracks[i].id,{volume:value/127});this.setKnob(i,value,false);return;}
    if(!value)return;
    if(action==='play')this.app.studio.toggle();
    if(action==='stop'){if(this.app.studio.recording)this.app.studio.stopRecord();else this.app.studio.halt();this.panic();}
    if(action==='record')this.app.studio.record('midi');
    if(action==='cycle')this.app.studio.toggleCycle();
  }
  // The drawer is a scale copy of the Oxygen 25 (MKV) product photo. at() takes
  // pixel positions measured on that 572x302 photo and turns them into percentages.
  mountPanel() {
    const p=this.panel,esc=s=>this.esc(s),names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],L=this.labels();
    const at=(x,y,w,h)=>`left:${((x-6)/5.72).toFixed(2)}%;top:${((y-2)/3.02).toFixed(2)}%;width:${(w/5.72).toFixed(2)}%;height:${(h/3.02).toFixed(2)}%`;
    const print=(x,y,w,text,cls='',help='')=>`<span class="ox-print ${cls}" style="${at(x,y,w,5)}"${help?` data-help="${help}"`:''}>${text}</span>`;
    const hw=(x,y,help,attrs,label,cls='')=>`<button class="ox-hw ${cls}" style="${at(x,y,17,11)}" data-help="${help}" ${attrs} aria-label="${label}"></button>`;
    const low=48+this.octave*12,white=[];for(let n=low;n<low+25;n++)if(!names[n%12].includes('#'))white.push(n);
    const kw=430/white.length;
    const keys=Array.from({length:25},(_,i)=>{const note=low+i,name=names[note%12],black=name.includes('#'),wi=white.filter(n=>n<note).length;
      return `<button class="ox-key ${black?'black':'white'}" style="${black?at(125+wi*kw-8,128,16,108):at(125+wi*kw,128,kw,172)}" data-key="${note}" data-target="keys" data-help="keys" data-item="key:${i}" aria-label="Key ${name}${Math.floor(note/12)-1}"><span>${name==='C'?'C'+(Math.floor(note/12)-1):''}</span></button>`;}).join('');
    const lx=i=>125+Math.floor(i/12)*200.7+(i%12)*16.72;
    const strip=[['top',113.5],['bottom',123]].map(([row,y])=>L[row].map((t,i)=>t?print(lx(i),y,16.72,t,'ox-keylabel'+(t.length>6?' ox-small':''),L.group(row,i)).replace('<span','<span data-item="label:'+L.group(row,i)+':'+t+'"'):'').join('')).join('')
      +print(lx(0),109,40,'ARP CTRL','ox-keyhead','lbl-arp')+print(lx(12),109,40,'TIME DIV','ox-keyhead','lbl-div')
      +print(lx(0),118.5,30,'KEY','ox-keyhead','lbl-key')+print(lx(12),118.5,40,'VOICING','ox-keyhead','lbl-voicing')+print(lx(20),118.5,40,'TYPE','ox-keyhead','lbl-type');
    const knobAt=[[199,27],[241,27],[285,27],[328,27],[219,70],[263,70],[306,70],[350,70]];
    const tracks=this.app.studio.tracks||[];tracks.slice(0,8).forEach((t,i)=>{this.knobs[i]=Math.round((t.volume??.8)*127);});
    const padAt=i=>[380+(i%4)*47,i<4?17:63];
    const learn=[['play','Play button'],['stop','Stop button'],['record','Record button'],['cycle','Loop button'],['volume','Fader (master)'],['faderbtn','Fader button (mute)'],['mod','Mod wheel'],...Array.from({length:8},(_,i)=>['level'+i,'Knob '+(i+1)]),...this.padNotes.map((_,i)=>['pad'+i,'Pad '+(i+1)])];
    p.innerHTML=`<div class="ox-title"><strong>M-AUDIO <span>OXYGEN 25 MKV</span></strong><span class="ox-midi-status"></span><button data-connect>CONNECT MIDI</button><button class="ox-record" data-action="record">RECORD MIDI AUDIO</button><button data-whats>WHAT'S THIS?</button><button data-guide>TRILL GUIDE</button><button data-close aria-label="Close Oxygen panel">&times;</button></div>
<div class="ox-tools"><div class="ox-sample"></div><div class="ox-learn"><label>MIDI Learn<select class="ox-learn-target">${learn.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><button data-learn-selected>${this.learning?'CANCEL LEARN':'LEARN'}</button><button data-panic>PANIC</button></div></div>
<div class="ox-deck"><div class="ox-guide"></div><div class="ox-scroll"><div class="ox-stage"><div class="ox-body${this.helpMode?' ox-helping':''}" role="group" aria-label="Oxygen 25 keyboard">
${print(47,18.5,90,'M-AUDIO','ox-logo')}
<div class="ox-display" style="${at(49,41,58,32)}" data-help="display">025</div>
${print(52,74,12,'ARP','ox-tag','modeleds')}${print(68,74,17,'CHORD','ox-tag','modeleds')}${print(89,74,16,'SCALE','ox-tag','modeleds')}
${print(112,36,28,'NOTE<br>REPEAT','ox-two')}<i class="ox-led" style="${at(123.5,45,5,5)}" data-led="repeat" data-help="nrled"></i>
${print(112,57,28,'DAW')}<i class="ox-led" style="${at(123.5,64,5,5)}" data-led="daw" data-help="dawled"></i>
${hw(54,90,'shift','data-shift','Shift')}${print(50,102,25,'SHIFT')}
${print(82,84,25,'TEMPO')}${hw(86,90,'tempo','data-tempo','Tempo','ox-red')}${print(82,102,25,'SYNC')}
${print(112,79,30,'NOTE<br>REPEAT','ox-two')}${hw(118,90,'noterepeat','data-repeat','Note repeat')}${print(113,102,27,'LATCH')}
${hw(150,90,'faderbtn','data-faderbtn','Fader button')}
${print(48,115,17,'&#9664;')}${print(70,115,17,'&#9654;')}${print(86,115,31,'DAW/PRESET')}
${hw(48,120,'arrows','data-arrow="-1"','Previous')}${hw(70,120,'arrows','data-arrow="1"','Next')}${hw(93,120,'dawpreset','data-dawpreset','DAW or preset mode')}
${print(47,133,19,'&#9664; MODE','ox-tag','arrows')}${print(69,133,19,'MODE &#9654;','ox-tag','arrows')}
${print(55,145,17,'&minus;')}${print(66,145,26,'OCTAVE')}${print(87,145,17,'+')}
${hw(55,150,'octave','data-octave="-1"','Octave down')}${hw(87,150,'octave','data-octave="1"','Octave up')}${print(58,164,42,'TRANSPOSE')}
${print(48,177,26,'PITCH')}${print(88,177,26,'MOD')}
<div class="ox-wheel-slot" style="${at(50,183,22,72)}"></div><div class="ox-wheel-slot" style="${at(90,183,22,72)}"></div>
<input class="ox-wheel" style="${at(52,185,18,68)}" data-pitch data-help="pitch" type="range" min="-2" max="2" step=".01" value="0" aria-label="Pitch wheel">
<input class="ox-wheel" style="${at(92,185,18,68)}" data-mod data-help="mod" type="range" min="0" max="127" value="${Math.round(this.mod*127)}" aria-label="Mod wheel">
${print(45,275.5,84,'OXYGEN<b>25</b>','ox-wordmark')}
<span class="ox-ticks" style="${at(141,28,7,54)}"></span><div class="ox-fader-slot" style="${at(150,25,17,60)}"></div>
<input class="ox-fader" style="${at(150,25,17,60)}" data-master data-help="fader" type="range" min="0" max="1" step=".01" value="${this.volume}" aria-label="Fader (sampler master volume)">
${knobAt.map(([x,y],i)=>`<button class="ox-knob" style="${at(x-8,y-8,16,16)}" data-knob="${i}" data-help="knobs" data-item="knob:${i}" aria-label="Knob ${i+1} (track ${i+1} volume)"><i style="transform:rotate(${-135+this.knobs[i]/127*270}deg)"></i></button>`).join('')}
${[['cycle',225,'Loop','&#10227;'],['stop',259,'Stop','&#9632;'],['play',293,'Play','&#9654;'],['record',327,'Record','&#9679;']].map(([a,x,l,s])=>`<button class="ox-hw ox-transport" style="${at(x,89,17,11)}" data-action="${a}" data-help="${a}" aria-label="${l}">${s}</button>`).join('')}${print(254,103,27,'PANIC','','stop')}
${this.slots.map((s,i)=>{const [x,y]=padAt(i);return `<button class="ox-pad" style="${at(x,y,38,38)}" data-pad="${i}" data-target="${i}" data-help="pads" data-item="pad:${i}" aria-label="Pad ${i+1}"><span>${esc(s?.name||this.app.state.pads[i]?.name||'')}</span></button>`;}).join('')}
${print(380,57,38,'PAD BANK 1','','padbank')}${print(427,57,38,'PAD BANK 2','','padbank')}
${print(334,103,46,'DAW KNOB CONTROL','ox-left ox-small','knobmode')}${['VOLUME','PAN','DEVICE','SENDS'].map((t,i)=>print(380+i*47,103,38,t,'','knobmode')).join('')}<span class="ox-rule" style="${at(334,108.5,226,1)}"></span>
<div class="ox-strip" style="${at(122,107,437,21)}" data-help="keys"></div>${strip}<span class="ox-rule" style="${at(125,118.3,430,.6)}"></span>
<div class="ox-keybed" style="${at(122,126,437,176)}"></div>${keys}
</div></div></div></div>`;
    const body=p.querySelector('.ox-body');
    // WHAT'S THIS? mode: clicks explain a control instead of using it.
    const intercept=e=>{if(!this.helpMode)return;const el=e.target.closest('[data-help]');if(!el)return;e.preventDefault();e.stopPropagation();if(e.type==='click')this.explain(el);};
    ['pointerdown','mousedown','click','input','change','wheel'].forEach(t=>body.addEventListener(t,intercept,{capture:true,passive:false}));
    p.querySelector('[data-close]').onclick=()=>this.app.setState({oxygenOpen:false});
    p.querySelector('[data-guide]').onclick=()=>this.guide(0);
    p.querySelector('[data-whats]').onclick=()=>{this.helpMode=!this.helpMode;body.classList.toggle('ox-helping',this.helpMode);this.leds();this.notify(this.helpMode?"WHAT'S THIS? is on: tap any button, knob, pad, key or label to learn it. Tap WHAT'S THIS? again to play.":'Back to playing.');};
    p.querySelector('[data-connect]').onclick=()=>this.app.initMidi();
    p.querySelector('[data-master]').oninput=e=>this.action('volume',+e.target.value*127);
    p.querySelector('[data-pitch]').oninput=e=>{const v=Math.round((+e.target.value/2+1)*8192);this.midi([224,v&127,Math.min(127,v>>7)]);};
    p.querySelector('[data-pitch]').onchange=e=>{e.target.value=0;this.midi([224,0,64]);};
    p.querySelector('[data-mod]').oninput=e=>{this.action('mod',+e.target.value);this.show(+e.target.value);};
    p.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{if(b.dataset.action==='stop'&&this.useShift()){this.panic();this.show('PAN');return;}this.action(b.dataset.action,127);this.leds();});
    p.querySelector('[data-shift]').onclick=()=>{this.shift=!this.shift;this.leds();};
    p.querySelector('[data-tempo]').onclick=()=>this.useShift()?this.notify('SHIFT + TEMPO = SYNC on the real keyboard: it follows your DAW clock. ScrewShop does not send MIDI clock, so tap TEMPO here to set the studio BPM.'):this.tapTempo();
    p.querySelector('[data-repeat]').onclick=()=>{if(this.useShift()){this.repeat=true;this.latch=!this.latch;}else{this.repeat=!this.repeat;this.latch=false;}if(!this.repeat||!this.latch){clearInterval(this.repeatTimer);this.repeatTimer=null;}this.leds();this.show(this.repeat?(this.latch?'LAT':'r16'):'OFF');};
    p.querySelector('[data-faderbtn]').onclick=()=>this.action('faderbtn',127);
    p.querySelector('[data-dawpreset]').onclick=()=>{if(this.useShift()){this.notify('SHIFT + DAW/PRESET picks the DAW protocol on the real keyboard (Mackie 1/2, Mackie/HUI, MIDI 1/2/3). ScrewShop uses Preset mode + MIDI Learn.');return;}this.daw=!this.daw;this.leds();this.show(this.daw?'DAW':'PRE');};
    p.querySelectorAll('[data-arrow]').forEach(b=>b.onclick=()=>this.arrow(+b.dataset.arrow));
    p.querySelectorAll('[data-octave]').forEach(b=>b.onclick=()=>{
      if(this.useShift()){this.transpose=Math.max(-12,Math.min(12,this.transpose+ +b.dataset.octave));this.show(this.transpose);return;}
      this.panic();this.octave=Math.max(-3,Math.min(4,this.octave+ +b.dataset.octave));this.panel=null;setTimeout(()=>this.show('OC'+(this.octave<0?'-':'')+Math.abs(this.octave)),250);});
    p.querySelector('[data-learn-selected]').onclick=()=>{this.learning=this.learning?null:p.querySelector('.ox-learn-target').value;this.notify(this.learning?'Move or press the hardware control to learn '+this.learning+'.':'MIDI Learn cancelled.');p.querySelector('[data-learn-selected]').textContent=this.learning?'CANCEL LEARN':'LEARN';};
    p.querySelector('[data-panic]').onclick=()=>this.panic();
    p.querySelectorAll('[data-knob]').forEach(k=>{const i=+k.dataset.knob;
      k.onpointerdown=e=>{e.preventDefault();k.setPointerCapture(e.pointerId);const y=e.clientY,start=this.knobs[i];k.onpointermove=m=>this.setKnob(i,start+(y-m.clientY)*1.2,true);};
      k.onpointerup=k.onpointercancel=()=>{k.onpointermove=null;};
      k.onwheel=e=>{e.preventDefault();this.setKnob(i,this.knobs[i]-Math.sign(e.deltaY)*4,true);};
      k.onkeydown=e=>{const d={ArrowUp:4,ArrowRight:4,ArrowDown:-4,ArrowLeft:-4}[e.key];if(d){e.preventDefault();this.setKnob(i,this.knobs[i]+d,true);}};
    });
    p.querySelectorAll('[data-pad]').forEach(b=>{const i=+b.dataset.pad;
      b.onpointerdown=e=>{if(e.button)return;b.setPointerCapture?.(e.pointerId);this.padDown(i);};
      b.onpointerup=b.onpointercancel=()=>this.padUp();
      b.onclick=e=>{if(e.detail===0){this.padDown(i);this.padUp();}};
    });
    p.querySelectorAll('[data-key]').forEach(b=>{
      b.onpointerdown=e=>{e.preventDefault();if(this.useShift()){this.explain(b);return;}b.setPointerCapture(e.pointerId);this.selected='keys';this.keyDown(+b.dataset.key);};
      b.onpointerup=b.onpointercancel=()=>{this.release(+b.dataset.key);this.renderEditor();};
      b.onkeydown=e=>{if(!e.repeat&&(e.key===' '||e.key==='Enter')){e.preventDefault();this.keyDown(+b.dataset.key);}};
      b.onkeyup=e=>{if(e.key===' '||e.key==='Enter')this.release(+b.dataset.key);};
    });
    p.ondragover=e=>{if(e.target.closest('[data-target]')){e.preventDefault();e.dataTransfer.dropEffect='copy';}};
    p.ondrop=async e=>{const target=e.target.closest('[data-target]');if(!target)return;e.preventDefault();e.stopPropagation();try{const raw=e.dataTransfer.getData('application/x-screwshop-loop');const item=raw?JSON.parse(raw):e.dataTransfer.files[0]?await this.app.studio.uploadFile(e.dataTransfer.files[0]):null;if(item)await this.assign(target.dataset.target,item,target.dataset.key?+target.dataset.key:60);}catch(err){this.notify('Could not load sound: '+err.message);}};
    this.renderEditor();this.leds();
    if(this.guideIndex!=null)this.guide(this.guideIndex,this.guideCustom);
  }
  renderEditor() {
    const box=this.panel?.querySelector('.ox-sample');if(!box)return;
    const slot=this.selected==='keys'?this.keySample:this.slots[this.selected];
    box.innerHTML=`<strong>${this.selected==='keys'?'KEYBOARD':'PAD '+(+this.selected+1)}: ${this.esc(slot?.name||'drop a sound on it')}</strong><label>Start (sec)<input data-trim="start" type="number" min="0" step=".001" value="${slot?.start||0}"></label><label>End (sec)<input data-trim="end" type="number" min=".001" step=".001" value="${slot?.end||0}"></label><button data-audition>AUDITION</button><button data-save-hit>SAVE ONE-SHOT</button>`;
    box.querySelectorAll('[data-trim]').forEach(input=>input.onchange=async()=>{const slot=this.selected==='keys'?this.keySample:this.slots[this.selected];if(!slot)return;const buffer=await this.decode(slot);const start=+box.querySelector('[data-trim="start"]').value,end=+box.querySelector('[data-trim="end"]').value;if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>buffer.duration){this.notify('Choose a start and end inside the sound.');this.renderEditor();return;}slot.start=start;slot.end=end;this.save();});
    box.querySelector('[data-audition]').onclick=()=>this.selected==='keys'?this.keyDown(this.rootNote):this.triggerPad(this.selected);
    box.querySelector('[data-save-hit]').onclick=()=>this.saveHit();
  }
  // Lights on the drawn keyboard follow the on-screen state.
  leds() {
    const p=this.panel;if(!p)return;const set=(sel,on)=>p.querySelectorAll(sel).forEach(el=>el.classList.toggle('on',!!on));
    set('[data-shift]',this.shift);set('[data-repeat],[data-led="repeat"]',this.repeat);set('[data-led="daw"]',this.daw);set('[data-faderbtn]',this.muted);
    set('.ox-body [data-action="record"]',this.app.studio.recording);set('.ox-body [data-action="play"]',this.app.studio.playing);set('.ox-body [data-action="cycle"]',this.app.studio.cycle?.on);set('[data-whats]',this.helpMode);
  }
  show(value) {
    const d=this.panel?.querySelector('.ox-display');if(!d)return;d.textContent=String(value).slice(0,3);
    clearTimeout(this.showTimer);this.showTimer=setTimeout(()=>{if(d.isConnected)d.textContent='025';},1500);
  }
  useShift() {const on=this.shift;this.shift=false;this.leds();return on;}
  setKnob(i,value,send) {
    const v=Math.max(0,Math.min(127,Math.round(value)));this.knobs[i]=v;
    const knob=this.panel?.querySelector('[data-knob="'+i+'"] i');if(knob)knob.style.transform='rotate('+(-135+v/127*270)+'deg)';
    if(send){this.action('level'+i,v);this.show(this.app.studio.tracks[i]?v:'---');}
  }
  tapTempo() {
    const now=performance.now();this.taps=(this.taps||[]).filter(t=>now-t<2000);this.taps.push(now);this.tempoAt=now;
    if(this.taps.length>1){const gaps=this.taps.slice(1).map((t,i)=>t-this.taps[i]);this.app.studio.setBpm(60000/(gaps.reduce((a,b)=>a+b)/gaps.length));}
    this.show(this.app.studio.bpm);
  }
  arrow(dir) {
    if(this.useShift()){this.notify('SHIFT + < or > is MODE SELECT on the real keyboard: it cycles Arp, Arp Latch, Smart Chord, Smart Scale and off. Press < and > together to switch the current mode on or off.');return;}
    if(performance.now()-(this.tempoAt||0)<3000){this.tempoAt=performance.now();this.app.studio.setBpm(this.app.studio.bpm+dir);this.show(this.app.studio.bpm);return;}
    const order=[0,1,2,3,4,5,6,7,'keys'],i=order.indexOf(this.selected);this.selected=order[(i+dir+order.length)%order.length];
    this.renderEditor();this.show(this.selected==='keys'?'KEY':'P'+(this.selected+1));
  }
  padDown(i) {
    if(this.useShift()){this.explain(this.panel.querySelector('[data-pad="'+i+'"]'));return;}
    this.selected=i;this.triggerPad(i);this.renderEditor();
    if(this.repeat){clearInterval(this.repeatTimer);this.repeatTimer=setInterval(()=>this.triggerPad(i),this.app.studio.beat()*250);}
  }
  padUp() {if(!this.latch){clearInterval(this.repeatTimer);this.repeatTimer=null;}}
  async saveHit() {
    const slot=this.selected==='keys'?this.keySample:this.slots[this.selected];if(!slot)return;
    const name=prompt('Name this one-shot:',slot.name+' hit');if(!name?.trim())return;
    try{const buffer=await this.decode(slot),rate=buffer.sampleRate,start=Math.floor(slot.start*rate),end=Math.min(buffer.length,Math.ceil(slot.end*rate)),frames=end-start,ch=buffer.numberOfChannels;
      const bytes=new ArrayBuffer(44+frames*ch*2),view=new DataView(bytes);const str=(offset,s)=>[...s].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
      str(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,ch,true);view.setUint32(24,rate,true);view.setUint32(28,rate*ch*2,true);view.setUint16(32,ch*2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,frames*ch*2,true);
      for(let i=0;i<frames;i++)for(let c=0;c<ch;c++){const fade=Math.min(1,i/(rate*.003),(frames-1-i)/(rate*.003));const x=Math.max(-1,Math.min(1,buffer.getChannelData(c)[start+i]*fade));view.setInt16(44+(i*ch+c)*2,Math.round(x*(x<0?32768:32767)),true);}
      const item=await this.app.studio.uploadFile(new File([bytes],name.trim()+'.wav',{type:'audio/wav'}));await this.assign(this.selected,item,this.rootNote);await this.app.loadLibrary();this.notify('Saved one reusable hit: '+name+'. Each pad press plays it once.');
    }catch(e){this.notify('One-shot could not save: '+e.message);}
  }
  // Shift functions printed above the 25 keys, left to right (Oxygen 25 MKV user guide).
  labels() {
    const top=['UP','DOWN','INCL','EXCL','ORDER','RANDOM','CHORD','GATE','SWING','OCT 0','OCT 1','OCT 2','1/4','1/4T','1/8','1/8T','1/16','1/16T','1/32','1/32T','','','','',''];
    const bottom=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B','1,3,5','1,3,7','1,3,5,7','1,5,9','1,5,12','3,5,1','5,1,3','RANDOM','MAJOR','MINOR','CUSTOM','CHANNEL','VELOCITY'];
    const group=(row,i)=>row==='top'?(i<7?'lbl-arp':i===7?'lbl-gate':i===8?'lbl-swing':i<12?'lbl-oct':'lbl-div'):(i<12?'lbl-key':i<20?'lbl-voicing':i<23?'lbl-type':i===23?'lbl-channel':'lbl-velocity');
    return {top,bottom,group};
  }
  labelHelp(group,t) {
    const arp={UP:'lowest to highest',DOWN:'highest to lowest',INCL:'up then down, playing the top and bottom notes twice (inclusive)',EXCL:'up then down without repeating the top and bottom notes (exclusive)',ORDER:'in the order you pressed them',RANDOM:'in random order',CHORD:'all together as a chord, re-struck in rhythm'};
    const voicing={'1,3,5':'root, 3rd and 5th: a plain triad','1,3,7':'root, 3rd and 7th: a lighter seventh sound','1,3,5,7':'root, 3rd, 5th and 7th: a full seventh chord','1,5,9':'root, 5th and 9th: open and airy','1,5,12':'root, 5th and the 5th an octave up: a wide power stack','3,5,1':'the triad with the 3rd on the bottom (1st inversion)','5,1,3':'the triad with the 5th on the bottom (2nd inversion)',RANDOM:'a different voicing each time'};
    return {
      'lbl-arp':'ARP CTRL: SHIFT + '+t+' makes the arpeggiator play held notes '+arp[t]+'. Turn ARP on with SHIFT + < or > (MODE SELECT).',
      'lbl-gate':'GATE: SHIFT + this key sets how long each arpeggiated note lasts. Short is choppy, long is smooth.',
      'lbl-swing':'SWING: SHIFT + this key pushes every other arpeggiated note late for a shuffle or bounce.',
      'lbl-oct':t+': SHIFT + this key sets how many extra octaves the arp pattern climbs (0, 1 or 2).',
      'lbl-div':'TIME DIV '+t+': SHIFT + this key sets the arp and NOTE REPEAT speed. 1/4 = one note per beat, 1/8 = two, 1/16 = four, 1/32 = eight. T = triplet (three notes in the space of two).',
      'lbl-key':'KEY '+t+': SHIFT + this key makes '+t+' the home key for Smart Chord and Smart Scale.',
      'lbl-voicing':'VOICING '+t+': with Smart Chord on, SHIFT + this key makes one finger play '+voicing[t]+'.',
      'lbl-type':'TYPE '+t+': SHIFT + this key sets the chord type for Smart Chord (MAJOR, MINOR, CUSTOM). In Smart Scale it picks the scale: Major, Pentatonic Major, Minor, Melodic Minor, Harmonic Minor, Pentatonic Minor, Custom Dorian or Custom Blues.',
      'lbl-channel':'CHANNEL: SHIFT + this key changes the MIDI channel the keys, pads or controls send on (whichever you touched last). ScrewShop hears every channel. If the pads stop working after a change, learn them again.',
      'lbl-velocity':'VELOCITY: SHIFT + this key changes the velocity curve for the keys or pads (whichever you played last). That sets how hard you must hit to get loud.'
    }[group]||'';
  }
  itemHelp(item) {
    const [kind,a,...rest]=item.split(':'),i=+a;
    if(kind==='knob')return ['Knob '+(i+1),'The real knob sends a MIDI CC in Preset mode. In DAW mode it controls track '+(i+1)+' volume, pan, device or sends (choose with SHIFT + pads 5-8). In ScrewShop, drag this knob up or down (or scroll it) to set the volume of timeline track '+(i+1)+'. To use the hardware knob, pick "Knob '+(i+1)+'" in MIDI Learn, press LEARN, then turn it.'];
    if(kind==='pad'){const shift=['SHIFT + this pad = PAD BANK 1: all 8 pads switch to bank 1 notes.','SHIFT + this pad = PAD BANK 2: all 8 pads switch to bank 2 notes, a second set of 8 sounds.','This pad has no SHIFT function.','This pad has no SHIFT function.','SHIFT + this pad = VOLUME: in DAW mode all 8 knobs control track volumes.','SHIFT + this pad = PAN: in DAW mode the knobs pan tracks left and right.','SHIFT + this pad = DEVICE: in DAW mode the knobs control the selected instrument or effect.','SHIFT + this pad = SENDS: in DAW mode the knobs set aux send levels (reverb or delay buses).'][i];
      return ['Pad '+(i+1),'Velocity-sensitive: hit it harder and it plays louder. Drag a sound from the library onto it. One press plays the sound once, and holding it with NOTE REPEAT on rolls it. '+shift+' If the real pad plays the wrong sound, pick "Pad '+(i+1)+'" in MIDI Learn and hit it.'];}
    if(kind==='key'){const L=this.labels(),note=48+this.octave*12+i,name=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][note%12]+(Math.floor(note/12)-1);
      const shift=[['top',L.top[i]],['bottom',L.bottom[i]]].filter(x=>x[1]).map(([row,t])=>this.labelHelp(L.group(row,i),t)).join(' ');
      return ['Key '+name,'Plays '+name+'. Drop an instrument sample on a key to make it the root pitch. Other keys play it higher or lower, and it keeps playing until you let go or the sample ends. SHIFT functions printed above this key: '+shift];}
    if(kind==='label'){const t=rest.join(':');return [t,this.labelHelp(a,t)];}
    return null;
  }
  explain(el) {
    const i=this.steps().findIndex(s=>s[0]===el.dataset.help);
    this.guide(i<0?0:i,el.dataset.item?this.itemHelp(el.dataset.item):null);
  }
  steps() {
    return [
      ['','Your Oxygen 25 (MKV)','This drawer is drawn from the real keyboard. Connect USB, press CONNECT MIDI and allow browser MIDI access. Oxygen controls sounds in ScrewShop; it does not store audio files. Press NEXT to go through every control, or tap WHAT\'S THIS? and then tap any part.'],
      ['display','LED display','Three digits that show the preset number (025 at start-up), the value of whatever you just moved or pressed, and programming info. On screen it shows tempo, octave, knob and fader values as you change them.'],
      ['modeleds','ARP / CHORD / SCALE lights','The dots under the display show the active mode. ARP lit = arpeggiator on, ARP flashing = Arp Latch, CHORD = Smart Chord, SCALE = Smart Scale. These modes run inside the keyboard, and ScrewShop simply plays the notes it sends.'],
      ['shift','SHIFT','Hold SHIFT and press or move another control to get its second function. Those are the smaller labels printed under buttons and above the keys. On screen, tap SHIFT once and it applies to the next thing you press.'],
      ['tempo','TEMPO / SYNC','Tap TEMPO in rhythm to set the tempo. Hold it and press < or > to nudge by 1 BPM. SHIFT + TEMPO = SYNC, which follows your DAW clock. Tempo drives the arpeggiator and note repeat. On screen, tapping TEMPO sets the studio BPM, and < or > right after nudges it.'],
      ['noterepeat','NOTE REPEAT / LATCH','Turns on note repeat: a held pad re-hits at the current time division. SHIFT + NOTE REPEAT latches it so it keeps going after you let go. While it is on, SHIFT + a TIME DIV key (or < and >) changes the speed. On screen, held pads roll in 1/16 notes at the studio BPM.'],
      ['nrled','NOTE REPEAT light','Lit solid while note repeat is on.'],
      ['dawled','DAW light','Lit solid while DAW mode is on (see DAW / PRESET).'],
      ['fader','Fader','Sends a MIDI CC in Preset mode or a track fader in DAW mode. In ScrewShop it is the sampler master volume: drag it here, or the hardware fader controls it on CC7. You can also assign it with MIDI Learn.'],
      ['faderbtn','Fader button','The button under the fader is mappable. In DAW mode it sends mute or select style messages. In ScrewShop it mutes and unmutes the sampler (lit = muted). Learn "Fader button" to use the hardware one.'],
      ['knobs','Knobs 1-8','Eight assignable knobs. Preset mode: each sends its own MIDI CC. DAW mode: track volume, pan, device or sends. In ScrewShop, knob N sets the volume of timeline track N: drag up or down, scroll, or learn the hardware knob. Tap any knob in WHAT\'S THIS? for its details.'],
      ['cycle','Loop','Turns loop (cycle) on or off. In ScrewShop it toggles the cycle region on the timeline.'],
      ['stop','Stop / PANIC','Stops playback, and a double-press returns to the start. SHIFT + STOP = PANIC, which sends All Notes Off on all 16 MIDI channels. In ScrewShop it stops playback or the current take and silences the sampler.'],
      ['play','Play','Starts playback. In ScrewShop it plays or pauses the timeline.'],
      ['record','Record','Arms recording. In ScrewShop it records what the sampler plays as a new audio track. Backing tracks are not re-recorded.'],
      ['pads','Pads 1-8','Velocity-sensitive pads that send notes. Drag a sound onto a pad. One press plays it once. Use Start and End above to cut out one hit, then SAVE ONE-SHOT. Hold SHIFT on a pad for its second job. If the hardware pads play the wrong sounds, use MIDI Learn.'],
      ['padbank','PAD BANK 1 / 2','SHIFT + pad 1 or pad 2 switches all 8 pads between two banks of notes, giving you 16 sounds. Bank 2 sends different notes, so learn the pads again if you use it in ScrewShop.'],
      ['knobmode','DAW KNOB CONTROL','In DAW mode, SHIFT + pad 5, 6, 7 or 8 sets all eight knobs to VOLUME, PAN, DEVICE or SENDS for the matching DAW tracks. Not every DAW supports every mode. In ScrewShop the knobs always set track volume.'],
      ['arrows','< > / MODE SELECT','Preset mode: step through presets. DAW mode: scroll track banks. Edit mode: pick the control to edit. During note repeat: change the time division. SHIFT + < or > = MODE SELECT, which cycles Arp, Arp Latch, Smart Chord, Smart Scale and off. Press both together to switch the current mode on or off. On screen, they choose which pad the sample editor above shows.'],
      ['dawpreset','DAW / PRESET','Switches between DAW mode (the controls drive your DAW mixer and transport) and Preset mode (use < and > to pick presets). SHIFT + DAW/PRESET picks the DAW protocol: MC1 Mackie 1 (Cubase, Studio One, Reaper), MC2 Mackie 2 (finer pan), M|H Mackie/HUI (Pro Tools, Logic), M1 MIDI 1 (Ableton), M2 MIDI 2 (MPC Beats, Reason), M3 MIDI 3 (Ableton clip launching). ScrewShop is not a Mackie DAW, so use Preset mode + MIDI Learn here.'],
      ['octave','OCTAVE - / + (TRANSPOSE)','Shifts the keys (and pad range) down or up one octave. SHIFT + either button transposes by a semitone. On screen, OCTAVE changes the key range and SHIFT + OCTAVE transposes the sampler.'],
      ['pitch','PITCH wheel','Spring-loaded wheel. Roll it up to raise pitch, down to lower it, and let go to snap back. The range is set by the instrument receiving it. In ScrewShop it bends the keyboard sample up to 2 semitones.'],
      ['mod','MOD wheel','Adds expression. Most synths use it for vibrato or tremolo, and it can be reassigned. In ScrewShop it turns held notes down by up to 60%.'],
      ['keys','25 keys','Velocity-sensitive keys that send notes. Drop an instrument sample on a key to set its root pitch, and the other keys transpose it. Hold SHIFT and press a labeled key for the programming functions printed above (next steps). While a mode is active, only that mode\'s SHIFT functions work.'],
      ['lbl-arp','ARP CTRL: UP to CHORD','SHIFT + these keys pick the arpeggiator order: UP, DOWN, INCL (up and down, repeating the ends), EXCL (up and down, not repeating the ends), ORDER (as played), RANDOM, CHORD (all together).'],
      ['lbl-gate','GATE','SHIFT + GATE sets how long each arpeggiated note lasts.'],
      ['lbl-swing','SWING','SHIFT + SWING delays every other arpeggiated note for a shuffle feel.'],
      ['lbl-oct','OCT 0 / 1 / 2','SHIFT + these keys set how many extra octaves the arpeggio covers.'],
      ['lbl-div','TIME DIV','SHIFT + 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32 or 1/32T sets the arp and note repeat speed. T = triplet.'],
      ['lbl-key','KEY: C to B','SHIFT + these 12 keys set the home key for Smart Chord and Smart Scale.'],
      ['lbl-voicing','VOICING','With Smart Chord on, SHIFT + these keys choose the chord one finger plays: 1,3,5 / 1,3,7 / 1,3,5,7 / 1,5,9 / 1,5,12 / 3,5,1 / 5,1,3 / RANDOM (numbers are scale degrees).'],
      ['lbl-type','TYPE','SHIFT + MAJOR, MINOR or CUSTOM picks the Smart Chord type. In Smart Scale it picks the scale: Major, Pentatonic Major, Minor, Melodic Minor, Harmonic Minor, Pentatonic Minor, Custom Dorian, Custom Blues.'],
      ['lbl-channel','CHANNEL','SHIFT + CHANNEL changes the MIDI channel for the keys, pads or controls you touched last.'],
      ['lbl-velocity','VELOCITY','SHIFT + VELOCITY changes the velocity curve for the keys or pads, which sets how hard you must play to get loud.'],
      ['','Back panel','USB powers the keyboard and carries MIDI. SUSTAIN takes a foot pedal, and ScrewShop holds notes on CC64. Do not press the pedal while powering on, or it works backwards. POWER switches it on, and the Kensington slot is for a lock cable. More settings live in the Oxygen Preset Editor from m-audio.com.'],
      ['','Build and layer','Record drums, stop, then load a bass or piano sample and record another pass. Each pass becomes an audio region you can split, move and undo. Open the 16-step sequencer below for repeating patterns.'],
      ['','Your local sound folders','BEATS & IMPORTS keeps source files. SPLITZ holds each quick or full revision. Full splits include distinct sample candidates, not every repetition. Preview, trim, and NAME & SAVE PACK to make an independent named copy.']
    ];
  }
  guide(index,custom) {
    const steps=this.steps();this.guideIndex=Math.max(0,Math.min(steps.length-1,index));this.guideCustom=custom||null;
    const p=this.panel,box=p?.querySelector('.ox-guide');if(!box)return;
    const [id,title,body]=steps[this.guideIndex],[t,b]=custom||[title,body];
    p.querySelectorAll('.ox-lit').forEach(e=>e.classList.remove('ox-lit'));
    const lit=id?[...p.querySelectorAll('.ox-body [data-help="'+id+'"]')]:[];lit.forEach(e=>e.classList.add('ox-lit'));
        box.innerHTML='<img src="/assets/trill.png" alt="Trill"><div class="ox-guide-copy"><small>'+(custom?"TRILL / WHAT'S THIS?":'TRILL / '+(this.guideIndex+1)+' OF '+steps.length)+'</small><h4>'+this.esc(t)+'</h4><p>'+this.esc(b)+'</p><select data-jump aria-label="Jump to a control">'+steps.map((s,i)=>'<option value="'+i+'"'+(i===this.guideIndex?' selected':'')+'>'+(i+1)+'. '+this.esc(s[1])+'</option>').join('')+'</select> <a href="https://cdn.inmusicbrands.com/m-audio/maudio_documentation/Oxygen%20Series%20MKV%20-%20User%20Guide%20-%20v1.2.pdf" target="_blank" rel="noopener noreferrer">Oxygen 25 MKV manual</a></div><div class="ox-guide-nav"><button data-back>BACK</button><button data-next>NEXT</button><button data-done>CLOSE</button></div>';
    const close=()=>{this.guideIndex=null;this.guideCustom=null;box.innerHTML='';p.querySelectorAll('.ox-lit').forEach(e=>e.classList.remove('ox-lit'));};
    box.querySelector('[data-back]').onclick=()=>this.guide(this.guideIndex-1);
    box.querySelector('[data-next]').onclick=()=>this.guideIndex===steps.length-1?close():this.guide(this.guideIndex+1);
    box.querySelector('[data-done]').onclick=close;
    box.querySelector('[data-jump]').onchange=e=>this.guide(+e.target.value);
    lit[0]?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  dispose() {clearInterval(this.timer);this.panic();this.previewAudio?.pause();this.bus?.disconnect();}
};
