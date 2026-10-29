import { batch, createStore } from '@tanstack/store'
import type { Store } from '@tanstack/store'
import type { TabId, TopicKey } from '@tape/core/ids'
import type { HubMode, HubStats, HubToTab, TabToHub } from '#/core/protocol'
import { topicKey } from '#/core/topics'
import type { Frame, FrameOf, Topic } from '#/core/topics'

/** The tab's end of the wire: a SharedWorker port, a dedicated Worker, or a test channel. */
export interface TabPort {
  readonly mode: HubMode
  post(message: TabToHub): void
  close(): void
  listen(onMessage: (message: HubToTab) => void): void
}

/**
 * The tab's whole view of the streaming core. A topic's store is created on first read and
 * retained while mounted. Frames land in a latest-wins inbox flushed once per animation frame
 * inside `batch`, so React commits at most once per frame however fast the hub sends.
 */
/** What a reader may do with a store: read and subscribe, never write. */
export type ReadStore<T> = Pick<Store<T>, 'get' | 'subscribe'>

export interface HubClient {
  readonly mode: HubMode
  readonly stats: ReadStore<HubStats | null>
  store<T extends Topic>(topic: T): ReadStore<FrameOf<T> | null>
  retain(topic: Topic): () => void
}

interface Entry {
  readonly topic: Topic
  readonly store: Store<Frame | null>
  refs: number
}

export interface Lifecycle {
  /** Holds a lock named after the tab for the page's life, then calls `ready`. */
  holdLiveness(tab: TabId, ready: () => void): void
  newTabId(): TabId
  isVisible(): boolean
  requestFrame(fn: () => void): void
  onVisibility(fn: (visible: boolean) => void): void
  onPageHide(fn: () => void): void
  /** A page restored from the back/forward cache is a new tab to the hub. */
  onPageRestore(fn: () => void): void
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

  // Unwanted entries stay, so a component that read a store before retaining it never holds an
  // orphan. Their frame is cleared so a later reader never sees old prices as current.
  const sendWant = () => {
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
    queueMicrotask(sendWant)
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
      sendWant()
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
