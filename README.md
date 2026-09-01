# Elsewhere

Capture one camera frame, estimate its depth on-device, and look around the
textured 3D surface it becomes — entirely in the browser.

## What it does

- Captures a single still frame from your camera (nothing is sent anywhere).
- Runs a monocular depth model on it locally, in a Web Worker.
- Displaces a WebGL mesh along that depth map and textures it with the frame.
- Lets you look around the result with the pointer — real parallax, not a
  faked pan — or, optionally, with your head.

This is V1: single-frame monocular depth, not a room scan or SLAM. Those are
the natural next steps, not what this version claims.

## How it works

```
camera frame → Depth Anything V2 (Worker, WebGPU) → per-pixel depth
            → WebGL mesh (vertices displaced by depth, gaps at depth cliffs)
            → pointer- or head-driven parallax camera
```

1. **Capture** — one frame, held on-device, only after you click Start camera.
2. **Depth** — Depth Anything V2 Small (Apache-2.0, ~19MB, quantized) runs in
   a Worker via ONNX Runtime Web and produces a per-pixel depth estimate.
3. **Mesh** — the frame becomes a grid of vertices displaced along their
   depth; discontinuous regions (depth cliffs) are left as gaps, not smeared.
4. **Look around** — the pointer orbits a small, bounded virtual camera
   around the mesh. An optional **Use head tracking** button drives the same
   camera from head movement instead; it's off by default, and pointer
   control is unaffected unless you turn it on.

Nothing captured is ever sent anywhere — the only network requests the live
pipeline makes are one-time fetches of the model weights and the ONNX
runtime, both self-hosted at this app's own origin (verified with a live
network trace, not just by reading the code).

## Technical highlights

- **Runs entirely client-side.** Depth inference happens in a Web Worker on
  WebGPU; there's no server, no upload, no analysis of what you capture.
- **Worker isolation is required, not optional.** ONNX Runtime Web's WebGPU
  backend throws on Safari's main thread but works inside a dedicated
  Worker; running the same Worker path on every browser keeps one pipeline
  instead of two.
- **Self-hosted inference runtime.** The ONNX WASM runtime is served from
  this app's own origin instead of a third-party CDN, so nothing outside the
  browser sits in the request path of a pipeline whose whole premise is
  local processing.
- **Optional head tracking.** MediaPipe's `FaceLandmarker` tracks one face,
  translation only (no rotation, expression, or identity). The first
  reading calibrates a neutral center; an exponential moving average
  smooths subsequent readings into the same clamped range pointer parallax
  uses. Toggling it off (or hitting Recapture, or navigating away) stops the
  camera immediately. The MediaPipe model is the one dependency loaded from
  a third-party CDN, and only once you explicitly enable the feature.

## Run locally

```sh
npm install
npm run dev          # http://localhost:5176 — needs a WebGPU-capable browser
npm run build
npm test              # pure logic: mesh, depth math, tracking math — no GPU needed
npm run typecheck
```

A browser without WebGPU gets an honest compatibility message, never a slow
CPU fallback.

## Limitations

- **Single-frame depth, not a scan.** No multi-frame fusion or camera-pose
  tracking; the mesh reflects one frame's monocular depth estimate.
- **Bounded viewpoint, not new geometry.** Head tracking and pointer
  parallax both move a small virtual camera around a fixed mesh; neither
  reconstructs anything beyond what the single depth pass produced.
- **No recorded example bundled** in this build — `public/example/README.md`
  explains why and how to add one. Live capture (camera permission required)
  works normally either way.
