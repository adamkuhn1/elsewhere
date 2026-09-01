import type { MeshData } from "./mesh";

// ---------------------------------------------------------------------------
// WebGL2 renderer: a textured, depth-displaced mesh viewed through a small,
// bounded, pointer-driven camera orbit. Deliberately plain -- no bloom, no
// particles, no decorative shader work; the only fragment-shader job is
// "sample the photo," and the only vertex-shader job is "place this point
// where the mesh says, then apply one camera."
//
// Discontinuous regions (see mesh.ts) are missing triangles, not black
// triangles: the canvas clears with alpha 0, so a gap shows the page behind
// it -- an honest cut-away, not a fabricated surface.
// ---------------------------------------------------------------------------

const VERTEX_SRC = `#version 300 es
uniform mat4 uProjection;
uniform mat4 uView;
in vec3 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision mediump float;
uniform sampler2D uTexture;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uTexture, vUv);
}`;

const MAX_DEVICE_PIXEL_RATIO = 2;
/** World-space radius of the pointer-driven camera orbit. Small enough to
 *  read as looking, not as flying through the scene. */
export const MAX_PARALLAX_OFFSET = 0.35;
/** Per-frame interpolation factor toward the pointer's target offset --
 *  smooths out instant jumps without adding perceptible lag. */
const PARALLAX_SMOOTHING = 0.08;
/** Head tracking is going for a "virtual window" feel, not subtle mouse
 *  parallax -- it gets a bigger orbit radius and faster convergence than
 *  the pointer, set via `setInputMode`. Pointer behavior above is
 *  unchanged; this is strictly additive. */
export const HEAD_PARALLAX_OFFSET = 0.5;
const HEAD_PARALLAX_SMOOTHING = 0.18;

/** Pulled out of the class so camera bounds are testable without a WebGL
 *  context: clamps a normalized pointer position to [-1, 1] on each axis,
 *  which is what actually keeps the camera orbit bounded (drawFrame scales
 *  this clamped value by MAX_PARALLAX_OFFSET). */
export function clampParallax(x: number, y: number): [number, number] {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  return [clamp(x), clamp(y)];
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

function perspective(fovYRad: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye: [number, number, number], target: [number, number, number]): Float32Array {
  const up: [number, number, number] = [0, 1, 0];
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  // prettier-ignore
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function sub(a: number[], b: number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(v: number[]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly positionBuffer: WebGLBuffer;
  private readonly uvBuffer: WebGLBuffer;
  private readonly indexBuffer: WebGLBuffer;
  private readonly texture: WebGLTexture;
  private readonly locs: { projection: WebGLUniformLocation; view: WebGLUniformLocation };

  private indexCount = 0;
  private pointerTarget: [number, number] = [0, 0];
  private pointerCurrent: [number, number] = [0, 0];
  private parallaxOffset = MAX_PARALLAX_OFFSET;
  private parallaxSmoothing = PARALLAX_SMOOTHING;
  private rafHandle: number | undefined;
  private paused = false;
  private disposed = false;
  private resizeObserver: ResizeObserver | undefined;
  private intersectionObserver: IntersectionObserver | undefined;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true });
    if (!gl) throw new Error("webgl2-unsupported");
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    this.positionBuffer = gl.createBuffer()!;
    this.uvBuffer = gl.createBuffer()!;
    this.indexBuffer = gl.createBuffer()!;
    this.texture = gl.createTexture()!;

    const projLoc = gl.getUniformLocation(program, "uProjection");
    const viewLoc = gl.getUniformLocation(program, "uView");
    if (!projLoc || !viewLoc) throw new Error("Missing expected uniforms");
    this.locs = { projection: projLoc, view: viewLoc };

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    this.observeResize();
    this.observeVisibility();
  }

  uploadMesh(mesh: MeshData): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.indexCount = mesh.indices.length;
  }

  uploadTexture(source: ImageBitmap | ImageData): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /** `x`, `y` in [-1, 1] -- normalized pointer position within the canvas. */
  setPointer(x: number, y: number): void {
    this.pointerTarget = clampParallax(x, y);
  }

  /** Switches the camera-orbit radius and convergence speed between the
   *  subtle, well-established pointer feel and a deliberately stronger,
   *  faster-converging one for head tracking. Both `setPointer` calls (from
   *  a mouse drag or from tracking.ts) go through the same interpolation in
   *  `drawFrame` either way -- this only changes the two constants that
   *  interpolation uses, not the input path itself. */
  setInputMode(mode: "pointer" | "head"): void {
    this.parallaxOffset = mode === "head" ? HEAD_PARALLAX_OFFSET : MAX_PARALLAX_OFFSET;
    this.parallaxSmoothing = mode === "head" ? HEAD_PARALLAX_SMOOTHING : PARALLAX_SMOOTHING;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    } else {
      this.scheduleFrame();
    }
  }

  private scheduleFrame(): void {
    if (this.disposed || this.paused || this.rafHandle !== undefined) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = undefined;
      this.drawFrame();
      this.scheduleFrame();
    });
  }

  private drawFrame(): void {
    const gl = this.gl;
    this.pointerCurrent[0] += (this.pointerTarget[0] - this.pointerCurrent[0]) * this.parallaxSmoothing;
    this.pointerCurrent[1] += (this.pointerTarget[1] - this.pointerCurrent[1]) * this.parallaxSmoothing;

    const eye: [number, number, number] = [
      this.pointerCurrent[0] * this.parallaxOffset,
      -this.pointerCurrent[1] * this.parallaxOffset,
      1.6,
    ];
    const view = lookAt(eye, [0, 0, 0]);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const projection = perspective((45 * Math.PI) / 180, aspect, 0.1, 10);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.locs.projection, false, projection);
    gl.uniformMatrix4fv(this.locs.view, false, view);

    const posLoc = gl.getAttribLocation(this.program, "aPosition");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

    const uvLoc = gl.getAttribLocation(this.program, "aUv");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
  }

  start(): void {
    this.resize();
    this.scheduleFrame();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  private observeVisibility(): void {
    if (typeof IntersectionObserver === "undefined") return;
    this.intersectionObserver = new IntersectionObserver(([entry]) => this.setPaused(!entry.isIntersecting));
    this.intersectionObserver.observe(this.canvas);
  }

  /** Releases every GPU resource. Must run on recapture (before the next
   *  `uploadMesh`/`uploadTexture`) and on unmount -- a WebGL context has a
   *  hard per-page limit, so a leaked one here eventually breaks capture
   *  entirely, not just this component.
   *
   *  Deliberately does *not* call `WEBGL_lose_context.loseContext()`: that
   *  actively breaks a same-canvas remount shortly after disposal (React
   *  StrictMode's dev-mode mount-cleanup-mount, or a fast recapture) --
   *  `getContext('webgl2')` on a canvas whose context was just explicitly
   *  lost comes back in a broken state where every shader compile fails
   *  with a null info log, confirmed live. Deleting the individual GL
   *  objects below already frees the GPU memory; the context itself is
   *  reclaimed when the canvas is garbage collected. */
  dispose(): void {
    this.disposed = true;
    this.setPaused(true);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    const gl = this.gl;
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteBuffer(this.uvBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
  }
}
