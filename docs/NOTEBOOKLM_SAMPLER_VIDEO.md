# NotebookLM video: "Make a basic beat on the M-AUDIO / SAMPLER tab"

NotebookLM can only explain what's in its sources. It can't see ScrewShop or record your screen, so it builds a narrated slide video from what you give it. Paste only the prompt and it will guess how the app works. Give it this source document and the screenshots, and it can teach your real app.

## Setup (about 2 minutes)

1. Go to notebooklm.google.com and create a new notebook named **ScrewShop Sampler**.
2. **Add source → Copied text.** Paste everything under **SOURCE: ScrewShop sampler walkthrough** below.
3. **Add source → upload** the 8 screenshots in `docs/notebooklm-sampler/` (01 to 08). The video can show them as slides, so viewers see the real screen.
4. Open **Studio → Video Overview**, click the pencil (**Customize**), choose the **Explainer** format, and paste **PROMPT A** into the box. If the box won't take that much text, paste **PROMPT B** instead.
5. Generate the video, watch it once, and if a step is wrong or missing, generate again with a line added to the prompt (for example, "Spend more time on step 6, chopping").

---

## PROMPT A (full, paste into the Video Overview customize box)

```
Make a hands-on tutorial for ONE viewer: a Houston rapper who owns an
M-Audio Oxygen 25 and is new to beat making. Teach only the M-AUDIO /
SAMPLER tab of ScrewShop, using ONLY the steps in the source. Don't invent
buttons, menus or features.

Follow the "Worked example" in exact order, one step per slide or scene:
connect the Oxygen and press Learn all 8 pads, import a song, Quick or
Full split it, preview the stems, drag sounds onto pads 1 to 5, chop the
loop, play the pads, program the 16-step pattern (kick, snare, hi-hats,
808, loop), record a live pass with count-in, add a second pattern, then
Save Beat and Send to Studio. For every step say: what to click, where it
is on screen, what you should see, and why it matters for the beat.

Use the screenshots as visuals whenever a step matches one. Start by
explaining the pad layout (pads 1 to 4 bottom row, 5 to 8 top row) and the
readout line, because that's how the viewer checks the keyboard is mapped
right. Use the real-world comparisons in the source (warehouse shelves for
pads, a conveyor belt for the sequencer). End with the troubleshooting
list and a 30-second recap of the whole flow. Keep it practical,
encouraging and plain-spoken, no programming talk. Aim for 8 to 10 minutes.
```

## PROMPT B (short version, in case the box has a character limit)

```
Hands-on tutorial for a beginner with an M-Audio Oxygen 25. Teach only
ScrewShop's M-AUDIO / SAMPLER tab, using only the source's steps. Follow the
"Worked example" in order: Learn all 8 pads, import, split, drag stems onto
pads, chop, play, program the 16-step beat, record live, save, Send to
Studio. For each step: what to click, what you see, why it matters. Show
the screenshots. End with troubleshooting and a recap.
```

---

## SOURCE: ScrewShop sampler walkthrough

# ScrewShop M-AUDIO / SAMPLER tab: make a basic beat with the Oxygen 25

ScrewShop is a music studio that runs on your own computer. It is opened in a web browser at `http://localhost:5050/barwork` after starting the ScrewShop shortcut. Nothing is uploaded; songs, stems and beats stay on the computer. The app has five tabs along the bottom: SONGS, NOTEPAD, STUDIO, SCREW and **M-AUDIO / SAMPLER**. This walkthrough covers only M-AUDIO / SAMPLER, where you turn pieces of songs into sounds on pads and arrange them into a beat.

## The big picture in plain words

Think of the sampler as a small warehouse:
- The **library** on the left is the receiving dock. Every song, stem, chop and saved beat arrives there.
- The **pads** are shelves. You put one sound on each shelf. There are 8 pads on the keyboard and 2 banks, so 16 shelves.
- The **sequencer** at the bottom is a conveyor belt that moves left to right in a loop. Each square is a moment in time. Light up a square and that pad's sound plays when the belt reaches it.
- **Studio** is the shipping dock, where finished beats go to become songs with vocals.

