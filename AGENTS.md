# ScrewShop — one project

Canonical folder: C:/Users/travi/Projects/ScrewShop.
Rhymeflux and BarWork were earlier names/implementations of this same project.
Do not create another app or checkout under those names.

- Active interface: docs/barwork.html. Keep five tabs: SONGS, NOTEPAD, STUDIO, SCREW, M-AUDIO / SAMPLER. The sampler consolidates PACKS, the sound library, and Oxygen input; docs/sampler.js extends the existing workspace. Studio handles audio recording and arrangement. Sampler recording stores editable notes; Studio handoff renders WAV internally and preserves the sampler source. Existing /barwork bookmarks still work.
- Local service: scripts/local_server.py. Run with .venv/Scripts/python.exe.
- User data: data/ (SQLite, audio, Markdown exports). Never commit, erase, or expose this directory as static files.
- Local-only is the owner's current choice. No automatic Supabase traffic or deployment.
- archive/barwork-native-backend preserves the earlier native iOS/backend repo, history, uncommitted handoffs and build artifacts. It is reference source, not a second active server.
- Keep the /barwork URL working for existing bookmarks. Product name is ScrewShop.
- Preserve existing user work and all three projects' Git histories. Never replace uncommitted changes with old copies.
- Test persistence, actual queue processing, mobile layout, and access boundaries when changing them.
- Do not claim iPhone recording or installation is tested without testing on an actual device.
