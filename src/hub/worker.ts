import type { TabId } from '@tape/core/ids'
import { createReporter } from '#/analytics/exception'
import type { HubToTab } from '#/core/protocol'
import { VENUES } from '#/site'
import { createHub } from './hub'
import type { HubPort, SocketLike } from './hub'

interface WorkerScope {
  onconnect?: unknown
  addEventListener: ((type: 'connect', listener: (event: MessageEvent) => void) => void) &
    ((type: 'message', listener: (event: MessageEvent) => void) => void) &
    ((type: 'error', listener: (event: ErrorEvent) => void) => void) &
    ((type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void) => void)
  postMessage: (message: unknown) => void
}

const scope = self as unknown as WorkerScope
const shared = 'onconnect' in scope

function fromWebSocket(ws: WebSocket): SocketLike {
  const socket: SocketLike = {
    send: (data) => ws.readyState === WebSocket.OPEN && ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  }
  ws.onopen = () => socket.onopen?.()
  ws.onmessage = (e) => socket.onmessage?.(String(e.data))
  ws.onclose = () => socket.onclose?.()
  return socket
}

const hub = createHub({
  mode: shared ? 'shared' : 'dedicated',
  venues: VENUES,
  openSocket: (url) => fromWebSocket(new WebSocket(url)),
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  random: Math.random,
  // The tab holds this lock for its whole life, so the hub's request is granted the moment the tab dies.
  watchTabGone: shared
    ? (tab: TabId) => navigator.locks.request(`tape-tab:${tab}`, () => undefined).then(() => undefined)
    : () => new Promise<void>(() => {}),
})

// A SharedWorker's errors reach no page on their own, so the hub hands them to a tab.
const report = createReporter((event) => hub.report(event))
scope.addEventListener('error', (e) => report(e.error, 'hub', false))
scope.addEventListener('unhandledrejection', (e) => report(e.reason, 'hub', false))

function fromPort(port: MessagePort): HubPort {
  return {
    post: (m: HubToTab) => port.postMessage(m),
    listen: (fn) => {
      port.onmessage = (e) => fn(e.data)
      port.start()
    },
    close: () => port.close(),
  }
}

if (shared) {
  scope.addEventListener('connect', (event) => {
    const port = event.ports[0]
    if (port) hub.connect(fromPort(port))
  })
} else {
  hub.connect({
    post: (m: HubToTab) => scope.postMessage(m),
    listen: (fn) => scope.addEventListener('message', (e) => fn(e.data)),
    close: () => {},
  })
}
