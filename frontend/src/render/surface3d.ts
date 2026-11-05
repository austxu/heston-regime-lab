/**
 * A dependency-free Canvas-2D 3D surface renderer (no WebGL).
 *
 * The IV grid is projected with a mild perspective camera, split into quads, sorted back to
 * front (painter's algorithm) and filled with an OKLab colormap modulated by Lambert
 * shading; market quotes are depth-sorted together with the quads so the surface occludes
 * them correctly. Rendering is on demand: frames are scheduled only while something moves
 * (morphing between surfaces, inertia after a drag, auto-rotation).
 */
import type { Grid } from '../math/surface'
import { pctTickFormat } from '../lib/format'
import { ticks } from '../lib/scale'
import { colorAt } from './colormap'

export interface SurfaceData {
  grid: Grid
  iv: Float64Array
  flag: Uint8Array
}
export interface SurfacePoint {
  x: number
  tau: number
  iv: number
  model?: number
}
export interface HoverInfo {
  x: number
  tau: number
  iv: number
  flagged: boolean
  px: number
  py: number
}
export interface RendererOptions {
  xLabel: string
  xTick: (x: number) => string
  xTicks: (lo: number, hi: number) => number[]
  tauTicks?: number[]
  onHover?: (h: HoverInfo | null) => void
  onInteract?: () => void
  reducedMotion?: boolean
  /** Attract-mode styling: no tick labels or titles, extra room for an HTML overlay. */
  minimal?: boolean
  pad?: { top: number; bottom: number }
}

const BOX_H = 1.15
/** Box corners plus the floor ring where tick labels and axis titles sit. */
const fitPoints = (ring: number) => {
  const pts: [number, number, number][] = []
  for (const cx of [-1, 1]) for (const cy of [-1, 1]) for (const cz of [0, BOX_H]) pts.push([cx, cy, cz])
  for (const cx of [-ring, ring]) for (const cy of [-ring, ring]) pts.push([cx, cy, 0])
  return pts
}
const FIT_WIDE = fitPoints(1.38)
const FIT_SMALL = fitPoints(1.24)
const FIT_MIN = fitPoints(1.02)
const DIST = 7.5
const DEFAULT_YAW = -0.52
const DEFAULT_PITCH = 0.4
const FONT_MONO = '"Roboto Mono", ui-monospace, monospace'
const FONT_SANS = 'Inter, system-ui, sans-serif'
const MUTED = '#94979c'
const GRID = 'rgba(206, 207, 210, 0.10)'
const GRID_STRONG = 'rgba(206, 207, 210, 0.22)'

