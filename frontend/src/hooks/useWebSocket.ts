import { useCallback, useEffect, useRef, useState } from 'react'

export type WsStatus = 'idle' | 'connecting' | 'open' | 'retrying' | 'closed' | 'error'

interface UseWebSocketOptions<T> {
  onMessage: (msg: T) => void
  onOpen?: () => void
  onClose?: (ev: CloseEvent) => void
  /** Return false to suppress automatic reconnect on a given close (for example, a finished job). */
  shouldReconnect?: (ev: CloseEvent) => boolean
  maxRetries?: number
  baseDelay?: number
  maxDelay?: number
}

export interface UseWebSocketResult {
  status: WsStatus
  retries: number
  connect: (url: string) => void
  disconnect: () => void
}

/**
 * Imperative WebSocket hook with bounded exponential-backoff reconnection.
 *
 * A monotonically increasing connection generation makes callbacks from replaced sockets inert.
 * That prevents an old socket's delayed close event from scheduling a second connection after a
 * manual restart. Callback refs also keep consumer renders from tearing down an active stream.
 */
export function useWebSocket<T>(opts: UseWebSocketOptions<T>): UseWebSocketResult {
  const { maxRetries = 6, baseDelay = 500, maxDelay = 15_000 } = opts
  const [status, setStatus] = useState<WsStatus>('idle')
  const [retries, setRetries] = useState(0)

  const optsRef = useRef(opts)
  optsRef.current = opts

  const wsRef = useRef<WebSocket | null>(null)
  const urlRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const retryRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const openRef = useRef<(generation: number) => void>(() => undefined)

  const clearRetryTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const scheduleReconnect = useCallback(
    (generation: number, event: CloseEvent) => {
      if (generation !== generationRef.current || !urlRef.current) return
      if (optsRef.current.shouldReconnect && !optsRef.current.shouldReconnect(event)) {
        setStatus('closed')
        return
      }
      if (retryRef.current >= maxRetries) {
        setStatus('error')
        return
      }

      const retryNumber = retryRef.current + 1
      const exponentialDelay = Math.min(maxDelay, baseDelay * 2 ** retryRef.current)
      const jitter = Math.random() * Math.min(250, exponentialDelay * 0.2)
      retryRef.current = retryNumber
      setRetries(retryNumber)
      setStatus('retrying')
      clearRetryTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        openRef.current(generation)
      }, exponentialDelay + jitter)
    },
    [baseDelay, clearRetryTimer, maxDelay, maxRetries],
  )

  const open = useCallback(
    (generation: number) => {
      const url = urlRef.current
      if (!url || generation !== generationRef.current) return

      setStatus('connecting')
      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch {
        scheduleReconnect(generation, syntheticCloseEvent())
        return
      }
      wsRef.current = socket

      socket.onopen = () => {
        if (generation !== generationRef.current || wsRef.current !== socket) {
          socket.close(1000, 'Superseded connection')
          return
        }
        // Keep the retry budget for the lifetime of this logical connection. An
        // unstable server can successfully complete the WebSocket handshake and
        // then drop immediately; resetting here would make every such cycle retry
        // number one forever. A manual connect/disconnect starts a fresh budget.
        setStatus('open')
        optsRef.current.onOpen?.()
      }

      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (generation !== generationRef.current || wsRef.current !== socket) return
        if (typeof event.data !== 'string') return
        try {
          optsRef.current.onMessage(JSON.parse(event.data) as T)
        } catch {
          // A malformed or non-JSON frame should not terminate an otherwise healthy stream.
        }
      }

      socket.onerror = () => {
        // Browsers intentionally hide WebSocket error details. The ensuing close event handles
        // retry state; if one never arrives, closing here guarantees forward progress.
        if (generation === generationRef.current && wsRef.current === socket) {
          try {
            socket.close()
          } catch {
            wsRef.current = null
            scheduleReconnect(generation, syntheticCloseEvent())
          }
        }
      }

      socket.onclose = (event: CloseEvent) => {
        if (generation !== generationRef.current || wsRef.current !== socket) return
        wsRef.current = null
        optsRef.current.onClose?.(event)
        scheduleReconnect(generation, event)
      }
    },
    [scheduleReconnect],
  )
  openRef.current = open

  const disconnect = useCallback(() => {
    generationRef.current += 1
    urlRef.current = null
    clearRetryTimer()
    retryRef.current = 0
    setRetries(0)
    setStatus('idle')

    const socket = wsRef.current
    wsRef.current = null
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, 'Client disconnected')
    }
  }, [clearRetryTimer])

  const connect = useCallback(
    (url: string) => {
      const generation = generationRef.current + 1
      generationRef.current = generation
      clearRetryTimer()
      retryRef.current = 0
      setRetries(0)
      urlRef.current = url

      const previous = wsRef.current
      wsRef.current = null
      if (previous && previous.readyState < WebSocket.CLOSING) {
        previous.close(1000, 'Connection replaced')
      }
      openRef.current(generation)
    },
    [clearRetryTimer],
  )

  useEffect(() => {
    return () => {
      generationRef.current += 1
      urlRef.current = null
      clearRetryTimer()
      const socket = wsRef.current
      wsRef.current = null
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, 'Component unmounted')
      }
    }
  }, [clearRetryTimer])

  return { status, retries, connect, disconnect }
}

/** WebSocket construction errors do not provide a CloseEvent, so use an equivalent signal. */
function syntheticCloseEvent(): CloseEvent {
  return new CloseEvent('close', { code: 1006, reason: 'Connection could not be opened' })
}
