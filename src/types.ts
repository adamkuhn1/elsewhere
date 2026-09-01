// CameraPose and Keyframe are shaped so a future multi-frame version can
// grow out of them without a rewrite (CameraPose already generalizes past
// identity). V1 uses exactly one Keyframe with an identity pose.

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
 * Releases a Keyframe's retained image if it's closeable. `ImageBitmap` is a
 * GPU/decoder-backed resource that leaks until GC unless explicitly closed;
 * `ImageData` has no `.close()` at all, so calling one unconditionally would
 * throw.
 *
 * Duck-typed on `.close` being a function rather than `instanceof
 * ImageBitmap`: the `ImageBitmap` constructor doesn't exist outside a
 * browser, so `instanceof` would throw in Node-based unit tests.
 *
 * Safe on `undefined` and safe to call twice (closing an already-closed
 * ImageBitmap is a documented no-op).
 */
export function releaseKeyframeImage(keyframe: Keyframe | undefined): void {
  const image = keyframe?.image;
  if (image && typeof (image as { close?: unknown }).close === "function") {
    (image as ImageBitmap).close();
  }
}
