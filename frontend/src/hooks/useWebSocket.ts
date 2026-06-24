import { useCallback, useEffect, useRef, useState } from 'react'

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

interface UseWebSocketOptions<T> {
  onMessage: (msg: T) => void
  onOpen?: () => void
  onClose?: (ev: CloseEvent) => void
  /** Return false to suppress automatic reconnect on a given close (e.g. job finished). */
  shouldReconnect?: () => boolean
  maxRetries?: number
  baseDelay?: number
  maxDelay?: number
}

interface UseWebSocketResult {
  status: WsStatus
  retries: number
  connect: (url: string) => void
  disconnect: () => void
}

/**
 * Imperative WebSocket hook with **exponential backoff reconnection**.
 *
 * On an unexpected close it retries with delay `min(maxDelay, base * 2^n)` plus jitter, up
 * to `maxRetries`. A manual `disconnect()` or a `shouldReconnect()` returning false stops
 * reconnection (used by the calibration stream so a finished run doesn't restart). JSON
 * messages are parsed and handed to `onMessage`. Callbacks are kept in refs so changing
 * them never tears down the socket.
 */
export function useWebSocket<T>(opts: UseWebSocketOptions<T>): UseWebSocketResult {
  const { maxRetries = 6, baseDelay = 500, maxDelay = 15_000 } = opts
  const [status, setStatus] = useState<WsStatus>('idle')
  const [retries, setRetries] = useState(0)

  const optsRef = useRef(opts)
  optsRef.current = opts

  const wsRef = useRef<WebSocket | null>(null)
  const urlRef = useRef<string | null>(null)
  const manualClose = useRef(false)
  const retryRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  const open = useCallback(() => {
    const url = urlRef.current
    if (!url) return
    setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      setStatus('error')
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      retryRef.current = 0
      setRetries(0)
      setStatus('open')
      optsRef.current.onOpen?.()
    }
    ws.onmessage = (e: MessageEvent) => {
      try {
        optsRef.current.onMessage(JSON.parse(e.data) as T)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onerror = () => setStatus('error')
    ws.onclose = (ev: CloseEvent) => {
      setStatus('closed')
      optsRef.current.onClose?.(ev)
      if (manualClose.current) return
      if (optsRef.current.shouldReconnect && !optsRef.current.shouldReconnect()) return
      if (retryRef.current >= maxRetries) return
      const delay = Math.min(maxDelay, baseDelay * 2 ** retryRef.current) + Math.random() * 250
      retryRef.current += 1
      setRetries(retryRef.current)
      timerRef.current = window.setTimeout(open, delay)
    }
  }, [baseDelay, maxDelay, maxRetries])

  const connect = useCallback(
    (url: string) => {
      manualClose.current = false
      retryRef.current = 0
      setRetries(0)
      urlRef.current = url
      // Close any existing socket before opening a fresh one.
      if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
        manualClose.current = true
        wsRef.current.close()
        manualClose.current = false
      }
      open()
    },
    [open],
  )

  const disconnect = useCallback(() => {
    manualClose.current = true
    if (timerRef.current) window.clearTimeout(timerRef.current)
    wsRef.current?.close()
  }, [])

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      manualClose.current = true
      if (timerRef.current) window.clearTimeout(timerRef.current)
      wsRef.current?.close()
    }
  }, [])

  return { status, retries, connect, disconnect }
}
