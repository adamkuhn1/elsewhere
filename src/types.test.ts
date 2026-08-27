import { describe, expect, it, vi } from "vitest";
import { identityPose, releaseKeyframeImage, type Keyframe } from "./types";

describe("identityPose", () => {
  it("returns a 16-element column-major identity matrix", () => {
    const pose = identityPose();
    expect(Array.from(pose.matrix)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("returns a fresh matrix each call, not a shared mutable instance", () => {
    const a = identityPose();
    const b = identityPose();
    a.matrix[0] = 99;
    expect(b.matrix[0]).toBe(1);
  });
});

function keyframeWithImage(image: Keyframe["image"]): Keyframe {
  return { image, depth: new Float32Array(0), width: 0, height: 0, pose: identityPose() };
}

describe("releaseKeyframeImage", () => {
  it("closes an ImageBitmap-like image (has a .close method)", () => {
    const close = vi.fn();
    releaseKeyframeImage(keyframeWithImage({ close } as unknown as ImageBitmap));
    expect(close).toHaveBeenCalledOnce();
  });

  it("never calls .close() on an ImageData -- it has no such method and doing so would throw", () => {
    // A real ImageData has no `close` property at all; this models that
    // exactly rather than adding a jsdom dependency just to construct one.
    const imageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData;
    expect(() => releaseKeyframeImage(keyframeWithImage(imageData))).not.toThrow();
  });

  it("is a safe no-op when there is no keyframe at all", () => {
    expect(() => releaseKeyframeImage(undefined)).not.toThrow();
  });

  it("is safe to call twice on the same keyframe (closing an already-closed bitmap is a documented no-op)", () => {
    const close = vi.fn();
    const kf = keyframeWithImage({ close } as unknown as ImageBitmap);
    releaseKeyframeImage(kf);
    releaseKeyframeImage(kf);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
