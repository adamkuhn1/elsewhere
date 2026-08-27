// ---------------------------------------------------------------------------
// Head tracking: deferred, not faked.
//
// Phase 7 of this project's build brief allows deferring head tracking to a
// later milestone if implementing it would exceed the current budget --
// explicitly on the condition that the interface point is real and tested,
// not that tracking data is faked in the meantime. Pointer parallax
// (renderer.ts's setPointer) is the actual, working, always-on control;
// this module exists so App.tsx has one honest place to ask "is head
// tracking available" and get a real answer, and so a later milestone can
// implement `HeadTracker` (most likely wrapping a small, well-supported
// face-landmark library such as MediaPipe FaceLandmarker; see the note
// against rebuilding face detection from scratch) without changing this
// file's shape.
// ---------------------------------------------------------------------------

/** Normalized head offset, same [-1, 1] range and axis convention as
 *  `renderer.ts`'s `setPointer` -- a future implementation can feed this
 *  straight into the same call. */
export interface HeadPose {
  x: number;
  y: number;
}

export interface HeadTracker {
  start(video: HTMLVideoElement): Promise<void>;
  stop(): void;
  onPose(callback: (pose: HeadPose) => void): void;
}

/** Always available, always honest: head tracking is not implemented in
 *  V1. Calling `start()` rejects rather than silently doing nothing, so a
 *  caller can't mistake "no-op" for "tracking, but you're holding still." */
export class UnimplementedHeadTracker implements HeadTracker {
  async start(_video: HTMLVideoElement): Promise<void> {
    throw new Error("Head tracking is not implemented in this version. Use pointer parallax.");
  }
  stop(): void {
    // Nothing was started; stopping is always safe.
  }
  onPose(_callback: (pose: HeadPose) => void): void {
    // No poses will ever be delivered.
  }
}

/** `false` in V1, always. Not a capability probe -- there is nothing to
 *  probe yet -- but a single source of truth so the UI never has to guess
 *  whether to show a "track my head" control. */
export function isHeadTrackingAvailable(): boolean {
  return false;
}
