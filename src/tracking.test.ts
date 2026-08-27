import { describe, expect, it, vi } from "vitest";
import { UnimplementedHeadTracker, isHeadTrackingAvailable } from "./tracking";

describe("head tracking (deferred, per Phase 7)", () => {
  it("reports unavailable rather than pretending to support it", () => {
    expect(isHeadTrackingAvailable()).toBe(false);
  });

  it("start() rejects instead of silently no-op'ing, so a caller can't mistake 'not implemented' for 'tracking, hold still'", async () => {
    const tracker = new UnimplementedHeadTracker();
    await expect(tracker.start({} as HTMLVideoElement)).rejects.toThrow(/not implemented/i);
  });

  it("stop() and onPose() are safe no-ops even though start() always rejects", () => {
    const tracker = new UnimplementedHeadTracker();
    const callback = vi.fn();
    expect(() => tracker.stop()).not.toThrow();
    expect(() => tracker.onPose(callback)).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
});
