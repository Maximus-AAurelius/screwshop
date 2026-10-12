# ScrewShop

One local music studio, formerly called **Rhymeflux** and **Barwork**.

Open the **ScrewShop** desktop shortcut or `Start ScrewShop.cmd`.
Your existing address still works: **http://localhost:5050/barwork**.
The five tabs are SONGS, NOTEPAD, STUDIO, SCREW and M-AUDIO / SAMPLER.

## Write different songs

In **NOTEPAD**, enter a **Song name** above the page and press **SAVE SONG**. Names and lyrics also autosave as you type. The **MY SONGS** side list shows your saved notebooks; click a song to return to its lyrics, or **+ NEW SONG** to start a blank page. Switching saves your current song first. On a phone, the list sits above the writing page.

Your existing lyrics keep their original notebook. Each song saves separately on this computer and exports to its own Markdown file under `data/Obsidian/Songs/`. If saving fails, the notepad keeps a browser draft for recovery and lets you retry with **SAVE SONG**. These lyric notebooks share the existing audio workspace.

## Songs, Studio mixes and clarity

- **SONGS** is the shared browser for originals, Studio mixes, polished versions, split stems, recordings, sound packs and editable sampler saves.
- **SAVE MIX TO SONGS** in STUDIO renders the current arrangement into a new reusable WAV. You can also name and save the current Studio mix from SONGS. Each save creates a new version and preserves the editable session.
- In SONGS, use **Load sampler pad** or **Chop to pad** to work with an original or split stem. **LOAD FROM SONGS** in M-AUDIO / SAMPLER returns to this browser.
- **Mix & clarity** accepts a dropped audio file, a file selected on your phone, or **Polish mix** on a saved song. Choose **Engineer mix** (AI split into vocals/drums/bass/music, per-stem engineer processing, vocal forward, mastered to -14 LUFS) or a whole-file polish (Balanced, Vocal clarity, Warm), with Gentle or Standard processing. The local queue creates a separate WAV and shows the original, result, and measured loudness/peak levels for comparison.

See [the SONGS guide](docs/SONGS.md) for the workflow and processing details.

## Save and split

1. In SONGS, import an MP3, WAV, M4A or other supported audio file.
2. In that song's **More** menu, choose **Quick split** (vocals + instrumental) or **Full split** (vocals, drums, bass, guitar, piano, other, instrumental).
3. Keep this computer running. The processor starts automatically; failures appear in the page and can be retried.
4. Play the output or assign it to a sampler pad. Sources and stems remain on this computer.

## Save audio for another project or DAW

- **SAVE WAV** beside a stem saves a copy under `Beats/` and offers a browser download.
- **USE AS NEW TRACK** adds an independent copy to SONGS. Use SET AS BEAT there to work with the instrumental. Existing lyrics are preserved; this does not create a separate lyric document.
- A successful **FULL SPLIT** automatically creates `Beats/sound packs/<track>-<split-id>/` with seven aligned WAV files, a manifest and DAW import notes, plus a ZIP beside it. **SAVE SOUND PACK ZIP** downloads that pack, including full splits made before this feature.
- Import the six individual stems at the same start position in your DAW, or use vocals + instrumental. Do not layer the instrumental over its component stems.

The transport stays at the top of every tab. PLAY previews for stems and takes use that shared player; pause/stop also control decks, pads and patterns. Source BPM is entered manually (not detected); Playback BPM and TEMPO change playback speed. Your Trill GUIDE portrait opens the walkthrough.

The Windows health check now runs in one persistent hidden process launched at sign-in, instead of launching a process every minute. Its checks still run every 60 seconds without opening a terminal.

The models are already installed on this computer. A fresh installation downloads models on first use. Audio is never uploaded for separation. Maximum upload: 300 MB. Maximum split duration: 30 minutes. Full-length songs take longer than the short test fixtures; guitar/piano separation quality varies.

