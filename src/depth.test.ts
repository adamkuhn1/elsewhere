import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLiveDepthSupport, normalizeDepth, resetLiveDepthSupportCache } from "./depth";

describe("normalizeDepth", () => {
  it("returns an empty array for empty input", () => {
    expect(normalizeDepth(new Float32Array(0)).length).toBe(0);
  });

  it("maps the full range to [0, 1]", () => {
    const raw = Float32Array.from([2, 4, 6, 8, 10]);
    const out = normalizeDepth(raw);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...out)).toBeLessThanOrEqual(1);
    expect(Math.max(...out)).toBeCloseTo(1, 5);
  });

  it("clamps outlier pixels instead of letting them dominate the range", () => {
    // 100 normal values clustered together, plus one wild outlier.
    const raw = new Float32Array(101);
    for (let i = 0; i < 100; i++) raw[i] = 5 + i * 0.01; // 5.00..5.99
    raw[100] = 10000; // outlier
    const out = normalizeDepth(raw);
    // The 99th percentile clamp means the outlier's own normalized value is
    // clamped to 1, but the *typical* values still spread out over a
    // meaningful chunk of [0, 1] rather than being crushed near 0.
    const typical = out.slice(0, 100);
    expect(Math.max(...typical)).toBeGreaterThan(0.5);
  });

  it("is stable (idempotent up to floating point) when applied twice", () => {
    const raw = Float32Array.from([1, 2, 3, 4, 5]);
    const once = normalizeDepth(raw);
    const twice = normalizeDepth(once);
    for (let i = 0; i < once.length; i++) {
      expect(twice[i]).toBeCloseTo(once[i], 3);
    }
  });

  it("returns a constant field rather than NaN when depth has zero spread", () => {
    const raw = new Float32Array(16).fill(3);
    const out = normalizeDepth(raw);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(out.every((v) => v === 0.5)).toBe(true);
  });

  it("every output value is finite", () => {
    const raw = Float32Array.from([Number.NaN, 1, 2, 3].filter(Number.isFinite));
    const out = normalizeDepth(raw);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLiveDepthSupportCache();
});

describe("checkLiveDepthSupport (capability preflight, run before any camera request)", () => {
  it("is false, and never touches fetch, when the browser has no navigator.gpu at all", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", fetchSpy);
    expect(await checkLiveDepthSupport()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is false when requestAdapter() resolves to null (WebGPU present but no usable adapter)", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => null) } });
    expect(await checkLiveDepthSupport()).toBe(false);
  });

  it("is false when requestAdapter() itself throws", async () => {
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: vi.fn(async () => {
          throw new Error("no adapter");
        }),
      },
    });
    expect(await checkLiveDepthSupport()).toBe(false);
  });

  it("is false when the runtime asset HEAD request 404s (asset preflight, not just adapter)", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => ({})) } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    expect(await checkLiveDepthSupport()).toBe(false);
  });

  it("is false when the asset request is answered by an HTML fallback (misconfigured hosting) rather than the real runtime file", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => ({})) } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "text/html" } })),
    );
    expect(await checkLiveDepthSupport()).toBe(false);
  });

  it("is true when a real adapter is returned and the runtime asset answers as itself", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => ({})) } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "application/wasm" } })),
    );
    expect(await checkLiveDepthSupport()).toBe(true);
  });

  it("only requests an adapter once across repeated calls (memoized)", async () => {
    const requestAdapter = vi.fn(async () => ({}));
    vi.stubGlobal("navigator", { gpu: { requestAdapter } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "application/wasm" } })),
    );
    await checkLiveDepthSupport();
    await checkLiveDepthSupport();
    await checkLiveDepthSupport();
    expect(requestAdapter).toHaveBeenCalledOnce();
  });
});
