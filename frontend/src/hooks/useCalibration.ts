import { useCallback, useEffect, useRef, useState } from 'react'
import { calibrationWsUrl } from '../api/client'
import type { CalibrationResponse, CalibrationStreamMessage, HestonParamValues } from '../api/types'
import { demoData } from '../demo'
import { useDataMode } from '../lib/dataModeContext'
import { useWebSocket } from './useWebSocket'
import type { WsStatus } from './useWebSocket'

export interface CalibrationStep {
  iteration: number
  loss: number
  params: HestonParamValues
}

export interface UseCalibrationResult {
  start: () => void
  stop: () => void
  running: boolean
  steps: CalibrationStep[]
  finalParams: HestonParamValues | null
  finalError: number | null
  done: boolean
  errorMsg: string | null
  wsStatus: WsStatus
  retries: number
  preview: CalibrationResponse
}

/**
 * Drives the /ws/calibration stream: opening the socket triggers a server-side calibration
 * that emits one `progress` frame per L-BFGS-B iteration, then a `done` frame. We accumulate
 * the convergence path for the live chart, then close cleanly (no reconnect on completion —
 * reconnection only fires if the socket drops mid-run, in which case the server restarts the
 * run and we reset the path on the fresh open).
 */
export function useCalibration(): UseCalibrationResult {
  const { preferLive } = useDataMode()
  const [steps, setSteps] = useState<CalibrationStep[]>([])
  const [finalParams, setFinalParams] = useState<HestonParamValues | null>(null)
  const [finalError, setFinalError] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const completedRef = useRef(false)
  const disconnectRef = useRef<() => void>(() => undefined)
  const autoStartedRef = useRef(false)

  const { connect, disconnect, status, retries } = useWebSocket<CalibrationStreamMessage>({
    onOpen: () => {
      // A fresh open (initial or reconnect) means the server is streaming from iteration 1.
      setSteps([])
    },
    onMessage: (m) => {
      if (m.type === 'progress') {
        setSteps((prev) => [...prev, { iteration: m.iteration, loss: m.loss, params: m.params }])
      } else if (m.type === 'done') {
        completedRef.current = true
        setDone(true)
        if (m.params) setFinalParams(m.params)
        setFinalError(m.mean_iv_error ?? null)
        disconnectRef.current()
      } else if (m.type === 'error') {
        completedRef.current = true
        setErrorMsg(m.message ?? 'Calibration failed')
        disconnectRef.current()
      }
    },
    shouldReconnect: () => !completedRef.current,
  })
  disconnectRef.current = disconnect

  const reset = useCallback(() => {
    setSteps([])
    setFinalParams(null)
    setFinalError(null)
    setDone(false)
    setErrorMsg(null)
  }, [])

  const start = useCallback(() => {
    completedRef.current = false
    reset()
    try {
      connect(calibrationWsUrl(preferLive))
    } catch {
      completedRef.current = true
      setErrorMsg('The configured API address is invalid. Check the frontend environment settings.')
    }
  }, [connect, preferLive, reset])

  const stop = useCallback(() => {
    completedRef.current = true
    disconnect()
  }, [disconnect])

  const previousModeRef = useRef(preferLive)
  useEffect(() => {
    if (previousModeRef.current === preferLive) return
    previousModeRef.current = preferLive
    completedRef.current = true
    disconnect()
    if (!preferLive) autoStartedRef.current = false
    reset()
  }, [disconnect, preferLive, reset])

  // Start the live refinement after the static preview is already visible. StrictMode-safe
  // because the ref prevents a duplicate socket when React replays mount effects in dev.
  useEffect(() => {
    if (!preferLive || autoStartedRef.current) return
    autoStartedRef.current = true
    start()
  }, [preferLive, start])

  const running =
    (status === 'open' || status === 'connecting' || status === 'retrying') &&
    !done &&
    !errorMsg

  const connectionError =
    status === 'error'
      ? 'The calibration stream could not connect after several attempts. Check the API and try again.'
      : errorMsg

  return {
    start,
    stop,
    running,
    steps,
    finalParams,
    finalError,
    done,
    errorMsg: connectionError,
    wsStatus: status,
    retries,
    preview: demoData.calibration,
  }
}
