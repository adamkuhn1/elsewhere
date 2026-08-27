import { describe, expect, it } from "vitest";
import { buildMesh } from "./mesh";

function flatDepth(width: number, height: number, value = 0.5): Float32Array {
  return new Float32Array(width * height).fill(value);
}

describe("buildMesh", () => {
  it("throws when depth length doesn't match width*height", () => {
    expect(() => buildMesh(new Float32Array(10), 4, 4)).toThrow(/does not match/);
  });

  it("caps grid resolution at maxGridResolution on the longer axis", () => {
    const mesh = buildMesh(flatDepth(400, 200), 400, 200, { maxGridResolution: 100 });
    expect(mesh.gridWidth).toBe(100);
    expect(mesh.gridHeight).toBe(50);
  });

  it("produces one position triple and one uv pair per grid vertex", () => {
    const mesh = buildMesh(flatDepth(64, 64), 64, 64, { maxGridResolution: 16 });
    const vertexCount = mesh.gridWidth * mesh.gridHeight;
    expect(mesh.positions.length).toBe(vertexCount * 3);
    expect(mesh.uvs.length).toBe(vertexCount * 2);
  });

  it("emits both triangles per quad when depth is uniform (no discontinuities)", () => {
    const mesh = buildMesh(flatDepth(32, 32, 0.5), 32, 32, { maxGridResolution: 8 });
    const quads = (mesh.gridWidth - 1) * (mesh.gridHeight - 1);
    expect(mesh.indices.length).toBe(quads * 6);
  });

  it("rejects triangles spanning a depth discontinuity instead of stretching them", () => {
    const size = 8;
    const depth = new Float32Array(size * size).fill(0);
    // Right half is a sharp step forward -- a real cliff, not a gradient.
    for (let y = 0; y < size; y++) {
      for (let x = size / 2; x < size; x++) depth[y * size + x] = 1;
    }
    const withGap = buildMesh(depth, size, size, { maxGridResolution: size, discontinuityThreshold: 0.08 });
    const flat = buildMesh(flatDepth(size, size), size, size, { maxGridResolution: size, discontinuityThreshold: 0.08 });
    expect(withGap.indices.length).toBeLessThan(flat.indices.length);
  });

  it("keeps every triangle when the discontinuity threshold is looser than the step", () => {
    const size = 8;
    const depth = new Float32Array(size * size).fill(0);
    for (let y = 0; y < size; y++) {
      for (let x = size / 2; x < size; x++) depth[y * size + x] = 0.05;
    }
    const mesh = buildMesh(depth, size, size, { maxGridResolution: size, discontinuityThreshold: 0.5 });
    const quads = (mesh.gridWidth - 1) * (mesh.gridHeight - 1);
    expect(mesh.indices.length).toBe(quads * 6);
  });

  it("bounds z displacement to displacementScale regardless of depth value", () => {
    const size = 4;
    const depth = new Float32Array(size * size);
    depth[0] = 0;
    depth[depth.length - 1] = 1;
    const mesh = buildMesh(depth, size, size, { maxGridResolution: size, displacementScale: 0.6 });
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const z = mesh.positions[i * 3 + 2];
      expect(Math.abs(z)).toBeLessThanOrEqual(0.3 + 1e-6);
    }
  });

  it("maps image v (down) to NDC y (up) with a flip", () => {
    const size = 4;
    const mesh = buildMesh(flatDepth(size, size), size, size, { maxGridResolution: size });
    // Grid index 0 is (gx=0, gy=0) -- top-left of the image (v=0) -- and
    // should land at NDC y = +1 (top of clip space), not -1.
    expect(mesh.positions[1]).toBeCloseTo(1, 5);
    const lastRowFirstCol = (mesh.gridHeight - 1) * mesh.gridWidth;
    expect(mesh.positions[lastRowFirstCol * 3 + 1]).toBeCloseTo(-1, 5);
  });
});
