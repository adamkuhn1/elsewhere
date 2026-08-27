// ---------------------------------------------------------------------------
// Depth inference worker.
//
// Runs off the main thread unconditionally, in Chrome and Safari alike. This
// isn't a Chrome-only optimization: Safari's ONNX-Runtime-Web WebGPU backend
// throws (`webgpuInit is not a function`) when initialized on the main
// thread, and works correctly inside a dedicated Worker. Chrome pays nothing
// for running the same way, so there is one code path, not two. Verified
// empirically against this exact model/runtime pair in real Chrome 151 and
// real Safari 26.5, not assumed from documentation -- see README.md.
// ---------------------------------------------------------------------------
import { pipeline, RawImage, env, type DepthEstimationPipeline } from "@huggingface/transformers";
import { closeAfter } from "./closeAfter";

// No third party in the request path of a feature whose entire claim is that
// it runs on the visitor's machine: the ONNX Runtime WASM binaries are
// fetched same-origin (see vite.config.ts's self-hosting plugin), not from
// onnxruntime-web's default CDN. The model weights themselves still come
// from Hugging Face's CDN -- that's a one-time asset fetch, not visitor
// data, and is what "processed locally" has always meant here: the frame
// never leaves the browser, not that nothing is ever downloaded into it.
env.backends.onnx.wasm!.wasmPaths = "/ort/";

const MODEL_ID = "onnx-community/depth-anything-v2-small";

type Ready = { type: "ready" };
type Result = { type: "result"; depth: Float32Array; width: number; height: number };
type Failure = { type: "error"; reason: string; message: string };
type OutMessage = Ready | Result | Failure;

type InMessage = { type: "init" } | { type: "infer"; image: ImageBitmap };

let estimator: DepthEstimationPipeline | undefined;
let loading: Promise<void> | undefined;

function post(msg: OutMessage) {
  postMessage(msg);
}

async function load(): Promise<void> {
  if (!("gpu" in navigator)) {
    throw Object.assign(new Error("WebGPU not available"), { reason: "webgpu-unsupported" });
  }
  try {
    estimator = await pipeline("depth-estimation", MODEL_ID, { device: "webgpu", dtype: "q4f16" });
  } catch (err) {
    throw Object.assign(new Error(String(err)), { reason: "model-load-failed" });
  }
}

async function infer(bitmap: ImageBitmap): Promise<Result> {
  if (!estimator) throw new Error("infer() called before load()");

  // `bitmap` arrived by transfer (see depth.ts's estimate()) -- this worker
  // now owns the only reference to it, so it's the only place that can ever
  // release it. closeAfter() closes it once drawn regardless of whether the
  // draw itself succeeds, so a mid-draw failure can't leak it either.
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  await closeAfter(bitmap, () => {
    if (!ctx) throw Object.assign(new Error("2D canvas context unavailable"), { reason: "inference-failed" });
    ctx.drawImage(bitmap, 0, 0);
  });
  const image = RawImage.fromCanvas(canvas);

  try {
    // predicted_depth is already interpolated back to the input's own
    // width/height by the pipeline (see @huggingface/transformers'
    // DepthEstimationPipeline), so it lines up 1:1 with the captured
    // frame's pixels for mesh.ts without any resizing here.
    const { predicted_depth } = await estimator(image);
    const [height, width] = predicted_depth.dims.slice(-2);
    return {
      type: "result",
      depth: Float32Array.from(predicted_depth.data as Float32Array | number[]),
      width,
      height,
    };
  } catch (err) {
    throw Object.assign(new Error(String(err)), { reason: "inference-failed" });
  }
}

self.onmessage = async (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      loading ??= load();
      await loading;
      post({ type: "ready" });
      return;
    }
    if (msg.type === "infer") {
      const result = await infer(msg.image);
      post(result);
    }
  } catch (err) {
    const reason = (err as { reason?: string }).reason ?? "inference-failed";
    post({ type: "error", reason, message: err instanceof Error ? err.message : String(err) });
  }
};
