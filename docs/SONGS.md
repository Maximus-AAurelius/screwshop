# Songs, Studio mixes and clarity

SONGS is ScrewShop's shared browser. Imported files, Studio mixes, polished versions, split stems, recordings, packs and sampler saves stay on the computer hosting the studio. Phones use the same saved library.

## Preview time

Press ▶ on any SONGS row. The player opens right under that row and shows **where you are / how long it is** (for example `0:12 / 3:20`). Chops and split pieces count from their own start, so a 6-second chop reads `0:00 / 0:06`. Drag the bar to jump, ❚❚ pauses, ■ stops.

## A beat for each notepad song

In NOTEPAD, under the song name, choose **Beat for this song** and pick any audio from SONGS. The beat is saved inside that song, so opening the song opens its beat too. Play/pause, stop, back 5 seconds, drag to any spot, loop and volume are right there while you write. **CHANGE** picks a different beat; **✕** removes it from the song (the audio stays in SONGS). The beat stops when you leave NOTEPAD.

Code: `docs/song-library.js` (preview), `docs/notepad.js` (song beat, stored in the song's `meta.beat`). Test: `tests/song_beat_browser.py`.

## Item menus: ⋮ or right-click

Every SONGS row has one menu with everything you can do to that item. Press **⋮** on the row, right-click the row, or focus the row and press the Menu key or Shift+F10. The menu closes when you choose something, click elsewhere, scroll or press Esc, and arrow keys move through it. Actions that can't run right now are dimmed; choosing one says why (for example, "A split is already running for this song").

The same kind of menu is on:

- **STUDIO clips:** right-click a clip (double-click still works). Rename, split here or at the playhead, split to a new track, duplicate, copy, cut, paste, repeat 2× or 4×, reset to full length, move to a new track, mute/solo/lock the track, chop a piece onto a pad and delete. Ctrl+C, Ctrl+X, Ctrl+V and Ctrl+D work on the selected clip.
- **NOTEPAD songs:** ⋮ or right-click. Open, rename, duplicate, download the lyrics as .txt, delete.
- **Sampler pads:** right-click a pad. See [SAMPLER.md](SAMPLER.md).

## Delete and UNDO

Choose **Delete…** in an item's menu, or press **Delete** on a focused row. Everything can be deleted: songs, Studio mixes, polished and saved versions, stems, split packs, recordings, chops, beats, kits and packs.

1. The item disappears at once and an **UNDO** button counts down 10 seconds.
2. After 10 seconds the computer moves it to **`ScrewShop\Deleted Files\<date time> - <name>\`**. That folder holds the audio and an `item.json` with every removed record, so it can be put back by hand. Deleted notepad songs are saved there as `<title>.md`.
3. If something still uses the audio (a Studio clip, a sampler pad, a kit or another copy), the file stays where it is so nothing goes silent. The message says so. Delete it from there too and the next delete moves it.

Deleting a song that was split asks whether to delete its stems and split pack too. They are kept unless you tick the box. Closing the page during the countdown still finishes the delete. The beat that's open in the sampler can't be deleted until you open or start another one.

Removing a Studio clip or clearing a pad never deletes audio. It gets its own UNDO button, and Ctrl+Z also works.

Code: `docs/item-menu.js` (menus, UNDO, dialogs), `scripts/trash.py` (`POST /api/trash`). Tests: `tests/test_trash.py`, `tests/library_browser.py`, `tests/regions_browser.py`, `tests/notepad_songs_browser.py`, `tests/pad_menu_browser.py`.

## Video to MP3 (removed from the page)

The SONGS page no longer shows a VIDEO TO MP3 section. To add a song, use **+ UPLOAD FILE** with an audio file you own.

The server converter is still in the code but nothing on the page calls it. It pulls the first audio track out of a video as a 320 kbps MP3 using the bundled FFmpeg and adds it as a new song.

Its limits:

- Up to 300 MB and 30 minutes.
- Page links from YouTube, Instagram or TikTok are refused with a clear message. Those links open a web page, not a media file.
- Only public internet addresses are fetched. Links to this computer or your home network are refused, and redirects are re-checked.

Code: `scripts/media_import.py` (`POST /api/import-media`). Test: `tests/media_import_browser.py`.

## Save the song you are making

In STUDIO, choose **SAVE MIX TO SONGS**. Alternatively, open SONGS, give the current Studio mix a name and choose **SAVE STUDIO MIX TO SONGS**. ScrewShop renders a new WAV of the arrangement, including its offsets, trims, loops, track volume, mute/solo selection and playback speed. Each save creates a separate version; the editable session, recordings and sampler sources remain available.

Open the **Studio mixes** category to listen, rename, download, load a deck, add the mix to Studio or polish it. Saving a mix does not flatten or replace your Studio tracks.

## Export a finished MP3

In STUDIO, choose **EXPORT MP3 → SONGS** and name the song. ScrewShop renders the arrangement through the mixer, masters it to streaming level (-14 LUFS, -1 dBTP), and encodes a 320 kbps MP3. The finished song goes to two places:

- **SONGS → Imported**, the same as a file you imported yourself.
- **`ScrewShop\mp3s\<name>.mp3`** on the computer. If that name already exists, ScrewShop saves `<name> (2).mp3` instead of overwriting the existing file.

Nothing goes to your browser's Downloads folder. **EXPORT MIX WAV** still downloads an unmastered WAV, for use in other software.

## Slow a song down in Studio (screwed)

The speed box in the Studio toolbar has two numbers:

- **SONG BPM** is the song's real tempo. It sets the grid and click and does not change the sound.
- **PLAY AT** is the tempo you want to hear. Type a BPM, drag the slider or tap **-10% / -20% / -30%**. **1×** returns to the original speed.

Speed works the way a turntable does: everything slows together and the pitch drops, as the label shows (for example, `80% speed · pitch -3.9 st`). The bottom TEMPO slider controls the same speed while you're on the Studio tab. The speed is saved with the session and is used for saves and exports.

You can record over a slowed session. Your take is saved so it plays back exactly as you performed it and stays locked to the beat at any speed. The unprocessed recording is also kept.

## Mix in Studio (MIXER)

Choose **MIXER** to open a channel strip for every track, plus the master bus. Every control changes the sound live while playing and is used for SAVE MIX and EXPORT.

| Section | Controls | Typical rap starting points |
|---|---|---|
| EQ | High-pass, low shelf, mid bell (freq + width), high shelf | Vocals: high-pass 80–100 Hz, -2 dB around 250–300 Hz, +1–3 dB at 3 kHz |
| COMP | Threshold, ratio, attack, release, makeup | Vocals: 3–4:1, 5 ms attack, 80–120 ms release, 3–6 dB of reduction |
| DE-ESS | Frequency, amount | 5–8 kHz; use it if "s" sounds are harsh after compression |
| COLOR & SPACE | Saturation, reverb send, delay send, pan | Keep lead vocal, kick and bass centered |
| FADER | Volume, mute, solo, reset | |
| MASTER | Reverb (decay, pre-delay, tone), tempo-synced delay, glue compressor, output gain, limiter | Glue 2:1, 30 ms / 200 ms; limiter on at -1 dB |

A strip with every section off passes audio unchanged. The master limiter is on by default. It keeps the mix under -1 dBFS without turning down the whole song.

## Engineer mix of a song you drop in

In **Mix & clarity**, drop a song, or choose **Polish mix** on a SONGS row, then select **Engineer mix (split, mix, master)**:

1. AI stem separation (Demucs) splits the song into vocals, drums, bass and music.
2. Each stem gets its own engineer chain:
   - **Vocals:** cleanup, presence, air, compression, de-essing.
   - **Drums:** kick weight, snap and parallel compression.
   - **Bass:** compression, centered in mono.
   - **Music:** a pocket carved at 3 kHz so the vocal sits in front.
3. Each stem is level-matched after processing, so only the deliberate changes affect the balance. The vocal is then raised (+1.5 dB Gentle, +2.5 dB Standard).
4. The stems are recombined with mix-bus glue compression, then mastered to -14 LUFS / -1 dBTP. If needed, the master uses up to 6 dB of oversampled limiting; it never squashes more than that.

Expect it to take about twice the song's length on this computer. The result appears under **Polished** with a before/after report that lists every processing step. The original is never changed. AI separation can leave small artifacts on cymbals and reverb tails. For full control, split the song, put the stems in STUDIO and use the MIXER.

## Load sounds into M-AUDIO / SAMPLER

Press **⋮** on a song or stem (or right-click its row) and choose **Load onto a sampler pad…**, select a destination and load it. **Chop a piece onto a pad…** opens the waveform editor for choosing a phrase. Split stems stay grouped with their source in SONGS. Packs can still open the pack loader and fill pads together.

The sampler's **LOAD FROM SONGS** button returns to this browser. The sampler keeps its pad editors, MIDI controls, instruments, sequencer and editable kit/beat saves.

## Make a polished version

1. In **Mix & clarity**, drop an audio file or choose one using the file picker. On an existing SONGS row, choose **Polish mix** to select it.
2. Choose **Engineer mix** (see above), **Balanced**, **Vocal clarity** or **Warm**, and **Gentle** or **Standard** processing. Start gently and listen before adding more processing.
3. Start processing. The computer works through a saved queue; progress and errors remain available when you return. Keep the computer running.
4. Compare the original and polished audio. The new version also appears under **Polished**, where it can be reused or downloaded.

The processor uses local FFmpeg filters for low-frequency rumble removal, restrained tonal EQ and dynamics, with de-essing in the vocal preset. It measures loudness and true peak, then applies measured gain toward the loudness target while keeping a safe peak ceiling. A dynamic recording may remain below the loudness target to retain its transients. Processing produces a new 24-bit WAV; it never replaces the original. Files are limited to 300 MB and 30 minutes.

Loudness and peak measurements describe audio levels, not a score for musical quality. Listen on headphones and speakers and choose the version you prefer. Polishing a finished mix affects vocals and instruments together. To change their balance independently, use separate recordings or split stems in Studio before saving a mix. Existing distortion, a poor recording or separation artifacts cannot always be repaired by this process.

The implementation follows the [FFmpeg audio-filter documentation](https://ffmpeg.org/ffmpeg-filters.html#Audio-Filters). [iZotope's mixing and mastering guide](https://www.izotope.com/community/blog/what-is-the-difference-between-mixing-and-mastering) explains individual-track balancing and the subtle processing used on a finished mix.
