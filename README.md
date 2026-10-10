# PlayAlong

A phone songbook for chords, lyrics and notes that scrolls the sheet in time with the song.

- **Timed scroll.** Enter the song's length, plus how long the intro and outro run, and the sheet
  scrolls through the singing in between. Nudge the speed while you play and save it.
- **Read from screenshots.** Add screenshots of a chord sheet in any order. The text is read on the
  phone (Tesseract), website clutter is dropped, the screenshots are put in order and the lines
  they share are joined. Nothing is sent anywhere except the song you save.
- **Baritone ukulele.** Six-line guitar tab is shown converted for baritone (D G B E). Chord names
  need no conversion.
- **Transpose, text size, stage-friendly dark mode, foot-pedal keys, screen stays on while playing.**

## How it runs

One small Node server (`server.js`, no dependencies) serves the app in `public/` and keeps the
songbook in a single file, `songs.json`. A passcode keeps it private.

| Setting | Where | What it does |
| --- | --- | --- |
| `APP_PASSCODE` | Railway → service → Variables | The passcode to open the songbook. Required: without it nothing can be read or saved. Changing it signs everyone out. |
| A volume | Railway → service → right-click → Attach volume (any mount path, e.g. `/data`) | Where `songs.json` lives. **Without a volume Railway wipes the songbook on every deploy**, and the app shows a warning until one is attached. |
| `PORT` | Set by Railway | |

`GET /healthz` reports the deployed commit (`commit`) and whether storage is permanent
(`persistentStorage`), so you can check a deploy is the one you expect.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo → PlayAlong.** If Railway's GitHub app is set to
   "Only select repositories", add PlayAlong *and keep your other repositories ticked*: saving that
   list replaces it, and a repository dropped from it stops auto-deploying without any error.
2. **Variables:** add `APP_PASSCODE` with a passcode you choose.
3. **Attach a volume** to the service (mount path `/data`).
4. **Settings → Networking → Generate Domain** for a `*.up.railway.app` address.
5. Open the address, enter the passcode, and on iPhone use Share → **Add to Home Screen**.

Railway redeploys on every push to `main`.

## Backups

The library has **Download a backup of your songs** (a JSON file) and **Import songs from a backup**,
which skips songs already in the songbook (same title and artist).

## Develop

```bash
APP_PASSCODE=dev npm start    # http://localhost:3000, songs in ./data/
npm test                      # starts the server and checks the API
```

The text reader loads Tesseract.js 5.1.1 from jsDelivr; the English language data
(`public/ocr/eng.traineddata.gz`, the official `@tesseract.js-data/eng` 1.0.0 file) is served by the app.
