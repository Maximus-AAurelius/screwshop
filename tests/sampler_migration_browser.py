"""Existing Oxygen/legacy pads and patterns migrate without replacing their records."""
import os, sys, tempfile, threading, wave
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from local_server import make_server

with tempfile.TemporaryDirectory() as temp:
    server=make_server(temp,port=0)
    source=server.store.asset('stems','local/legacy.wav');source.parent.mkdir(parents=True)
    with wave.open(str(source),'wb') as w:
        w.setparams((1,2,22050,0,'NONE','not compressed'));w.writeframes(b'\0\0'*22050)
    url='/audio/stems/local/legacy.wav'
    oxygen={'id':'oxygen-workspace','slots':[{'name':'Existing chop','url':url,'start':.1,'end':.4}],
            'keySample':{'name':'Existing keys','url':url,'start':0,'end':1},'rootNote':57,
            'padNotes':[{'note':40,'channel':2}],'maps':{'volume':{'type':176,'channel':0,'number':12}}}
    server.store.query({'table':'settings','action':'upsert','values':oxygen})
    server.store.query({'table':'pads','action':'insert','values':{'pad_index':2,'label':'Old pad','storage_path':'local/legacy.wav'}})
    steps=[[i in (0,4,8,12) for i in range(16)]]
    server.store.query({'table':'settings','action':'upsert','values':{'id':'studio','steps':steps,'bpm':93}})
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as p:
            chrome=os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
            browser=p.chromium.launch(executable_path=chrome,headless=True)
            page=browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/barwork')
            page.evaluate('''()=>{const tick=StudioWorkspace.prototype.tick;StudioWorkspace.prototype.tick=function(){window.sampler=this;return tick.call(this)}}''')
            page.wait_for_function('window.sampler?.ready && sampler.buffers.size>0')
            assert page.evaluate('sampler.slots[0].start')==.1
            assert page.evaluate('sampler.slots[2].name')=='Old pad'
            assert page.evaluate('sampler.slots[16].name')=='Existing keys'
            assert page.evaluate('sampler.project.root')==57
            assert page.evaluate('sampler.project.maps["master"].number')==12
            assert page.evaluate('sampler.project.maps["pad:0"].channel')==2
            assert page.evaluate('sampler.pattern.events.length')==4
            assert page.evaluate('sampler.project.bpm')==93
            page.evaluate('sampler.save()')
            original=server.store.query({'table':'settings','filters':[['id','oxygen-workspace']],'single':'required'})
            assert original['slots']==oxygen['slots'] and original['rootNote']==57
            assert len(server.store.query({'table':'pads'}))==1
            assert source.is_file()
            print('PASS: legacy Oxygen samples, trims, root, MIDI controls, pad records and step patterns preserved and migrated')
            browser.close()
    finally:
        server.shutdown();thread.join();server.server_close()
