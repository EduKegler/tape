import { throttle } from '@tanstack/pacer'
import { initialSync, stepBook } from '@tape/core/book'
import type { BookInput, BookSync } from '@tape/core/book'
import { DecimalError } from '@tape/core/fixed'
import { VENUE_IDS, parseStreamKey, splitMarketKey, streamKey } from '@tape/core/ids'
import type { Interval, MarketKey, StreamKey, TabId, VenueId } from '@tape/core/ids'
import { emptyTape, pushTrades, upsertCandle } from '@tape/core/market'
import type { Candle, MarketSpec, TradeTape } from '@tape/core/market'
import { fromKeys } from '@tape/core/record'
import { toCandle, toLevels, toTrades } from '@tape/venues/normalize'
import { VenueParseError } from '@tape/venues/types'
import type { StreamTarget, VenueAdapter, VenueEvent } from '@tape/venues/types'
import { projectBook, projectCandle, projectCompare, projectDepth, projectTrades } from '#/core/project'
import type { MarketView } from '#/core/project'
import { parseTabMessage } from '#/core/protocol'
import type { HubMode, HubStats, HubToTab } from '#/core/protocol'
import { deriveStreams, marketsFor, topicKey } from '#/core/topics'
import type { Frame, FrameStatus, Topic, TopicKey } from '#/core/topics'
import type { ExceptionEvent } from '#/analytics/exception'
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
  version: number
  liveAt: number | null
}

interface TabState {
  readonly port: HubPort
  wants: ReadonlyMap<TopicKey, Topic>
  visible: boolean
  readonly sent: Map<TopicKey, number>
}

type NotShown = null
type RetryAt = number

interface VenueState {
  readonly adapter: VenueAdapter
  conn: ConnState
  socket: SocketLike | null
  lastMessageAt: number
  opened: number
  readonly specs: Map<MarketKey, MarketSpec | NotShown>
  readonly bySymbol: Map<string, MarketKey>
  readonly specReads: Map<MarketKey, 'loading' | RetryAt>
}

