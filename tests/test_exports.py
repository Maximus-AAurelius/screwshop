import json
import sys
import tempfile
import unittest
import wave
import zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from local_store import Store
from studio_exports import FULL_STEMS, save_stem, save_pack, reuse_stem, safe_export_path, save_mp3, mp3_available


def seed_pack(store):
    source = store.asset('beats', 'local/source.wav')
    source.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(source), 'wb') as audio:
        audio.setnchannels(2); audio.setsampwidth(2); audio.setframerate(44100)
        audio.writeframes(b'\0' * 44100 * 4 * 8)
    store.query({'table':'beats','action':'upsert','values':{'id':'beat-test','label':'Test track','storage_path':'local/source.wav'}})
    job = store.query({'table':'split_jobs','action':'insert','values':{'beat_id':'beat-test','mode':'full'},'single':'required'})
    stems = {}
    for kind in FULL_STEMS:
        relative = f"local/beat-test/{job['id']}/{kind}.wav"
        path = store.asset('stems', relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(source.read_bytes())
        stems[kind] = store.query({'table':'stems','action':'upsert','values':{'beat_id':'beat-test','kind':kind,'storage_path':relative},'single':'required'})
    store.query({'table':'split_jobs','action':'update','filters':[['id',job['id']]],'values':{'status':'done'}})
    return job, stems


class ExportTests(unittest.TestCase):
    def test_mp3_encode_and_input_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            seed_pack(store)
            for path in ['../private.wav', 'https://example.com/a.wav', 'local/missing.wav']:
                with self.assertRaises(ValueError):
                    save_mp3(store, path, 'Nope')
            bad = store.asset('beats', 'local/playlist.wav')
            bad.write_text('file https://example.com/private')
            with self.assertRaises(ValueError):
                save_mp3(store, 'local/playlist.wav', 'Nope')
            if not mp3_available():
                self.skipTest('Local MP3 encoder unavailable')
            result = save_mp3(store, 'local/source.wav', 'Beat sharing')
            row = store.query({'table':'exports','filters':[['id',result['id']]],'single':'required'})
            self.assertEqual(row['download_name'], 'Beat-sharing.mp3')
            self.assertGreater(safe_export_path(store, row['relative_path']).stat().st_size, 1000)
            self.assertTrue(store.asset('beats', 'local/source.wav').is_file())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.job, self.stems = seed_pack(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_individual_wav_and_reuse_do_not_change_lyrics(self):
        self.store.query({'table':'songs','action':'upsert','values':{'id':'song','meta':json.dumps({'lines':['Keep these lyrics']})}})
        stem = self.stems['instrumental']
        saved = save_stem(self.store, stem['id'])
        record = self.store.query({'table':'exports','filters':[['id',saved['id']]],'single':'required'})
        exported = safe_export_path(self.store, record['relative_path'])
        self.assertEqual(exported.read_bytes(), self.store.asset('stems',stem['storage_path']).read_bytes())
        row = reuse_stem(self.store, stem['id'])
        self.assertEqual(reuse_stem(self.store, stem['id'])['id'], row['id'])
        self.assertEqual(len(self.store.query({'table':'library'})), 1)
        self.store.asset('stems',stem['storage_path']).write_bytes(b'changed source')
        self.assertNotEqual(self.store.asset('beats',row['storage_path']).read_bytes(), b'changed source')
        self.assertEqual(json.loads(self.store.query({'table':'songs','single':'required'})['meta'])['lines'], ['Keep these lyrics'])

    def test_pack_has_aligned_wavs_manifest_and_is_repeatable(self):
        saved = save_pack(self.store, beat_id='beat-test')
        row = self.store.query({'table':'exports','filters':[['id',saved['id']]],'single':'required'})
        archive = safe_export_path(self.store, row['relative_path'])
        with zipfile.ZipFile(archive) as z:
            self.assertEqual(len([n for n in z.namelist() if n.endswith('.wav')]), 7)
            meta = json.loads(z.read(next(n for n in z.namelist() if n.endswith('manifest.json'))))
            self.assertEqual({v['frames'] for v in meta['files'].values()}, {44100 * 8})
        self.assertEqual(save_pack(self.store, beat_id='beat-test')['id'], saved['id'])

    def test_missing_stem_never_produces_partial_pack(self):
        self.store.asset('stems',self.stems['piano']['storage_path']).unlink()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            save_pack(self.store, beat_id='beat-test')
        self.assertEqual(list(self.store.beats_root.rglob('*.zip')), [])

    def test_export_path_cannot_escape(self):
        for path in ['../private.wav', '/outside.wav', 'C:/secret.wav', 'a\\..\\private.zip', 'secret.pem']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                safe_export_path(self.store,path)


if __name__ == '__main__':
    unittest.main()
