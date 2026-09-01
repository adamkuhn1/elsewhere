// ---------------------------------------------------------------------------
// Head tracking: optional, local, off by default.
//
// Adds one alternative input into renderer.ts's setPointer -- a face
// landmark tracker (MediaPipe's FaceLandmarker) that turns head movement
// into the same normalized [-1, 1] offset a pointer drag would produce.
// `@mediapipe/tasks-vision` and its model are only fetched once the visitor
// clicks "Use head tracking" (see the dynamic import in `start()`).
//
// Movement is normalized against the visitor's own face size at calibration,
// not the whole camera frame: a person sitting close fills much more of the
// frame per centimeter of real head motion than someone sitting farther
// back, so normalizing against frame size instead makes the same physical
// lean feel wildly different depending on distance from the webcam.
// ---------------------------------------------------------------------------

/** Normalized head offset, same [-1, 1] range and axis convention as
 *  `renderer.ts`'s `setPointer`. */
export interface HeadPose {
  x: number;
  y: number;
}

/** One frame's raw face reading: landmark centroid plus bounding-box size,
 *  all in the model's normalized [0, 1] image space. The size is what makes
 *  face-relative (rather than frame-relative) normalization possible. */
export interface FaceMetrics {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface HeadTracker {
  start(video: HTMLVideoElement): Promise<void>;
  stop(): void;
  /** Fires once per detected frame with the raw face reading. The caller
   *  (App.tsx) owns calibration -- the first reading it gets becomes
   *  neutral -- and turns subsequent readings into a pose via
   *  `faceRelativePose`. */
  onPose(callback: (metrics: FaceMetrics) => void): void;
}

/** `getUserMedia` is the only real prerequisite -- the tracker itself is a
 *  WASM model that runs on CPU or GPU depending on what the browser offers,
 *  so this isn't a hard capability gate the way WebGPU is for the depth
 *  model. The UI can offer the control and let `start()` fail honestly
 *  (camera denied, model failed to load) if something's actually wrong. */
export function isHeadTrackingAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/** Centroid (landmark average) and bounding box of one set of face
 *  landmarks, in the same normalized [0, 1] image space MediaPipe reports.
 *  Exported for testing; not part of the public tracking surface. */
export function computeFaceMetrics(points: { x: number; y: number }[]): FaceMetrics {
  let sx = 0;
  let sy = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const n = points.length;
  return { centerX: sx / n, centerY: sy / n, width: maxX - minX, height: maxY - minY };
}

/** Sensitivity gain applied after face-relative normalization, turning a
 *  real head lean into a deliberate viewpoint change. Tuned empirically so
 *  small unconscious movement stays quiet while a real lean reads clearly. */
export const HEAD_GAIN_X = 2.1;
export const HEAD_GAIN_Y = 1.75;

function clamp(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

/**
 * Turns one raw face reading into a pose, relative to how the face looked
 * at calibration, before any temporal smoothing. `dx`/`dy` are the
 * centroid's displacement from neutral divided by the *neutral* face's own
 * width/height -- proportional to the visitor's own apparent head size
 * rather than the full camera frame, so the same physical lean reads about
 * the same regardless of how far back they're sitting. Gain then
 * exaggerates that into the "peer around the scene" feel this is going
 * for; clamping keeps it inside the same [-1, 1] range `setPointer`
 * expects. Pure and exported for testing.
 */
export function faceRelativePose(current: FaceMetrics, neutral: FaceMetrics): HeadPose {
  const dx = (current.centerX - neutral.centerX) / neutral.width;
  const dy = (current.centerY - neutral.centerY) / neutral.height;
  // Front-camera video is not mirrored at the pixel level (unlike its CSS
  // preview, if one were shown), so leaning right moves the detected face
  // toward smaller x in the raw frame -- the opposite of dragging the
  // pointer right. Negating x keeps "lean right" and "drag right" doing
  // the same thing to the view.
  return { x: clamp(-dx * HEAD_GAIN_X), y: clamp(dy * HEAD_GAIN_Y) };
}

/**
 * Exponential moving average toward a target pose. Raw per-frame face
 * metrics (and the gain applied on top in `faceRelativePose`) can jitter
 * frame to frame, so this is still needed -- but tuned lighter than
 * generic UI smoothing so the view keeps up with real head motion instead
 * of visibly lagging behind it. Pure and exported for testing.
 */
export function smoothHeadOffset(target: HeadPose, previous: HeadPose, alpha = 0.38): HeadPose {
  return {
    x: previous.x + alpha * (target.x - previous.x),
    y: previous.y + alpha * (target.y - previous.y),
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
  private callback: ((metrics: FaceMetrics) => void) | undefined;

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
        this.callback?.(computeFaceMetrics(face));
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

  onPose(callback: (metrics: FaceMetrics) => void): void {
    this.callback = callback;
  }
}
