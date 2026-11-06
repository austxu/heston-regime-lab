/**
 * WebGL2 layer for the 3D surface: a bicubically refined mesh with per-vertex normals,
 * Blinn-Phong lighting, analytic grid lines, a projected IV contour map on the floor,
 * depth-tested market quotes with residual stems and an optional wireframe target surface.
 * It shares SurfaceRenderer's camera (the same projection, written as a clip-space
 * transform), so the canvas-2D layers above and below it (axes, labels, hover) line up
 * exactly. SurfaceRenderer falls back to its own canvas-2D painter whenever this layer cannot
 * be created or its context is lost.
 *
 * The effects mode (attract loop only) adds a mirror reflection under the floor, bright grid
 * lines with a light scan sweeping across maturities, a rim light, and bloom: the scene is
 * rendered into a multisampled framebuffer, its bright parts are blurred at half resolution
 * and added back.
 */
import { LUT } from './colormap'

export interface GlCamera {
  yaw: number
  pitch: number
  scale: number
  cx: number
  cy: number
  w: number
  h: number
  dpr: number
  dist: number
  boxH: number
  zLo: number
  zHi: number
}

export interface GlMesh {
  /** World x per grid column and world y per grid row (both in [-1, 1]). */
  wx: ArrayLike<number>
  wy: ArrayLike<number>
  iv: ArrayLike<number>
  flag: ArrayLike<number> | null
}

/** Effects-mode state: the scan light's clock, in seconds. */
export interface GlFx {
  time: number
}

export interface GlPoint {
  wx: number
  wy: number
  iv: number
  model?: number
}

const VS = `#version 300 es
in vec2 aXY;
in float aZ;
in vec3 aN;
in vec2 aUV;
in float aFlag;
uniform vec4 uRot;   // cos yaw, sin yaw, cos pitch, sin pitch
uniform vec4 uView;  // scale, cx, cy, dist (CSS px)
uniform vec2 uSize;  // CSS w, h
uniform vec3 uZ;     // zLo, zHi, box height
uniform float uMode; // 0 surface, 1 floor projection, 2 mirror reflection
uniform float uPointSize;
out float vT;
out vec3 vN;
out vec2 vUV;
out float vFlag;
out vec3 vW;
vec4 project(vec3 p) {
  float xr = p.x * uRot.x - p.y * uRot.y;
  float yr = p.x * uRot.y + p.y * uRot.x;
  float zc = p.z - 0.5 * uZ.z;
  float close = -yr * uRot.z + zc * uRot.w;
  float up = yr * uRot.w + zc * uRot.z;
  float w = (uView.w - close) / uView.w;
  return vec4(
    (2.0 * uView.y / uSize.x - 1.0) * w + 2.0 * uView.x / uSize.x * xr,
    (1.0 - 2.0 * uView.z / uSize.y) * w + 2.0 * uView.x / uSize.y * up,
    -0.25 * close * w,
    w);
}
void main() {
  vT = (aZ - uZ.x) / (uZ.y - uZ.x);
  float h = clamp(vT, 0.0, 1.2) * uZ.z;
  float z = uMode > 1.5 ? -h : uMode > 0.5 ? 0.0 : vT * uZ.z;
  vW = vec3(aXY, z);
  gl_Position = project(vW);
  gl_PointSize = uPointSize;
  // Normal into view space: (screen x, up, toward the camera).
  float xr = aN.x * uRot.x - aN.y * uRot.y;
  float yr = aN.x * uRot.y + aN.y * uRot.x;
  vN = vec3(xr, yr * uRot.w + aN.z * uRot.z, -yr * uRot.z + aN.z * uRot.w);
  vUV = aUV;
  vFlag = aFlag;
}`

