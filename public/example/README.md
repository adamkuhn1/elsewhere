# Recorded example — pending

This public build intentionally does not ship a recorded example. The
private development copy has one, but it's a self-portrait taken as a first
placeholder, and it isn't going in a public repo.

`loadRecordedExample()` (`src/recordedExample.ts`) already handles this case
on its own: a missing `manifest.json` here just means visitors who don't
grant camera access see an honest "the recorded example hasn't been
captured yet" message instead of a fabricated one. Live capture (camera
permission required) is unaffected.

To add a real one: run the app, use `?debug=1` → "Try live capture" →
"Capture frame" → "Download as recorded example" on a non-portrait scene
(a room corner, an object — anything without a person), then drop the
three resulting files (`manifest.json`, `frame.jpg`, `depth.bin`) in this
directory.
