/**
 * WebGL2 layer for the 3D surface: a bicubically refined mesh with per-vertex normals,
 * Blinn-Phong lighting, analytic grid lines, a projected IV contour map on the floor and
 * depth-tested market quotes with residual stems. It shares SurfaceRenderer's camera (the
 * same projection, written as a clip-space transform), so the canvas-2D layers above and
 * below it (axes, labels, hover) line up exactly. SurfaceRenderer falls back to its own
 * canvas-2D painter whenever this layer cannot be created or its context is lost.
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
uniform float uFloor;
uniform float uPointSize;
out float vT;
out vec3 vN;
out vec2 vUV;
out float vFlag;
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
  float z = uFloor > 0.5 ? 0.0 : vT * uZ.z;
  gl_Position = project(vec3(aXY, z));
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
uniform sampler2D uLut;
uniform float uFloor;
uniform float uContour;
out vec4 o;
void main() {
  vec3 base = texture(uLut, vec2(clamp(vT, 0.0, 1.0), 0.5)).rgb;
  float grey = dot(base, vec3(0.3, 0.59, 0.11));
  base = mix(base, vec3(grey * 0.55), vFlag * 0.65);
  if (uFloor > 0.5) {
    // Floor: a dim projection of the surface with iso-vol contour lines.
    float c = vT / uContour;
    float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / max(fwidth(c), 1e-4), 1.0);
    vec3 col = base * 0.42 + line * 0.25;
    o = vec4(col * 0.5, 0.5);
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
  col = mix(col, col * 0.5, line * 0.45);
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
  // A solid disc (inner 55%) with a warm-white core, plus a soft ember glow to the edge.
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = length(d);
  float aa = fwidth(r);
  float disc = 1.0 - smoothstep(0.55 - aa, 0.55 + aa, r);
  float glow = (1.0 - smoothstep(0.55, 1.0, r)) * 0.32;
  float a = max(disc, glow) * uAlpha;
  if (a <= 0.003) discard;
  vec3 core = mix(vec3(1.0, 0.95, 0.9), vC.rgb, smoothstep(0.05, 0.5, r));
  vec3 col = mix(vC.rgb, core, disc);
  o = vec4(col * a, a);
}`

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

  draw(cam: GlCamera, mesh: GlMesh, points: GlPoint[], contourStep: number) {
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
    gl.bindVertexArray(this.vao)
    // Floor projection first, without depth, then the lit surface with depth.
    gl.disable(gl.DEPTH_TEST)
    gl.uniform1f(u('uFloor'), 1)
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.uniform1f(u('uFloor'), 0)
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0)

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
      gl.uniform1f(u('uPointSize'), (cam.w < 480 ? 8 : 10) * cam.dpr)
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
    gl.bindVertexArray(null)
  }
}
