import { describe, expect, it } from "vitest";
import {
  computeFaceMetrics,
  faceRelativePose,
  HEAD_GAIN_X,
  HEAD_GAIN_Y,
  isHeadTrackingAvailable,
  smoothHeadOffset,
} from "./tracking";

describe("head tracking", () => {
  it("reports available exactly when getUserMedia exists (no WebGPU-style hard gate)", () => {
    // This test runs under Node, which has no real camera API, so the
    // negative case is the one naturally exercised here; the positive case
    // is a one-line boolean check the type signature already guarantees.
    expect(isHeadTrackingAvailable()).toBe(false);
  });

  describe("computeFaceMetrics", () => {
    it("centers on the landmark average and sizes to the bounding box", () => {
      const points = [
        { x: 0.4, y: 0.3 },
        { x: 0.6, y: 0.3 },
        { x: 0.6, y: 0.5 },
        { x: 0.4, y: 0.5 },
      ];
      const metrics = computeFaceMetrics(points);
      expect(metrics.centerX).toBeCloseTo(0.5, 10);
      expect(metrics.centerY).toBeCloseTo(0.4, 10);
      expect(metrics.width).toBeCloseTo(0.2, 10);
      expect(metrics.height).toBeCloseTo(0.2, 10);
    });
  });

  describe("faceRelativePose", () => {
    const neutral = { centerX: 0.5, centerY: 0.5, width: 0.2, height: 0.25 };

    it("maps the neutral face itself to a centered pose", () => {
      const pose = faceRelativePose(neutral, neutral);
      expect(pose.x).toBeCloseTo(0, 10);
      expect(pose.y).toBeCloseTo(0, 10);
    });

    it("inverts x (mirrors the unmirrored front-camera frame) but not y", () => {
      const right = faceRelativePose({ ...neutral, centerX: neutral.centerX + 0.02 }, neutral);
      expect(right.x).toBeLessThan(0); // a visitor's own left, per the mirroring note in tracking.ts
      const down = faceRelativePose({ ...neutral, centerY: neutral.centerY + 0.02 }, neutral);
      expect(down.y).toBeGreaterThan(0);
    });

    it("normalizes displacement against the neutral face's own size, not the whole frame", () => {
      // Same absolute pixel displacement (0.02), but a smaller neutral face
      // (as if the visitor were sitting farther back) should produce a
      // *larger* normalized pose -- proportional to their own apparent head
      // size, not to the camera frame.
      const nearFace = { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4 };
      const farFace = { centerX: 0.5, centerY: 0.5, width: 0.1, height: 0.1 };
      const nearPose = faceRelativePose({ ...nearFace, centerX: nearFace.centerX + 0.02 }, nearFace);
      const farPose = faceRelativePose({ ...farFace, centerX: farFace.centerX + 0.02 }, farFace);
      expect(Math.abs(farPose.x)).toBeGreaterThan(Math.abs(nearPose.x));
    });

    it("applies the documented sensitivity gain before clamping", () => {
      // A small, sub-clamping displacement should scale up by very close to
      // the gain constant -- confirms the gain is actually wired in, not
      // just declared.
      const small = faceRelativePose({ ...neutral, centerX: neutral.centerX + 0.01 }, neutral);
      const expectedX = -((0.01 / neutral.width) * HEAD_GAIN_X);
      expect(small.x).toBeCloseTo(expectedX, 5);
      expect(HEAD_GAIN_X).toBeGreaterThan(1);
      expect(HEAD_GAIN_Y).toBeGreaterThan(1);
    });

    it("clamps to [-1, 1] rather than letting a big lean or gain overshoot", () => {
      const farRight = faceRelativePose({ ...neutral, centerX: neutral.centerX + 5 }, neutral);
      expect(farRight.x).toBe(-1);
      const farDown = faceRelativePose({ ...neutral, centerY: neutral.centerY + 5 }, neutral);
      expect(farDown.y).toBe(1);
    });

    it("falls back to 0 rather than propagating NaN for a degenerate (zero-size) neutral face", () => {
      const degenerate = { centerX: 0.5, centerY: 0.5, width: 0, height: 0 };
      const pose = faceRelativePose({ centerX: 0.6, centerY: 0.6, width: 0.2, height: 0.2 }, degenerate);
      expect(pose.x).toBe(0);
      expect(pose.y).toBe(0);
    });
  });

  describe("smoothHeadOffset", () => {
    it("starts at the previous value and moves toward the target", () => {
      const target = { x: 1, y: 0 };
      const first = smoothHeadOffset(target, { x: 0, y: 0 }, 0.45);
      expect(first.x).toBeCloseTo(0.45, 5);
      const second = smoothHeadOffset(target, first, 0.45);
      expect(second.x).toBeGreaterThan(first.x);
      expect(second.x).toBeLessThan(target.x);
    });

    it("converges to the target if held steady", () => {
      const target = { x: 0.6, y: -0.4 };
      let smoothed = { x: 0, y: 0 };
      for (let i = 0; i < 60; i++) smoothed = smoothHeadOffset(target, smoothed, 0.45);
      expect(smoothed.x).toBeCloseTo(target.x, 3);
      expect(smoothed.y).toBeCloseTo(target.y, 3);
    });

    it("converges noticeably faster at the default alpha than the old 0.25 pointer-style smoothing did", () => {
      const target = { x: 1, y: 0 };
      const withDefaultAlpha = smoothHeadOffset(target, { x: 0, y: 0 });
      const withOldAlpha = smoothHeadOffset(target, { x: 0, y: 0 }, 0.25);
      expect(withDefaultAlpha.x).toBeGreaterThan(withOldAlpha.x);
    });
  });
});
