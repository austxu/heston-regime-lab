/**
 * Brent's root finder — a line-by-line port of scipy.optimize.brentq (brentq.c), so
 * implied vols converge along the same path, to the same tolerance, as the Python code.
 */
const RTOL = 4 * Number.EPSILON

export function brentq(
  f: (x: number) => number,
  xa: number,
  xb: number,
  xtol = 2e-12,
  rtol = RTOL,
  maxIter = 100,
): number {
  let xpre = xa
  let xcur = xb
  let xblk = 0
  let fblk = 0
  let spre = 0
  let scur = 0
  let fpre = f(xpre)
  let fcur = f(xcur)
  if (fpre === 0) return xpre
  if (fcur === 0) return xcur
  if (Math.sign(fpre) === Math.sign(fcur)) return Number.NaN
  for (let i = 0; i < maxIter; i++) {
    if (fpre !== 0 && fcur !== 0 && Math.sign(fpre) !== Math.sign(fcur)) {
      xblk = xpre
      fblk = fpre
      spre = scur = xcur - xpre
    }
    if (Math.abs(fblk) < Math.abs(fcur)) {
      xpre = xcur
      xcur = xblk
      xblk = xpre
      fpre = fcur
      fcur = fblk
      fblk = fpre
    }
    const delta = (xtol + rtol * Math.abs(xcur)) / 2
    const sbis = (xblk - xcur) / 2
    if (fcur === 0 || Math.abs(sbis) < delta) return xcur
    if (Math.abs(spre) > delta && Math.abs(fcur) < Math.abs(fpre)) {
      let stry: number
      if (xpre === xblk) {
        stry = (-fcur * (xcur - xpre)) / (fcur - fpre)
      } else {
        const dpre = (fpre - fcur) / (xpre - xcur)
        const dblk = (fblk - fcur) / (xblk - xcur)
        stry = (-fcur * (fblk * dblk - fpre * dpre)) / (dblk * dpre * (fblk - fpre))
      }
      if (2 * Math.abs(stry) < Math.min(Math.abs(spre), 3 * Math.abs(sbis) - delta)) {
        spre = scur
        scur = stry
      } else {
        spre = sbis
        scur = sbis
      }
    } else {
      spre = sbis
      scur = sbis
    }
    xpre = xcur
    fpre = fcur
    if (Math.abs(scur) > delta) xcur += scur
    else xcur += sbis > 0 ? delta : -delta
    fcur = f(xcur)
  }
  return xcur
}
