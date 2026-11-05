/**
 * Perceptually ordered colormap built in OKLab: deep indigo -> accent purple -> pink ->
 * ember -> pale gold, with lightness increasing monotonically so IV level reads as
 * brightness even in greyscale or for colour-vision deficiencies.
 */
const STOPS = ['#241c47', '#5b3fa8', '#9e77ed', '#e46fc0', '#f0887b', '#f9c98f', '#fdf1cf']

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function linearToSrgb(c: number) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
}
function hexToOklab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const r = srgbToLinear(((n >> 16) & 255) / 255)
  const g = srgbToLinear(((n >> 8) & 255) / 255)
  const b = srgbToLinear((n & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function oklabToRgb([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const to = (c: number) => Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(c))))
  return [to(r), to(g), to(bb)]
}

/** 256-entry RGB lookup table. */
export const LUT: Uint8ClampedArray = (() => {
  const labs = STOPS.map(hexToOklab)
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (labs.length - 1)
    const k = Math.min(labs.length - 2, Math.floor(t))
    const f = t - k
    const mix = labs[k].map((v, c) => v + (labs[k + 1][c] - v) * f) as [number, number, number]
    const [r, g, b] = oklabToRgb(mix)
    lut[i * 3] = r
    lut[i * 3 + 1] = g
    lut[i * 3 + 2] = b
  }
  return lut
})()

export function colorAt(t: number, shade = 1, alpha = 1): string {
  const i = Math.round(Math.min(1, Math.max(0, t)) * 255) * 3
  const r = Math.round(LUT[i] * shade)
  const g = Math.round(LUT[i + 1] * shade)
  const b = Math.round(LUT[i + 2] * shade)
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

export function cssGradient(steps = 12): string {
  const parts: string[] = []
  for (let i = 0; i <= steps; i++) parts.push(`${colorAt(i / steps)} ${((i / steps) * 100).toFixed(1)}%`)
  return `linear-gradient(to top, ${parts.join(', ')})`
}
