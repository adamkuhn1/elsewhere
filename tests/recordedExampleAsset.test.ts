import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Validates the actual committed recorded-example asset on disk -- not a
// mock, the real public/example/ files. Distinct from recordedExample.test.ts
// (which tests loadRecordedExample()'s fetch/failure logic against mocked
// responses): this is the "is the file itself well-formed" check, so a
// future replacement of the example (see public/example/README.md) that
// ships mismatched dimensions or corrupt depth data fails CI immediately
// instead of only surfacing as a broken portfolio demo.
//
// This public repo doesn't bundle an example yet (the private dev copy's one
// is a self-portrait, deliberately not published -- see public/example/README.md).
// The asset-content checks below skip themselves when the manifest is absent
// rather than failing CI over a known, intentional gap; loadRecordedExample()
// already degrades to an honest in-app message in that case.
// ---------------------------------------------------------------------------

const EXAMPLE_DIR = join(__dirname, "../public/example");
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const hasExample = existsSync(join(EXAMPLE_DIR, "manifest.json"));

describe("committed recorded-example asset", () => {
  it.skipIf(!hasExample)("manifest declares a positive width/height and references the other two files", () => {
    const manifest = JSON.parse(readFileSync(join(EXAMPLE_DIR, "manifest.json"), "utf8"));
    expect(manifest.width).toBeGreaterThan(0);
    expect(manifest.height).toBeGreaterThan(0);
    expect(manifest.image).toBe("frame.jpg");
    expect(manifest.depth).toBe("depth.bin");
    expect(typeof manifest.provenance).toBe("string");
    expect(manifest.provenance.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasExample)("depth.bin's byte length is exactly width * height * 4 (one f32 per pixel)", () => {
    const manifest = JSON.parse(readFileSync(join(EXAMPLE_DIR, "manifest.json"), "utf8"));
    const bytes = readFileSync(join(EXAMPLE_DIR, "depth.bin"));
    expect(bytes.length).toBe(manifest.width * manifest.height * 4);
  });

  it.skipIf(!hasExample)("every depth value is finite, and there is meaningful variance (not a flat/corrupt field)", () => {
    const bytes = readFileSync(join(EXAMPLE_DIR, "depth.bin"));
    const depth = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    expect(depth.every(Number.isFinite)).toBe(true);
    // Not Math.min(...depth): a ~900k-element spread blows the call stack.
    let min = Infinity;
    let max = -Infinity;
    for (const v of depth) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(max - min).toBeGreaterThan(0.05);
  });

  it.skipIf(!hasExample)("frame.jpg is a real JPEG (correct magic bytes), not an empty or corrupt file", () => {
    const bytes = readFileSync(join(EXAMPLE_DIR, "frame.jpg"));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
  });

  it("has this README even without the example files (explains the gap)", () => {
    expect(existsSync(join(EXAMPLE_DIR, "README.md"))).toBe(true);
  });
});
