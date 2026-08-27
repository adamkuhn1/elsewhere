import type { FailureReason } from "./types";
import { identityPose, type Keyframe } from "./types";

export class RecordedExampleError extends Error {
  constructor(
    public readonly reason: FailureReason,
    message: string,
  ) {
    super(message);
    this.name = "RecordedExampleError";
  }
}

interface Manifest {
  width: number;
  height: number;
  image: string;
  depth: string;
  provenance: string;
}

/**
 * Loads the one bundled recorded example: a real captured frame and its
 * real inferred depth (see `public/example/README.md` for provenance),
 * pre-computed so this path never touches the camera or the depth runtime.
 *
 * `public/example/manifest.json` is intentionally not checked into this
 * repo yet -- it needs an actual photographed room, which this build
 * process cannot produce on its own. Until Adam captures one frame through
 * the live pipeline above and it's exported here, this throws the same
 * honest, typed failure a visitor would see, rather than a raw fetch error
 * or a fabricated placeholder image.
 */
export async function loadRecordedExample(): Promise<Keyframe> {
  const manifestRes = await fetch("/example/manifest.json");
  if (!manifestRes.ok) {
    throw new RecordedExampleError(
      "recorded-example-load-failed",
      "The recorded example hasn't been captured yet.",
    );
  }
  const manifest: Manifest = await manifestRes.json();

  const [imageRes, depthRes] = await Promise.all([
    fetch(`/example/${manifest.image}`),
    fetch(`/example/${manifest.depth}`),
  ]);
  if (!imageRes.ok || !depthRes.ok) {
    throw new RecordedExampleError("recorded-example-load-failed", "The recorded example's assets failed to load.");
  }

  const [imageBlob, depthBuffer] = await Promise.all([imageRes.blob(), depthRes.arrayBuffer()]);
  const image = await createImageBitmap(imageBlob);
  const depth = new Float32Array(depthBuffer);

  if (depth.length !== manifest.width * manifest.height) {
    // The bitmap above decoded successfully -- it's a real GPU/decoder
    // resource now, and this function is about to throw without ever
    // handing it to a caller who could release it. Close it here rather
    // than leaking it on this failure path.
    image.close();
    throw new RecordedExampleError(
      "recorded-example-load-failed",
      "The recorded example's depth data doesn't match its declared dimensions.",
    );
  }

  return {
    image,
    depth,
    width: manifest.width,
    height: manifest.height,
    pose: identityPose(),
  };
}
