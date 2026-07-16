import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSocket } from './useWebSocket'
import type { UseWebSocketResult } from './useWebSocket'

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: MockWebSocket[] = []

  readonly url: string
  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  emitClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code, wasClean: code === 1000 }))
  }
}

let root: Root
let socket: UseWebSocketResult

function Harness() {
  socket = useWebSocket<unknown>({
    onMessage: () => undefined,
    maxRetries: 2,
    baseDelay: 100,
    maxDelay: 500,
  })
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Harness />))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useWebSocket', () => {
  it('ignores a delayed close from a socket that has been replaced', () => {
    act(() => socket.connect('ws://example.test/first'))
    const first = MockWebSocket.instances[0]
    act(() => first.emitOpen())

    act(() => socket.connect('ws://example.test/second'))
    expect(MockWebSocket.instances).toHaveLength(2)

    act(() => {
      first.emitClose()
      vi.advanceTimersByTime(2_000)
    })

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toBe('ws://example.test/second')
  })

  it('reconnects an unexpectedly closed active socket', () => {
    act(() => socket.connect('ws://example.test/stream'))
    const first = MockWebSocket.instances[0]
    act(() => first.emitOpen())
    act(() => first.emitClose())

    expect(socket.status).toBe('retrying')
    expect(socket.retries).toBe(1)

    act(() => vi.advanceTimersByTime(1_000))
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].url).toBe('ws://example.test/stream')
  })

  it('caps repeated connections that open and then drop', () => {
    act(() => socket.connect('ws://example.test/stream'))

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const active = MockWebSocket.instances[attempt]
      act(() => active.emitOpen())
      act(() => active.emitClose())

      if (attempt < 2) {
        expect(socket.status).toBe('retrying')
        expect(socket.retries).toBe(attempt + 1)
        act(() => vi.runOnlyPendingTimers())
      }
    }

    expect(socket.status).toBe('error')
    expect(socket.retries).toBe(2)
    act(() => vi.runAllTimers())
    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('does not reconnect after a manual disconnect', () => {
    act(() => socket.connect('ws://example.test/stream'))
    const active = MockWebSocket.instances[0]
    act(() => active.emitOpen())
    act(() => socket.disconnect())
    act(() => {
      active.emitClose(1000)
      vi.advanceTimersByTime(2_000)
    })

    expect(socket.status).toBe('idle')
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})
