"""Recorded audio stays retryable after upload or session-save failures. Isolated store."""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from local_server import make_server

with tempfile.TemporaryDirectory() as directory:
    server = make_server(directory, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    session = lambda: next((r for r in server.store.query({"table": "settings"}) if r["id"] == "recording-session"), None)
    try:
        with sync_playwright() as p:
            chrome = os.environ.get("SS_CHROME") or str(sorted((Path(os.environ["LOCALAPPDATA"]) / "ms-playwright").glob("chromium-*/chrome-win64/chrome.exe"))[-1])
            browser = p.chromium.launch(executable_path=chrome, headless=True, args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, permissions=["microphone"])
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            failure = {"upload": False, "session": False}

            def inject_failure(route):
                request = route.request
                query = request.post_data_json if "/api/query" in request.url else {}
                upload = failure["upload"] and "/api/audio/takes/" in request.url
                saving = failure["session"] and query.get("table") == "settings" and query.get("action") == "upsert" and query.get("values", {}).get("id") == "recording-session"
                if upload or saving:
                    failure["upload" if upload else "session"] = False
                    route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": {"message": "Injected disk failure"}}))
                else:
                    route.continue_()

            page.route("**/api/**", inject_failure)
            page.goto(f"http://127.0.0.1:{server.server_port}/barwork")
            page.get_by_role("button", name="STUDIO", exact=True).click()
            page.get_by_role("button", name="1234 COUNT-IN", exact=True).click()
            page.wait_for_timeout(300)

            for kind, count in (("upload", 1), ("session", 2)):
                failure[kind] = True
                page.get_by_role("button", name="RECORD", exact=True).click()
                page.get_by_role("button", name="STOP", exact=True).wait_for(timeout=8000)
                page.wait_for_timeout(650)
                page.get_by_role("button", name="STOP", exact=True).click()
                retry = page.get_by_role("button", name="RETRY SAVE RECORDING", exact=True)
                retry.wait_for(timeout=10000)
                page.get_by_text("Recording is still in memory. Use RETRY SAVE before closing: Injected disk failure", exact=True).wait_for()
                assert not failure[kind], f"{kind} failure was never exercised"
                retry.click()
                retry.wait_for(state="detached", timeout=10000)
                page.wait_for_function(f'document.querySelectorAll("[data-clip]").length === {count}')
                takes = server.store.query({"table": "takes"})
                assert len(takes) == count, "retry duplicated a recorded take"
                assert len(session()["tracks"]) == count, "retry duplicated a Studio track"
                assert all(take["duration_secs"] > 0.2 for take in takes)
                print(f"{kind} failure: recording retained, retry saved {count} take(s) without duplicates", flush=True)

            page.reload()
            page.get_by_role("button", name="STUDIO", exact=True).click()
            page.wait_for_function('document.querySelectorAll("[data-clip]").length === 2')
            assert len(session()["tracks"]) == 2
            assert not errors, errors
            print("PASS: recording upload/session failure, retry, decoded audio duration, no duplicate takes, persistence", flush=True)
            browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
