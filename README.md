# Elsewhere

**A locally processed spatial photograph. Capture one camera frame, estimate
its depth on-device, and look around the textured surface it becomes.**

Elsewhere is V1 of a longer-running project. This version does exactly one
thing: takes a single still frame, runs a monocular depth model on it inside
your browser, and turns the result into a displaced, textured mesh you can
look around with the pointer. It is **not** vSLAM, a room scan, or a digital
twin — those are the honest next steps, not what this version claims.

**Status: work in progress.** The pipeline is real and works end to end, but
this is an early version with a narrow, deliberately limited scope.

## Run it

```sh
npm install
npm run dev          # http://localhost:5176 -- needs a WebGPU-capable browser
npm run build         # production build
npm test              # unit tests (pure logic: mesh, depth math, no GPU needed)
npm run typecheck
```

Live capture needs **WebGPU** (current desktop Chrome; Safari works too, but
depth inference deliberately runs inside a Worker rather than the main
thread — see "Why a Worker," below). A browser without WebGPU gets an honest
compatibility message and the recorded example, never a slow CPU fallback:
the archived predecessor project measured the CPU execution provider at
~1.6s/frame and 400MB+ of heap for this model, which is a different,
unusable experience, not a slower version of this one.

## What actually happens, step by step

1. You click **Start camera** — nothing is requested before this.
2. You click **Capture frame** — exactly one frame, held on-device.
3. A depth model (Depth Anything V2 Small, Apache-2.0, ~19MB, quantized)
   runs in a Worker and produces a per-pixel depth estimate.
4. The frame becomes a WebGL mesh: a grid of vertices displaced along their
   estimated depth, discontinuous regions (depth cliffs) left as gaps rather
   than stretched into a smear.
5. Moving the pointer orbits a small, bounded virtual camera around that
   mesh — real parallax, not a fake 3D-looking pan. An optional **Use head
   tracking** button offers the same control driven by head movement instead
   (see below); it's off unless you explicitly turn it on, and pointer
   parallax works exactly as before if you never touch it.
6. **Nothing captured is ever sent anywhere.** The only network requests the
   live pipeline makes are one-time fetches of the model weights (from
   Hugging Face) and the ONNX runtime (self-hosted, same-origin — see
   below) — confirmed by a live network trace, not just by reading the code.

**Open recorded example** does the same thing without touching your camera,
when one is bundled — see the note below.

## Why a Worker, unconditionally

ONNX Runtime Web's WebGPU backend throws (`webgpuInit is not a function`)
when initialized on Safari's main thread, and works correctly inside a
dedicated Worker. Chrome has no such restriction — but running the same code
path on both browsers, rather than branching, means there's one pipeline to
reason about instead of two. This was verified empirically against the
actual model and runtime this app ships, in real Chrome and real Safari, not
assumed from documentation.

## Why the ONNX runtime is self-hosted

`env.backends.onnx.wasm.wasmPaths` points at this app's own `/ort/` path
instead of onnxruntime-web's default CDN. A pipeline whose entire claim is
"this runs on your machine" shouldn't put a third party in the request path
of its own runtime. `vite.config.ts` copies the exact WASM/JS pair this
installed version of onnxruntime-web can ever select (inspected directly in
the published package — three of its four WebGPU build variants are dead
code in this release) from `node_modules` into the served output, via a dev
middleware (Vite refuses to let source code `import()` a file under
`public/`) and a build step that removes the duplicate copy Rollup would
otherwise bundle from the library's own internal `new URL(...)` reference.

## What V1 deliberately does not do

- No multi-frame fusion, no camera-pose estimation beyond the identity pose
  the `Keyframe`/`CameraPose` contract in `src/types.ts` already carries for
  a future version — see that file for exactly what's meant to grow here
  without a rewrite.
- No generated or synthetic depth data anywhere, including the recorded
  example.

## Optional head tracking

`src/tracking.ts` adds one alternative input into the same `setPointer` call
pointer-drag already drives: a face-landmark tracker (MediaPipe's
`FaceLandmarker`, one face, translation only — no rotation, no expression, no
identity, nothing stored or recorded) that turns head movement into the same
normalized offset a pointer drag would. It's entirely optional and off by
default. Clicking **Use head tracking** requests camera access, calibrates
your first head position as center, and smooths subsequent readings with an
exponential moving average before feeding them into the exact same clamp
pointer parallax already uses. Clicking it again (or hitting Recapture, or
navigating away) stops the camera immediately and hands control back to the
pointer. The MediaPipe library and its model are only fetched the moment you
click the button — never on page load — and are the one deliberate exception
to "self-hosted": they're loaded from Google's own CDN, a one-time asset
fetch with the same "not visitor data" status as the depth model weights
above, not a request this app routes your camera data through.

## Recorded example

This build doesn't bundle one yet — see `public/example/README.md`.
`loadRecordedExample()` handles the gap honestly: without camera access,
"Open recorded example" shows a plain message instead of a fabricated
image. Live capture (camera permission required) works normally.

To add one: add `?debug=1` to the URL, use the live pipeline above on a
non-portrait scene (a room corner, an object — anything without a person),
and the viewing screen gains a **Download as recorded example** button that
exports exactly the three files `src/recordedExample.ts` expects
(`frame.jpg`, `depth.bin`, `manifest.json`). Drop them into
`public/example/` and update its README's provenance note in the same
commit.
