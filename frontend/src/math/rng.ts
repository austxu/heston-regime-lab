/** Small seeded PRNG (xoshiro128**) with uniform and normal draws, for reproducible MC. */
export class Rng {
  private s: Uint32Array
  private spare = Number.NaN
  constructor(seed = 1) {
    // SplitMix32 to expand the seed into four non-zero words.
    let x = seed >>> 0
    this.s = new Uint32Array(4)
    for (let i = 0; i < 4; i++) {
      x = (x + 0x9e3779b9) >>> 0
      let z = x
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
      this.s[i] = (z ^ (z >>> 16)) >>> 0 || 1
    }
  }
  /** Uniform in [0, 1). */
  next(): number {
    const s = this.s
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0
    const t = s[1] << 9
    s[2] ^= s[0]
    s[3] ^= s[1]
    s[1] ^= s[2]
    s[0] ^= s[3]
    s[2] ^= t
    s[3] = rotl(s[3], 11)
    return result / 4294967296
  }
  /** Standard normal (Marsaglia polar method). */
  normal(): number {
    if (!Number.isNaN(this.spare)) {
      const v = this.spare
      this.spare = Number.NaN
      return v
    }
    let u: number
    let v: number
    let s: number
    do {
      u = 2 * this.next() - 1
      v = 2 * this.next() - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const f = Math.sqrt((-2 * Math.log(s)) / s)
    this.spare = v * f
    return u * f
  }
}

function rotl(x: number, k: number) {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}
