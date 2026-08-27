import type { FailureReason } from "./types";

// ---------------------------------------------------------------------------
// Main-thread handle onto the depth-inference worker.
//
// One worker, created lazily on first use and reused for subsequent
// captures -- recapture must not pay the model-load cost twice. No worker
// protocol beyond the three messages worker.ts already speaks; this is
// deliberately not a generic RPC layer.
// ---------------------------------------------------------------------------

export class DepthEstimationError extends Error {
  constructor(
    public readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "DepthEstimationError";
  }
}

export interface DepthResult {
  depth: Float32Array;
  width: number;
  height: number;
}

type PendingInfer = {
  resolve: (r: DepthResult) => void;
  reject: (e: DepthEstimationError) => void;
};

export class DepthEstimator {
  private worker: Worker | undefined;
  private readyPromise: Promise<void> | undefined;
  private pending: PendingInfer | undefined;

  /** Loads the runtime and model. Idempotent: safe to call once up front or
   *  lazily on first capture. Callers should already have gone through
   *  `checkLiveDepthSupport()` before ever reaching this -- this is a
   *  second, cheap guard against a caller that skipped it, not the
   *  preflight itself. */
  async ready(): Promise<void> {
    if (!(typeof navigator !== "undefined" && "gpu" in navigator)) {
      throw new DepthEstimationError("webgpu-unsupported", "This browser has no WebGPU support.");
    }
    this.readyPromise ??= this.init();
    return this.readyPromise;
  }

  private init(): Promise<void> {
    const worker = new Worker(new URL("./depth/worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (e) => this.onMessage(e.data);
    worker.onerror = (e) => {
      const err = new DepthEstimationError("runtime-init-failed", e.message || "Worker failed to start.");
      this.pending?.reject(err);
      this.pending = undefined;
    };
    return new Promise((resolve, reject) => {
      const onFirstMessage = (e: MessageEvent) => {
        worker.removeEventListener("message", onFirstMessage);
        if (e.data.type === "ready") resolve();
        else reject(new DepthEstimationError(e.data.reason ?? "runtime-init-failed", e.data.message ?? "Failed to initialize."));
      };
      worker.addEventListener("message", onFirstMessage);
      worker.postMessage({ type: "init" });
    });
  }

  private onMessage(msg: { type: string; depth?: Float32Array; width?: number; height?: number; reason?: string; message?: string }) {
    if (!this.pending) return; // the "ready" message from init() is handled by init()'s own listener
    if (msg.type === "result") {
      this.pending.resolve({ depth: msg.depth!, width: msg.width!, height: msg.height! });
    } else if (msg.type === "error") {
      this.pending.reject(new DepthEstimationError((msg.reason as FailureReason) ?? "inference-failed", msg.message ?? "Inference failed."));
    }
    this.pending = undefined;
  }

  async estimate(bitmap: ImageBitmap): Promise<DepthResult> {
    await this.ready();
    const worker = this.worker;
    if (!worker) throw new DepthEstimationError("runtime-init-failed", "Worker not initialized.");
    if (this.pending) throw new DepthEstimationError("inference-failed", "An inference is already in progress.");
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      worker.postMessage({ type: "infer", image: bitmap }, [bitmap]);
    });
  }

  /** Tears the worker down entirely -- recapture starts clean rather than
   *  reusing a worker that might be mid-inference. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.readyPromise = undefined;
    this.pending = undefined;
  }
}

/**
 * Same self-hosted path depth/worker.ts points `wasmPaths` at (see
 * vite.config.ts's self-hosting plugin) -- checking that this exact file
 * answers is a real preflight of the runtime this app will actually load,
 * not just a capability guess. A HEAD request costs nothing close to the
 * ~19MB model itself; nothing here downloads the model.
 */
const ORT_ASSET_PREFLIGHT_URL = "/ort/ort-wasm-simd-threaded.asyncify.wasm";

let supportPromise: Promise<boolean> | undefined;

/**
 * Whether live depth capture can actually work here -- checked *before* the
 * camera is ever requested, so an unsupported browser never sees a camera
 * permission prompt it can't use. More than a `"gpu" in navigator` guess:
 * requests a real adapter (the same call the worker's own `pipeline()`
 * needs to succeed) and confirms the exact WASM runtime file this app would
 * load is actually reachable -- neither step touches the camera or
 * downloads the depth model itself.
 *
 * Cached after the first call (a dropped/regranted GPU adapter mid-session
 * is not a case this app tries to recover from live) so repeated idle-screen
 * renders or capture attempts don't repeat the check.
 */
export function checkLiveDepthSupport(): Promise<boolean> {
  supportPromise ??= (async () => {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
    try {
      const adapter = await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
      if (!adapter) return false;
    } catch {
      return false;
    }
    try {
      const res = await fetch(ORT_ASSET_PREFLIGHT_URL, { method: "HEAD" });
      if (!res.ok) return false;
      const contentType = res.headers.get("content-type") ?? "";
      // A dev/hosting misconfiguration serving the SPA's index.html for an
      // unmatched path is the specific failure this guards -- it 200s, but
      // it isn't the runtime, and loading it as WASM later fails opaquely.
      if (contentType.includes("text/html")) return false;
    } catch {
      return false;
    }
    return true;
  })();
  return supportPromise;
}

/** Test-only: clears the memoized result so a test can simulate a changed
 *  environment across cases. Not used by application code. */
export function resetLiveDepthSupportCache(): void {
  supportPromise = undefined;
}

/**
 * Depth values as ONNX Runtime returns them are the model's own raw scale
 * (larger = closer, roughly monotonic disparity -- not metric depth, not
 * bounded to any fixed range) and can occasionally include a handful of
 * extreme outlier pixels. mesh.ts needs a stable, bounded [0, 1] field:
 * near = 1, far = 0, clamped to the 1st/99th percentile so a few outlier
 * pixels can't blow out the whole mesh's depth range.
 */
export function normalizeDepth(raw: Float32Array): Float32Array {
  if (raw.length === 0) return new Float32Array(0);
  const sorted = Float32Array.from(raw).sort();
  const lo = percentile(sorted, 0.01);
  const hi = percentile(sorted, 0.99);
  const span = hi - lo;
  const out = new Float32Array(raw.length);
  if (span <= 0) {
    out.fill(0.5);
    return out;
  }
  for (let i = 0; i < raw.length; i++) {
    const v = (raw[i] - lo) / span;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

function percentile(sorted: Float32Array, p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}
