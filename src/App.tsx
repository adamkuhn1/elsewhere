import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraError } from "./camera";
import { DepthEstimator, DepthEstimationError, checkLiveDepthSupport, normalizeDepth } from "./depth";
import { buildMesh } from "./mesh";
import { Renderer } from "./renderer";
import { loadRecordedExample, RecordedExampleError } from "./recordedExample";
import { downloadAsRecordedExample, isExportDebugEnabled } from "./exportCapture";
import { identityPose, releaseKeyframeImage, type Keyframe, type CaptureFailure } from "./types";

type Stage =
  | { kind: "idle" }
  | { kind: "camera-starting" }
  | { kind: "camera-ready" }
  | { kind: "processing" }
  | { kind: "viewing"; keyframe: Keyframe; source: "captured" | "recorded" }
  | { kind: "failed"; failure: CaptureFailure };

const FAILURE_COPY: Record<CaptureFailure["reason"], string> = {
  "camera-denied": "Camera access was denied. Allow it in your browser's site settings and try again.",
  "camera-unavailable": "No camera could be started on this device.",
  "webgpu-unsupported": "This browser doesn't support WebGPU, which the depth model needs. Try the recorded example instead.",
  "runtime-init-failed": "The depth-estimation runtime failed to start.",
  "model-load-failed": "The depth model failed to load. Check your connection and try again.",
  "inference-failed": "Depth estimation failed on that frame. Try again.",
  "webgl-unsupported": "This browser doesn't support WebGL2, which the viewer needs.",
  "recorded-example-load-failed": "The recorded example hasn't been captured yet.",
};

