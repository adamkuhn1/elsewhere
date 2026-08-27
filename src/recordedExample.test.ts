import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRecordedExample, RecordedExampleError } from "./recordedExample";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadRecordedExample", () => {
  it("fails with a concise, typed, human-readable state when the manifest is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(loadRecordedExample()).rejects.toThrow(RecordedExampleError);
    await expect(loadRecordedExample()).rejects.toMatchObject({ reason: "recorded-example-load-failed" });
  });

  it("fails the same typed way when an asset (not just the manifest) 404s", async () => {
    const manifest = { width: 2, height: 2, image: "frame.jpg", depth: "depth.bin", provenance: "test" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );
    await expect(loadRecordedExample()).rejects.toMatchObject({ reason: "recorded-example-load-failed" });
  });

  it("fails the same typed way when depth data length doesn't match declared dimensions, and closes the decoded bitmap it can no longer hand to a caller", async () => {
    const manifest = { width: 4, height: 4, image: "frame.jpg", depth: "depth.bin", provenance: "test" };
    const wrongLengthDepth = new Float32Array(4); // should be 16 for a 4x4 frame
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("manifest.json")) return new Response(JSON.stringify(manifest), { status: 200 });
        if (String(url).endsWith("depth.bin")) return new Response(wrongLengthDepth.buffer, { status: 200 });
        return new Response(new Blob(["fake-image"]), { status: 200 });
      }),
    );
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4, height: 4, close }) as unknown as ImageBitmap),
    );
    await expect(loadRecordedExample()).rejects.toMatchObject({ reason: "recorded-example-load-failed" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("succeeds and returns an identity-pose keyframe when every asset is present and consistent", async () => {
    const manifest = { width: 2, height: 2, image: "frame.jpg", depth: "depth.bin", provenance: "test capture" };
    const depth = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("manifest.json")) return new Response(JSON.stringify(manifest), { status: 200 });
        if (String(url).endsWith("depth.bin")) return new Response(depth.buffer, { status: 200 });
        return new Response(new Blob(["fake-image"]), { status: 200 });
      }),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 2, height: 2 }) as unknown as ImageBitmap),
    );

    const keyframe = await loadRecordedExample();
    expect(keyframe.width).toBe(2);
    expect(keyframe.height).toBe(2);
    Array.from(keyframe.depth).forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.2, 0.3, 0.4][i], 5));
    expect(Array.from(keyframe.pose.matrix)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});