## What the screen shows (see screenshot 01)

- **Top toolbar:** library toggle (☰), MIDI status, **MIDI** (connect), **BPM**, **Play**, **Record**, **■** (All Notes Off, stops stuck sounds), **Click** (metronome), **Count-in**, **Master** volume, **Save Kit**, **Save Beat**, **Send to Studio**.
- **Left: the sound library.** **Import** (files) and **Folder** buttons, a search box, a filter (All, Packs, Samples, Stems, Chops, Beats, Favorites) and a **Preview** volume slider. Each sound has ▶ to preview it and a ☆ to favorite it. Imported songs also have **Quick split** and **Full split** buttons.
- **Middle: a drawing of the M-Audio Oxygen 25.** It matches the real keyboard: 8 pads at the top right, **pads 1 to 4 on the bottom row and pads 5 to 8 on the top row**, 8 knobs, a fader, transport buttons and 25 keys. Above it: **BANK 1 · PADS 1–8**, **BANK 2 · PADS 9–16**, and a **readout line** that names what you're pointing at or what the keyboard just sent, for example: `Heard: MIDI ch 10, note 38 (D2) → Pad 2`. **WHAT'S THIS?** turns on a mode where tapping any part of the drawing explains it. **TRILL GUIDE** is a step-by-step tour.
- **Above the drawing:** Undo ↶ / Redo ↷, **Keys play** (Pads 1–16, Instrument 1 or Instrument 2), **Clear assignment**, **Copy**, **Paste**, **MIDI Learn selected**, **Learn all 8 pads**.
- **Below the drawing:** the selected sound's editor (waveform, trim, pitch, slice).
- **Bottom: the sequencer.** Pattern menu, **+** (add), **Duplicate**, **Rename**, **Delete**, **Beats** (pattern length), **Piano roll**, **View** (16, 32 or 64 steps), **Edit notes**, then **Grid**, **Swing**, **Quantize**, **Overdub**, **Velocity** and **Note beats**. Each pad gets its own row (lane) with **M** (mute), **S** (solo) and a volume slider.

## Worked example: a basic screwed-style beat, start to finish

### Step 1: Connect the Oxygen and map the pads (screenshots 06 and 07)
1. Plug the Oxygen 25 into USB **before** opening ScrewShop. Use Chrome or Edge on the computer; phones can't use MIDI keyboards here.
2. Keep the keyboard in **Preset mode**, not DAW mode (the DAW/PRESET button).
3. Open **M-AUDIO / SAMPLER** and click **MIDI** in the toolbar. The status should change from "No MIDI connected" to the keyboard's name.
4. Click **Learn all 8 pads**. The pad the app is waiting for glows green and the readout says `hit PAD 1 on your Oxygen`. Hit the real pads **1, 2, 3, 4 (bottom row, left to right), then 5, 6, 7, 8 (top row, left to right)**. When the last one is done, it says all 8 pads are learned.
5. Test it: hit any pad. The same pad lights on screen, and the readout shows the note it sent and which pad it reached.
6. For pads 9 to 16, click **BANK 2 · PADS 9–16**, switch the keyboard to its second pad bank, and do **Learn all 8 pads** again.

Why it matters: the keyboard sends a number (a MIDI note) for each pad. Learning tells ScrewShop which number belongs to which pad, like labeling shelves so deliveries land in the right spot. The mapping is saved, so you only do this once.

### Step 2: Import a song (screenshot 02)
Click **Import** at the top of the library and pick an MP3, WAV or M4A. (**Folder** imports a whole folder of sounds, like a drum kit.) The song appears under **Imported sounds**. Press ▶ to preview it. Preview never records and has its own **Preview** volume.

### Step 3: Split the song into pieces
Under the song, choose:
- **Quick split:** fast, gives **vocals** and **instrumental**.
- **Full split:** slower, gives **vocals, drums, bass, guitar, piano, other** and a mixed **instrumental**.

Progress shows in the library. Keep the computer on while it works. A long song takes a few minutes, and the first Full split downloads an extra model. When it finishes, the pieces appear as **Stems** in the library. **Name & Save Pack** on a split folder keeps it as a named sound pack. Limits: files up to 300 MB and songs up to 30 minutes.