export default function App() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [compare, setCompare] = useState(false);
  // null = still checking, on mount, before ever rendering "Try live capture".
  const [liveSupported, setLiveSupported] = useState<boolean | null>(null);
  const cameraRef = useRef<Camera>();
  const estimatorRef = useRef<DepthEstimator>();
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  // The image currently held by whatever Keyframe is in `stage` (if any) --
  // tracked outside React state because releasing it is an imperative
  // side effect that must run exactly once per keyframe, not something a
  // render should trigger.
  const heldKeyframeRef = useRef<Keyframe>();

  const camera = () => (cameraRef.current ??= new Camera());
  const estimator = () => (estimatorRef.current ??= new DepthEstimator());

  // Checked once, before the idle screen ever offers "Try live capture" -- an
  // unsupported browser never sees a control that would just end in a
  // permission prompt it can't use. Costs one WebGPU adapter request and one
  // HEAD fetch of the runtime's own WASM file; downloads no model.
  useEffect(() => {
    let cancelled = false;
    checkLiveDepthSupport().then((supported) => {
      if (!cancelled) setLiveSupported(supported);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      cameraRef.current?.stop();
      estimatorRef.current?.dispose();
      releaseKeyframeImage(heldKeyframeRef.current);
      heldKeyframeRef.current = undefined;
    },
    [],
  );

  const startCamera = useCallback(async () => {
    setStage({ kind: "camera-starting" });
    // Defensive re-check, not just the mount-time one: covers the narrow
    // window before that check resolves, and any caller that reaches here
    // some other way. Either way, no camera permission is requested for an
    // unsupported browser.
    const supported = await checkLiveDepthSupport();
    if (!supported) {
      setStage({ kind: "failed", failure: { reason: "webgpu-unsupported", message: "This browser doesn't support live depth capture." } });
      return;
    }
    try {
      await camera().start();
      setStage({ kind: "camera-ready" });
    } catch (err) {
      const failure = err instanceof CameraError ? { reason: err.reason, message: err.message } : { reason: "camera-unavailable" as const, message: String(err) };
      setStage({ kind: "failed", failure });
    }
  }, []);

  // The live <video> element only exists in the "camera-ready" stage; wire
  // its stream once the DOM node for that stage actually mounts.
  useEffect(() => {
    if (stage.kind !== "camera-ready") return;
    const video = videoPreviewRef.current;
    const active = cameraRef.current;
    if (!video || !active) return;
    active.attachPreview(video);
  }, [stage.kind]);

  /** Swaps in a freshly built keyframe as the one the app displays,
   *  releasing whatever keyframe was previously held first. Centralizing
   *  this is what makes "close on replace" a single rule instead of one
   *  each call site has to remember. */
  const showKeyframe = useCallback((keyframe: Keyframe, source: "captured" | "recorded") => {
    releaseKeyframeImage(heldKeyframeRef.current);
    heldKeyframeRef.current = keyframe;
    setStage({ kind: "viewing", keyframe, source });
  }, []);

  const capture = useCallback(async () => {
    setStage({ kind: "processing" });
    let textureBitmap: ImageBitmap | undefined;
    try {
      const bitmap = await camera().capture();
      // The frame needed for processing has been obtained -- the camera
      // itself has no further job, whatever happens next. Stopped here,
      // unconditionally, rather than only on the success path.
      camera().stop();
      // estimate() transfers `bitmap` to the worker (zero-copy), which
      // detaches it on this thread -- a detached ImageBitmap fails
      // texImage2D silently later with no exception, just a WebGL warning
      // and a blank texture. An independent copy, taken before the
      // transfer, is what the renderer actually displays; the worker
      // closes its own (transferred) copy once it's drawn.
      textureBitmap = await createImageBitmap(bitmap);
      const { depth, width, height } = await estimator().estimate(bitmap);
      const keyframe: Keyframe = {
        image: textureBitmap,
        depth: normalizeDepth(depth),
        width,
        height,
        pose: identityPose(),
      };
      showKeyframe(keyframe, "captured");
    } catch (err) {
      // Camera may not have reached the `stop()` call above yet (e.g. the
      // capture() call itself threw) -- stop is idempotent, so calling it
      // again here is always safe and closes that gap.
      camera().stop();
      // textureBitmap may have decoded successfully even though a later
      // step (estimate()) failed -- it was never handed to showKeyframe,
      // so nothing else will ever release it.
      textureBitmap?.close();
      const failure =
        err instanceof CameraError || err instanceof DepthEstimationError
          ? { reason: err.reason, message: err.message }
          : { reason: "inference-failed" as const, message: String(err) };
      setStage({ kind: "failed", failure });
    }
  }, [showKeyframe]);

  const openRecordedExample = useCallback(async () => {
    setStage({ kind: "processing" });
    try {
      const keyframe = await loadRecordedExample();
      showKeyframe(keyframe, "recorded");
    } catch (err) {
      const failure =
        err instanceof RecordedExampleError
          ? { reason: err.reason, message: err.message }
          : { reason: "recorded-example-load-failed" as const, message: String(err) };
      setStage({ kind: "failed", failure });
    }
  }, [showKeyframe]);

  const recapture = useCallback(() => {
    camera().stop();
    releaseKeyframeImage(heldKeyframeRef.current);
    heldKeyframeRef.current = undefined;
    setCompare(false);
    setStage({ kind: "idle" });
  }, []);

  const backFromFailure = useCallback(() => {
    // Defensive: most failure paths already stop the camera and release any
    // partially-built image themselves, but "Back" is the one exit every
    // failure state shares, so it re-asserts both rather than trusting each
    // path upstream got it right.
    camera().stop();
    releaseKeyframeImage(heldKeyframeRef.current);
    heldKeyframeRef.current = undefined;
    setStage({ kind: "idle" });
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Elsewhere</h1>
        <p className="app-status">Work in progress</p>
      </header>

      <p className="app-copy">
        A locally processed spatial photograph: capture one camera frame, estimate its depth on this device, and turn it into a
        textured 3D surface you can look around. Nothing you capture leaves your browser.
      </p>

      {stage.kind === "idle" && (
        <div className="panel">
          {/* The reliable default: works everywhere, immediately, with no
              permission prompt. Listed and styled first for that reason --
              live capture is the deliberate secondary action below it, not
              the other way around. */}
          <button onClick={openRecordedExample}>Open recorded example</button>
          {liveSupported === false && (
            <p className="panel-note">
              This browser doesn't support live depth capture (WebGPU is required). The recorded example above works everywhere.
            </p>
          )}
          {liveSupported !== false && (
            <button className="secondary" onClick={startCamera}>
              Try live capture
            </button>
          )}
        </div>
      )}

      {stage.kind === "camera-starting" && <p className="panel-status">Requesting camera access…</p>}

      {stage.kind === "camera-ready" && (
        <div className="panel">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoPreviewRef} className="preview" autoPlay playsInline muted />
          <button onClick={capture}>Capture frame</button>
        </div>
      )}

      {stage.kind === "processing" && <p className="panel-status">Estimating depth…</p>}

      {stage.kind === "viewing" && (
        <div className="panel">
          <MeshView keyframe={stage.keyframe} compare={compare} />
          <div className="controls">
            <button onClick={() => setCompare((c) => !c)}>{compare ? "Show mesh" : "Compare to original"}</button>
            <button onClick={recapture}>{stage.source === "captured" ? "Recapture" : "Try live capture"}</button>
            {stage.source === "captured" && isExportDebugEnabled() && (
              <button
                className="secondary"
                onClick={() => downloadAsRecordedExample(stage.keyframe, "Captured through Elsewhere's own live pipeline.")}
              >
                Download as recorded example
              </button>
            )}
          </div>
          {stage.source === "recorded" && <p className="panel-note">Recorded example — no camera used.</p>}
        </div>
      )}

      {stage.kind === "failed" && (
        <div className="panel">
          <p className="panel-error">{FAILURE_COPY[stage.failure.reason]}</p>
          <button onClick={backFromFailure}>Back</button>
        </div>
      )}
    </div>
  );
}

function MeshView({ keyframe, compare }: { keyframe: Keyframe; compare: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new Renderer(canvas);
    rendererRef.current = renderer;
    const mesh = buildMesh(keyframe.depth, keyframe.width, keyframe.height);
    renderer.uploadMesh(mesh);
    renderer.uploadTexture(keyframe.image);
    renderer.start();
    return () => {
      renderer.dispose();
      rendererRef.current = undefined;
    };
    // keyframe is treated as immutable once passed in (a fresh capture
    // produces a fresh object), so this effect intentionally runs once per
    // mount rather than tracking keyframe's fields individually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyframe]);

  useEffect(() => {
    rendererRef.current?.setPaused(compare);
  }, [compare]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    rendererRef.current?.setPointer(x, y);
  };

  return (
    <div className="mesh-view" onPointerMove={onPointerMove}>
      <canvas ref={canvasRef} className={compare ? "hidden" : undefined} />
      {compare && (
        <OriginalImage image={keyframe.image} />
      )}
    </div>
  );
}

function OriginalImage({ image }: { image: ImageBitmap | ImageData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const width = "width" in image ? image.width : 0;
    const height = "height" in image ? image.height : 0;
    canvas.width = width;
    canvas.height = height;
    if (image instanceof ImageData) ctx.putImageData(image, 0, 0);
    else ctx.drawImage(image, 0, 0);
  }, [image]);
  return <canvas ref={canvasRef} className="original" />;
}
