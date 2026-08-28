import { describe, expect, it } from "vitest";
import { clampParallax, HEAD_PARALLAX_OFFSET, MAX_PARALLAX_OFFSET } from "./renderer";

describe("clampParallax (camera bounds)", () => {
  it("passes through values already inside [-1, 1]", () => {
    expect(clampParallax(0.4, -0.6)).toEqual([0.4, -0.6]);
  });

  it("clamps values beyond the bound on both axes", () => {
    expect(clampParallax(5, -5)).toEqual([1, -1]);
  });

  it("never returns a value outside [-1, 1] for extreme input", () => {
    for (const v of [Infinity, -Infinity, 1e9, -1e9]) {
      const [x, y] = clampParallax(v, v);
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to 0 for non-finite input rather than propagating NaN", () => {
    expect(clampParallax(NaN, NaN)).toEqual([0, 0]);
  });

  it("keeps the world-space camera orbit small enough to read as looking, not flying", () => {
    // MAX_PARALLAX_OFFSET is what a clamped pointer value of 1 gets scaled
    // by in drawFrame -- this is the actual bound on how far the camera can
    // move, and it must stay well under the eye's own distance from the
    // subject (1.6, in drawFrame) or the camera could swing past the mesh.
    expect(MAX_PARALLAX_OFFSET).toBeLessThan(1.6);
    expect(MAX_PARALLAX_OFFSET).toBeGreaterThan(0);
  });

  it("gives head tracking a visibly stronger orbit than the pointer, but still short of the eye's own distance", () => {
    // Head tracking is going for a "peer around the scene" feel and should
    // read as clearly stronger than pointer parallax, but 1.6 (the eye's
    // fixed distance from the subject in drawFrame) is still the hard
    // ceiling -- past that the camera could swing past the mesh entirely.
    expect(HEAD_PARALLAX_OFFSET).toBeGreaterThan(MAX_PARALLAX_OFFSET);
    expect(HEAD_PARALLAX_OFFSET).toBeLessThan(1.6);
  });
});
