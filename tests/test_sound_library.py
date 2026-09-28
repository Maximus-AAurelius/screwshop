import sys, unittest, tempfile
from pathlib import Path
import numpy as np
import soundfile as sf
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from sound_library import sample_candidates,index_split,save_library_pack
from test_exports import seed_pack
from local_store import Store

class SoundLibraryTests(unittest.TestCase):
    def test_repeated_kicks_become_one_reusable_hit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); rate=44100;t=np.arange(rate//5)/rate
            kick=np.sin(2*np.pi*65*t)*np.exp(-t*24)
            audio=np.zeros(rate*5)
            for i in range(5):audio[i*rate:i*rate+len(kick)]=kick*(.4+i*.1)
            sf.write(root/'drums.wav',audio,rate)
            hits=sample_candidates(root/'drums.wav',root/'hits','drums')
            self.assertEqual(len(hits),1)
            self.assertLess(hits[0]['duration'],1)
            self.assertGreater(np.max(np.abs(sf.read(hits[0]['path'])[0])),.1)

    def test_split_folders_named_pack_copies_and_path_safety(self):
        with tempfile.TemporaryDirectory() as temp:
            store=Store(temp);job,_=seed_pack(store)
            folder=index_split(store,job)
            self.assertEqual(len(folder['files']),7) # silence must not create fake hits
            self.assertTrue(all(x['storage_path'].startswith('SPLITZ/') for x in folder['files']))
            pack=save_library_pack(store,folder['id'],'My drum kit')
            self.assertEqual(pack['name'],'My drum kit')
            for x in pack['files']:
                self.assertTrue(x['storage_path'].startswith('Packs/My-drum-kit-'))
                self.assertTrue(store.asset(x['bucket'],x['storage_path']).is_file())
            bad={**folder,'id':'bad-folder','files':[{'bucket':'stems','storage_path':'../../outside.wav','name':'bad'}]}
            store.query({'table':'settings','action':'upsert','values':bad})
            with self.assertRaises(ValueError):save_library_pack(store,'bad-folder','escape')
            quick=index_split(store,{**job,'id':job['id'],'mode':'quick'})
            self.assertEqual([x['name'] for x in quick['files']],['vocals','instrumental'])

if __name__=='__main__':unittest.main()
