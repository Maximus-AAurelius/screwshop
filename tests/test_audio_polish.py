"""Real private audio processing, durable queue recovery and API access boundaries."""
import hashlib
import http.client
import json
import math
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import audio_polish
import local_server
from local_store import Store


def seed(store, path="local/source.wav", duration=8, transient=False):
    rate = 48000
    time_axis = np.arange(int(rate * duration)) / rate
    envelope = .75 + .2 * np.sin(2 * np.pi * .4 * time_axis)
    # Intentionally excessive subsonic rumble, with musical midrange to preserve.
    audio = .11 * np.sin(2 * np.pi * 12 * time_axis)
    audio += envelope * (.15 * np.sin(2 * np.pi * 440 * time_axis) + .07 * np.sin(2 * np.pi * 1500 * time_axis))
    if transient:
        audio *= .09
        audio[rate * 2:rate * 2 + 240] += .8 * np.hanning(240)
    source = store.asset("beats", path)
    source.parent.mkdir(parents=True, exist_ok=True)
    sf.write(source, np.column_stack((audio, audio * .95)), rate, subtype="PCM_24")
    return source


def await_job(store, job_id, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = store.query({"table": "polish_jobs", "filters": [["id", job_id]], "single": "required"})
        if job["status"] in {"done", "error"}:
            return job
        time.sleep(.1)
    raise AssertionError("Real audio polish job did not finish in time")


class AudioPolish(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, **values):
        return {"bucket": "beats", "storage_path": "local/source.wav", "name": "Clarity test",
                "preset": "balanced", "strength": "gentle", **values}

    def test_real_output_is_measured_finite_rumble_reduced_and_original_untouched(self):
        source = seed(self.store)
        original = source.read_bytes()
        job = audio_polish.enqueue(self.store, self.request(source_id="song-origin"))
        result = audio_polish.process_job(self.store, audio_polish.claim_job(self.store))
        library = self.store.query({"table": "library", "filters": [["id", result["result_library_id"]]], "single": "required"})
        output = self.store.asset(library["bucket"], library["storage_path"])
        before, rate = sf.read(source, always_2d=True)
        after, after_rate = sf.read(output, always_2d=True)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(library["source_sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(library["source_kind"], "polished-version")
        self.assertEqual(library["name"], job["name"], "The chosen version name must match the saved song")
        self.assertEqual(library["source_id"], "song-origin")
        self.assertEqual(library["bucket"], "beats", "Processed songs remain eligible for Quick / Full split")
        self.assertTrue(np.isfinite(after).all())
        self.assertEqual(after.shape, before.shape)
        self.assertEqual(after_rate, 48000)
        self.assertEqual(sf.info(output).subtype, "PCM_24")
        self.assertLessEqual(result["report"]["after"]["true_peak_db"], -1)
        self.assertAlmostEqual(result["report"]["after"]["integrated_lufs"], -14, delta=.3)
        self.assertLess(np.max(np.abs(after)), 1)
        # Compare frequency ratios so normalization gain cannot fake rumble cleanup.
        spectra = [np.abs(np.fft.rfft(x[:, 0])) for x in (before, after)]
        frequencies = np.fft.rfftfreq(len(before), 1 / rate)
        low, mid = np.argmin(abs(frequencies - 12)), np.argmin(abs(frequencies - 440))
        self.assertLess(spectra[1][low] / spectra[1][mid], .4 * spectra[0][low] / spectra[0][mid])
        self.assertEqual(result["result_url"], "/audio/beats/polished/" + job["id"] + ".wav")

    def test_vocal_and_warm_presets_process_audio(self):
        source = seed(self.store, duration=4)
        original = source.read_bytes()
        for preset in ("vocal", "warm"):
            job = audio_polish.enqueue(self.store, self.request(preset=preset, strength="standard"))
            result = audio_polish.process_job(self.store, audio_polish.claim_job(self.store))
            self.assertTrue(all(math.isfinite(value) for value in result["report"]["after"].values() if value is not None))
            self.assertLessEqual(result["report"]["after"]["true_peak_db"], -1)
            self.store.query({"table": "polish_jobs", "action": "update", "filters": [["id", job["id"]]], "values": {"status": "done"}})
        self.assertEqual(source.read_bytes(), original)

    def test_phone_m4a_input_is_decoded_and_preserved(self):
        source = seed(self.store, duration=2)
        phone = self.store.asset("beats", "local/phone.m4a")
        audio_polish._ffmpeg([*audio_polish._input(source), "-c:a", "aac", "-b:a", "128k", str(phone)])
        original = phone.read_bytes()
        audio_polish.enqueue(self.store, self.request(storage_path="local/phone.m4a", preset="vocal"))
        result = audio_polish.process_job(self.store, audio_polish.claim_job(self.store))
        self.assertEqual(phone.read_bytes(), original)
        self.assertLessEqual(result["report"]["after"]["true_peak_db"], -1)
        self.assertGreater(result["report"]["duration_seconds"], 1.9)

    def test_peaky_source_keeps_transient_headroom_instead_of_forcing_loudness(self):
        source = seed(self.store, duration=5, transient=True)
        original = source.read_bytes()
        audio_polish.enqueue(self.store, self.request())
        result = audio_polish.process_job(self.store, audio_polish.claim_job(self.store))
        self.assertLess(result["report"]["after"]["integrated_lufs"], -14.3)
        self.assertLessEqual(result["report"]["after"]["true_peak_db"], -1)
        self.assertTrue(any("preserve dynamics" in note for note in result["report"]["notes"]))
        self.assertEqual(source.read_bytes(), original)

    def test_path_input_size_and_presets_are_bounded(self):
        seed(self.store, duration=1)
        for fields in ({"bucket": "exports"}, {"storage_path": "../source.wav"},
                       {"storage_path": "/source.wav"}, {"storage_path": "https://example.com/a.wav"},
                       {"storage_path": "local/..\\secret.wav"}, {"storage_path": "local/missing.wav"},
                       {"preset": "perfect"}, {"strength": "crush"}, {"name": "x" * 201}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                audio_polish.enqueue(self.store, self.request(**fields))
        large = self.store.asset("beats", "local/large.wav")
        with large.open("wb") as handle:
            handle.truncate(audio_polish.MAX_BYTES + 1)
        with self.assertRaises(ValueError):
            audio_polish.enqueue(self.store, self.request(storage_path="local/large.wav"))
        silent = self.store.asset("beats", "local/silent.wav")
        sf.write(silent, np.zeros(48000), 48000)
        audio_polish.enqueue(self.store, self.request(storage_path="local/silent.wav"))
        with self.assertRaisesRegex(ValueError, "silent"):
            audio_polish.process_job(self.store, audio_polish.claim_job(self.store))

    def test_duration_limit_is_enforced_after_decode(self):
        seed(self.store, duration=2)
        audio_polish.enqueue(self.store, self.request())
        with patch.object(audio_polish, "MAX_SECONDS", 1), self.assertRaisesRegex(ValueError, "30 minutes"):
            audio_polish.process_job(self.store, audio_polish.claim_job(self.store))

    def test_disguised_playlist_cannot_open_network_or_external_local_inputs(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        requests = []

        class Trap(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"private remote response")

            def log_message(self, *args):
                pass

        trap = ThreadingHTTPServer(("127.0.0.1", 0), Trap)
        trap_thread = threading.Thread(target=trap.serve_forever, daemon=True)
        trap_thread.start()
        try:
            source = self.store.asset("beats", "local/playlist.wav")
            source.parent.mkdir(parents=True, exist_ok=True)
            private = Path(self.temp.name) / "private.wav"
            sf.write(private, np.ones(48000) * .1, 48000)
            for contents in (f"#EXTM3U\nhttp://127.0.0.1:{trap.server_port}/secret.wav\n",
                             "ffconcat version 1.0\nfile '" + str(private).replace("\\", "/") + "'\n"):
                source.write_text(contents)
                job = audio_polish.enqueue(self.store, self.request(storage_path="local/playlist.wav"))
                with self.assertRaisesRegex(ValueError, "could not be decoded"):
                    audio_polish.process_job(self.store, audio_polish.claim_job(self.store))
                self.store.query({"table": "polish_jobs", "action": "update", "filters": [["id", job["id"]]], "values": {"status": "error"}})
            self.assertEqual(requests, [], "Disguised media must never fetch a URL")
            self.assertEqual(self.store.query({"table": "library"}), [])
        finally:
            trap.shutdown()
            trap.server_close()
            trap_thread.join(2)

    def test_pending_jobs_resume_after_reopen_and_errors_retry_durably(self):
        source = seed(self.store, duration=3)
        original = source.read_bytes()
        job = audio_polish.enqueue(self.store, self.request())
        duplicate = audio_polish.enqueue(self.store, self.request())
        self.assertEqual(job["id"], duplicate["id"])
        reopened = Store(self.temp.name)
        processor = audio_polish.attach(reopened)
        try:
            finished = await_job(reopened, job["id"])
            self.assertEqual(finished["status"], "done", finished.get("error_message"))
            self.assertEqual(finished["progress"], 100)
            self.assertEqual(source.read_bytes(), original)
            bad = reopened.asset("beats", "local/bad.wav")
            bad.write_bytes(b"this is not an audio file")
            failed = audio_polish.enqueue(reopened, self.request(storage_path="local/bad.wav"))
            failed = await_job(reopened, failed["id"])
            self.assertEqual(failed["status"], "error")
            self.assertNotIn(self.temp.name, failed["error_message"])
            # The owner replaces the malformed import, then retries the existing job.
            bad.write_bytes(original)
            retried = audio_polish.enqueue(reopened, {"action": "retry", "job_id": failed["id"]})
            self.assertEqual(retried["id"], failed["id"])
            finished = await_job(reopened, failed["id"])
            self.assertEqual(finished["status"], "done", finished.get("error_message"))
        finally:
            processor.release()
        self.assertFalse(processor.thread.is_alive())
        self.assertEqual(len(audio_polish.jobs(Store(self.temp.name))), 2)

    def test_interrupted_running_job_is_visible_and_retryable_on_start(self):
        seed(self.store, duration=1)
        job = audio_polish.enqueue(self.store, self.request())
        audio_polish.claim_job(self.store)
        processor = audio_polish.attach(Store(self.temp.name))
        try:
            recovered = await_job(self.store, job["id"])
            self.assertEqual(recovered["status"], "error")
            self.assertIn("restarted", recovered["error_message"])
        finally:
            processor.release()


class PolishHTTP(unittest.TestCase):
    def test_server_owned_queue_origin_headers_remote_auth_and_static_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Store(temporary)
            seed(store, duration=1)
            server = local_server.make_server(temporary, 0, store=store)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_port

            def request(method, path, body=None, extra=None):
                connection = http.client.HTTPConnection("127.0.0.1", port)
                headers = {"Host": f"127.0.0.1:{port}", "X-ScrewShop": "1", "Content-Type": "application/json"}
                headers.update(extra or {})
                connection.request(method, path, json.dumps(body) if body is not None else None, headers)
                response = connection.getresponse()
                data = response.read()
                connection.close()
                return response.status, json.loads(data) if response.headers.get("Content-Type") == "application/json" else data

            try:
                status, data = request("POST", "/api/polish", {"bucket": "beats", "storage_path": "local/source.wav", "name": "HTTP test"})
                self.assertEqual(status, 202)
                self.assertIn(data["data"]["status"], {"pending", "running"})
                self.assertEqual(request("GET", "/api/polish")[0], 200)
                for action in ("insert", "upsert", "update", "delete"):
                    self.assertEqual(request("POST", "/api/query", {"table": "polish_jobs", "action": action,
                                                                     "values": {"status": "done"}, "filters": [["id", data["data"]["id"]]]})[0], 400)
                self.assertEqual(request("POST", "/api/polish", {}, {"Origin": "https://evil.example"})[0], 403)
                self.assertEqual(request("POST", "/api/polish", {}, {"X-ScrewShop": ""})[0], 403)
                self.assertEqual(request("GET", "/data/screwshop.sqlite3")[0], 404)
                with patch.object(local_server.Handler, "is_local", return_value=False), patch.object(local_server.Handler, "is_secure", return_value=True):
                    self.assertEqual(request("GET", "/api/polish")[0], 401)
                    self.assertEqual(request("POST", "/api/polish", {})[0], 401)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(2)


if __name__ == "__main__":
    unittest.main()
