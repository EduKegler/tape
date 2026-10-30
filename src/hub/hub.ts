import { throttle } from '@tanstack/pacer'
import type { ExceptionEvent } from '#/analytics/exception'
import { initialSync, stepBook } from '@tape/core/book'
import type { BookInput, BookSync } from '@tape/core/book'
import { DecimalError } from '@tape/core/fixed'
import { VENUE_IDS, parseStreamKey, splitMarketKey, streamKey } from '@tape/core/ids'
import type { Interval, MarketKey, StreamKey, TabId, TopicKey, VenueId } from '@tape/core/ids'
import { emptyTape, pushTrades, upsertCandle } from '@tape/core/market'
import type { Candle, MarketSpec, TradeTape } from '@tape/core/market'
import { projectBook, projectCandle, projectCompare, projectDepth, projectTrades } from '#/core/project'
import type { MarketView } from '#/core/project'
import { parseTabMessage } from '#/core/protocol'
import type { HubMode, HubStats, HubToTab } from '#/core/protocol'
import { deriveStreams, marketsFor, topicKey } from '#/core/topics'
import type { Frame, FrameStatus, Topic } from '#/core/topics'
import { toCandle, toLevels, toTrades } from '@tape/venues/normalize'
import { VenueParseError } from '@tape/venues/types'
import type { StreamTarget, VenueAdapter, VenueEvent } from '@tape/venues/types'
import { stepConnection } from './connection'
import type { ConnEffect, ConnEvent, ConnState } from './connection'

export interface Hub {
  connect: (port: HubPort) => void
  report: (event: ExceptionEvent) => void
  inspect: () => HubInspection
  dispose: () => void
}

export interface HubPort {
  post: (message: HubToTab) => void
  listen: (onMessage: (data: unknown) => void) => void
  close: () => void
}

export interface SocketLike {
  send: (data: string) => void
  close: () => void
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: (() => void) | null
}

export interface HubDeps {
  readonly mode: HubMode
  readonly venues: Readonly<Record<VenueId, VenueAdapter>>
  openSocket: (url: string) => SocketLike
  readonly fetch: typeof globalThis.fetch
  now: () => number
  random: () => number
  watchTabGone: (tab: TabId) => Promise<void>
}

interface HubInspection {
  readonly tabs: number
  readonly streams: readonly StreamKey[]
  readonly connections: Readonly<Record<VenueId, ConnState['s']>>
  readonly socketsOpened: Readonly<Record<VenueId, number>>
  readonly phases: Readonly<Record<string, BookSync['phase']>>
}

const SNAPSHOT_TIMEOUT_MS = 8_000
const FLUSH_MS = 100
const TICK_MS = 1000
const SPEC_RETRY_MS = 5000

interface MarketState {
  readonly key: MarketKey
  readonly venue: VenueId
  sync: BookSync
  readonly trades: TradeTape
  readonly candles: Map<Interval, readonly Candle[]>
  uncrossed: number
  version: number
}

interface TabState {
  readonly port: HubPort
  wants: ReadonlyMap<TopicKey, Topic>
  visible: boolean
  readonly sent: Map<TopicKey, number>
}

interface VenueState {
  readonly adapter: VenueAdapter
  conn: ConnState
  socket: SocketLike | null
  lastMessageAt: number
  opened: number
  specs: ReadonlyMap<MarketKey, MarketSpec> | null
  bySymbol: ReadonlyMap<string, MarketKey>
  specFetch: 'idle' | 'loading' | 'error'
  specRetryAt: number
}

