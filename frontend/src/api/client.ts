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

/** Remove trailing slashes so endpoint paths compose consistently. */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '')

/** A 202 from the heavy regime-parameter analysis means "computing, poll again". */
export class AnalysisPendingError extends Error {
  constructor() {
    super('analysis is being computed')
    this.name = 'AnalysisPendingError'
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly path: string

  constructor(status: number, path: string, message: string) {
    super(message)
    this.status = status
    this.path = path
    this.name = 'ApiError'
  }
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(0, path, 'Unable to reach the API. Check that the service is running and try again.')
  }
  if (!res.ok) {
    throw new ApiError(res.status, path, await responseErrorMessage(res))
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError(res.status, path, 'The API returned an invalid response.')
  }
}

const live = (preferLive: boolean) => (preferLive ? '' : '?live=false')

export const api = {
  // In same-origin deployments nginx keeps `/health` as its own liveness probe and
  // exposes FastAPI health at `/api-health`. A configured cross-origin API base points
  // directly at FastAPI, where the endpoint remains `/health`.
  health: (signal?: AbortSignal) => getJSON<HealthResponse>(healthPath(API_BASE), signal),

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
    let res: Response
    try {
      res = await fetch(`${API_BASE}/api/regime/parameters`, {
        signal,
        headers: { Accept: 'application/json' },
      })
    } catch (err) {
      if (isAbortError(err)) throw err
      throw new ApiError(
        0,
        '/api/regime/parameters',
        'Unable to reach the API. Check that the service is running and try again.',
      )
    }
    if (res.status === 202) throw new AnalysisPendingError()
    if (!res.ok) {
      throw new ApiError(
        res.status,
        '/api/regime/parameters',
        await responseErrorMessage(res),
      )
    }
    try {
      return (await res.json()) as RegimeParametersResponse
    } catch {
      throw new ApiError(
        res.status,
        '/api/regime/parameters',
        'The API returned an invalid response.',
      )
    }
  },
}

export function healthPath(apiBase: string): '/health' | '/api-health' {
  return apiBase.trim() ? '/health' : '/api-health'
}

/** Build the WebSocket URL for the calibration stream, honouring API_BASE. */
export function calibrationWsUrl(preferLive = true): string {
  return buildCalibrationWsUrl(API_BASE, window.location.href, preferLive)
}

export function buildCalibrationWsUrl(
  apiBase: string,
  pageUrl: string,
  preferLive = true,
): string {
  const base = new URL(apiBase.replace(/\/+$/, '') || '/', pageUrl)
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = `${base.pathname.replace(/\/$/, '')}/ws/calibration`
  base.search = preferLive ? '' : '?live=false'
  base.hash = ''
  return base.toString()
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function responseErrorMessage(response: Response): Promise<string> {
  const fallback =
    response.status === 429
      ? 'Too many requests. Wait a moment before trying again.'
      : response.status >= 500
        ? 'The API encountered an error. Please try again.'
        : `The API rejected the request (${response.status}).`

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = (await response.json().catch(() => null)) as
      | { detail?: unknown; message?: unknown }
      | null
    const detail = body?.detail ?? body?.message
    if (typeof detail === 'string' && detail.trim()) return detail.slice(0, 240)
  }
  return fallback
}