const FS = `#version 300 es
precision highp float;
in float vT;
in vec3 vN;
in vec2 vUV;
in float vFlag;
in vec3 vW;
uniform sampler2D uLut;
uniform float uMode;
uniform float uContour;
uniform float uFx;
uniform float uTime;
uniform float uNt;
uniform float uBoxH;
uniform vec3 uCam;
out vec4 o;
void main() {
  vec3 base = texture(uLut, vec2(clamp(vT, 0.0, 1.0), 0.5)).rgb;
  float grey = dot(base, vec3(0.3, 0.59, 0.11));
  base = mix(base, vec3(grey * 0.55), vFlag * 0.65);
  if (uMode > 1.5) {
    // Mirror image below a glossy floor: keep only fragments whose view ray crosses the
    // floor inside the box, fading with depth below it.
    float s = uCam.z / (uCam.z - vW.z);
    vec2 q = uCam.xy + (vW.xy - uCam.xy) * s;
    if (abs(q.x) > 1.0 || abs(q.y) > 1.0) discard;
    float fade = pow(1.0 - clamp(-vW.z / (0.85 * uBoxH), 0.0, 1.0), 2.0);
    float a = 0.6 * fade;
    o = vec4(base * a, a);
    return;
  }
  if (uMode > 0.5) {
    // Floor: a dim projection of the surface with iso-vol contour lines.
    float c = vT / uContour;
    float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / max(fwidth(c), 1e-4), 1.0);
    vec3 col = base * 0.42 + line * 0.25;
    float a = uFx > 0.5 ? 0.3 : 0.5;
    o = vec4(col * a, a);
    return;
  }
  vec3 n = normalize(vN);
  bool under = n.z < 0.0;
  if (under) n = -n;
  vec3 L = normalize(vec3(-0.35, 0.78, 0.52));
  float lam = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 48.0);
  float rim = pow(1.0 - max(n.z, 0.0), 3.0);
  float shade = 0.46 + 0.54 * lam;
  vec3 col = base * shade + (under ? 0.0 : 0.16) * spec + 0.05 * rim * base;
  if (under) col *= 0.6;
  // Analytic grid lines along the computed grid (one per solved row / column).
  vec2 g = abs(fract(vUV - 0.5) - 0.5) / max(fwidth(vUV), vec2(1e-4));
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  if (uFx > 0.5) {
    // Bright grid lines, a band of light sweeping from short to long maturities, rim light.
    float ph = fract(uTime * 0.16) * 1.6 - 0.3;
    float band = exp(-pow((vUV.y / uNt - ph) * 8.0, 2.0));
    vec3 glowc = mix(base, vec3(1.0), 0.4);
    col = mix(col, glowc, line * (0.22 + 0.6 * band)) + base * band * 0.14;
    col += vec3(0.62, 0.47, 0.93) * pow(1.0 - n.z, 2.5) * 0.3;
  } else {
    col = mix(col, col * 0.5, line * 0.45);
  }
  o = vec4(col, 1.0);
}`

const PVS = `#version 300 es
in vec3 aP;
in vec4 aC;
uniform vec4 uRot;
uniform vec4 uView;
uniform vec2 uSize;
uniform vec3 uZ;
uniform float uPointSize;
out vec4 vC;
void main() {
  float xr = aP.x * uRot.x - aP.y * uRot.y;
  float yr = aP.x * uRot.y + aP.y * uRot.x;
  float zc = aP.z - 0.5 * uZ.z;
  float close = -yr * uRot.z + zc * uRot.w;
  float up = yr * uRot.w + zc * uRot.z;
  float w = (uView.w - close) / uView.w;
  gl_Position = vec4(
    (2.0 * uView.y / uSize.x - 1.0) * w + 2.0 * uView.x / uSize.x * xr,
    (1.0 - 2.0 * uView.z / uSize.y) * w + 2.0 * uView.x / uSize.y * up,
    -0.25 * (close + 0.01) * w,
    w);
  gl_PointSize = uPointSize;
  vC = aC;
}`

