import { toTabId } from '@tape/core/ids'
import { track } from '#/analytics/track'
import type { HubToTab, TabToHub } from '#/core/protocol'
import { NETWORK } from '#/site'
import { createRegistry } from './registry'
import type { HubClient, Lifecycle, TabPort } from './registry'

function sharedPort(): TabPort {
  const worker = new SharedWorker(new URL('../hub/worker.ts', import.meta.url), {
    type: 'module',
    name: `tape-hub:${NETWORK}`,
  })
  worker.port.start()
  return {
    mode: 'shared',
    post: (message: TabToHub) => worker.port.postMessage(message),
    listen: (fn) => (worker.port.onmessage = (event: MessageEvent<HubToTab>) => fn(event.data)),
    close: () => worker.port.close(),
  }
}

function dedicatedPort(): TabPort {
  const worker = new Worker(new URL('../hub/worker.ts', import.meta.url), {
    type: 'module',
    name: `tape-hub:${NETWORK}`,
  })
  return {
    mode: 'dedicated',
    post: (message: TabToHub) => worker.postMessage(message),
    listen: (fn) => (worker.onmessage = (event: MessageEvent<HubToTab>) => fn(event.data)),
    close: () => worker.terminate(),
  }
}

const browserLifecycle: Lifecycle = {
  newTabId: () => toTabId(crypto.randomUUID()),
  isVisible: () => document.visibilityState === 'visible',
  holdLiveness(tab, ready) {
    if (!('locks' in navigator)) {
      ready()
      return
    }
    void navigator.locks.request(`tape-tab:${tab}`, () => {
      ready()
      return new Promise<never>(() => {})
    })
  },
  requestFrame: (fn) => {
    requestAnimationFrame(fn)
  },
  onVisibility: (fn) => document.addEventListener('visibilitychange', () => fn(document.visibilityState === 'visible')),
  onPageHide: (fn) => window.addEventListener('pagehide', fn),
  onPageRestore: (fn) => window.addEventListener('pageshow', (event) => event.persisted && fn()),
}

export function connectHub(): HubClient {
  const forceDedicated = new URLSearchParams(location.search).get('hub') === 'dedicated'
  const shared = typeof SharedWorker === 'function' && !forceDedicated
  return createRegistry(shared ? sharedPort : dedicatedPort, browserLifecycle, track)
}
