"""Named lyric notebooks preserve separate songs, local drafts, and existing work.

All writes use an isolated temporary local server, never the owner's data folder.
"""
import json
import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from local_server import make_server

LEGACY_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "existing-other-song"


def chrome_path():
    configured = os.environ.get("SS_CHROME")
    if configured:
        return configured
    return str(sorted((Path(os.environ["LOCALAPPDATA"]) / "ms-playwright").glob("chromium-*/chrome-win64/chrome.exe"))[-1])


def song_row(server, song_id):
    return server.store.query({"table": "songs", "filters": [["id", song_id]], "single": "optional"})


def song_lines(row):
    return json.loads(row["meta"])["lines"] if row else None


def wait_for_song(page, server, song_id, title, lyrics):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        row = song_row(server, song_id)
        if row and row.get("title") == title and song_lines(row) == lyrics.split("\n"):
            return row
        page.wait_for_timeout(50)
    raise AssertionError(f"Song {song_id} did not persist separately: {song_row(server, song_id)!r}")


def active_id(page):
    expect(page.get_by_role("button", name="+ NEW SONG", exact=True)).to_be_enabled()
    return page.locator('.np-song-list [data-song-id][aria-current="true"]').get_attribute("data-song-id")


def select_song(page, song_id, lyrics):
    page.locator(f'.np-song-list button[data-song-id="{song_id}"]').click()
    expect(page.locator('.np-song-list [aria-current="true"]')).to_have_attribute("data-song-id", song_id)
    expect(page.get_by_role("textbox", name="Verse notebook", exact=True)).to_have_value(lyrics)


def open_notepad(page):
    page.get_by_role("button", name="NOTEPAD", exact=True).click()
    page.get_by_role("textbox", name="Song name", exact=True).wait_for()


