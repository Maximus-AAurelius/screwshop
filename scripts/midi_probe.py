"""Read the connected MIDI device in Chromium without loading or changing a project."""
import argparse
import json
import os
import tempfile
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from local_server import make_server


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds',type=int,default=30)
    seconds=max(1,min(60,parser.parse_args().seconds))
    with tempfile.TemporaryDirectory(prefix='screwshop-midi-probe-') as temp:
        server=make_server(temp,port=0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as p:
                chrome=os.environ.get('SS_CHROME') or str(sorted((Path(os.environ['LOCALAPPDATA'])/'ms-playwright').glob('chromium-*/chrome-win64/chrome.exe'))[-1])
                browser=p.chromium.launch(executable_path=chrome,headless=True)
                context=browser.new_context(permissions=['midi','midi-sysex'])
                page=context.new_page()
                # A static JSON page supplies a secure loopback origin without opening the app.
                page.goto(f'http://127.0.0.1:{server.server_port}/manifest.webmanifest')
                devices=page.evaluate('''async()=>{
                    window.midiEvents=[];window.midiAccess=await navigator.requestMIDIAccess();
                    const devices=[];for(const input of midiAccess.inputs.values()){
                        await input.open();devices.push({name:input.name,state:input.state,connection:input.connection});
                        input.onmidimessage=e=>{if(midiEvents.length<1000)midiEvents.push({port:input.name,at:e.receivedTime,data:Array.from(e.data)});};
                    }return devices;
                }''')
                print('Browser MIDI inputs: '+json.dumps(devices),flush=True)
                print(f'Listening for {seconds} seconds. Play repeated keys/pads now.',flush=True)
                page.wait_for_timeout(seconds*1000)
                events=page.evaluate('midiEvents')
                ons=[e for e in events if e['data'][0]&240==144 and len(e['data'])>2 and e['data'][2]>0]
                offs=[e for e in events if e['data'][0]&240==128 or e['data'][0]&240==144 and len(e['data'])>2 and e['data'][2]==0]
                gaps=[];last={}
                for e in ons:
                    key=(e['port'],e['data'][0]&15,e['data'][1])
                    if key in last:gaps.append(round(e['at']-last[key],2))
                    last[key]=e['at']
                print(json.dumps({'note_ons':len(ons),'note_offs':len(offs),'fastest_repeat_ms':min(gaps) if gaps else None,'notes':sorted(set(e['data'][1] for e in ons)),'velocity_range':[min(e['data'][2] for e in ons),max(e['data'][2] for e in ons)] if ons else None}),flush=True)
                browser.close()
        finally:
            server.shutdown();thread.join();server.server_close()


if __name__=='__main__':main()
