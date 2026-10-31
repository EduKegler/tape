import { batch, createStore } from '@tanstack/store'
import type { Store } from '@tanstack/store'
import type { TabId } from '@tape/core/ids'
import type { ExceptionEvent } from '#/analytics/exception'
import type { HubMode, HubStats, HubToTab, TabToHub } from '#/core/protocol'
import { topicKey } from '#/core/topics'
import type { Frame, FrameOf, Topic, TopicKey } from '#/core/topics'

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

export function createRegistry(
  connect: () => TabPort,
  life: Lifecycle,
  report: (event: ExceptionEvent) => void,
): HubClient {
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
    for (const [key, entry] of entries) {
      if (entry.refs > 0) wanted.push(entry.topic)
      else if (entry.store.get() !== null) {
        pending.delete(key)
        entry.store.setState(() => null)
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
    port.listen((message) => {
      if (message.t === 'stats') stats.setState(() => message.stats)
      if (message.t === 'exception') report(message.event)
      if (message.t !== 'frames') return
      for (const frame of message.frames) if (entries.get(frame.key)?.refs) pending.set(frame.key, frame)
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

  const entryFor = (topic: Topic): Entry => {
    const key = topicKey(topic)
    let entry = entries.get(key)
    if (!entry) {
      entry = { topic, store: createStore<Frame | null>(null), refs: 0 }
      entries.set(key, entry)
    }
    return entry
  }

  return {
    get mode() {
      return port.mode
    },
    stats,
    store: <T extends Topic>(topic: T) => entryFor(topic).store as unknown as ReadStore<FrameOf<T> | null>,
    retain(topic) {
      const retained = entryFor(topic)
      retained.refs++
      scheduleWant()
      return () => {
        retained.refs--
        scheduleWant()
      }
    },
  }
}
