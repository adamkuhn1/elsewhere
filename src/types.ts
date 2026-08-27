// ---------------------------------------------------------------------------
// Durable data contracts.
//
// These two shapes are written so V2 (multi-frame visual odometry) can grow
// out of them without a rewrite -- CameraPose already generalizes past
// identity, Keyframe already carries everything a future pose-graph or
// keyframe database would need per-frame. Nothing else is built yet: no map
// manager, no keyframe store, no pose graph. V1 has exactly one Keyframe,
// held in a single piece of component state, with an identity pose.
// ---------------------------------------------------------------------------

/** A camera pose as a 4x4 column-major matrix, identity for V1. */
export interface CameraPose {
  matrix: Float32Array;
}

export function identityPose(): CameraPose {
  // prettier-ignore
  return {
    matrix: new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]),
  };
}

/**
 * One captured, depth-estimated frame. `depth` is row-major, `width*height`
 * long, one finite value per pixel in the same normalized units `depth.ts`
 * produces (see `normalizeDepth`) -- not raw model output, not meters.
 */
export interface Keyframe {
  image: ImageBitmap | ImageData;
  depth: Float32Array;
  width: number;
  height: number;
  pose: CameraPose;
}

/** Every way V1's pipeline can honestly fail, named so the UI can react to
 *  each with a specific, human-readable message instead of one generic
 *  "something went wrong." */
export type FailureReason =
  | "camera-denied"
  | "camera-unavailable"
  | "webgpu-unsupported"
  | "runtime-init-failed"
  | "model-load-failed"
  | "inference-failed"
  | "webgl-unsupported"
  | "recorded-example-load-failed"
  | "render-failed";

export interface CaptureFailure {
  reason: FailureReason;
  message: string;
}

/**
 * Releases a Keyframe's retained image if it's closeable. `ImageBitmap` is
 * a GPU/decoder-backed resource that must be explicitly released or it
 * leaks until GC; `ImageData` is a plain typed-array wrapper with no such
 * resource and *no* `.close()` method at all -- calling one on it would be
 * a runtime error, not just a no-op, so the check here isn't optional
 * defensiveness.
 *
 * Duck-typed on `.close` being a function, deliberately not
 * `instanceof ImageBitmap`: the `ImageBitmap` constructor doesn't exist as
 * a global outside a browser (Node test environments included), so an
 * `instanceof` check would throw a TypeError in exactly the unit tests this
 * function needs to be covered by. Checking for the method this function
 * actually calls is both the more portable check and the more literal
 * reading of "never call .close() on ImageData."
 *
 * Safe to call on `undefined` (nothing held yet) and safe to call twice
 * (closing an already-closed ImageBitmap is a documented no-op).
 */
export function releaseKeyframeImage(keyframe: Keyframe | undefined): void {
  const image = keyframe?.image;
  if (image && typeof (image as { close?: unknown }).close === "function") {
    (image as ImageBitmap).close();
  }
}
