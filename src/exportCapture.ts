import type { Keyframe } from "./types";

// ---------------------------------------------------------------------------
// This build never touches a real camera itself: an automated build
// process has no business photographing anyone's room, so
// the one real recorded example has to come from Adam actually using the
// live pipeline above, once, on his own machine. This turns whatever he
// just captured into the exact three files `recordedExample.ts` expects
// under public/example/ -- gated behind ?debug=1 so it never appears in the
// normal visitor UI.
// ---------------------------------------------------------------------------

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadAsRecordedExample(keyframe: Keyframe, provenance: string): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = keyframe.width;
  canvas.height = keyframe.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  if (keyframe.image instanceof ImageData) ctx.putImageData(keyframe.image, 0, 0);
  else ctx.drawImage(keyframe.image, 0, 0);

  const imageBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!imageBlob) throw new Error("Failed to encode frame as JPEG");

  const manifest = {
    width: keyframe.width,
    height: keyframe.height,
    image: "frame.jpg",
    depth: "depth.bin",
    provenance,
  };

  download("frame.jpg", imageBlob);
  download("depth.bin", new Blob([keyframe.depth.buffer as ArrayBuffer]));
  download("manifest.json", new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
}

export function isExportDebugEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";
}