export function createHub(deps: HubDeps): Hub {
  const tabs = new Map<TabId, TabState>()
  const markets = new Map<MarketKey, MarketState>()
  const topics = new Map<TopicKey, { frame: Frame; signature: string }>()
  const venueState = (id: VenueId): VenueState => ({
    adapter: deps.venues[id],
    conn: { s: 'idle' },
    socket: null,
    lastMessageAt: 0,
    opened: 0,
    specs: null,
    bySymbol: new Map(),
    specFetch: 'idle',
    specRetryAt: 0,
  })
  const venues = Object.fromEntries(VENUE_IDS.map((id) => [id, venueState(id)])) as Record<VenueId, VenueState>
  let lastWanted: ReadonlyMap<StreamKey, number> = new Map()
  let streams: ReadonlySet<StreamKey> = new Set()
  let messages = 0
  let framesPosted = 0
  let reconcileQueued = false
  const unreported: ExceptionEvent[] = []

  const market = (key: MarketKey): MarketState => {
    let m = markets.get(key)
    if (!m) {
      const { venue } = splitMarketKey(key)
      m = {
        key,
        venue,
        sync: initialSync(venues[venue].adapter.book.protocol).sync,
        trades: emptyTape(),
        candles: new Map(),
        uncrossed: 0,
        version: 0,
      }
      markets.set(key, m)
    }
    return m
  }

  const specOf = (key: MarketKey) => venues[splitMarketKey(key).venue].specs?.get(key) ?? null

  function statusOf(m: MarketState): FrameStatus {
    const v = venues[m.venue]
    if (v.conn.s !== 'open') return 'stale'
    return m.sync.phase === 'live' ? 'live' : 'syncing'
  }

  function project(topic: Topic, key: TopicKey): Frame | null {
    const keys = marketsFor(topic)
    const views = keys.flatMap((k) => {
      const spec = specOf(k)
      const m = markets.get(k)
      return spec && m
        ? [
            {
              spec,
              sync: m.sync,
              trades: m.trades,
              candles: m.candles,
              status: statusOf(m),
              uncrossed: m.uncrossed,
            } satisfies MarketView,
          ]
        : []
    })
    if (views.length === 0) return null
    const signature = keys
      .map((k) => `${markets.get(k)?.version ?? -1}:${markets.get(k) ? statusOf(markets.get(k)!) : ''}`)
      .join('|')
    const cached = topics.get(key)
    if (cached?.signature === signature) return cached.frame
    const version = (cached?.frame.version ?? 0) + 1
    const view = views[0]!
    let frame: Frame
    switch (topic.kind) {
      case 'book':
        frame = projectBook(key, view, topic.group, version)
        break
      case 'depth':
        frame = projectDepth(key, view, version)
        break
      case 'trades':
        frame = projectTrades(key, view, version)
        break
      case 'candle':
        frame = projectCandle(key, view, topic.interval, version)
        break
      case 'compare':
        frame = projectCompare(key, topic.base, Object.fromEntries(views.map((v) => [v.spec.venue, v])), version)
        break
    }
    topics.set(key, { frame, signature })
    return frame
  }

  function flushNow(): void {
    for (const tab of tabs.values()) {
      if (!tab.visible) continue
      const frames: Frame[] = []
      for (const [key, topic] of tab.wants) {
        const frame = project(topic, key)
        if (frame && tab.sent.get(key) !== frame.version) {
          frames.push(frame)
          tab.sent.set(key, frame.version)
        }
      }
      if (frames.length) {
        tab.port.post({ t: 'frames', frames })
        framesPosted += frames.length
      }
    }
  }

  const flush = throttle(flushNow, { wait: FLUSH_MS, leading: true, trailing: true })

  const touch = (m: MarketState) => {
    m.version++
    flush()
  }

  function followsBook(m: MarketState): boolean {
    const conn = venues[m.venue].conn
    return conn.s === 'open' && conn.subscribed.has(streamKey(m.key, 'book'))
  }

  function stopBooks(keys: readonly StreamKey[]): void {
    for (const k of keys) {
      const { market: m, channel } = parseStreamKey(k)
      if (channel === 'book') feedBook(market(m), { kind: 'reset', reason: 'stopped' })
    }
  }

  function feedBook(m: MarketState, input: BookInput): void {
    const v = venues[m.venue]
    const before = m.sync.phase
    const step = stepBook(v.adapter.book.protocol, m.sync, input)
    m.sync = step.sync
    m.uncrossed += step.uncrossed
    if (step.changed || step.sync.phase !== before) touch(m)
    if (step.effect.kind === 'fetch-snapshot') fetchSnapshot(m, step.effect.epoch)
    if (step.effect.kind === 'resubscribe')
      stepVenue(m.venue, { e: 'resubscribe', streams: [streamKey(m.key, 'book')] })
  }

  function fetchSnapshot(m: MarketState, epoch: number): void {
    const v = venues[m.venue]
    const spec = specOf(m.key)
    if (!spec || v.adapter.book.protocol !== 'rest-snapshot-sequenced') return
    const waiting = () => m.sync.phase === 'awaiting-snapshot' && m.sync.epoch === epoch
    v.adapter.book
      .fetchSnapshot(spec, deps.fetch, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS))
      .then((snap) =>
        feedBook(m, {
          kind: 'rest-snapshot',
          epoch,
          lastUpdateId: snap.lastUpdateId,
          bids: toLevels(snap.bids, spec),
          asks: toLevels(snap.asks, spec),
        }),
      )
      .catch(() => {
        if (waiting()) setTimeout(() => waiting() && feedBook(m, { kind: 'reset', reason: 'corrupt' }), 2000)
      })
  }

  function apply(e: VenueEvent, spec: MarketSpec): void {
    const m = market(e.market)
    try {
      switch (e.kind) {
        case 'book-snapshot':
          if (!followsBook(m)) return
          feedBook(m, { kind: 'snapshot', bids: toLevels(e.bids, spec), asks: toLevels(e.asks, spec), time: e.time })
          return
        case 'book-delta':
          if (!followsBook(m)) return
          feedBook(m, {
            kind: 'delta',
            bids: toLevels(e.bids, spec),
            asks: toLevels(e.asks, spec),
            seq: e.seq,
            time: e.time,
          })
          return
        case 'trades':
          if (pushTrades(m.trades, toTrades(e.trades, spec))) touch(m)
          return
        case 'candle': {
          let bars = m.candles.get(e.interval) ?? []
          for (const c of e.candles) bars = upsertCandle(bars, toCandle(c, spec))
          m.candles.set(e.interval, bars)
          touch(m)
          return
        }
      }
    } catch (error) {
      if (!(error instanceof DecimalError)) throw error
      if (e.kind === 'book-snapshot' || e.kind === 'book-delta') feedBook(m, { kind: 'reset', reason: 'corrupt' })
    }
  }

  function ingest(venue: VenueId, raw: string): void {
    const v = venues[venue]
    messages++
    v.lastMessageAt = deps.now()
    let events: readonly VenueEvent[]
    try {
      events = v.adapter.parse(raw, (symbol) => v.bySymbol.get(symbol) ?? null)
    } catch (error) {
      if (error instanceof VenueParseError && error.market)
        feedBook(market(error.market), { kind: 'reset', reason: 'corrupt' })
      return
    }
    for (const e of events) {
      const spec = specOf(e.market)
      if (spec) apply(e, spec)
    }
  }

  function targets(venue: VenueId, keys: readonly StreamKey[]): StreamTarget[] {
    return keys.flatMap((k) => {
      const { market: m, channel, interval } = parseStreamKey(k)
      const spec = venues[venue].specs?.get(m)
      return spec ? [{ spec, channel, interval }] : []
    })
  }

  function run(venue: VenueId, effect: ConnEffect): void {
    const v = venues[venue]
    switch (effect.fx) {
      case 'open': {
        const socket = deps.openSocket(v.adapter.url)
        v.socket = socket
        v.opened++
        socket.onopen = () => v.socket === socket && stepVenue(venue, { e: 'opened' })
        socket.onmessage = (data) => v.socket === socket && ingest(venue, data)
        socket.onclose = () => {
          if (v.socket !== socket) return
          v.socket = null
          stepVenue(venue, { e: 'closed' })
        }
        return
      }
      case 'close': {
        const socket = v.socket
        v.socket = null
        socket?.close()
        for (const m of markets.values()) if (m.venue === venue) feedBook(m, { kind: 'reset', reason: 'stopped' })
        return
      }
      case 'subscribe':
        for (const frame of v.adapter.subscribeFrames(targets(venue, effect.streams))) v.socket?.send(frame)
        return
      case 'unsubscribe':
        for (const frame of v.adapter.unsubscribeFrames(targets(venue, effect.streams))) v.socket?.send(frame)
        stopBooks(effect.streams)
        return
      case 'keepalive':
        if (v.adapter.keepalive) v.socket?.send(v.adapter.keepalive.frame)
        return
      case 'streams-reset':
        for (const k of effect.streams) {
          const { market: m, channel } = parseStreamKey(k)
          if (channel === 'book') feedBook(market(m), { kind: 'reset', reason: 'subscribed' })
        }
        return
      case 'streams-stale':
        stopBooks(effect.streams)
        for (const k of effect.streams) touch(market(parseStreamKey(k).market))
        return
    }
  }

  function desiredFor(venue: VenueId): ReadonlySet<StreamKey> {
    const v = venues[venue]
    return new Set([...streams].filter((k) => v.specs?.has(parseStreamKey(k).market)))
  }

  function stepVenue(venue: VenueId, event: ConnEvent): void {
    const v = venues[venue]
    const now = deps.now()
    const before = v.conn.s
    const { state, effects } = stepConnection(
      v.conn,
      event,
      { desired: desiredFor(venue), now, lastMessageAt: v.lastMessageAt, rand: deps.random() },
      {
        silenceMs: v.adapter.silenceMs,
        keepaliveMs: v.adapter.keepalive?.everyMs ?? null,
      },
    )
    v.conn = state
    if (state.s === 'open' && event.e === 'opened') v.lastMessageAt = now
    for (const effect of effects) run(venue, effect)
    if (before !== state.s) for (const m of markets.values()) if (m.venue === venue) touch(m)
  }

  function ensureSpecs(venue: VenueId): void {
    const v = venues[venue]
    if (v.specs || v.specFetch === 'loading' || deps.now() < v.specRetryAt) return
    v.specFetch = 'loading'
    v.adapter
      .fetchSpecs(deps.fetch)
      .then((specs) => {
        v.specs = new Map([...specs.values()].map((s) => [s.key, s]))
        v.bySymbol = new Map([...specs.values()].map((s) => [s.venueSymbol, s.key]))
        v.specFetch = 'idle'
        reconcile()
      })
      .catch(() => {
        v.specFetch = 'error'
        v.specRetryAt = deps.now() + SPEC_RETRY_MS
        flush()
      })
  }

  function reconcile(): void {
    const derived = deriveStreams(
      [...tabs.values()].map((t) => t.wants),
      lastWanted,
      deps.now(),
    )
    streams = derived.streams
    lastWanted = derived.lastWanted
    for (const key of topics.keys()) if (![...tabs.values()].some((t) => t.wants.has(key))) topics.delete(key)
    for (const venue of VENUE_IDS) {
      if ([...streams].some((k) => k.startsWith(`${venue}:`))) ensureSpecs(venue)
      stepVenue(venue, { e: 'tick' })
    }
    flush()
  }

  function queueReconcile(): void {
    if (reconcileQueued) return
    reconcileQueued = true
    queueMicrotask(() => {
      reconcileQueued = false
      reconcile()
    })
  }

  function dropTab(id: TabId): void {
    const tab = tabs.get(id)
    if (!tab) return
    tabs.delete(id)
    tab.port.close()
    queueReconcile()
  }

  function sendReports(): void {
    const tab = [...tabs.values()].find((t) => t.visible) ?? tabs.values().next().value
    if (!tab) return
    for (const event of unreported.splice(0)) tab.port.post({ t: 'exception', event })
  }

  let lastMessages = 0
  let lastFrames = 0
  const timer = setInterval(() => {
    reconcile()
    const stats: HubStats = {
      mode: deps.mode,
      tabs: tabs.size,
      sockets: VENUE_IDS.filter((id) => venues[id].conn.s === 'open').length,
      streams: streams.size,
      messagesPerSecond: messages - lastMessages,
      framesPerSecond: framesPosted - lastFrames,
    }
    lastMessages = messages
    lastFrames = framesPosted
    for (const tab of tabs.values()) if (tab.visible) tab.port.post({ t: 'stats', stats })
  }, TICK_MS)

  return {
    connect(port) {
      let id: TabId | null = null
      port.listen((data) => {
        const msg = parseTabMessage(data)
        if (!msg) return
        if (msg.t === 'hello') {
          if (id) return
          id = msg.tab
          const tab = id
          tabs.set(tab, { port, wants: new Map(), visible: msg.visible, sent: new Map() })
          void deps.watchTabGone(tab).then(() => dropTab(tab))
          sendReports()
          return
        }
        const tab = id ? tabs.get(id) : undefined
        if (!tab || !id) return
        switch (msg.t) {
          case 'want': {
            tab.wants = new Map(msg.topics.map((t) => [topicKey(t), t]))
            for (const key of tab.sent.keys()) if (!tab.wants.has(key)) tab.sent.delete(key)
            queueReconcile()
            return
          }
          case 'visible':
            tab.visible = msg.visible
            if (msg.visible) tab.sent.clear()
            flush()
            return
          case 'bye':
            dropTab(id)
            return
        }
      })
    },
    report(event) {
      unreported.push(event)
      sendReports()
    },
    inspect() {
      return {
        tabs: tabs.size,
        streams: [...streams],
        connections: Object.fromEntries(VENUE_IDS.map((id) => [id, venues[id].conn.s])) as Record<
          VenueId,
          ConnState['s']
        >,
        socketsOpened: Object.fromEntries(VENUE_IDS.map((id) => [id, venues[id].opened])) as Record<VenueId, number>,
        phases: Object.fromEntries([...markets.values()].map((m) => [m.key, m.sync.phase])),
      }
    },
    dispose() {
      clearInterval(timer)
      for (const id of VENUE_IDS) venues[id].socket?.close()
    },
  }
}
