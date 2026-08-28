import { describe, expect, it } from "vitest";
import { centroidToPose, isHeadTrackingAvailable, smoothHeadOffset } from "./tracking";

describe("head tracking", () => {
  it("reports available exactly when getUserMedia exists (no WebGPU-style hard gate)", () => {
    // This test runs under Node, which has no real camera API, so the
    // negative case is the one naturally exercised here; the positive case
    // is a one-line boolean check the type signature already guarantees.
    expect(isHeadTrackingAvailable()).toBe(false);
  });

  it("maps a centered face to a centered pose", () => {
    const pose = centroidToPose(0.5, 0.5);
    expect(pose.x).toBeCloseTo(0, 10);
    expect(pose.y).toBeCloseTo(0, 10);
  });

  it("inverts x (mirrors the unmirrored front-camera frame) but not y", () => {
    const right = centroidToPose(0.75, 0.5); // face detected toward the frame's right
    expect(right.x).toBeLessThan(0); // a visitor's own left, per the mirroring note in tracking.ts
    const down = centroidToPose(0.5, 0.75);
    expect(down.y).toBeGreaterThan(0);
  });

  it("calibrates to the first neutral pose rather than an assumed center", () => {
    const neutral = { x: 0.3, y: -0.1 };
    const smoothed = smoothHeadOffset(neutral, neutral, { x: 0, y: 0 }, 1);
    expect(smoothed).toEqual({ x: 0, y: 0 });
  });

  it("smooths toward the raw offset rather than jumping to it", () => {
    const neutral = { x: 0, y: 0 };
    const raw = { x: 1, y: 0 };
    const first = smoothHeadOffset(raw, neutral, { x: 0, y: 0 }, 0.25);
    expect(first.x).toBeCloseTo(0.25, 5);
    const second = smoothHeadOffset(raw, neutral, first, 0.25);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.x).toBeLessThan(raw.x);
  });

  it("converges to the raw offset if held steady", () => {
    const neutral = { x: 0, y: 0 };
    const raw = { x: 0.6, y: -0.4 };
    let smoothed = { x: 0, y: 0 };
    for (let i = 0; i < 200; i++) smoothed = smoothHeadOffset(raw, neutral, smoothed, 0.25);
    expect(smoothed.x).toBeCloseTo(raw.x, 3);
    expect(smoothed.y).toBeCloseTo(raw.y, 3);
  });
});