## Where everything saves

| Content | Location |
|---|---|
| Songs, library, takes, pads, pattern and job state | `data/screwshop.sqlite3` |
| Imported audio, recordings and split outputs | `data/audio/` |
| Plain Markdown lyric exports | `data/Obsidian/Songs/` |
| Model cache | `data/models/` |
| Job diagnostics | `data/logs/` |
| Local HTTPS keys and certificate | `data/tls/` (private) |

Open `data/Obsidian` as an Obsidian vault if you want to read/copy lyrics there. Export is currently one-way: edits in Obsidian do not update the studio. Removing an audio item from the interface keeps its original file for recovery.

Create a consistent music backup with:

```powershell
.venv/Scripts/python.exe scripts/backup.py
```

Backups are in `data/backups/`. Copy a backup to another drive for protection against computer/drive loss. The backup includes the database, audio and lyric exports; it excludes local TLS keys, pairing secrets and replaceable models.

## Phone and desktop app

The desktop shortcut opens an app-style Edge window, backed by the local service. The web app also has an install manifest and service worker. It is not a standalone Windows installer or App Store release.

Use [the iPhone setup guide](docs/IPHONE-SETUP.md) for private home Wi-Fi access, HTTPS microphone recording, pairing, and Home Screen installation. The computer must remain awake and running. The cached interface is not a fully offline phone database.

## One project, preserved history

- `docs/barwork.html`: active interface, now branded ScrewShop.
- `scripts/local_server.py`, `scripts/local_store.py`, `scripts/separate_audio.py`: active local service and processor.
- `archive/barwork-native-backend/`: original BarWork repository, including its `.git`, uncommitted handoffs, native iPhone app, TypeScript engine, backend and build artifacts. It is preserved reference source, not a second active app.
- `archive/cloud-web/`: original handoff, README, early page and cloud worker scripts.
- `design/originals/`: original design ZIP and Houston/DJ Screw reference artwork.
- `workspace/`: original design-canvas exports; reference only.

The original Git histories and remote repositories were not rewritten or pushed. Old Supabase records/files remain untouched; they have **not** been copied into the new local database because no authenticated cloud export was available. Existing browser cloud tokens are not read or sent anywhere by ScrewShop. You may need to re-import music that existed only in Supabase.

## Security and sharing

- **Phones and friends connect over HTTPS only.** Plain `http://` on Wi-Fi only serves the iPhone certificate profile and forwards everything else to HTTPS. The computer itself (localhost) always works.
- **Every device has its own login key**, named when it pairs. Manage them on the computer in **Settings → DEVICES & FRIENDS**: one-time pairing code, **NEW CODE**, **REMOVE** per device, **UNPAIR ALL DEVICES**. Only key hashes are stored (`data/devices.json`).
- **The iPhone certificate is limited by name constraints** to home-network addresses, localhost and this computer's name, so a leaked key can't impersonate public websites. Older unrestricted certificates are retired automatically (reinstall the profile once; see `docs/IPHONE-SETUP.md`).
- **Friends anywhere:** Tailscale (free, up to 6 users). ScrewShop detects Tailscale, allows its address, and uses Tailscale's real HTTPS certificate. See `docs/FRIENDS-SETUP.md`.
- The old Supabase cloud project refuses new sign-ups (database trigger `block_new_signups`); your existing account and files there are untouched.
- After updating server code, double-click **Restart ScrewShop.cmd**.
- Checks: `python -m unittest discover -s tests` includes `tests/test_security.py`.

## STUDIO: GarageBand-style multitrack

