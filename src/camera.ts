import type { FailureReason } from "./types";

export class CameraError extends Error {
  constructor(
    public readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

/**
 * One camera session: start on explicit request, capture exactly one frame
 * on request, stop when done. No continuous frame loop -- V1 estimates
 * depth for a single still frame, so the stream only needs to stay open
 * between "start" and the one "capture."
 */
export class Camera {
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  /** An offscreen video used for `capture()` before any visible preview
   *  element exists yet -- `start()` resolves as soon as the stream is
   *  granted, one render ahead of the "camera-ready" stage's own <video>
   *  mounting, so capture must not depend on that element existing. */
  private offscreenVideo: HTMLVideoElement | undefined;

  /** Must be called from a user gesture (a click handler), never
   *  automatically on mount -- camera access is always an explicit ask. */
  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError("camera-unavailable", "This browser has no camera API.");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new CameraError("camera-denied", "Camera access was denied.");
      }
      throw new CameraError("camera-unavailable", "No camera could be started.");
    }
    this.offscreenVideo = document.createElement("video");
    this.offscreenVideo.srcObject = this.stream;
    this.offscreenVideo.playsInline = true;
    this.offscreenVideo.muted = true;
    await this.offscreenVideo.play();
    this.video = this.offscreenVideo;
  }

  /** Points a visible `<video>` element at the already-running stream, once
   *  one exists in the DOM (the "camera-ready" stage's own preview). This
   *  becomes the element `capture()` reads from, so what the visitor sees
   *  framed is exactly what gets captured. */
  attachPreview(videoEl: HTMLVideoElement): void {
    if (!this.stream) return;
    videoEl.srcObject = this.stream;
    void videoEl.play();
    this.video = videoEl;
  }

  /** Grabs the current frame as an ImageBitmap. */
  async capture(): Promise<ImageBitmap> {
    if (!this.video) throw new CameraError("camera-unavailable", "Camera is not started.");
    return createImageBitmap(this.video);
  }

  /** Stops every track. Must be called on recapture and on unmount --
   *  releasing the pointer/UI is not the same as releasing the camera
   *  light. */
  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video = undefined;
    this.offscreenVideo = undefined;
  }

  get isActive(): boolean {
    return this.stream !== undefined;
  }
}