export function createHub(deps: HubDeps): Hub {
  const tabs = new Map<TabId, TabState>()
  const markets = new Map<MarketKey, MarketState>()
  const topics = new Map<TopicKey, { frame: Frame; signature: string }>()
  const initialVenue = (id: VenueId): VenueState => ({
    adapter: deps.venues[id],
    conn: { s: 'idle' },
    socket: null,
    lastMessageAt: 0,
    opened: 0,
    specs: new Map(),
    bySymbol: new Map(),
    specReads: new Map(),
  })
  const venues = fromKeys(VENUE_IDS, initialVenue)
  let lastWanted: ReadonlyMap<StreamKey, number> = new Map()
  let streams: ReadonlySet<StreamKey> = new Set()
  let messages = 0
  let framesPosted = 0
  let reconcileQueued = false
  const unreported: ExceptionEvent[] = []

  const market = (key: MarketKey): MarketState => {
    let state = markets.get(key)
    if (!state) {
      const { venue } = splitMarketKey(key)
      state = {
        key,
        venue,
        sync: initialSync(venues[venue].adapter.book.protocol).sync,
        trades: emptyTape(),
        candles: new Map(),
        version: 0,
        liveAt: null,
      }
      markets.set(key, state)
    }
    return state
  }

  const specOf = (key: MarketKey) => venues[splitMarketKey(key).venue].specs.get(key) ?? null
  const unlisted = (key: MarketKey) => venues[splitMarketKey(key).venue].specs.get(key) === null

  function statusOf(state: MarketState): FrameStatus {
    const venueState = venues[state.venue]
    if (venueState.conn.s !== 'open') return 'stale'
    return state.sync.phase === 'live' ? 'live' : 'syncing'
  }

  function project(topic: Topic, key: TopicKey): Frame | null {
    const keys = marketsFor(topic)
    const views = keys.flatMap((marketKey) => {
      const spec = specOf(marketKey)
      const state = markets.get(marketKey)
      return spec && state
        ? [
            {
              spec,
              sync: state.sync,
              trades: state.trades,
              candles: state.candles,
              status: statusOf(state),
              liveAt: state.liveAt,
            } satisfies MarketView,
          ]
        : []
    })
    const missing = keys.filter(unlisted)
    if (views.length === 0 && (topic.kind !== 'compare' || missing.length === 0)) return null
    const signature = keys
      .map(
        (marketKey) =>
          `${markets.get(marketKey)?.version ?? -1}:${markets.get(marketKey) ? statusOf(markets.get(marketKey)!) : unlisted(marketKey)}`,
      )
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
        frame = projectCompare(
          key,
          Object.fromEntries(views.map((marketView) => [marketView.spec.venue, marketView])),
          new Set(missing.map((marketKey) => splitMarketKey(marketKey).venue)),
          version,
        )
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

  const touch = (state: MarketState) => {
    state.version++
    if (statusOf(state) === 'live') state.liveAt = deps.now()
    flush()
  }

  function followsBook(state: MarketState): boolean {
    const conn = venues[state.venue].conn
    return conn.s === 'open' && conn.subscribed.has(streamKey(state.key, 'book'))
  }

  function stopBooks(keys: readonly StreamKey[]): void {
    for (const stream of keys) {
      const { market: marketKey, channel } = parseStreamKey(stream)
      if (channel === 'book') feedBook(market(marketKey), { kind: 'reset', reason: 'stopped' })
    }
  }

  function feedBook(state: MarketState, input: BookInput): void {
    const venueState = venues[state.venue]
    const before = state.sync.phase
    const step = stepBook(venueState.adapter.book.protocol, state.sync, input)
    state.sync = step.sync
    if (step.changed || step.sync.phase !== before) touch(state)
    if (step.effect.kind === 'fetch-snapshot') fetchSnapshot(state, step.effect.epoch)
    if (step.effect.kind === 'resubscribe')
      stepVenue(state.venue, { e: 'resubscribe', streams: [streamKey(state.key, 'book')] })
  }

  function fetchSnapshot(state: MarketState, epoch: number): void {
    const venueState = venues[state.venue]
    const spec = specOf(state.key)
    if (!spec || venueState.adapter.book.protocol !== 'rest-snapshot-sequenced') return
    const waiting = () => state.sync.phase === 'awaiting-snapshot' && state.sync.epoch === epoch
    venueState.adapter.book
      .fetchSnapshot(spec, deps.fetch, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS))
      .then((snap) =>
        feedBook(state, {
          kind: 'rest-snapshot',
          epoch,
          lastUpdateId: snap.lastUpdateId,
          bids: toLevels(snap.bids, spec),
          asks: toLevels(snap.asks, spec),
        }),
      )
      .catch(() => {
        if (waiting()) setTimeout(() => waiting() && feedBook(state, { kind: 'reset', reason: 'corrupt' }), 2000)
      })
  }

  function apply(event: VenueEvent, spec: MarketSpec): void {
    const state = market(event.market)
    try {
      switch (event.kind) {
        case 'book-snapshot':
          if (!followsBook(state)) return
          feedBook(state, {
            kind: 'snapshot',
            bids: toLevels(event.bids, spec),
            asks: toLevels(event.asks, spec),
            time: event.time,
          })
          return
        case 'book-delta':
          if (!followsBook(state)) return
          feedBook(state, {
            kind: 'delta',
            bids: toLevels(event.bids, spec),
            asks: toLevels(event.asks, spec),
            seq: event.seq,
            time: event.time,
          })
          return
        case 'trades':
          if (pushTrades(state.trades, toTrades(event.trades, spec))) touch(state)
          return
        case 'candle': {
          let bars = state.candles.get(event.interval) ?? []
          for (const candle of event.candles) bars = upsertCandle(bars, toCandle(candle, spec))
          state.candles.set(event.interval, bars)
          touch(state)
          return
        }
      }
    } catch (error) {
      if (!(error instanceof DecimalError)) throw error
      if (event.kind === 'book-snapshot' || event.kind === 'book-delta')
        feedBook(state, { kind: 'reset', reason: 'corrupt' })
    }
  }

  function ingest(venue: VenueId, raw: string): void {
    const venueState = venues[venue]
    messages++
    venueState.lastMessageAt = deps.now()
    let events: readonly VenueEvent[]
    try {
      events = venueState.adapter.parse(raw, (symbol) => venueState.bySymbol.get(symbol) ?? null)
    } catch (error) {
      if (error instanceof VenueParseError && error.market)
        feedBook(market(error.market), { kind: 'reset', reason: 'corrupt' })
      return
    }
    for (const event of events) {
      const spec = specOf(event.market)
      if (spec) apply(event, spec)
    }
  }

  function targets(venue: VenueId, keys: readonly StreamKey[]): StreamTarget[] {
    return keys.flatMap((stream) => {
      const { market: marketKey, channel, interval } = parseStreamKey(stream)
      const spec = venues[venue].specs.get(marketKey)
      return spec ? [{ spec, channel, interval }] : []
    })
  }

  function run(venue: VenueId, effect: ConnEffect): void {
    const venueState = venues[venue]
    switch (effect.fx) {
      case 'open': {
        const socket = deps.openSocket(venueState.adapter.url)
        venueState.socket = socket
        venueState.opened++
        socket.onopen = () => venueState.socket === socket && stepVenue(venue, { e: 'opened' })
        socket.onmessage = (data) => venueState.socket === socket && ingest(venue, data)
        socket.onclose = () => {
          if (venueState.socket !== socket) return
          venueState.socket = null
          stepVenue(venue, { e: 'closed' })
        }
        return
      }
      case 'close': {
        const socket = venueState.socket
        venueState.socket = null
        socket?.close()
        for (const state of markets.values())
          if (state.venue === venue) feedBook(state, { kind: 'reset', reason: 'stopped' })
        return
      }
      case 'subscribe':
        for (const frame of venueState.adapter.subscribeFrames(targets(venue, effect.streams)))
          venueState.socket?.send(frame)
        return
      case 'unsubscribe':
        for (const frame of venueState.adapter.unsubscribeFrames(targets(venue, effect.streams)))
          venueState.socket?.send(frame)
        stopBooks(effect.streams)
        return
      case 'keepalive':
        if (venueState.adapter.keepalive) venueState.socket?.send(venueState.adapter.keepalive.frame)
        return
      case 'streams-stale':
        stopBooks(effect.streams)
        for (const stream of effect.streams) touch(market(parseStreamKey(stream).market))
        return
    }
  }

  function desiredFor(venue: VenueId): ReadonlySet<StreamKey> {
    const venueState = venues[venue]
    return new Set([...streams].filter((stream) => venueState.specs.get(parseStreamKey(stream).market)))
  }

  function stepVenue(venue: VenueId, event: ConnEvent): void {
    const venueState = venues[venue]
    const now = deps.now()
    const before = venueState.conn.s
    const { state, effects } = stepConnection(
      venueState.conn,
      event,
      { desired: desiredFor(venue), now, lastMessageAt: venueState.lastMessageAt, rand: deps.random() },
      {
        silenceMs: venueState.adapter.silenceMs,
        keepaliveMs: venueState.adapter.keepalive?.everyMs ?? null,
      },
    )
    venueState.conn = state
    if (state.s === 'open' && event.e === 'opened') venueState.lastMessageAt = now
    for (const effect of effects) run(venue, effect)
    if (before !== state.s)
      for (const marketState of markets.values()) if (marketState.venue === venue) touch(marketState)
  }

  function ensureSpec(key: MarketKey): void {
    const { venue, base } = splitMarketKey(key)
    const venueState = venues[venue]
    const read = venueState.specReads.get(key)
    if (venueState.specs.has(key) || read === 'loading' || deps.now() < (read ?? 0)) return
    venueState.specReads.set(key, 'loading')
    venueState.adapter
      .fetchMarket(base, deps.fetch)
      .then((spec) => {
        venueState.specs.set(key, spec)
        if (spec) venueState.bySymbol.set(spec.venueSymbol, key)
        venueState.specReads.delete(key)
        reconcile()
      })
      .catch(() => {
        venueState.specReads.set(key, deps.now() + SPEC_RETRY_MS)
        flush()
      })
  }

  function reconcile(): void {
    const derived = deriveStreams(
      [...tabs.values()].map((tab) => tab.wants),
      lastWanted,
      deps.now(),
    )
    streams = derived.streams
    lastWanted = derived.lastWanted
    for (const key of topics.keys()) if (![...tabs.values()].some((tab) => tab.wants.has(key))) topics.delete(key)
    for (const stream of streams) ensureSpec(parseStreamKey(stream).market)
    for (const venue of VENUE_IDS) stepVenue(venue, { e: 'tick' })
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
    const tab = [...tabs.values()].find((candidate) => candidate.visible) ?? tabs.values().next().value
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
            tab.wants = new Map(msg.topics.map((topic) => [topicKey(topic), topic]))
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
        connections: fromKeys(VENUE_IDS, (id) => venues[id].conn.s),
        socketsOpened: fromKeys(VENUE_IDS, (id) => venues[id].opened),
        phases: Object.fromEntries([...markets.values()].map((state) => [state.key, state.sync.phase])),
      }
    },
    dispose() {
      clearInterval(timer)
      for (const id of VENUE_IDS) venues[id].socket?.close()
    },
  }
}
