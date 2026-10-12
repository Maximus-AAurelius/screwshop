"""Deleted Files: rows go, unused audio moves, audio still in use stays put."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from local_store import Store
from trash import move_to_trash


class TrashTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.store.trash_root = Path(self.temp.name) / "Deleted Files"

    def tearDown(self):
        self.temp.cleanup()

    def audio(self, bucket, name):
        path = self.store.asset(bucket, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"RIFF")
        return path

    def insert(self, table, values):
        return self.store.query({"table": table, "action": "upsert", "values": values})[0]

    def rows(self, table):
        return self.store.query({"table": table})

    def test_song_with_stems_moves_everything_unused(self):
        song = self.audio("beats", "local/song.wav")
        stem = self.audio("stems", "SPLITZ/song/vocals.wav")
        self.insert("library", {"id": "song", "name": "My Song", "storage_path": "local/song.wav"})
        self.insert("beats", {"id": "b1", "label": "My Song", "storage_path": "local/song.wav"})
        self.insert("stems", {"id": "s1", "beat_id": "b1", "kind": "vocals", "storage_path": "SPLITZ/song/vocals.wav"})
        self.insert("settings", {"id": "split-1", "folder_type": "split", "beat_id": "b1", "files": [{"bucket": "stems", "storage_path": "SPLITZ/song/vocals.wav"}]})
        result = move_to_trash(self.store, [{"table": "library", "id": "song", "with_stems": True}])
        self.assertEqual(result["removed"], 4)
        self.assertFalse(song.exists())
        self.assertFalse(stem.exists())
        folder = self.store.trash_root / result["folder"]
        self.assertTrue((folder / "beats" / "song.wav").is_file())
        self.assertTrue((folder / "stems" / "vocals.wav").is_file())
        manifest = json.loads((folder / "item.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "My Song")
        self.assertEqual(self.rows("stems"), [])
        self.assertEqual([r["id"] for r in self.rows("settings")], [])

    def test_song_without_stems_keeps_stems(self):
        song = self.audio("beats", "local/song.wav")
        stem = self.audio("stems", "SPLITZ/song/vocals.wav")
        self.insert("library", {"id": "song", "name": "My Song", "storage_path": "local/song.wav"})
        self.insert("beats", {"id": "b1", "label": "My Song", "storage_path": "local/song.wav"})
        self.insert("stems", {"id": "s1", "beat_id": "b1", "kind": "vocals", "storage_path": "SPLITZ/song/vocals.wav"})
        move_to_trash(self.store, [{"table": "library", "id": "song"}])
        self.assertFalse(song.exists(), "the bookkeeping beats row must not keep the song alive")
        self.assertTrue(stem.exists())
        self.assertEqual(len(self.rows("stems")), 1)

    def test_audio_used_by_studio_is_kept(self):
        song = self.audio("beats", "local/My Beat.wav")
        self.insert("library", {"id": "song", "name": "Beat", "storage_path": "local/My Beat.wav"})
        self.insert("settings", {"id": "studio-session", "tracks": [{"clips": [{"url": "/audio/beats/local/My%20Beat.wav"}]}]})
        result = move_to_trash(self.store, [{"table": "library", "id": "song"}])
        self.assertTrue(song.exists())
        self.assertEqual(result["kept"], ["My Beat.wav"])
        self.assertEqual(self.rows("library"), [])

    def test_notepad_song_saves_lyrics(self):
        self.insert("songs", {"id": "lyric", "title": "Night Ride", "meta": json.dumps({"lines": ["bar one", "bar two"]})})
        result = move_to_trash(self.store, [{"table": "songs", "id": "lyric"}])
        text = (self.store.trash_root / result["folder"] / "Night Ride.md").read_text(encoding="utf-8")
        self.assertIn("bar two", text)
        self.assertFalse((Path(self.temp.name) / "Obsidian" / "Songs" / "lyric.md").exists())
        self.assertEqual(self.rows("songs"), [])

    def test_refuses_app_state_rows(self):
        self.insert("settings", {"id": "studio-session", "tracks": []})
        with self.assertRaises(ValueError):
            move_to_trash(self.store, [{"table": "settings", "id": "studio-session"}])
        self.assertEqual(len(self.rows("settings")), 1)

    def test_single_stem_leaves_its_split_folder(self):
        stem = self.audio("stems", "SPLITZ/song/drums.wav")
        self.insert("stems", {"id": "s1", "beat_id": "b1", "kind": "drums", "storage_path": "SPLITZ/song/drums.wav"})
        self.insert("settings", {"id": "split-1", "folder_type": "split", "beat_id": "b1", "files": [
            {"bucket": "stems", "storage_path": "SPLITZ/song/drums.wav"}, {"bucket": "stems", "storage_path": "SPLITZ/song/bass.wav"}]})
        move_to_trash(self.store, [{"table": "stems", "id": "s1"}])
        self.assertFalse(stem.exists())
        folder = self.rows("settings")[0]
        self.assertEqual([f["storage_path"] for f in folder["files"]], ["SPLITZ/song/bass.wav"])

    def test_one_sound_out_of_a_pack(self):
        hit = self.audio("beats", "packs/kick.wav")
        self.insert("settings", {"id": "pack-1", "folder_type": "pack", "name": "Drums", "files": [
            {"name": "Kick", "bucket": "beats", "storage_path": "packs/kick.wav"}, {"name": "Snare", "bucket": "beats", "storage_path": "packs/snare.wav"}]})
        move_to_trash(self.store, [{"table": "settings", "id": "pack-1", "file": "packs/kick.wav"}], "Kick")
        self.assertFalse(hit.exists())
        self.assertEqual([f["name"] for f in self.rows("settings")[0]["files"]], ["Snare"])

    def test_note_only_entries_are_logged(self):
        result = move_to_trash(self.store, [{"note": {"name": "Hook chop", "start": 1, "end": 2}}], "Hook chop")
        manifest = json.loads((self.store.trash_root / result["folder"] / "item.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["list_items"][0]["name"], "Hook chop")


if __name__ == "__main__":
    unittest.main()
