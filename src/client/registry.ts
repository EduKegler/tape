import { batch, createStore } from '@tanstack/store'
import type { Store } from '@tanstack/store'
import type { TabId, TopicKey } from '@tape/core/ids'
import type { HubMode, HubStats, HubToTab, TabToHub } from '#/core/protocol'
import { topicKey } from '#/core/topics'
import type { Frame, FrameOf, Topic } from '#/core/topics'

export interface TabPort {
  readonly mode: HubMode
  post: (message: TabToHub) => void
  close: () => void
  listen: (onMessage: (message: HubToTab) => void) => void
}

type ReadStore<T> = Pick<Store<T>, 'get' | 'subscribe'>

export interface HubClient {
  readonly mode: HubMode
  readonly stats: ReadStore<HubStats | null>
  store: <T extends Topic>(topic: T) => ReadStore<FrameOf<T> | null>
  retain: (topic: Topic) => () => void
}

interface Entry {
  readonly topic: Topic
  readonly store: Store<Frame | null>
  refs: number
}

export interface Lifecycle {
  holdLiveness: (tab: TabId, ready: () => void) => void
  newTabId: () => TabId
  isVisible: () => boolean
  requestFrame: (fn: () => void) => void
  onVisibility: (fn: (visible: boolean) => void) => void
  onPageHide: (fn: () => void) => void
  onPageRestore: (fn: () => void) => void
}

export function createRegistry(connect: () => TabPort, life: Lifecycle): HubClient {
  const entries = new Map<TopicKey, Entry>()
  const pending = new Map<TopicKey, Frame>()
  const stats = createStore<HubStats | null>(null)
  let port = connect()
  let rafScheduled = false
  let wantScheduled = false

  const flushInbox = () => {
    rafScheduled = false
    batch(() => {
      for (const [key, frame] of pending) entries.get(key)?.store.setState(() => frame)
    })
    pending.clear()
  }

  const sendWantClearingUnwanted = () => {
    wantScheduled = false
    const wanted: Topic[] = []
    for (const [key, e] of entries) {
      if (e.refs > 0) wanted.push(e.topic)
      else if (e.store.get() !== null) {
        pending.delete(key)
        e.store.setState(() => null)
      }
    }
    port.post({ t: 'want', topics: wanted })
  }

  const scheduleWant = () => {
    if (wantScheduled) return
    wantScheduled = true
    queueMicrotask(sendWantClearingUnwanted)
  }

  const start = () => {
    const tab = life.newTabId()
    port.listen((m) => {
      if (m.t === 'stats') stats.setState(() => m.stats)
      if (m.t !== 'frames') return
      for (const f of m.frames) if (entries.get(f.key)?.refs) pending.set(f.key, f)
      if (!rafScheduled && pending.size) {
        rafScheduled = true
        life.requestFrame(flushInbox)
      }
    })
    life.holdLiveness(tab, () => {
      port.post({ t: 'hello', tab, visible: life.isVisible() })
      sendWantClearingUnwanted()
    })
  }

  start()
  life.onVisibility((visible) => port.post({ t: 'visible', visible }))
  life.onPageHide(() => port.post({ t: 'bye' }))
  life.onPageRestore(() => {
    port.close()
    port = connect()
    start()
  })

  const entry = (topic: Topic): Entry => {
    const key = topicKey(topic)
    let e = entries.get(key)
    if (!e) {
      e = { topic, store: createStore<Frame | null>(null), refs: 0 }
      entries.set(key, e)
    }
    return e
  }

  return {
    get mode() {
      return port.mode
    },
    stats,
    store: <T extends Topic>(topic: T) => entry(topic).store as unknown as ReadStore<FrameOf<T> | null>,
    retain(topic) {
      const e = entry(topic)
      e.refs++
      scheduleWant()
      return () => {
        e.refs--
        scheduleWant()
      }
    },
  }
}
