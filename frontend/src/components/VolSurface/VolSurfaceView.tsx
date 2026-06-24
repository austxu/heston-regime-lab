import { useMemo, useState } from 'react'
import Plot from '../Plot'
import { Card } from '../ui/Card'
import { ChartSkeleton } from '../ui/Skeleton'
import { QueryState } from '../ui/QueryState'
import { RangeFilter } from '../ui/RangeFilter'
import { StalenessIndicator } from '../ui/StalenessIndicator'
import { useSurface } from '../../hooks/useApiQueries'
import type { SurfaceResponse } from '../../api/types'
import { COLORS, PLOT_CONFIG, baseLayout, darkScene } from '../../lib/theme'

export function VolSurfaceView() {
  const query = useSurface()
  return (
    <div className="space-y-4">
      <QueryState query={query} skeleton={<ChartSkeleton height={460} />}>
        {(data) => <SurfaceContent data={data} />}
      </QueryState>
    </div>
  )
}

function SurfaceContent({ data }: { data: SurfaceResponse }) {
  const { moneyness, maturities } = data
  const [mRange, setMRange] = useState<[number, number]>([moneyness[0], moneyness[moneyness.length - 1]])
  const [tRange, setTRange] = useState<[number, number]>([maturities[0], maturities[maturities.length - 1]])

  const sliced = useMemo(() => sliceSurface(data, mRange, tRange), [data, mRange, tRange])

  // Shared z-axis range so the two surfaces are visually comparable.
  const zr = useMemo(() => zRange(sliced.market, sliced.heston), [sliced])

  return (
    <>
      <Card
        title="Implied Volatility Surface — Market vs Heston"
        subtitle="Calibrated Heston surface beside the market surface; rotate to inspect the smile/term structure."
        right={<StalenessIndicator provenance={data.provenance} />}
      >
        <div className="mb-4 flex flex-wrap gap-6">
          <RangeFilter
            label="Moneyness (K/S)"
            min={moneyness[0]}
            max={moneyness[moneyness.length - 1]}
            step={0.01}
            value={mRange}
            onChange={setMRange}
            format={(v) => v.toFixed(2)}
          />
          <RangeFilter
            label="Maturity (yrs)"
            min={maturities[0]}
            max={maturities[maturities.length - 1]}
            step={0.01}
            value={tRange}
            onChange={setTRange}
            format={(v) => v.toFixed(2)}
          />
          <div className="ml-auto self-end text-xs text-muted">
            spot {data.spot.toFixed(0)} · {sliced.moneyness.length}×{sliced.maturities.length} grid
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SurfacePanel
            title="Market"
            x={sliced.moneyness}
            y={sliced.maturities}
            z={sliced.market}
            colorscale="YlGnBu"
            zr={zr}
          />
          <SurfacePanel
            title="Heston model"
            x={sliced.moneyness}
            y={sliced.maturities}
            z={sliced.heston}
            colorscale="Purples"
            zr={zr}
          />
        </div>
      </Card>

      <Card
        title="Calibration Error Heatmap"
        subtitle="Market − Heston implied vol (vol points). Red = market richer than model; blue = model richer."
      >
        <ErrorHeatmap x={sliced.moneyness} y={sliced.maturities} market={sliced.market} heston={sliced.heston} />
      </Card>
    </>
  )
}

function SurfacePanel({
  title,
  x,
  y,
  z,
  colorscale,
  zr,
}: {
  title: string
  x: number[]
  y: number[]
  z: (number | null)[][]
  colorscale: string
  zr: [number, number]
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{title}</div>
      <Plot
        data={[
          {
            type: 'surface',
            x,
            y,
            z,
            colorscale,
            cmin: zr[0],
            cmax: zr[1],
            showscale: false,
            contours: { z: { show: true, usecolormap: true, project: { z: true } } },
            hovertemplate: 'K/S %{x:.2f}<br>τ %{y:.2f}y<br>IV %{z:.1%}<extra></extra>',
          },
        ]}
        layout={baseLayout({
          height: 380,
          margin: { l: 0, r: 0, t: 0, b: 0 },
          scene: darkScene({ zaxis: { ...(darkScene().zaxis as object), range: zr } }),
        })}
        config={PLOT_CONFIG}
        style={{ width: '100%', height: 380 }}
        useResizeHandler
      />
    </div>
  )
}

function ErrorHeatmap({
  x,
  y,
  market,
  heston,
}: {
  x: number[]
  y: number[]
  market: (number | null)[][]
  heston: (number | null)[][]
}) {
  const diff = market.map((row, i) => row.map((v, j) => diffCell(v, heston[i]?.[j])))
  const absMax = Math.max(
    0.001,
    ...diff.flat().filter((v): v is number => v != null).map((v) => Math.abs(v)),
  )
  return (
    <Plot
      data={[
        {
          type: 'heatmap',
          x,
          y,
          z: diff,
          colorscale: 'RdBu',
          reversescale: true,
          zmid: 0,
          zmin: -absMax,
          zmax: absMax,
          colorbar: { title: { text: 'Δ IV', side: 'right' }, tickformat: '.1%', outlinewidth: 0 },
          hovertemplate: 'K/S %{x:.2f}<br>τ %{y:.2f}y<br>Δ %{z:.2%}<extra></extra>',
        },
      ]}
      layout={baseLayout({
        height: 320,
        xaxis: { title: { text: 'Moneyness K/S' }, gridcolor: COLORS.edge },
        yaxis: { title: { text: 'Maturity (yrs)' }, gridcolor: COLORS.edge },
        margin: { l: 56, r: 16, t: 8, b: 44 },
      })}
      config={PLOT_CONFIG}
      style={{ width: '100%', height: 320 }}
      useResizeHandler
    />
  )
}

// -- grid helpers ------------------------------------------------------------ //

function diffCell(a: number | null, b: number | null | undefined): number | null {
  return a == null || b == null ? null : a - b
}

interface SlicedSurface {
  moneyness: number[]
  maturities: number[]
  market: (number | null)[][]
  heston: (number | null)[][]
}

function sliceSurface(
  data: SurfaceResponse,
  [mLo, mHi]: [number, number],
  [tLo, tHi]: [number, number],
): SlicedSurface {
  const mIdx = data.moneyness.map((m, i) => [m, i] as const).filter(([m]) => m >= mLo - 1e-9 && m <= mHi + 1e-9)
  const tIdx = data.maturities.map((t, i) => [t, i] as const).filter(([t]) => t >= tLo - 1e-9 && t <= tHi + 1e-9)
  const pick = (grid: (number | null)[][]) => tIdx.map(([, ti]) => mIdx.map(([, mi]) => grid[ti][mi]))
  return {
    moneyness: mIdx.map(([m]) => m),
    maturities: tIdx.map(([t]) => t),
    market: pick(data.market_iv),
    heston: pick(data.heston_iv),
  }
}

function zRange(a: (number | null)[][], b: (number | null)[][]): [number, number] {
  const vals = [...a.flat(), ...b.flat()].filter((v): v is number => v != null && Number.isFinite(v))
  if (!vals.length) return [0, 1]
  return [Math.min(...vals) * 0.98, Math.max(...vals) * 1.02]
}
