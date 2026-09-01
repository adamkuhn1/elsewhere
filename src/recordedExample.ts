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

// A dev server or a static host with SPA-style fallback routing answers a
// missing /example/manifest.json with 200 and the app's own index.html
// (there's no manifest.json route, so it falls back to serving the shell) --
// not a 404. `res.ok` alone can't tell "exists" from "missing" here; the
// content has to actually look like the manifest, not HTML.
function parseManifest(text: string): Manifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const m = parsed as Partial<Manifest> | null;
  if (!m || typeof m.width !== "number" || typeof m.height !== "number" || typeof m.image !== "string" || typeof m.depth !== "string") {
    return undefined;
  }
  return m as Manifest;
}

/**
 * Whether a recorded example is actually bundled in this build. Fetches and
 * validates the manifest's actual shape (see parseManifest) rather than
 * trusting a 200 status alone -- the idle screen uses this to decide
 * whether "Open recorded example" is worth offering, rather than showing an
 * active-looking button that always fails.
 */
export async function hasRecordedExample(): Promise<boolean> {
  try {
    const res = await fetch("/example/manifest.json");
    if (!res.ok) return false;
    return parseManifest(await res.text()) !== undefined;
  } catch {
    return false;
  }
}

export async function loadRecordedExample(): Promise<Keyframe> {
  const manifestRes = await fetch("/example/manifest.json");
  const manifest = manifestRes.ok ? parseManifest(await manifestRes.text()) : undefined;
  if (!manifest) {
    throw new RecordedExampleError(
      "recorded-example-load-failed",
      "The recorded example hasn't been captured yet.",
    );
  }

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