- Tracks stack down the page with a **bars.beats ruler** on top and a big position display (bar.beat.sixteenth + time).
- **IMPORT AUDIO** puts your first file on Track 1 as the beat; later imports land on a new track at the playhead. You can also drop audio files from Windows straight onto a lane.
- **LOOPS & FILES** lists split stems/sound-pack pieces and your SONGS. Drag one onto a track, or onto the empty bottom lane for a new track (on a phone, tap **+ ADD**).
- **Clips** drag left/right (and between tracks) and snap to the beat; hold **Alt** for free placement. Drag a clip's **right edge** past its end to **loop** it (notches mark each repeat) or pull it in to trim. ⧉ duplicates a clip, × or Delete removes it (the audio file stays in SONGS/takes).
- **CYCLE**: drag along the top strip of the ruler to set the yellow region; playback repeats it. **CLICK** = metronome, **COUNT-IN** = one bar of clicks before RECORD. Shortcuts: C cycle, K click, Ctrl+D duplicate.
- **RECORD** adds a new vocal track at the playhead (cycle is ignored while recording).
- **Speed (screwed)**: **SONG BPM** is the song's real tempo (grid + click). **PLAY AT**, the slider, or **-10% / -20% / -30%** slow the whole session; pitch drops with speed like a turntable. Recording keeps the speed, and takes are conformed so they stay in sync at any speed. Speed is saved and used by saves and exports.
- **MIXER**: a channel strip per track (EQ, compressor, de-esser, saturation, reverb/delay sends, pan, fader) and a master bus (reverb, tempo-synced delay, glue compressor, gain, -1 dB limiter). Playback and exports use the same engine (`docs/mix-engine.js`, `docs/mix-worklet.js`).
- **EXPORT MP3 → SONGS** masters to -14 LUFS / -1 dBTP, encodes 320 kbps, adds it to SONGS → Imported and saves `ScrewShop\mp3s\<name>.mp3`. See [docs/SONGS.md](docs/SONGS.md).
- Sessions saved by the old STUDIO open automatically as one clip per track.

## SCREW room: lining up two records

- Each deck has a **clock** under its waveform: where you are (m:ss.t), time left, the song length, loop points, and on deck B how far it is **BEHIND A / AHEAD OF A** (or **LOCKED WITH A**).
- **PLAY BOTH / PAUSE BOTH / STOP BOTH** start and stop both decks on the same audio instant. STOP BOTH returns both to the start.
- **MATCH B → A** puts deck B at deck A's exact spot and speed. **NUDGE B** (−1s, −.1, −.02, +.02, +.1, +1s) moves B behind or ahead. Same song on both decks + MATCH + nudge B back about one beat = the DJ Screw double.
- **LEARN TO MIX WITH TRILL** (top of the SCREW room, also in the GUIDE drawer) has three step-by-step lessons (Blend 2 Songs, Screw It, Headphones?) that outline each control as you go.
- Turning CHOP on while a deck plays now jumps straight into the loop.

## Current limits

- NOTEPAD has separate named lyric notebooks. SONGS remains the shared audio library; Studio keeps one audio arrangement.
- SCREW decks perform live; finished mix export is not implemented. No headphone/split cue (both decks go to one output) and no BPM detection on the decks. Deck positions/effects are not restored across reloads.
- AMMO uses curated phrases and rhyme matching, not a generative AI service.
- Rhyme editor and media controls retain the original custom design runtime. Its dynamic evaluation prevents using a strict no-eval CSP; keep code changes reviewed.
- Phone recording, audio routing and Home Screen installation still need physical iPhone acceptance testing.
- Separate native iPhone source/build was preserved, not renamed/rebuilt as a new ScrewShop native app.

## Development and verification

```powershell
npm ci
npm run vendor
npm test
npm run test:browser
.venv/Scripts/python.exe tests/split_smoke.py
.venv/Scripts/python.exe tests/phone_check.py
```

Browser tests need Playwright (`uv pip install --python .venv/Scripts/python.exe playwright`) and an installed Chromium. Real split tests use an isolated generated test track, not personal music. `Setup ScrewShop.cmd` installs the tested local audio runtime using `uv`. See [AUDIT-2026-09-23.md](docs/AUDIT-2026-09-23.md).
