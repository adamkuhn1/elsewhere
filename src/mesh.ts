// ---------------------------------------------------------------------------
// Depth-displaced mesh generation.
//
// Pure data in, pure data out -- no WebGL here, so this is unit-testable
// without a GPU (see mesh.test.ts). renderer.ts turns the result into GPU
// buffers.
// ---------------------------------------------------------------------------

export interface MeshData {
  /** x, y, z triples, one per grid vertex. x/y in [-1, 1] (NDC-ish, scaled
   *  by the renderer to the actual quad); z is depth-driven displacement. */
  positions: Float32Array;
  /** u, v pairs, one per grid vertex, for sampling the source image. */
  uvs: Float32Array;
  /** Triangle indices into positions/uvs. A triangle is omitted entirely
   *  when it would span a depth discontinuity -- see `discontinuity`. */
  indices: Uint32Array;
  /** Grid dimensions actually used (after resolution capping). */
  gridWidth: number;
  gridHeight: number;
}

export interface MeshOptions {
  /**
   * Maximum grid resolution along the longer axis. The depth map is
   * per-pixel, but a per-pixel mesh is both unnecessary (depth from a
   * single monocular estimate has nowhere near pixel-level precision) and
   * slow -- this caps triangle count while still tracking the depth map's
   * actual resolution up to the cap, so mesh density reflects real depth
   * resolution rather than an arbitrary fixed grid.
   */
  maxGridResolution?: number;
  /**
   * Depth discontinuity threshold, in normalized [0, 1] depth units,
   * above which a triangle is rejected rather than stretched across the
   * gap. Depth values must already be normalized (see depth.ts).
   */
  discontinuityThreshold?: number;
  /** Displacement scale for the z axis, in the same NDC-ish units as x/y. */
  displacementScale?: number;
}

const DEFAULTS = {
  maxGridResolution: 160,
  discontinuityThreshold: 0.08,
  displacementScale: 0.6,
} satisfies Required<MeshOptions>;

/**
 * Builds a displaced grid mesh from a normalized depth field.
 *
 * `depth` must be row-major, `width * height` long, already normalized to
 * [0, 1] (near = 1, far = 0) via `normalizeDepth` -- this function trusts
 * that contract rather than re-deriving it, so depth normalization stays a
 * single-owner concern.
 */
export function buildMesh(depth: Float32Array, width: number, height: number, options: MeshOptions = {}): MeshData {
  if (width <= 0 || height <= 0 || depth.length !== width * height) {
    throw new Error(`buildMesh: depth length ${depth.length} does not match ${width}x${height}`);
  }
  const opts = { ...DEFAULTS, ...options };

  const aspect = width / height;
  const gridWidth = Math.max(2, aspect >= 1 ? opts.maxGridResolution : Math.round(opts.maxGridResolution * aspect));
  const gridHeight = Math.max(2, aspect >= 1 ? Math.round(opts.maxGridResolution / aspect) : opts.maxGridResolution);

  const vertexCount = gridWidth * gridHeight;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const gridDepth = new Float32Array(vertexCount);

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const u = gx / (gridWidth - 1);
      const v = gy / (gridHeight - 1);
      const sx = Math.min(width - 1, Math.round(u * (width - 1)));
      const sy = Math.min(height - 1, Math.round(v * (height - 1)));
      const d = depth[sy * width + sx];

      const gi = gy * gridWidth + gx;
      // x right, y up, z toward the viewer -- image v grows downward, NDC y
      // grows upward, hence the flip.
      positions[gi * 3 + 0] = u * 2 - 1;
      positions[gi * 3 + 1] = -(v * 2 - 1);
      positions[gi * 3 + 2] = (d - 0.5) * opts.displacementScale;
      uvs[gi * 2 + 0] = u;
      uvs[gi * 2 + 1] = v;
      gridDepth[gi] = d;
    }
  }

  const indices: number[] = [];
  for (let gy = 0; gy < gridHeight - 1; gy++) {
    for (let gx = 0; gx < gridWidth - 1; gx++) {
      const a = gy * gridWidth + gx;
      const b = a + 1;
      const c = a + gridWidth;
      const d = c + 1;

      if (!discontinuous(gridDepth, a, b, c, opts.discontinuityThreshold)) {
        indices.push(a, c, b);
      }
      if (!discontinuous(gridDepth, b, c, d, opts.discontinuityThreshold)) {
        indices.push(b, c, d);
      }
    }
  }

  return {
    positions,
    uvs,
    indices: Uint32Array.from(indices),
    gridWidth,
    gridHeight,
  };
}

/** A triangle is discontinuous if any two of its three corners' depths
 *  differ by more than the threshold -- that's the "cliff" a stretched
 *  triangle would otherwise smear across. */
function discontinuous(gridDepth: Float32Array, a: number, b: number, c: number, threshold: number): boolean {
  const da = gridDepth[a];
  const db = gridDepth[b];
  const dc = gridDepth[c];
  const maxDiff = Math.max(Math.abs(da - db), Math.abs(db - dc), Math.abs(da - dc));
  return maxDiff > threshold;
}
