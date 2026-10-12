"""SONGS preview shows clip time under the row; NOTEPAD songs keep their own saved beat.

All writes use an isolated temporary local server, never the owner's data folder.
"""
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
import threading
import wave
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from local_server import make_server

SONG_A, SONG_B = "beat-song-a", "beat-song-b"

with tempfile.TemporaryDirectory() as temp:
    server = make_server(temp, port=0)
    tone = Path(temp) / "tone.wav"
    with wave.open(str(tone), "wb") as audio:
        audio.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
        # 4 seconds, so the readout must say 0:04.
        audio.writeframes(b"".join(struct.pack("<h", int(9000 * math.sin(i * 2 * math.pi * 220 / 22050))) for i in range(22050 * 4)))
    path = server.store.asset("beats", "local/trap.wav")
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(tone, path)
    server.store.query({"table": "library", "action": "insert", "values": {"id": "trap", "name": "Trap beat", "storage_path": "local/trap.wav", "created_at": "2026-01-01T12:00:00Z"}})
    for song_id, title in ((SONG_A, "Song with beat"), (SONG_B, "Song without beat")):
        server.store.query({"table": "songs", "action": "upsert", "values": {"id": song_id, "title": title, "meta": json.dumps({"lines": [title + " verse"], "keep": "me"})}})
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"

    def meta(song_id):
        row = server.store.query({"table": "songs", "filters": [["id", song_id]], "single": "optional"})
        return json.loads(row["meta"])

    with sync_playwright() as p:
        chrome = os.environ.get("SS_CHROME") or str(sorted((Path(os.environ["LOCALAPPDATA"]) / "ms-playwright").glob("chromium-*/chrome-win64/chrome.exe"))[-1])
        browser = p.chromium.launch(executable_path=chrome, headless=True, args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/barwork")

        # 1. SONGS preview: the player opens directly under the row and shows position / length.
        page.get_by_role("button", name="SONGS", exact=True).click()
        page.get_by_role("button", name="Preview Trap beat", exact=True).click()
        player = page.locator(".ss-library-preview")
        expect(player).to_be_visible()
        assert page.evaluate("document.querySelector('.ss-library-preview').previousElementSibling?.dataset.entry?.includes('trap')"), "Preview is not under its row"
        time_box = player.locator("[data-preview-time]")
        expect(time_box).to_have_text(re.compile(r"^0:0\d / 0:04$"))
        page.wait_for_function("document.querySelector('.ss-library-preview audio').currentTime > 1.1")
        expect(time_box).to_have_text(re.compile(r"^0:0[1-4] / 0:04$"))
        player.get_by_role("button", name="Pause preview").click()
        expect(player.get_by_role("button", name="Play preview")).to_be_visible()
        page.get_by_role("button", name="Stop audio preview", exact=True).click()
        expect(player).to_be_hidden()

        # 2. NOTEPAD: pick a beat once; it is saved in the song and survives a reload.
        page.get_by_role("button", name="NOTEPAD", exact=True).click()
        page.locator(f'.np-song-list button[data-song-id="{SONG_A}"]').click()
        picker = page.get_by_role("combobox", name="Choose a beat from SONGS")
        picker.select_option(label="Trap beat")
        expect(page.locator(".np-beat-name")).to_have_text("Trap beat")
        for _ in range(100):
            if meta(SONG_A).get("beat"):
                break
            page.wait_for_timeout(50)
        saved = meta(SONG_A)
        assert saved["beat"]["url"] == "/audio/beats/local/trap.wav", saved
        assert saved["keep"] == "me" and saved["lines"] == ["Song with beat verse"], "Saving the beat lost song data"

        page.reload()
        page.get_by_role("button", name="NOTEPAD", exact=True).click()
        page.locator(f'.np-song-list button[data-song-id="{SONG_A}"]').click()
        expect(page.locator(".np-beat-name")).to_have_text("Trap beat")
        expect(page.locator(".np-beat-time")).to_have_text("0:00 / 0:04")
        page.get_by_role("button", name="Play beat").click()
        page.wait_for_function("document.querySelector('.np-beat-time').textContent.startsWith('0:01')")
        page.get_by_role("button", name="Pause beat").click()
        page.get_by_role("button", name="Stop beat and go back to the start").click()
        expect(page.locator(".np-beat-time")).to_have_text("0:00 / 0:04")

        # Each song keeps its own beat; switching songs shows the picker again.
        page.locator(f'.np-song-list button[data-song-id="{SONG_B}"]').click()
        expect(picker).to_be_visible()
        assert "beat" not in meta(SONG_B)
        page.locator(f'.np-song-list button[data-song-id="{SONG_A}"]').click()
        expect(page.locator(".np-beat-name")).to_have_text("Trap beat")

        # Leaving the notepad stops the beat.
        page.get_by_role("button", name="Play beat").click()
        page.wait_for_function("document.querySelector('.np-beat-play').textContent === '❚❚'")
        page.get_by_role("button", name="SONGS", exact=True).click()
        page.wait_for_timeout(400)
        page.get_by_role("button", name="NOTEPAD", exact=True).click()
        expect(page.get_by_role("button", name="Play beat")).to_be_visible()

        # Mobile layout: nothing scrolls sideways.
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(200)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Notepad beat bar overflows on phone width"
        page.get_by_role("button", name="SONGS", exact=True).click()
        page.get_by_role("button", name="Preview Trap beat", exact=True).click()
        expect(page.locator("[data-preview-time]")).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Preview player overflows on phone width"

        assert not errors, errors
        browser.close()
    server.shutdown()
print("song beat browser test passed")