with tempfile.TemporaryDirectory() as directory:
    server = make_server(directory, port=0)
    legacy_title = "My existing song"
    legacy_disk_lyrics = "The verse already saved on disk"
    recovered_lyrics = "The newer local verse\nKeep this second line"
    other_lyrics = "Another song already on disk"
    for song_id, title, lyrics in (
        (LEGACY_ID, legacy_title, legacy_disk_lyrics),
        (OTHER_ID, "Existing other song", other_lyrics),
    ):
        server.store.query({"table": "songs", "action": "upsert", "values": {
            "id": song_id,
            "title": title,
            "meta": json.dumps({"lines": lyrics.split("\n"), "preserve_me": "existing metadata"}),
        }})
    original_other = song_row(server, OTHER_ID)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chrome_path(), headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            failure = {"enabled": False, "count": 0}
            race = {"enabled": False, "injected": False, "song_id": None,
                    "older": "An older queued verse", "newer": "The newer verse must survive the older commit"}

            def inject_save_failure(route):
                query = route.request.post_data_json
                is_song_write = query.get("table") == "songs" and query.get("action") in {"insert", "upsert", "update"}
                values = query.get("values", {})
                if race["enabled"] and is_song_write and values.get("id") == race["song_id"]:
                    lyrics = json.loads(values.get("meta", "{}" )).get("lines")
                    if lyrics == [race["older"]] and not race["injected"]:
                        # Keep A1's request paused while the user writes A2. A1
                        # then commits with a timestamp later than A2's draft.
                        race["injected"] = True
                        page.evaluate("""lyrics => {
                            const editor = document.querySelector('.np-editor');
                            editor.value = lyrics;
                            editor.dispatchEvent(new Event('input', {bubbles: true}));
                        }""", race["newer"])
                        route.continue_()
                        return
                    if lyrics == [race["newer"]]:
                        route.fulfill(status=500, content_type="application/json", body=json.dumps({"data": None, "error": {"message": "Injected newer-save failure"}}))
                        return
                if failure["enabled"] and is_song_write:
                    failure["count"] += 1
                    route.fulfill(status=500, content_type="application/json", body=json.dumps({"data": None, "error": {"message": "Injected disk failure"}}))
                else:
                    route.continue_()

            page.route("**/api/query", inject_save_failure)
            # The migration seed runs only once, so reloads cannot recreate a consumed draft.
            page.add_init_script("""(() => {
                if (!localStorage.getItem('notepad-song-test-seeded')) {
                    localStorage.setItem('notepad-song-test-seeded', '1');
                    localStorage.setItem('screwshop-draft', JSON.stringify({lines: %s, at: Date.now() + 1000}));
                }
            })();""" % json.dumps(recovered_lyrics.split("\n")))
            page.goto(f"http://127.0.0.1:{server.server_port}/barwork")
            open_notepad(page)
            name = page.get_by_role("textbox", name="Song name", exact=True)
            editor = page.get_by_role("textbox", name="Verse notebook", exact=True)
            expect(editor).to_have_value(recovered_lyrics)
            expect(name).to_have_value(legacy_title)
            assert active_id(page) == LEGACY_ID, "Existing writing was assigned a different song ID"
            wait_for_song(page, server, LEGACY_ID, legacy_title, recovered_lyrics)
            page.wait_for_function("localStorage.getItem('screwshop-draft') === null")
            assert song_row(server, OTHER_ID) == original_other, "Migrating the original notebook modified another song"

            # Names and writing render as text and keep the existing song identity.
            special_title = 'City <lights> & "south" 🎵 /..'
            special_lyrics = '<script>window.notepadInjection = true</script>\nQuotes " & apostrophes \'\n\nA last line 🎵'
            name.fill(special_title)
            editor.fill(special_lyrics)
            page.get_by_role("button", name="SAVE SONG", exact=True).click()
            wait_for_song(page, server, LEGACY_ID, special_title, special_lyrics)
            assert special_title in page.locator(f'.np-song-list [data-song-id="{LEGACY_ID}"]').inner_text()
            assert page.evaluate("window.notepadInjection === undefined"), "Lyrics were interpreted as HTML"

            # Creating songs gives blank independent notebooks and distinct default names.
            page.get_by_role("button", name="+ NEW SONG", exact=True).click()
            expect(editor).to_have_value("")
            expect(name).to_have_value("Untitled song")
            first_id = active_id(page)
            assert first_id not in {LEGACY_ID, OTHER_ID}
            first_draft = "First new song\nThis outgoing edit must survive a quick new-song click"
            editor.fill(first_draft)
            page.get_by_role("button", name="+ NEW SONG", exact=True).click()
            expect(editor).to_have_value("")
            expect(name).to_have_value("Untitled song 2")
            second_id = active_id(page)
            assert second_id not in {LEGACY_ID, OTHER_ID, first_id}
            wait_for_song(page, server, first_id, "Untitled song", first_draft)

            duplicate_title = "Twin song"
            second_lyrics = "The second song has its own words\nKeep them apart"
            name.fill(duplicate_title)
            editor.fill(second_lyrics)
            page.get_by_role("button", name="SAVE SONG", exact=True).click()
            wait_for_song(page, server, second_id, duplicate_title, second_lyrics)

            # Rename and edit immediately before switching, without waiting for autosave.
            select_song(page, first_id, first_draft)
            name.fill(duplicate_title)
            first_lyrics = "The first song's final words\nNew edits right before switching"
            editor.fill(first_lyrics)
            select_song(page, second_id, second_lyrics)
            wait_for_song(page, server, first_id, duplicate_title, first_lyrics)
            wait_for_song(page, server, second_id, duplicate_title, second_lyrics)
            assert page.locator(".np-song-list button").filter(has_text=duplicate_title).count() == 2
            songs = server.store.query({"table": "songs"})
            assert len(songs) == 4 and len({song["id"] for song in songs}) == 4, songs
            exports = Path(directory) / "Obsidian" / "Songs"
            for song_id, lyrics in ((first_id, first_lyrics), (second_id, second_lyrics)):
                exported = (exports / f"{song_id}.md").read_text(encoding="utf-8")
                assert exported.startswith(f"# {duplicate_title}\n\n")
                assert "\n\n".join(lyrics.split("\n")) in exported
            assert song_row(server, OTHER_ID) == original_other

            # Reload retains the chosen notebook, with all other notebooks untouched.
            page.reload()
            open_notepad(page)
            expect(editor).to_have_value(second_lyrics)
            expect(name).to_have_value(duplicate_title)
            assert active_id(page) == second_id
            assert page.evaluate("localStorage.getItem('screwshop-notepad-active')") == second_id
            select_song(page, LEGACY_ID, special_lyrics)
            expect(name).to_have_value(special_title)
            select_song(page, first_id, first_lyrics)
            select_song(page, OTHER_ID, other_lyrics)
            select_song(page, second_id, second_lyrics)

            # A failed disk save keeps this song's recoverable local name and lyrics.
            failure["enabled"] = True
            failed_title = "Recovered second song"
            failed_lyrics = "These words were written while disk saving failed\nDo not lose this draft"
            name.fill(failed_title)
            editor.fill(failed_lyrics)
            page.get_by_role("button", name="SAVE SONG", exact=True).click()
            expect(page.locator(".np-song-status")).to_contain_text(re.compile("not saved", re.I))
            assert failure["count"] > 0, "The disk failure was not exercised"
            assert song_lines(song_row(server, second_id)) == second_lyrics.split("\n")
            draft = page.evaluate("id => JSON.parse(localStorage.getItem('screwshop-lyric-draft:' + id))", second_id)
            assert draft["lines"] == failed_lyrics.split("\n") and draft["title"] == failed_title, draft
            assert page.evaluate("localStorage.getItem('screwshop-lyric-draft:' + %s)" % json.dumps(LEGACY_ID)) is None
            # Switching or creating a song waits for the outgoing save. Failed
            # saves keep the current page visible instead of losing its draft.
            song_count = page.locator(".np-song-list button").count()
            page.locator(f'.np-song-list button[data-song-id="{first_id}"]').click()
            expect(page.get_by_role("button", name="+ NEW SONG", exact=True)).to_be_enabled()
            assert active_id(page) == second_id
            expect(editor).to_have_value(failed_lyrics)
            page.get_by_role("button", name="+ NEW SONG", exact=True).click()
            expect(page.get_by_role("button", name="+ NEW SONG", exact=True)).to_be_enabled()
            assert active_id(page) == second_id
            assert page.locator(".np-song-list button").count() == song_count
            expect(editor).to_have_value(failed_lyrics)
            page.reload()
            open_notepad(page)
            expect(editor).to_have_value(failed_lyrics)
            expect(name).to_have_value(failed_title)
            assert active_id(page) == second_id
            assert song_lines(song_row(server, LEGACY_ID)) == special_lyrics.split("\n")
            failure["enabled"] = False
            page.get_by_role("button", name="SAVE SONG", exact=True).click()
            wait_for_song(page, server, second_id, failed_title, failed_lyrics)
            page.wait_for_function("id => localStorage.getItem('screwshop-lyric-draft:' + id) === null", arg=second_id)

            # A leftover legacy draft belongs only to the original UUID, even when
            # another notebook was active at startup.
            late_legacy = "A recovered legacy-only draft"
            page.evaluate("lines => localStorage.setItem('screwshop-draft', JSON.stringify({lines, at: Date.now() + 1000}))", [late_legacy])
            page.reload()
            open_notepad(page)
            expect(editor).to_have_value(failed_lyrics)
            assert active_id(page) == second_id
            select_song(page, LEGACY_ID, late_legacy)
            expect(name).to_have_value(special_title)
            page.get_by_role("button", name="SAVE SONG", exact=True).click()
            wait_for_song(page, server, LEGACY_ID, special_title, late_legacy)
            wait_for_song(page, server, second_id, failed_title, failed_lyrics)

            # A later disk timestamp on an older queued save must not make the
            # browser discard a newer local edit when its subsequent save fails.
            select_song(page, second_id, failed_lyrics)
            race["song_id"] = second_id
            race["enabled"] = True
            editor.fill(race["older"])
            expect(editor).to_have_value(race["newer"])
            expect(page.locator(".np-song-status")).to_contain_text(re.compile("not saved", re.I))
            assert race["injected"], "The older-save/newer-draft race was not exercised"
            assert song_lines(song_row(server, second_id)) == [race["older"]]
            page.reload()
            open_notepad(page)
            expect(editor).to_have_value(race["newer"])
            expect(name).to_have_value(failed_title)
            race["enabled"] = False
            page.get_by_role("button", name="SAVE SONG", exact=True).click()
            failed_lyrics = race["newer"]
            wait_for_song(page, server, second_id, failed_title, failed_lyrics)

            # The song list and named notebook remain usable on a phone-sized page.
            page.set_viewport_size({"width": 390, "height": 844})
            select_song(page, first_id, first_lyrics)
            expect(name).to_be_visible()
            expect(page.get_by_role("button", name="+ NEW SONG", exact=True)).to_be_visible()
            expect(page.get_by_role("button", name="SAVE SONG", exact=True)).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile notebook overflows horizontally"
            for song_id in (LEGACY_ID, OTHER_ID, first_id, second_id):
                button = page.locator(f'.np-song-list button[data-song-id="{song_id}"]')
                button.scroll_into_view_if_needed()
                expect(button).to_be_visible()
                bounds = button.bounding_box()
                assert bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 391, bounds
                assert button.inner_text().strip(), "A song button has no readable name"
            select_song(page, second_id, failed_lyrics)

            # A failed initial read cannot replace existing work with an empty
            # fallback notebook. The original draft remains available for retry.
            before_failed_read = server.store.query({"table": "songs"})
            read_page = browser.new_page(viewport={"width": 1440, "height": 1000})
            read_page.on("pageerror", lambda error: errors.append(str(error)))
            read_failure = {"enabled": True, "writes": 0}

            def inject_load_failure(route):
                query = route.request.post_data_json
                if query.get("table") == "songs":
                    if query.get("action", "select") == "select" and read_failure["enabled"]:
                        route.fulfill(status=500, content_type="application/json", body=json.dumps({"data": None, "error": {"message": "Injected song-load failure"}}))
                        return
                    if query.get("action", "select") != "select":
                        read_failure["writes"] += 1
                route.continue_()

            read_page.route("**/api/query", inject_load_failure)
            read_recovery = "The draft survives an unavailable song list"
            read_page.add_init_script("""(() => {
                localStorage.setItem('screwshop-notepad-active', %s);
                localStorage.setItem('screwshop-lyric-draft:' + %s, JSON.stringify({id: %s, title: %s, lines: [%s], at: Date.now() + 1000}));
            })();""" % tuple(json.dumps(value) for value in (second_id, second_id, second_id, failed_title, read_recovery)))
            read_page.goto(f"http://127.0.0.1:{server.server_port}/barwork")
            open_notepad(read_page)
            expect(read_page.get_by_role("button", name="RETRY LOAD", exact=True)).to_be_visible()
            expect(read_page.get_by_role("textbox", name="Verse notebook", exact=True)).to_be_disabled()
            expect(read_page.get_by_role("button", name="+ NEW SONG", exact=True)).to_be_disabled()
            expect(read_page.get_by_role("button", name="SAVE SONG", exact=True)).to_be_disabled()
            read_page.wait_for_timeout(400)
            assert read_failure["writes"] == 0, "A failed read triggered a song overwrite"
            assert server.store.query({"table": "songs"}) == before_failed_read
            read_draft = read_page.evaluate("id => JSON.parse(localStorage.getItem('screwshop-lyric-draft:' + id))", second_id)
            assert read_draft["lines"] == [read_recovery]
            read_failure["enabled"] = False
            read_page.get_by_role("button", name="RETRY LOAD", exact=True).click()
            expect(read_page.get_by_role("textbox", name="Verse notebook", exact=True)).to_have_value(read_recovery)
            wait_for_song(read_page, server, second_id, failed_title, read_recovery)
            assert active_id(read_page) == second_id
            assert song_lines(song_row(server, LEGACY_ID)) == [late_legacy]

            # Delete a song from its ⋮ / right-click menu: UNDO brings it back; otherwise its lyrics land in Deleted Files.
            other = read_page.locator(f'.np-song-list button[data-song-id="{OTHER_ID}"]')
            other.click(button="right")
            read_page.locator('.im-menu [data-action="delete"]').click()
            expect(other).to_have_count(0)
            read_page.locator(".im-toast .im-undo").click()
            expect(other).to_have_count(1)
            read_page.locator(f'[data-song-menu="{OTHER_ID}"]').click()
            read_page.locator('.im-menu [data-action="delete"]').click()
            read_page.locator(".im-toast .im-dismiss").last.click()
            read_page.wait_for_function("id => !document.querySelector(`[data-song-id='${id}']`)", arg=OTHER_ID)
            read_page.wait_for_timeout(500)
            assert song_row(server, OTHER_ID) is None, "deleted song still on disk"
            saved = list((Path(directory) / "Deleted Files").glob("*Existing other song*/Existing other song.md"))
            assert saved and other_lyrics in saved[0].read_text(encoding="utf-8")
            read_page.reload(); open_notepad(read_page)
            read_page.wait_for_timeout(500)
            expect(read_page.locator(f'.np-song-list button[data-song-id="{OTHER_ID}"]')).to_have_count(0)
            assert not errors, errors
            print("PASS: existing lyrics/draft migration, named songs, blank new songs, rapid switching, duplicate titles/exports, reload selection, failed-save recovery, newer-draft/older-save race, legacy isolation, mobile song access, failed-load preservation/retry", flush=True)
            browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
