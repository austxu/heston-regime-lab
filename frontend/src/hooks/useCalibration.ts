import { useCallback, useRef, useState } from 'react'
import { calibrationWsUrl } from '../api/client'
import type { CalibrationStreamMessage } from '../api/types'
import { useDataMode } from '../lib/dataMode'
import { useWebSocket } from './useWebSocket'

export interface CalibrationStep {
  iteration: number
  loss: number
  params: Record<string, number>
}

export interface UseCalibrationResult {
  start: () => void
  stop: () => void
  running: boolean
  steps: CalibrationStep[]
  finalParams: Record<string, number> | null
  finalError: number | null
  done: boolean
  errorMsg: string | null
  wsStatus: string
  retries: number
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
  const [finalParams, setFinalParams] = useState<Record<string, number> | null>(null)
  const [finalError, setFinalError] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const completedRef = useRef(false)

  const ws = useWebSocket<CalibrationStreamMessage>({
    onOpen: () => {
      // A fresh open (initial or reconnect) means the server is streaming from iteration 1.
      setSteps([])
    },
    onMessage: (m) => {
      if (m.type === 'progress' && m.iteration != null && m.loss != null && m.params) {
        setSteps((prev) => [...prev, { iteration: m.iteration!, loss: m.loss!, params: m.params! }])
      } else if (m.type === 'done') {
        completedRef.current = true
        setDone(true)
        if (m.params) setFinalParams(m.params)
        setFinalError(m.mean_iv_error ?? null)
        ws.disconnect()
      } else if (m.type === 'error') {
        completedRef.current = true
        setErrorMsg(m.message ?? 'Calibration failed')
        ws.disconnect()
      }
    },
    shouldReconnect: () => !completedRef.current,
  })

  const start = useCallback(() => {
    completedRef.current = false
    setSteps([])
    setFinalParams(null)
    setFinalError(null)
    setDone(false)
    setErrorMsg(null)
    ws.connect(calibrationWsUrl(preferLive))
  }, [preferLive, ws])

  const running = (ws.status === 'open' || ws.status === 'connecting') && !done && !errorMsg

  return {
    start,
    stop: ws.disconnect,
    running,
    steps,
    finalParams,
    finalError,
    done,
    errorMsg,
    wsStatus: ws.status,
    retries: ws.retries,
  }
}
