import { afterEach, describe, expect, it, vi } from "vitest";
import { Camera, CameraError } from "./camera";

function fakeVideoElement() {
  return {
    srcObject: null as unknown,
    playsInline: false,
    muted: false,
    play: vi.fn(async () => {}),
  };
}

function fakeTrack() {
  return { stop: vi.fn() };
}

function fakeStream(tracks: ReturnType<typeof fakeTrack>[]) {
  return { getTracks: () => tracks };
}

function stubDom(getUserMedia?: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("document", { createElement: vi.fn(() => fakeVideoElement()) });
  vi.stubGlobal("navigator", { mediaDevices: getUserMedia ? { getUserMedia } : undefined });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Camera lifecycle", () => {
  it("throws camera-unavailable when the browser has no getUserMedia at all", async () => {
    stubDom(undefined);
    const camera = new Camera();
    await expect(camera.start()).rejects.toThrow(CameraError);
    await expect(camera.start()).rejects.toMatchObject({ reason: "camera-unavailable" });
  });

  it("classifies a NotAllowedError as camera-denied, not a generic failure", async () => {
    stubDom(
      vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    );
    const camera = new Camera();
    await expect(camera.start()).rejects.toMatchObject({ reason: "camera-denied" });
  });

  it("stop() stops every track the granted stream held, and isActive reflects it", async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    stubDom(vi.fn(async () => fakeStream(tracks)));
    const camera = new Camera();
    await camera.start();
    expect(camera.isActive).toBe(true);

    camera.stop();

    expect(camera.isActive).toBe(false);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stop() is idempotent -- calling it again after already stopped does not re-stop tracks or throw", async () => {
    const tracks = [fakeTrack()];
    stubDom(vi.fn(async () => fakeStream(tracks)));
    const camera = new Camera();
    await camera.start();

    camera.stop();
    expect(() => camera.stop()).not.toThrow();
    expect(tracks[0].stop).toHaveBeenCalledOnce();
  });

  it("stop() before any start() is a safe no-op", () => {
    stubDom(undefined);
    const camera = new Camera();
    expect(() => camera.stop()).not.toThrow();
    expect(camera.isActive).toBe(false);
  });

  it("capture() throws camera-unavailable if the camera was never started", async () => {
    stubDom(undefined);
    const camera = new Camera();
    await expect(camera.capture()).rejects.toMatchObject({ reason: "camera-unavailable" });
  });

  it("capture() throws camera-unavailable once stopped, even if it was running a moment ago", async () => {
    const tracks = [fakeTrack()];
    stubDom(vi.fn(async () => fakeStream(tracks)));
    const camera = new Camera();
    await camera.start();
    camera.stop();
    await expect(camera.capture()).rejects.toMatchObject({ reason: "camera-unavailable" });
  });
});