Why it matters: splitting is like unpacking a pallet into separate boxes. Now you can use just the drums, or just a piano phrase, instead of the whole song.

### Step 4: Put sounds on pads (screenshot 03)
Drag a sound from the library onto a pad in the drawing. While you drag, the readout says where it will land, for example `Drop here → Pad 3 (bank 1, MIDI note 42)`. Pads with a sound turn bright red; empty pads stay dark. On a touch screen, tap the sound's name, then tap the pad.

Long sounds are trimmed for you. A full-split stem can be minutes long. If a sound is longer than 4 bars at the current BPM, the pad gets **the first 4 bars where the sound actually starts** (stems often begin with silence), and a note says so. The full stem stays in the library, so you can pick a different part any time. Set the BPM first, because bars are measured at the sampler's BPM.

For this example:
- **Pad 1:** a kick (from the drums stem, or any kick sample)
- **Pad 2:** a snare or clap
- **Pad 3:** a hi-hat
- **Pad 4:** an 808 or the bass stem
- **Pad 5:** a melodic loop (for example a few seconds of the piano or instrumental stem)

To move a sound between pads, drag one pad onto another; hold **Ctrl** to copy instead. **Undo** reverses any mistake.

### Step 5: Chop and shape a sound (screenshot 04)
Click a pad to select it. The editor shows its waveform:
- **Start** and **End** trim the sound in seconds. Click the waveform to set the start; **Shift-click** sets the end.
- **Volume**, **Pan**, **Pitch** (−36 to +36 semitones). Lowering pitch slows and deepens the sound, the classic Houston screwed feel. There is no time-stretching, so pitch and length change together.
- **Reverse**, **Hold / gate** (plays only while the pad is held), **Loop trim**.
- Under the controls, a line says exactly how long the pad plays, for example `Plays 11.71 s = 4.00 bars at 82 BPM`. The **1 bar**, **2 bars**, **4 bars** and **Whole sound** buttons set the length from Start. If you pitch the sound down, the buttons still give exactly that many bars.
- **Cut itself** (on by default): hitting the pad again stops the last hit, like pads on an MPC or a GarageBand drum kit. Long sounds never pile up. Turn it off only when you want hits to overlap.
- **Advanced sample controls:** **Attack / fade in**, **Release / fade out**, **Choke group** (put open and closed hi-hats in the same group so one cuts off the other), **Slice points (seconds)** plus **Slice to pads**, and **Save Chop**.

Example: select pad 5 (the loop), type `2, 4, 6` in Slice points and press **Slice to pads**. The loop is cut into 4 chops, and pads 1 to 4 now hold those chops (they replace what was there, so Undo if you only wanted to try it). **Save Chop** keeps a trimmed sound in the library under Chops without copying the audio.

### Step 6: Play it
- Hit the Oxygen pads. They're velocity sensitive, so harder hits play louder.
- The **knobs on the drawing** (drag up or down, or scroll) set the volume of pads 1 to 8 (bank 2: pads 9 to 16). The same volumes are the sliders on the sequencer lanes.
- The **fader** is master volume. The **pitch wheel** bends pitch while you hold a sound; the **mod wheel** softens it. The real keyboard's pitch and mod wheels work too.
- The keyboard's Play, Stop and Record buttons can be linked under **Project, transfer & export → Learn control**: pick play, stop, record or master, then press the real button or move the real fader.
- **Keys play:** set to **Pads 1–16** and the lowest 16 keys also play pads 1 to 16 (labeled P1 to P16). Set to **Instrument 1** and drop a sound on a key: that key becomes its **ROOT**, and every other key plays it higher or lower, like a piano made from your sample. Octave − / + moves the keys.
- No keyboard? Computer keys **1 2 3 4 / Q W E R / A S D F / Z X C V** play pads 1 to 16, and **Space** starts playback.