const PFS = `#version 300 es
precision highp float;
in vec4 vC;
uniform float uDisc;
uniform float uAlpha;
out vec4 o;
void main() {
  if (uDisc < 0.5) { o = vec4(vC.rgb * vC.a * uAlpha, vC.a * uAlpha); return; }
  // A plain anti-aliased disc.
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = length(d);
  float aa = fwidth(r);
  float a = (1.0 - smoothstep(1.0 - 2.0 * aa, 1.0, r)) * uAlpha;
  if (a <= 0.003) discard;
  o = vec4(vC.rgb * a, a);
}`

// Post-processing: one fullscreen triangle (no attributes), bright pass, blur, composite.
const QVS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 o;
void main() {
  vec4 c = texture(uSrc, vUv);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  o = vec4(c.rgb * smoothstep(0.6, 1.0, lum), 1.0);
}`

const BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
out vec4 o;
void main() {
  // 9-tap Gaussian (sigma ~2 texels) along uDir.
  vec3 c = texture(uSrc, vUv).rgb * 0.2270;
  c += (texture(uSrc, vUv + uDir).rgb + texture(uSrc, vUv - uDir).rgb) * 0.1946;
  c += (texture(uSrc, vUv + 2.0 * uDir).rgb + texture(uSrc, vUv - 2.0 * uDir).rgb) * 0.1216;
  c += (texture(uSrc, vUv + 3.0 * uDir).rgb + texture(uSrc, vUv - 3.0 * uDir).rgb) * 0.0540;
  c += (texture(uSrc, vUv + 4.0 * uDir).rgb + texture(uSrc, vUv - 4.0 * uDir).rgb) * 0.0162;
  o = vec4(c, 1.0);
}`

const COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uStrength;
out vec4 o;
void main() {
  vec4 c = texture(uScene, vUv);
  // Screen blend: the glow brightens without ever clipping to white.
  vec3 glow = texture(uBloom, vUv).rgb * uStrength;
  vec3 rgb = c.rgb + glow * (1.0 - c.rgb);
  // Stay premultiplied: alpha is at least the brightest channel of the added glow.
  float a = clamp(max(c.a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
  o = vec4(min(rgb, vec3(a)), a);
}`

interface Bloom {
  w: number
  h: number
  msaa: WebGLFramebuffer
  scene: WebGLFramebuffer
  sceneTex: WebGLTexture
  half: [WebGLFramebuffer, WebGLFramebuffer]
  halfTex: [WebGLTexture, WebGLTexture]
  drop: () => void
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const v = mk(gl.VERTEX_SHADER, vs)
  const f = mk(gl.FRAGMENT_SHADER, fs)
  if (!v || !f) return null
  const p = gl.createProgram()!
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null
}

/** Catmull-Rom resampling of a uniform sequence at fractional index t. */
function cubic(v: (i: number) => number, n: number, t: number) {
  const i = Math.min(n - 2, Math.max(0, Math.floor(t)))
  const f = t - i
  const p0 = v(Math.max(0, i - 1))
  const p1 = v(i)
  const p2 = v(i + 1)
  const p3 = v(Math.min(n - 1, i + 2))
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)))
}

export class GlSurface {
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private pprog: WebGLProgram
  private vao: WebGLVertexArrayObject
  private pvao: WebGLVertexArrayObject
  private buf: Record<'xy' | 'z' | 'n' | 'uv' | 'flag' | 'idx' | 'p' | 'c', WebGLBuffer>
  private tex: WebGLTexture
  private post: { bright: WebGLProgram; blur: WebGLProgram; composite: WebGLProgram; vao: WebGLVertexArrayObject } | null
  private bloom: Bloom | null = null
  private bloomFailed = false
  private nIdx = 0
  private shape = ''
  private rx = 0
  private ry = 0
  lost = false

  static create(canvas: HTMLCanvasElement): GlSurface | null {
    try {
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, depth: true })
      if (!gl) return null
      const prog = compile(gl, VS, FS)
      const pprog = compile(gl, PVS, PFS)
      if (!prog || !pprog) return null
      return new GlSurface(gl, prog, pprog, canvas)
    } catch {
      return null
    }
  }

  private constructor(gl: WebGL2RenderingContext, prog: WebGLProgram, pprog: WebGLProgram, canvas: HTMLCanvasElement) {
    this.gl = gl
    this.prog = prog
    this.pprog = pprog
    const bright = compile(gl, QVS, BRIGHT)
    const blur = compile(gl, QVS, BLUR)
    const composite = compile(gl, QVS, COMPOSITE)
    this.post = bright && blur && composite ? { bright, blur, composite, vao: gl.createVertexArray()! } : null
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    const b = () => gl.createBuffer()!
    this.buf = { xy: b(), z: b(), n: b(), uv: b(), flag: b(), idx: b(), p: b(), c: b() }
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    const attr = (prog: WebGLProgram, name: string, buf: WebGLBuffer, size: number) => {
      const loc = gl.getAttribLocation(prog, name)
      if (loc < 0) return
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
    }
    attr(prog, 'aXY', this.buf.xy, 2)
    attr(prog, 'aZ', this.buf.z, 1)
    attr(prog, 'aN', this.buf.n, 3)
    attr(prog, 'aUV', this.buf.uv, 2)
    attr(prog, 'aFlag', this.buf.flag, 1)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx)
    this.pvao = gl.createVertexArray()!
    gl.bindVertexArray(this.pvao)
    attr(pprog, 'aP', this.buf.p, 3)
    attr(pprog, 'aC', this.buf.c, 4)
    gl.bindVertexArray(null)

    this.tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    const rgba = new Uint8Array(256 * 4)
    for (let i = 0; i < 256; i++) {
      rgba[i * 4] = LUT[i * 3]
      rgba[i * 4 + 1] = LUT[i * 3 + 1]
      rgba[i * 4 + 2] = LUT[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  resize(w: number, h: number) {
    const c = this.gl.canvas as HTMLCanvasElement
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
  }

  /** Framebuffers for bloom at the current drawing-buffer size; null if unsupported. */
  private bloomTargets(): Bloom | null {
    const gl = this.gl
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    if (this.bloom && this.bloom.w === w && this.bloom.h === h) return this.bloom
    this.bloom?.drop()
    this.bloom = null
    if (this.bloomFailed || !this.post) return null
    const rbs: WebGLRenderbuffer[] = []
    const texs: WebGLTexture[] = []
    const fbs: WebGLFramebuffer[] = []
    const tex = (tw: number, th: number) => {
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      texs.push(t)
      return t
    }
    const fbTex = (t: WebGLTexture) => {
      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      fbs.push(fb)
      return fb
    }
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number)
    const msaa = gl.createFramebuffer()!
    fbs.push(msaa)
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa)
    for (const [fmt, att] of [
      [gl.RGBA8, gl.COLOR_ATTACHMENT0],
      [gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT],
    ] as const) {
      const rb = gl.createRenderbuffer()!
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, att, gl.RENDERBUFFER, rb)
      rbs.push(rb)
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    const sceneTex = tex(w, h)
    const scene = fbTex(sceneTex)
    const hw = Math.max(1, w >> 1)
    const hh = Math.max(1, h >> 1)
    const halfTex: [WebGLTexture, WebGLTexture] = [tex(hw, hh), tex(hw, hh)]
    const half: [WebGLFramebuffer, WebGLFramebuffer] = [fbTex(halfTex[0]), fbTex(halfTex[1])]
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const drop = () => {
      rbs.forEach((r) => gl.deleteRenderbuffer(r))
      texs.forEach((t) => gl.deleteTexture(t))
      fbs.forEach((f) => gl.deleteFramebuffer(f))
    }
    if (!ok) {
      drop()
      this.bloomFailed = true
      return null
    }
    this.bloom = { w, h, msaa, scene, sceneTex, half, halfTex, drop }
    return this.bloom
  }

  /** Bright pass, two blur passes at half resolution, composite onto the canvas. */
  private applyBloom(b: Bloom) {
    const gl = this.gl
    const post = this.post!
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, b.msaa)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b.scene)
    gl.blitFramebuffer(0, 0, b.w, b.h, 0, 0, b.w, b.h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(post.vao)
    const pass = (prog: WebGLProgram, src: WebGLTexture, dst: WebGLFramebuffer | null, vw: number, vh: number, set?: (u: (n: string) => WebGLUniformLocation | null) => void) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst)
      gl.viewport(0, 0, vw, vh)
      gl.useProgram(prog)
      const u = (n: string) => gl.getUniformLocation(prog, n)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.uniform1i(u('uSrc'), 0)
      set?.(u)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const hw = Math.max(1, b.w >> 1)
    const hh = Math.max(1, b.h >> 1)
    pass(post.bright, b.sceneTex, b.half[0], hw, hh)
    for (let k = 0; k < 2; k++) {
      pass(post.blur, b.halfTex[0], b.half[1], hw, hh, (u) => gl.uniform2f(u('uDir'), (1 + k) / hw, 0))
      pass(post.blur, b.halfTex[1], b.half[0], hw, hh, (u) => gl.uniform2f(u('uDir'), 0, (1 + k) / hh))
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, b.w, b.h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(post.composite)
    const u = (n: string) => gl.getUniformLocation(post.composite, n)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, b.sceneTex)
    gl.uniform1i(u('uScene'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, b.halfTex[0])
    gl.uniform1i(u('uBloom'), 1)
    gl.uniform1f(u('uStrength'), 0.85)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.activeTexture(gl.TEXTURE0)
    gl.enable(gl.BLEND)
  }

  /** Refined mesh layout (indices, uv) only changes with the grid shape. */
  private layout(nx: number, nt: number) {
    const key = `${nx}x${nt}`
    if (key === this.shape) return
    this.shape = key
    // ~3 refined vertices per solved cell, capped so meshes stay < ~16k vertices.
    this.rx = Math.min(120, (nx - 1) * 3 + 1)
    this.ry = Math.min(120, (nt - 1) * 3 + 1)
    const { rx, ry } = this
    const uv = new Float32Array(rx * ry * 2)
    for (let i = 0; i < ry; i++)
      for (let j = 0; j < rx; j++) {
        uv[(i * rx + j) * 2] = (j * (nx - 1)) / (rx - 1)
        uv[(i * rx + j) * 2 + 1] = (i * (nt - 1)) / (ry - 1)
      }
    const idx = new Uint16Array((rx - 1) * (ry - 1) * 6)
    let o = 0
    for (let i = 0; i < ry - 1; i++)
      for (let j = 0; j < rx - 1; j++) {
        const a = i * rx + j
        idx.set([a, a + 1, a + rx + 1, a, a + rx + 1, a + rx], o)
        o += 6
      }
    this.nIdx = idx.length
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.uv)
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
  }

  /**
   * Draw one frame. `wire`, on the same grid as `mesh`, is drawn as a wireframe (the market
   * surface the model is being fitted to); `fx` turns on the effects mode.
   */
  draw(cam: GlCamera, mesh: GlMesh, points: GlPoint[], contourStep: number, fx: GlFx | null = null, wire: ArrayLike<number> | null = null) {
    const gl = this.gl
    if (this.lost || gl.isContextLost()) {
      this.lost = true
      return
    }
    const nx = mesh.wx.length
    const nt = mesh.wy.length
    this.layout(nx, nt)
    const { rx, ry } = this
    const n = rx * ry
    const xy = new Float32Array(n * 2)
    const z = new Float32Array(n)
    const nrm = new Float32Array(n * 3)
    const fl = new Float32Array(n)
    // Separable Catmull-Rom refinement: rows first, then columns.
    const rows = new Float64Array(nt * rx)
    for (let i = 0; i < nt; i++) for (let j = 0; j < rx; j++) rows[i * rx + j] = cubic((c) => mesh.iv[i * nx + c], nx, (j * (nx - 1)) / (rx - 1))
    const lin = (v: ArrayLike<number>, t: number) => {
      const i = Math.min(v.length - 2, Math.floor(t))
      return v[i] + (v[i + 1] - v[i]) * (t - i)
    }
    for (let i = 0; i < ry; i++) {
      const ti = (i * (nt - 1)) / (ry - 1)
      const wy = lin(mesh.wy, ti)
      for (let j = 0; j < rx; j++) {
        const tj = (j * (nx - 1)) / (rx - 1)
        const k = i * rx + j
        xy[k * 2] = lin(mesh.wx, tj)
        xy[k * 2 + 1] = wy
        z[k] = cubic((r) => rows[r * rx + j], nt, ti)
        if (mesh.flag) {
          const a = Math.round(ti) * nx + Math.round(tj)
          fl[k] = mesh.flag[a] ? 1 : 0
        }
      }
    }
    // World-space normals from central differences of the refined heights.
    const hz = cam.boxH / (cam.zHi - cam.zLo)
    for (let i = 0; i < ry; i++)
      for (let j = 0; j < rx; j++) {
        const k = i * rx + j
        const j0 = Math.max(0, j - 1)
        const j1 = Math.min(rx - 1, j + 1)
        const i0 = Math.max(0, i - 1)
        const i1 = Math.min(ry - 1, i + 1)
        const dx = xy[(i * rx + j1) * 2] - xy[(i * rx + j0) * 2]
        const dzx = (z[i * rx + j1] - z[i * rx + j0]) * hz
        const dy = xy[(i1 * rx + j) * 2 + 1] - xy[(i0 * rx + j) * 2 + 1]
        const dzy = (z[i1 * rx + j] - z[i0 * rx + j]) * hz
        // (dx, 0, dzx) x (0, dy, dzy)
        let a = -dzx * dy
        let b = -dx * dzy
        let c = dx * dy
        const l = Math.hypot(a, b, c) || 1
        a /= l
        b /= l
        c /= l
        nrm[k * 3] = a
        nrm[k * 3 + 1] = b
        nrm[k * 3 + 2] = c
      }
    const up = (buf: WebGLBuffer, data: Float32Array) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    }
    up(this.buf.xy, xy)
    up(this.buf.z, z)
    up(this.buf.n, nrm)
    up(this.buf.flag, fl)

    const bloom = fx ? this.bloomTargets() : null
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloom ? bloom.msaa : null)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clearDepth(1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const setCommon = (prog: WebGLProgram) => {
      gl.useProgram(prog)
      const u = (name: string) => gl.getUniformLocation(prog, name)
      gl.uniform4f(u('uRot'), Math.cos(cam.yaw), Math.sin(cam.yaw), Math.cos(cam.pitch), Math.sin(cam.pitch))
      gl.uniform4f(u('uView'), cam.scale, cam.cx, cam.cy, cam.dist)
      gl.uniform2f(u('uSize'), cam.w, cam.h)
      gl.uniform3f(u('uZ'), cam.zLo, cam.zHi, cam.boxH)
      return u
    }
    let u = setCommon(this.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.uniform1i(u('uLut'), 0)
    gl.uniform1f(u('uContour'), contourStep / (cam.zHi - cam.zLo))
    gl.uniform1f(u('uFx'), fx ? 1 : 0)
    gl.uniform1f(u('uTime'), fx ? fx.time : 0)
    gl.uniform1f(u('uNt'), Math.max(1, nt - 1))
    gl.uniform1f(u('uBoxH'), cam.boxH)
    // Camera position in world space (the inverse of the view rotation applied to the eye).
    const ce = Math.cos(cam.pitch)
    const se = Math.sin(cam.pitch)
    gl.uniform3f(u('uCam'), -cam.dist * ce * Math.sin(cam.yaw), -cam.dist * ce * Math.cos(cam.yaw), cam.dist * se + cam.boxH / 2)
    gl.bindVertexArray(this.vao)
    // Reflection and floor projection first, without depth, then the lit surface with depth.
    gl.disable(gl.DEPTH_TEST)
    if (fx) {
      gl.uniform1f(u('uMode'), 2)
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0)
    }
    gl.uniform1f(u('uMode'), 1)
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.uniform1f(u('uMode'), 0)
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0)

    if (wire) {
      // Wireframe target on the solved grid: rows and columns as line segments, faint where
      // hidden behind the surface.
      const zf = (iv: number) => ((iv - cam.zLo) / (cam.zHi - cam.zLo)) * cam.boxH
      const segs: number[] = []
      for (let i = 0; i < nt; i++)
        for (let j = 0; j < nx; j++) {
          const a = i * nx + j
          if (j + 1 < nx) segs.push(mesh.wx[j], mesh.wy[i], zf(wire[a]), mesh.wx[j + 1], mesh.wy[i], zf(wire[a + 1]))
          if (i + 1 < nt) segs.push(mesh.wx[j], mesh.wy[i], zf(wire[a]), mesh.wx[j], mesh.wy[i + 1], zf(wire[a + nx]))
        }
      const pos = Float32Array.from(segs)
      const V = pos.length / 3
      const col = new Float32Array(V * 4)
      for (let k = 0; k < V; k++) col.set([0.98, 0.62, 0.52, 0.9], k * 4)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.p)
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.c)
      gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW)
      u = setCommon(this.pprog)
      gl.bindVertexArray(this.pvao)
      gl.uniform1f(u('uDisc'), 0)
      gl.depthMask(false)
      for (const [fn, alpha] of [
        [gl.GREATER, 0.22],
        [gl.LEQUAL, 1],
      ] as const) {
        gl.depthFunc(fn)
        gl.uniform1f(u('uAlpha'), alpha)
        gl.drawArrays(gl.LINES, 0, V)
      }
      gl.depthMask(true)
      gl.depthFunc(gl.LEQUAL)
    }

    if (points.length) {
      // Stems (model minus quote) as lines, then the quotes as anti-aliased discs.
      const P = points.length
      const pos = new Float32Array(P * 3 * 3)
      const col = new Float32Array(P * 4 * 3)
      const zf = (iv: number) => ((iv - cam.zLo) / (cam.zHi - cam.zLo)) * cam.boxH
      let s = 0
      points.forEach((pt) => {
        if (pt.model === undefined || !Number.isFinite(pt.model)) return
        pos.set([pt.wx, pt.wy, zf(pt.iv), pt.wx, pt.wy, zf(pt.model)], s * 6)
        col.set([0.94, 0.53, 0.48, 0.6, 0.94, 0.53, 0.48, 0.6], s * 8)
        s++
      })
      const stemVerts = s * 2
      points.forEach((pt, i) => {
        pos.set([pt.wx, pt.wy, zf(pt.iv)], stemVerts * 3 + i * 3)
        col.set([0.94, 0.53, 0.48, 1], stemVerts * 4 + i * 4)
      })
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.p)
      gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(0, (stemVerts + P) * 3), gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.c)
      gl.bufferData(gl.ARRAY_BUFFER, col.subarray(0, (stemVerts + P) * 4), gl.DYNAMIC_DRAW)
      u = setCommon(this.pprog)
      gl.bindVertexArray(this.pvao)
      gl.uniform1f(u('uPointSize'), (cam.w < 480 ? 4.5 : 5.5) * cam.dpr)
      // Quotes and stems never write depth; the parts behind the surface are drawn faintly
      // first (depth GREATER) instead of being clipped, then the visible parts in full.
      gl.depthMask(false)
      for (const [fn, alpha] of [
        [gl.GREATER, 0.28],
        [gl.LEQUAL, 1],
      ] as const) {
        gl.depthFunc(fn)
        gl.uniform1f(u('uAlpha'), alpha)
        gl.uniform1f(u('uDisc'), 0)
        if (stemVerts) gl.drawArrays(gl.LINES, 0, stemVerts)
        gl.uniform1f(u('uDisc'), 1)
        gl.drawArrays(gl.POINTS, stemVerts, P)
      }
      gl.depthMask(true)
      gl.depthFunc(gl.LEQUAL)
    }
    if (bloom) this.applyBloom(bloom)
    gl.bindVertexArray(null)
  }
}
