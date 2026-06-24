// Typed API client. Uses same-origin relative URLs by default (the Vite dev server and the
// production nginx both proxy /api + /ws to the FastAPI backend); override with
// VITE_API_BASE for a cross-origin backend.

import type {
  CalibrationResponse,
  ComparisonResponse,
  HealthResponse,
  RegimeCurrentResponse,
  RegimeHistoryResponse,
  RegimeParametersResponse,
  SurfaceResponse,
} from './types'

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? ''

/** A 202 from the heavy regime-parameter analysis means "computing, poll again". */
export class AnalysisPendingError extends Error {
  constructor() {
    super('analysis is being computed')
    this.name = 'AnalysisPendingError'
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    throw new ApiError(0, `Network error contacting API: ${(err as Error).message}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ApiError(res.status, `API ${res.status} on ${path}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

const live = (preferLive: boolean) => (preferLive ? '' : '?live=false')

export const api = {
  health: () => getJSON<HealthResponse>('/health'),

  calibration: (preferLive = true, signal?: AbortSignal) =>
    getJSON<CalibrationResponse>(`/api/calibration/run${live(preferLive)}`, signal),

  surface: (preferLive = true, signal?: AbortSignal) =>
    getJSON<SurfaceResponse>(`/api/surface${live(preferLive)}`, signal),

  regimeCurrent: (preferLive = true, signal?: AbortSignal) =>
    getJSON<RegimeCurrentResponse>(`/api/regime/current${live(preferLive)}`, signal),

  regimeHistory: (preferLive = true, downsample = 5, signal?: AbortSignal) =>
    getJSON<RegimeHistoryResponse>(
      `/api/regime/history?downsample=${downsample}${preferLive ? '' : '&live=false'}`,
      signal,
    ),

  comparison: (preferLive = true, signal?: AbortSignal) =>
    getJSON<ComparisonResponse>(`/api/comparison${live(preferLive)}`, signal),

  // 202 while the heavy analysis runs in the background -> surfaced as AnalysisPendingError
  // so React Query can keep polling.
  regimeParameters: async (signal?: AbortSignal): Promise<RegimeParametersResponse> => {
    const res = await fetch(`${API_BASE}/api/regime/parameters`, {
      signal,
      headers: { Accept: 'application/json' },
    }).catch((err) => {
      throw new ApiError(0, `Network error: ${(err as Error).message}`)
    })
    if (res.status === 202) throw new AnalysisPendingError()
    if (!res.ok) throw new ApiError(res.status, `API ${res.status} on /api/regime/parameters`)
    return (await res.json()) as RegimeParametersResponse
  },
}

/** Build the WebSocket URL for the calibration stream, honouring API_BASE. */
export function calibrationWsUrl(preferLive = true): string {
  const query = preferLive ? '' : '?live=false'
  if (API_BASE) {
    return `${API_BASE.replace(/^http/, 'ws')}/ws/calibration${query}`
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/ws/calibration${query}`
}