### Step 7: Program the beat on the sequencer (screenshot 05)
Set **BPM** to 70 to 82 for a slow, heavy Houston feel. Keep **Beats** at 4 (one bar) and **Grid** at 1/16, so the bar has 16 steps. Click squares to turn them on:
- **Kick (pad 1):** steps 1, 7, 9 and 12
- **Snare (pad 2):** steps 5 and 13 (beats 2 and 4)
- **Hi-hat (pad 3):** every other step: 1, 3, 5, 7, 9, 11, 13, 15
- **808 (pad 4):** steps 1 and 9
- **Loop (pad 5):** step 1, so it restarts every bar

Press **Play**. The pattern loops. The number in a lit square is its velocity (how hard it hits). Right-click a square, or turn on **Edit notes** and tap it, to change velocity or length. Make every other hi-hat softer (around 70) so it grooves. Use **M** / **S** on a lane to mute or solo it. **Swing** shifts every second step late for a bouncier feel. **Piano roll** shows notes by pitch, for instrument lanes.

### Step 8: Record a live take
1. Turn on **Count-in** (and **Click** if you want a metronome).
2. Press **Record**. After the count-in, play the Oxygen pads along with the loop.
3. Recording loops and **Overdub** is on by default, so each pass layers on top. Turn Overdub off to replace notes instead. On the drawing, the loop (⟳) button toggles overdub.
4. **Quantize** snaps your hits to the grid.
5. Press **Stop**. The notes you played are now squares you can edit.

### Step 9: Build song parts with patterns
Click **Duplicate**, rename the copy "Hook", and add or remove hits so the hook hits harder. **+** starts an empty pattern. Switch between patterns with the Pattern menu. A pattern can be up to 64 beats long.

### Step 10: Save, send and export (screenshot 08)
- **Save Kit** saves the sounds on the pads, their settings and your MIDI mapping.
- **Save Beat** saves every pattern, the tempo and the mix. The beat appears in the library under Beats, with **Open Beat** and **Send to Studio**. The project also autosaves.
- **Send to Studio** turns the beat into a WAV and places it in the Studio tab, where you arrange intro, verse, hook and outro and record vocals on their own tracks. Under **Project, transfer & export** you can send just the current pattern or all patterns in order, combined or as separate lanes. After changing the beat, **Update Studio render** refreshes those clips without moving them.
- **Export WAV** saves the current pattern as audio. MP3 appears when the computer can make MP3s.

## Troubleshooting

- **A pad lights up a different pad on screen:** press **Learn all 8 pads** and hit pads 1 to 8 in order (1 to 4 bottom row, 5 to 8 top row). Watch the readout: it shows the note each pad sends and where it went.
- **"No MIDI connected":** plug in the keyboard, click **MIDI**, and use Chrome or Edge on the computer.
- **Readout says "nothing (not learned yet)":** that pad or bank isn't mapped. Run **Learn all 8 pads** on that bank.
- **Pad lights but makes no sound:** the pad is empty (dark), its lane is muted, or Master or the fader is down.
- **A pad plays forever or repeats over itself:** select the pad and press **4 bars** (or 1 or 2), and check **Cut itself** is on. If **Loop trim** is ticked, the sound loops until you let go of the pad, so untick it for one-shots.
- **A sound won't stop:** press **■** (All Notes Off), or PANIC on the keyboard.
- **The wrong bank shows:** hitting a learned pad switches the drawing to its bank automatically. You can also click BANK 1 or BANK 2.

## Honest limits

- No time-stretching. Pitch changes also change length, which is the screwed sound.
- The keyboard's NOTE REPEAT isn't built in yet. Use the sequencer for rolls.
- ARP, CHORD and SCALE modes run inside the keyboard; ScrewShop just plays the notes it receives.
- MIDI keyboards work in desktop Chrome or Edge, not on a phone.

## 30-second recap
Connect → **Learn all 8 pads** → **Import** a song → **Quick** or **Full split** → drag stems onto **pads** (long ones become 4 bars) → pick **1/2/4 bars** or **Slice to pads** → play with the Oxygen → click in a **16-step pattern** → **Record** a live pass → **Duplicate** for a hook → **Save Beat** → **Send to Studio**.