export class SurfaceRenderer {
  private ctx: CanvasRenderingContext2D
  private opts: RendererOptions
  private w = 0
  private h = 0
  private dpr = 1
  private raf = 0
  private last = 0
  private yaw = DEFAULT_YAW
  private pitch = DEFAULT_PITCH
  private vYaw = 0
  private vPitch = 0
  private autoSpeed = 0
  private dragging = false
  private lastPointer: { x: number; y: number; t: number } | null = null
  private grid: Grid | null = null
  private cur: Float64Array | null = null
  private tgt: Float64Array | null = null
  private flag: Uint8Array | null = null
  private zLo = 0.1
  private zHi = 0.3
  private zLoT = 0.1
  private zHiT = 0.3
  private points: SurfacePoint[] = []
  private hoverPx: { x: number; y: number } | null = null
  private hover: (HoverInfo & { s: number; t: number; j: number; i: number }) | null = null
  // Per-frame projected geometry, reused for hit testing.
  private vx = new Float64Array(0)
  private vy = new Float64Array(0)
  private vc = new Float64Array(0)
  private order: number[] = []
  private scale = 1
  private cx = 0
  private cy = 0
  private ro: ResizeObserver
  private disposers: (() => void)[] = []

  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.opts = opts
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.bind()
    this.resize()
    if (document.fonts) void document.fonts.ready.then(() => this.requestFrame())
  }

  setOptions(o: Partial<RendererOptions>) {
    this.opts = { ...this.opts, ...o }
    this.requestFrame()
  }

  setSurface(d: SurfaceData, instant = false) {
    const sameShape = this.grid && this.cur && this.cur.length === d.iv.length && this.grid.kind === d.grid.kind
    this.grid = d.grid
    this.tgt = Float64Array.from(d.iv)
    this.flag = d.flag
    if (!sameShape || instant || this.opts.reducedMotion) this.cur = Float64Array.from(d.iv)
    this.updateRange(instant || !sameShape)
    this.requestFrame()
  }

  setPoints(p: SurfacePoint[]) {
    this.points = p
    this.updateRange(false)
    this.requestFrame()
  }

  setAutoRotate(speed: number) {
    this.autoSpeed = this.opts.reducedMotion ? 0 : speed
    this.requestFrame()
  }

  setReducedMotion(r: boolean) {
    this.opts.reducedMotion = r
    if (r) {
      this.autoSpeed = 0
      this.vYaw = this.vPitch = 0
    }
  }

  resetView() {
    this.yaw = DEFAULT_YAW
    this.pitch = DEFAULT_PITCH
    this.vYaw = this.vPitch = 0
    this.requestFrame()
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.disposers.forEach((d) => d())
  }

  /** Readable description of the current view for assistive tech. */
  get viewAngles() {
    return { yaw: this.yaw, pitch: this.pitch }
  }

  // ------------------------------------------------------------------ internals

  private updateRange(snap: boolean) {
    if (!this.tgt) return
    let lo = Infinity
    let hi = -Infinity
    for (const v of this.tgt) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    for (const p of this.points) {
      lo = Math.min(lo, p.iv)
      hi = Math.max(hi, p.iv)
    }
    const step = hi - lo > 0.3 ? 0.1 : hi - lo > 0.1 ? 0.05 : 0.025
    let zl = Math.floor((lo - 0.004) / step) * step
    let zh = Math.ceil((hi + 0.004) / step) * step
    if (zh - zl < 0.075) zh = zl + 0.075
    zl = Math.max(0, zl)
    this.zLoT = zl
    this.zHiT = zh
    if (snap || this.opts.reducedMotion) {
      this.zLo = zl
      this.zHi = zh
    }
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect()
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    this.w = r.width
    this.h = r.height
    const W = Math.round(r.width * this.dpr)
    const H = Math.round(r.height * this.dpr)
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W
      this.canvas.height = H
    }
    this.requestFrame()
  }

  private requestFrame() {
    if (this.raf) return
    this.raf = requestAnimationFrame((t) => {
      this.raf = 0
      const dt = this.last ? Math.min(64, t - this.last) : 16
      this.last = t
      const moving = this.step(dt)
      this.draw()
      if (moving) this.requestFrame()
      else this.last = 0
    })
  }

  /** Advance animations by dt ms; returns true while anything is still moving. */
  private step(dt: number): boolean {
    let moving = false
    if (this.cur && this.tgt) {
      const k = 1 - Math.exp(-dt / 110)
      let maxd = 0
      for (let i = 0; i < this.cur.length; i++) {
        const d = this.tgt[i] - this.cur[i]
        this.cur[i] += d * k
        maxd = Math.max(maxd, Math.abs(d))
      }
      if (maxd > 2e-5) moving = true
      else this.cur.set(this.tgt)
    }
    const kz = 1 - Math.exp(-dt / 160)
    this.zLo += (this.zLoT - this.zLo) * kz
    this.zHi += (this.zHiT - this.zHi) * kz
    if (Math.abs(this.zLoT - this.zLo) + Math.abs(this.zHiT - this.zHi) > 1e-5) moving = true
    else {
      this.zLo = this.zLoT
      this.zHi = this.zHiT
    }
    if (!this.dragging && (Math.abs(this.vYaw) > 1e-5 || Math.abs(this.vPitch) > 1e-5)) {
      this.yaw += this.vYaw * dt
      this.setPitch(this.pitch + this.vPitch * dt)
      const f = Math.exp(-dt / 380)
      this.vYaw *= f
      this.vPitch *= f
      moving = true
    }
    if (this.autoSpeed && !this.dragging) {
      this.yaw += (this.autoSpeed * dt) / 1000
      moving = true
    }
    return moving
  }

  private setPitch(p: number) {
    this.pitch = Math.min(1.25, Math.max(0.18, p))
  }

  private bind() {
    const c = this.canvas
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      c.addEventListener(type, fn as EventListener)
      this.disposers.push(() => c.removeEventListener(type, fn as EventListener))
    }
    on('pointerdown', (e) => {
      this.opts.onInteract?.()
      this.dragging = true
      this.vYaw = this.vPitch = 0
      this.lastPointer = { x: e.clientX, y: e.clientY, t: e.timeStamp }
      c.setPointerCapture(e.pointerId)
      this.setHover(null)
    })
    on('pointermove', (e) => {
      const r = c.getBoundingClientRect()
      if (this.dragging && this.lastPointer) {
        const dx = e.clientX - this.lastPointer.x
        const dy = e.clientY - this.lastPointer.y
        const dtp = Math.max(1, e.timeStamp - this.lastPointer.t)
        this.yaw += dx * 0.0085
        this.setPitch(this.pitch + dy * 0.006)
        // Smoothed angular velocity (rad / ms) for inertia on release.
        this.vYaw = 0.6 * this.vYaw + 0.4 * ((dx * 0.0085) / dtp)
        this.vPitch = 0.6 * this.vPitch + 0.4 * ((dy * 0.006) / dtp)
        this.lastPointer = { x: e.clientX, y: e.clientY, t: e.timeStamp }
        this.requestFrame()
      } else if (e.pointerType !== 'touch') {
        this.hoverPx = { x: e.clientX - r.left, y: e.clientY - r.top }
        this.requestFrame()
      }
    })
    const end = (e: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = false
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId)
      // Released after a pause: no fling.
      if (!this.lastPointer || e.timeStamp - this.lastPointer.t > 80 || this.opts.reducedMotion) this.vYaw = this.vPitch = 0
      this.requestFrame()
    }
    on('pointerup', end)
    on('pointercancel', end)
    on('pointerleave', () => {
      this.hoverPx = null
      this.setHover(null)
      this.requestFrame()
    })
    on('keydown', (e) => {
      const stepA = e.shiftKey ? 0.3 : 0.08
      let used = true
      if (e.key === 'ArrowLeft') this.yaw -= stepA
      else if (e.key === 'ArrowRight') this.yaw += stepA
      else if (e.key === 'ArrowUp') this.setPitch(this.pitch + stepA * 0.6)
      else if (e.key === 'ArrowDown') this.setPitch(this.pitch - stepA * 0.6)
      else if (e.key === 'Home' || e.key === '0') this.resetView()
      else used = false
      if (used) {
        e.preventDefault()
        this.opts.onInteract?.()
        this.requestFrame()
      }
    })
  }

  private setHover(h: SurfaceRenderer['hover']) {
    const prev = this.hover
    this.hover = h
    if (!h && !prev) return
    this.opts.onHover?.(h ? { x: h.x, tau: h.tau, iv: h.iv, flagged: h.flagged, px: h.px, py: h.py } : null)
  }

  // ------------------------------------------------------------------ geometry

  private gx(j: number) {
    const g = this.grid!
    const lo = g.x[0]
    const hi = g.x[g.x.length - 1]
    return ((g.x[j] - lo) / (hi - lo)) * 2 - 1
  }
  private wx(x: number) {
    const g = this.grid!
    const lo = g.x[0]
    const hi = g.x[g.x.length - 1]
    return ((x - lo) / (hi - lo)) * 2 - 1
  }
  private wy(tau: number) {
    const g = this.grid!
    const lo = g.tau[0]
    const hi = g.tau[g.tau.length - 1]
    return ((tau - lo) / (hi - lo)) * 2 - 1
  }
  private wz(iv: number) {
    return ((iv - this.zLo) / (this.zHi - this.zLo)) * BOX_H
  }

  /** Project world (x, y, z) to screen; returns [sx, sy, closeness]. */
  private proj(x: number, y: number, z: number, out: number[]) {
    const cy = Math.cos(this.yaw)
    const sy = Math.sin(this.yaw)
    const ce = Math.cos(this.pitch)
    const se = Math.sin(this.pitch)
    const xr = x * cy - y * sy
    const yr = x * sy + y * cy
    const zc = z - BOX_H / 2
    const close = -yr * ce + zc * se
    const up = yr * se + zc * ce
    const f = DIST / (DIST - close)
    out[0] = this.cx + this.scale * xr * f
    out[1] = this.cy - this.scale * up * f
    out[2] = close
  }

  /** Fit the rotating box into the canvas at a scale independent of yaw (no breathing). */
  private fitted = false
  private fitW = 0
  private fitH = 0

  /** Returns true while the fit is still easing toward its target. */
  private fit(): boolean {
    const padL = this.opts.minimal ? 16 : this.w < 480 ? 16 : 46
    const padR = this.w < 480 ? 26 : 64
    const padT = this.opts.pad?.top ?? 14
    const padB = this.opts.pad?.bottom ?? 16
    // Extents of the box corners and the label ring at the current view (scale 1, origin 0).
    const scale = this.scale
    const cx = this.cx
    const cy = this.cy
    this.scale = 1
    this.cx = 0
    this.cy = 0
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    const p = [0, 0, 0]
    for (const [px, py, pz] of this.opts.minimal ? FIT_MIN : this.w < 480 ? FIT_SMALL : FIT_WIDE) {
      this.proj(px, py, pz, p)
      x0 = Math.min(x0, p[0])
      x1 = Math.max(x1, p[0])
      y0 = Math.min(y0, p[1])
      y1 = Math.max(y1, p[1])
    }
    const availW = this.w - padL - padR
    const availH = this.h - padT - padB
    const ts = Math.max(10, Math.min(availW / (x1 - x0), availH / (y1 - y0)))
    const tcx = padL + availW / 2 - ((x0 + x1) / 2) * ts
    const tcy = padT + availH / 2 - ((y0 + y1) / 2) * ts
    // Ease toward the new fit so rotating does not make the box jump in size.
    const snap = !this.fitted || this.fitW !== this.w || this.fitH !== this.h
    const k = snap ? 1 : 0.18
    this.scale = scale + (ts - scale) * k
    this.cx = cx + (tcx - cx) * k
    this.cy = cy + (tcy - cy) * k
    this.fitted = true
    this.fitW = this.w
    this.fitH = this.h
    return Math.abs(ts - this.scale) > 0.3 || Math.abs(tcx - this.cx) > 0.3 || Math.abs(tcy - this.cy) > 0.3
  }

  // ------------------------------------------------------------------ drawing

  private draw() {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    if (!this.grid || !this.cur || this.w < 10 || this.h < 10) return
    if (this.fit()) this.requestFrame()
    const g = this.grid
    const nx = g.x.length
    const nt = g.tau.length
    const nv = nx * nt
    if (this.vx.length !== nv) {
      this.vx = new Float64Array(nv)
      this.vy = new Float64Array(nv)
      this.vc = new Float64Array(nv)
    }
    const p = [0, 0, 0]
    const wyRow = g.tau.map((t) => this.wy(t))
    for (let i = 0; i < nt; i++) {
      for (let j = 0; j < nx; j++) {
        const k = i * nx + j
        this.proj(this.gx(j), wyRow[i], this.wz(this.cur[k]), p)
        this.vx[k] = p[0]
        this.vy[k] = p[1]
        this.vc[k] = p[2]
      }
    }

    this.drawFrame(true)

    // Items: quads [0, Q) and points [Q, Q + P), sorted far -> near.
    const Q = (nx - 1) * (nt - 1)
    const P = this.points.length
    const key = new Float64Array(Q + P)
    for (let i = 0; i < nt - 1; i++)
      for (let j = 0; j < nx - 1; j++) {
        const a = i * nx + j
        key[i * (nx - 1) + j] = (this.vc[a] + this.vc[a + 1] + this.vc[a + nx] + this.vc[a + nx + 1]) / 4
      }
    const pp: { sx: number; sy: number; mx: number; my: number }[] = []
    this.points.forEach((pt, n) => {
      this.proj(this.wx(pt.x), this.wy(pt.tau), this.wz(pt.iv), p)
      const sx = p[0]
      const sy = p[1]
      key[Q + n] = p[2] + 0.02
      let mx = Number.NaN
      let my = Number.NaN
      if (pt.model !== undefined && Number.isFinite(pt.model)) {
        this.proj(this.wx(pt.x), this.wy(pt.tau), this.wz(pt.model), p)
        mx = p[0]
        my = p[1]
      }
      pp.push({ sx, sy, mx, my })
    })
    const order = Array.from({ length: Q + P }, (_, i) => i).sort((a, b) => key[a] - key[b])
    this.order = order

    // Light fixed relative to the camera: from the upper left, slightly toward the viewer.
    const L = [-0.35, 0.78, 0.52]
    const ll = Math.hypot(L[0], L[1], L[2])
    const cyw = Math.cos(this.yaw)
    const syw = Math.sin(this.yaw)
    const ce = Math.cos(this.pitch)
    const se = Math.sin(this.pitch)
    const dxw = 2 / (nx - 1)
    const span = this.zHi - this.zLo
    ctx.lineJoin = 'round'
    for (const it of order) {
      if (it >= Q) {
        const n = it - Q
        const q = pp[n]
        if (Number.isFinite(q.mx)) {
          ctx.strokeStyle = 'rgba(240, 136, 123, 0.55)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(q.sx, q.sy)
          ctx.lineTo(q.mx, q.my)
          ctx.stroke()
        }
        ctx.beginPath()
        ctx.arc(q.sx, q.sy, this.w < 480 ? 2.4 : 3, 0, Math.PI * 2)
        ctx.fillStyle = '#f0887b'
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = 'rgba(12, 14, 18, 0.9)'
        ctx.stroke()
        continue
      }
      const i = Math.floor(it / (nx - 1))
      const j = it % (nx - 1)
      const a = i * nx + j
      const b = a + 1
      const c = a + nx + 1
      const d = a + nx
      const ivAvg = (this.cur[a] + this.cur[b] + this.cur[c] + this.cur[d]) / 4
      // World-space normal from the two diagonals.
      const dyw = wyRow[i + 1] - wyRow[i]
      const z = (v: number) => ((v - this.zLo) / span) * BOX_H
      const ux = dxw
      const uy = dyw
      const uz = z(this.cur[c]) - z(this.cur[a])
      const vx2 = -dxw
      const vy2 = dyw
      const vz = z(this.cur[d]) - z(this.cur[b])
      let nX = uy * vz - uz * vy2
      let nY = uz * vx2 - ux * vz
      let nZ = ux * vy2 - uy * vx2
      const nl = Math.hypot(nX, nY, nZ) || 1
      nX /= nl
      nY /= nl
      nZ /= nl
      // Into view space (screen-x, up, toward camera).
      const xr = nX * cyw - nY * syw
      const yr = nX * syw + nY * cyw
      const vUp = yr * se + nZ * ce
      const vClose = -yr * ce + nZ * se
      let lam = (xr * L[0] + vUp * L[1] + vClose * L[2]) / ll
      const under = vClose < 0
      if (under) lam = -lam
      let shade = 0.5 + 0.5 * Math.max(0, lam)
      if (under) shade *= 0.62
      const flagged = this.flag && (this.flag[a] || this.flag[b] || this.flag[c] || this.flag[d])
      const t = (ivAvg - this.zLo) / span
      ctx.beginPath()
      ctx.moveTo(this.vx[a], this.vy[a])
      ctx.lineTo(this.vx[b], this.vy[b])
      ctx.lineTo(this.vx[c], this.vy[c])
      ctx.lineTo(this.vx[d], this.vy[d])
      ctx.closePath()
      ctx.fillStyle = flagged ? colorAt(t * 0.6, shade * 0.55, 0.55) : colorAt(t, shade)
      ctx.fill()
      ctx.lineWidth = 0.75
      ctx.strokeStyle = flagged ? 'rgba(12,14,18,0.25)' : 'rgba(12, 14, 18, 0.38)'
      ctx.stroke()
    }

    this.drawFrame(false)
    this.drawHover()
    this.drawColorbar()
  }

  /** Floor grid + back walls (behind = true) or the front tick labels (behind = false). */
  private drawFrame(behind: boolean) {
    const ctx = this.ctx
    const g = this.grid!
    const p = [0, 0, 0]
    const q = [0, 0, 0]
    const line = (a: number[], b: number[], color: string, width = 1, dash: number[] = []) => {
      this.proj(a[0], a[1], a[2], p)
      this.proj(b[0], b[1], b[2], q)
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(p[0], p[1])
      ctx.lineTo(q[0], q[1])
      ctx.stroke()
      ctx.setLineDash([])
    }
    const xLo = g.x[0]
    const xHi = g.x[g.x.length - 1]
    const tLo = g.tau[0]
    const tHi = g.tau[g.tau.length - 1]
    const xt = this.opts.xTicks(xLo, xHi)
    const tt = (this.opts.tauTicks ?? [0.25, 0.5, 1, 1.5, 2]).filter((t) => t >= tLo - 1e-9 && t <= tHi + 1e-9)
    const zt = ticks(this.zLo, this.zHi, 4).filter((z) => z >= this.zLo - 1e-9 && z <= this.zHi + 1e-9)
    // Closeness of wall centres decides which walls are behind the surface.
    const closeAt = (x: number, y: number) => {
      this.proj(x, y, BOX_H / 2, p)
      return p[2]
    }
    const backX = closeAt(-1, 0) < closeAt(1, 0) ? -1 : 1 // x-wall farther from camera
    const backY = closeAt(0, -1) < closeAt(0, 1) ? -1 : 1
    const frontX = -backX
    const frontY = -backY

    if (behind) {
      // Wall fills.
      const quad = (pts: number[][], fill: string) => {
        ctx.beginPath()
        pts.forEach((pt, n) => {
          this.proj(pt[0], pt[1], pt[2], p)
          if (n === 0) ctx.moveTo(p[0], p[1])
          else ctx.lineTo(p[0], p[1])
        })
        ctx.closePath()
        ctx.fillStyle = fill
        ctx.fill()
      }
      quad([[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]], 'rgba(255,255,255,0.018)')
      quad([[backX, -1, 0], [backX, 1, 0], [backX, 1, BOX_H], [backX, -1, BOX_H]], 'rgba(255,255,255,0.012)')
      quad([[-1, backY, 0], [1, backY, 0], [1, backY, BOX_H], [-1, backY, BOX_H]], 'rgba(255,255,255,0.012)')
      // Floor grid.
      for (const x of xt) line([this.wx(x), -1, 0], [this.wx(x), 1, 0], GRID)
      for (const t of tt) line([-1, this.wy(t), 0], [1, this.wy(t), 0], GRID)
      // Back-wall IV gridlines and verticals.
      for (const z of zt) {
        const wz = this.wz(z)
        line([backX, -1, wz], [backX, 1, wz], GRID)
        line([-1, backY, wz], [1, backY, wz], GRID)
      }
      for (const x of xt) line([this.wx(x), backY, 0], [this.wx(x), backY, BOX_H], GRID)
      for (const t of tt) line([backX, this.wy(t), 0], [backX, this.wy(t), BOX_H], GRID)
      // Box outline (floor + back edges).
      line([-1, -1, 0], [1, -1, 0], GRID_STRONG)
      line([1, -1, 0], [1, 1, 0], GRID_STRONG)
      line([1, 1, 0], [-1, 1, 0], GRID_STRONG)
      line([-1, 1, 0], [-1, -1, 0], GRID_STRONG)
      line([backX, backY, 0], [backX, backY, BOX_H], GRID_STRONG)
      line([backX, frontY, 0], [backX, frontY, BOX_H], GRID)
      line([frontX, backY, 0], [frontX, backY, BOX_H], GRID)
      return
    }

    if (this.opts.minimal) return
    // Labels (drawn last so they stay legible).
    const small = this.w < 480
    ctx.font = `400 ${small ? 9.5 : 10.5}px ${FONT_MONO}`
    ctx.fillStyle = MUTED
    const label = (x: number, y: number, z: number, text: string, dx = 0, dy = 0) => {
      this.proj(x, y, z, p)
      ctx.fillText(text, p[0] + dx, p[1] + dy)
    }
    // Strike-axis labels along the front y edge, pushed outward.
    const yOut = frontY * 1.13
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const x of xt) label(this.wx(x), yOut, 0, this.opts.xTick(x))
    // Maturity labels along the front x edge.
    const xOut = frontX * 1.13
    for (const t of tt) label(xOut, this.wy(t), 0, t < 1 ? `${Math.round(t * 12)}m` : `${t}y`)
    // IV labels on the leftmost vertical edge.
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    let best = corners[0]
    let bx = Infinity
    for (const c of corners) {
      if (c[0] === frontX && c[1] === frontY) continue
      this.proj(c[0], c[1], 0, p)
      if (p[0] < bx) {
        bx = p[0]
        best = c
      }
    }
    ctx.textAlign = 'right'
    // The floor-level tick is omitted: it would collide with the strike labels at that corner.
    const zf = pctTickFormat(zt)
    for (const z of zt) if (z > this.zLo + 1e-6) label(best[0], best[1], this.wz(z), zf(z), -7, 0)
    // Axis titles.
    ctx.font = `500 ${small ? 10 : 11}px ${FONT_SANS}`
    ctx.fillStyle = '#cecfd2'
    ctx.textAlign = 'center'
    // Titles sit between two ticks so they never collide with a tick label.
    const mid = (arr: number[]) => (arr.length > 1 ? (arr[Math.floor((arr.length - 1) / 2)] + arr[Math.floor((arr.length - 1) / 2) + 1]) / 2 : arr[0])
    label(xt.length > 1 ? this.wx(mid(xt)) : 0, frontY * (small ? 1.3 : 1.36), 0, this.opts.xLabel)
    label(frontX * (small ? 1.34 : 1.42), tt.length > 1 ? this.wy(mid(tt)) : 0, 0, 'maturity')
    label(best[0], best[1], BOX_H, 'implied vol', -7, -14)
  }

  private drawHover() {
    const ctx = this.ctx
    const g = this.grid!
    const nx = g.x.length
    const nt = g.tau.length
    if (!this.hoverPx || this.dragging) {
      if (this.hover) this.setHover(null)
      return
    }
    const { x: hx, y: hy } = this.hoverPx
    let found: SurfaceRenderer['hover'] = null
    for (let n = this.order.length - 1; n >= 0 && !found; n--) {
      const it = this.order[n]
      if (it >= (nx - 1) * (nt - 1)) continue
      const i = Math.floor(it / (nx - 1))
      const j = it % (nx - 1)
      const a = i * nx + j
      const tri = (i0: number, i1: number, i2: number) => {
        const x0 = this.vx[i0]
        const y0 = this.vy[i0]
        const d = (this.vy[i1] - this.vy[i2]) * (x0 - this.vx[i2]) + (this.vx[i2] - this.vx[i1]) * (y0 - this.vy[i2])
        if (Math.abs(d) < 1e-9) return null
        const l0 = ((this.vy[i1] - this.vy[i2]) * (hx - this.vx[i2]) + (this.vx[i2] - this.vx[i1]) * (hy - this.vy[i2])) / d
        const l1 = ((this.vy[i2] - y0) * (hx - this.vx[i2]) + (x0 - this.vx[i2]) * (hy - this.vy[i2])) / d
        const l2 = 1 - l0 - l1
        return l0 >= -1e-6 && l1 >= -1e-6 && l2 >= -1e-6 ? [l0, l1, l2] : null
      }
      let s = -1
      let t = -1
      const t1 = tri(a, a + 1, a + nx + 1)
      if (t1) {
        s = t1[1] + t1[2]
        t = t1[2]
      } else {
        const t2 = tri(a, a + nx + 1, a + nx)
        if (t2) {
          s = t2[1]
          t = t2[1] + t2[2]
        }
      }
      if (s < 0) continue
      const lerp = (u: number, v: number, f: number) => u + (v - u) * f
      const ivv = lerp(lerp(this.cur![a], this.cur![a + 1], s), lerp(this.cur![a + nx], this.cur![a + nx + 1], s), t)
      const xv = lerp(g.x[j], g.x[j + 1], s)
      const tv = lerp(g.tau[i], g.tau[i + 1], t)
      const fl = this.flag ? !!(this.flag[a] || this.flag[a + 1] || this.flag[a + nx] || this.flag[a + nx + 1]) : false
      found = { x: xv, tau: tv, iv: ivv, flagged: fl, px: hx, py: hy, s, t, i, j }
    }
    if (!found) {
      if (this.hover) this.setHover(null)
      return
    }
    // Iso-maturity and iso-strike curves through the hovered point, plus a drop line.
    const p = [0, 0, 0]
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(247, 247, 247, 0.92)'
    ctx.beginPath()
    for (let jj = 0; jj < nx; jj++) {
      const a = found.i * nx + jj
      const v = this.cur![a] + (this.cur![a + nx] - this.cur![a]) * found.t
      this.proj(this.gx(jj), this.wy(found.tau), this.wz(v), p)
      if (jj === 0) ctx.moveTo(p[0], p[1])
      else ctx.lineTo(p[0], p[1])
    }
    ctx.stroke()
    ctx.beginPath()
    for (let ii = 0; ii < nt; ii++) {
      const a = ii * nx + found.j
      const v = this.cur![a] + (this.cur![a + 1] - this.cur![a]) * found.s
      this.proj(this.wx(found.x), this.wy(g.tau[ii]), this.wz(v), p)
      if (ii === 0) ctx.moveTo(p[0], p[1])
      else ctx.lineTo(p[0], p[1])
    }
    ctx.stroke()
    const q = [0, 0, 0]
    this.proj(this.wx(found.x), this.wy(found.tau), this.wz(found.iv), p)
    this.proj(this.wx(found.x), this.wy(found.tau), 0, q)
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(247,247,247,0.5)'
    ctx.beginPath()
    ctx.moveTo(p[0], p[1])
    ctx.lineTo(q[0], q[1])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(p[0], p[1], 4, 0, Math.PI * 2)
    ctx.fillStyle = '#f7f7f7'
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#0c0e12'
    ctx.stroke()
    found.px = p[0]
    found.py = p[1]
    const prev = this.hover
    if (!prev || prev.x !== found.x || prev.tau !== found.tau || Math.abs(prev.iv - found.iv) > 1e-7) this.setHover(found)
    else this.hover = found
  }

  private drawColorbar() {
    const ctx = this.ctx
    const small = this.w < 480
    const bw = 7
    const bh = Math.min(small ? 80 : 120, this.h * 0.4)
    const x0 = this.w - (small ? 20 : 42)
    const y0 = 26
    ctx.font = `400 ${small ? 9 : 10}px ${FONT_MONO}`
    ctx.fillStyle = MUTED
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = small ? 'right' : 'left'
    ctx.fillText('IV %', small ? x0 + bw : x0 - 2, y0 - 9)
    for (let k = 0; k < bh; k++) {
      ctx.fillStyle = colorAt(1 - k / bh)
      ctx.fillRect(x0, y0 + k, bw, 1.5)
    }
    ctx.strokeStyle = 'rgba(206,207,210,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, bw + 1, bh + 1)
    ctx.font = `400 ${small ? 9 : 10}px ${FONT_MONO}`
    ctx.fillStyle = MUTED
    ctx.textAlign = small ? 'right' : 'left'
    ctx.textBaseline = 'middle'
    const zt = ticks(this.zLo, this.zHi, 3)
    const zf = pctTickFormat(zt, '')
    for (const z of zt) {
      const f = (z - this.zLo) / (this.zHi - this.zLo)
      if (f < -0.01 || f > 1.01) continue
      const y = y0 + bh * (1 - f)
      if (small) {
        ctx.fillRect(x0 - 4, y - 0.5, 3, 1)
        ctx.fillText(zf(z), x0 - 6, y)
      } else {
        ctx.fillRect(x0 + bw + 1, y - 0.5, 3, 1)
        ctx.fillText(zf(z), x0 + bw + 6, y)
      }
    }
    if (this.hover) {
      const f = (this.hover.iv - this.zLo) / (this.zHi - this.zLo)
      const y = y0 + bh * (1 - Math.min(1, Math.max(0, f)))
      ctx.fillStyle = '#f7f7f7'
      const tip = small ? x0 + bw + 2 : x0 - 2
      const back = small ? tip + 5 : tip - 5
      ctx.beginPath()
      ctx.moveTo(tip, y)
      ctx.lineTo(back, y - 3.5)
      ctx.lineTo(back, y + 3.5)
      ctx.fill()
    }
  }
}
