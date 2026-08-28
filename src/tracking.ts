// ---------------------------------------------------------------------------
// Head tracking: optional, local, off by default.
//
// Pointer parallax (renderer.ts's setPointer) is the real, always-on control.
// This module adds one alternative input into that exact same call: a face
// landmark tracker (MediaPipe's FaceLandmarker, not hand-written detection)
// that turns head movement into the same normalized [-1, 1] offset a pointer
// drag would produce. Nothing here decides *how* the mesh responds to that
// offset -- it just produces the offset. `@mediapipe/tasks-vision` and its
// model are only ever fetched once the visitor explicitly clicks "Use head
// tracking" (see the dynamic import in `start()`), never on page load.
// ---------------------------------------------------------------------------

/** Normalized head offset, same [-1, 1] range and axis convention as
 *  `renderer.ts`'s `setPointer`. */
export interface HeadPose {
  x: number;
  y: number;
}

export interface HeadTracker {
  start(video: HTMLVideoElement): Promise<void>;
  stop(): void;
  onPose(callback: (pose: HeadPose) => void): void;
}

/** `getUserMedia` is the only real prerequisite -- the tracker itself is a
 *  WASM model that runs on CPU or GPU depending on what the browser offers,
 *  so this isn't a hard capability gate the way WebGPU is for the depth
 *  model. The UI can offer the control and let `start()` fail honestly
 *  (camera denied, model failed to load) if something's actually wrong. */
export function isHeadTrackingAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/** One raw landmark-centroid reading, converted to the same [-1, 1] space as
 *  a pointer position, before any neutral-offset or smoothing is applied.
 *  Exported for testing; not part of the public tracking surface. */
export function centroidToPose(cx: number, cy: number): HeadPose {
  // Front-camera video is not mirrored at the pixel level (unlike its CSS
  // preview, if one were shown), so a head movement to the visitor's own
  // right moves the detected face toward smaller x in the raw frame -- the
  // opposite of how dragging the pointer right increases x. Negating x is
  // what keeps "lean right" and "drag right" doing the same thing to the
  // view. (Flip this sign if it turns out backwards on real hardware --
  // camera mirroring conventions are exactly the kind of thing that's only
  // truly confirmed by testing on the actual device.)
  return { x: -(cx - 0.5) * 2, y: (cy - 0.5) * 2 };
}

/**
 * Applies calibration (first reading becomes "centered") and a simple
 * exponential moving average to a raw pose, returning the value to feed
 * into `setPointer`. Pure function, easy to reason about and test without a
 * camera or a model: `neutral` is `null` until the first real reading
 * calibrates it, and `previous` is the last smoothed value (start at
 * `{x:0,y:0}`).
 */
export function smoothHeadOffset(
  raw: HeadPose,
  neutral: HeadPose,
  previous: HeadPose,
  alpha = 0.25,
): HeadPose {
  const dx = raw.x - neutral.x;
  const dy = raw.y - neutral.y;
  return {
    x: previous.x + alpha * (dx - previous.x),
    y: previous.y + alpha * (dy - previous.y),
  };
}

/**
 * Real head tracking via MediaPipe's FaceLandmarker (one face, translation
 * only -- no rotation, no expression, no identity, nothing stored or sent
 * anywhere). `start()` dynamically imports `@mediapipe/tasks-vision` and its
 * model, so a visitor who never enables this feature never downloads either.
 */
export class MediaPipeHeadTracker implements HeadTracker {
  private landmarker: import("@mediapipe/tasks-vision").FaceLandmarker | undefined;
  private raf: number | undefined;
  private callback: ((pose: HeadPose) => void) | undefined;

  async start(video: HTMLVideoElement): Promise<void> {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    );
    this.landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
    });

    const tick = (): void => {
      if (!this.landmarker) return;
      const result = this.landmarker.detectForVideo(video, performance.now());
      const face = result.faceLandmarks[0];
      if (face && face.length > 0) {
        // Centroid of every landmark, not one single point: averaging ~478
        // points is already a form of smoothing against per-frame jitter,
        // on top of the exponential average applied by the caller.
        let sx = 0;
        let sy = 0;
        for (const p of face) {
          sx += p.x;
          sy += p.y;
        }
        this.callback?.(centroidToPose(sx / face.length, sy / face.length));
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
    this.landmarker?.close();
    this.landmarker = undefined;
    this.callback = undefined;
  }

  onPose(callback: (pose: HeadPose) => void): void {
    this.callback = callback;
  }
}
