import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Base, TabId } from '@tape/core/ids'
import { marketKey } from '@tape/core/ids'
import { recordedFetch, wsFrames } from '@tape/venues/fixtures'
import { venues } from '@tape/venues/index'
import type { HubToTab, TabToHub } from '#/core/protocol'
import type { BookFrame, DepthFrame, Frame, Topic } from '#/core/topics'
import type { ExceptionEvent } from '#/analytics/exception'
import { createHub } from './hub'
import type { Hub, SocketLike } from './hub'

const VENUES = venues('mainnet')

interface FakeSocket extends SocketLike {
  readonly url: string
  readonly sent: string[]
  closed: boolean
}

function setup({ openAtOnce = true, fetch = recordedFetch } = {}) {
  const sockets: FakeSocket[] = []
  const gone = new Map<TabId, () => void>()
  const hub = createHub({
    mode: 'shared',
    venues: VENUES,
    fetch,
    now: () => Date.now(),
    random: () => 0.5,
    watchTabGone: (id) => new Promise<void>((resolve) => gone.set(id, resolve)),
    openSocket(url) {
      const socket: FakeSocket = {
        url,
        sent: [],
        closed: false,
        onopen: null,
        onmessage: null,
        onclose: null,
        send(data) {
          this.sent.push(data)
        },
        close() {
          this.closed = true
        },
      }
      sockets.push(socket)
      if (openAtOnce) queueMicrotask(() => socket.onopen?.())
      return socket
    },
  })
  return { hub, sockets, gone }
}

function openTab(hub: Hub, id: string, visible = true) {
  const frames = new Map<string, Frame>()
  const posted: Frame[] = []
  const exceptions: ExceptionEvent[] = []
  let deliver: (data: unknown) => void = () => {}
  hub.connect({
    post: (message: HubToTab) => {
      if (message.t === 'frames')
        for (const frame of structuredClone(message.frames)) {
          frames.set(frame.key, frame)
          posted.push(frame)
        }
      if (message.t === 'exception') exceptions.push(structuredClone(message.event))
    },
    listen: (fn) => (deliver = fn),
    close: () => {},
  })
  const send = (message: TabToHub) => deliver(structuredClone(message))
  send({ t: 'hello', tab: id as TabId, visible })
  return { frames, posted, exceptions, want: (topics: Topic[]) => send({ t: 'want', topics }), send }
}

function replay(sockets: FakeSocket[]) {
  for (const socket of sockets.filter((candidate) => !candidate.closed)) {
    const venue = Object.values(VENUES).find((adapter) => adapter.url === socket.url)!.id
    for (const raw of wsFrames(venue)) socket.onmessage?.(raw)
  }
}

const btc = (venue: 'binance' | 'hyperliquid' | 'dydx') => marketKey(venue, 'BTC' as Base)

const hyperliquidBook = (coin: 'BTC' | 'ETH') =>
  wsFrames('hyperliquid')
    .find((raw) => raw.includes('"l2Book"') && raw.includes('"levels"'))!
    .replaceAll('"coin":"BTC"', `"coin":"${coin}"`)
    .replace(/"sz":"[0-9.]+"/g, '"sz":"1.0"')
const dydxBook = wsFrames('dydx').find((raw) => raw.includes('"subscribed"') && raw.includes('v4_orderbook'))!
const dydxCorrupt = wsFrames('dydx')
  .find((raw) => raw.includes('channel_data') && raw.includes('v4_orderbook'))!
  .replace(/\["\d+"/, '["8x"')
const binanceDiffWithoutBids = wsFrames('binance')
  .find((raw) => raw.includes('depthUpdate'))!
  .replace('"b":[', '"bids":[')
const bookTopic = (market: ReturnType<typeof btc>) => ({ kind: 'book', market, group: '1' }) as const
const liveSince = (posted: readonly Frame[], from: number) =>
  posted.slice(from).filter((frame) => frame.kind === 'book' && frame.status === 'live')

describe('hub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('serves two tabs from one socket per venue and sends render-ready books', async () => {
    const { hub, sockets } = setup()
    const first = openTab(hub, 'a')
    const second = openTab(hub, 'b')
    first.want([
      { kind: 'book', market: btc('binance'), group: '1' },
      { kind: 'book', market: btc('binance'), group: '100' },
      { kind: 'trades', market: btc('dydx') },
    ])
    second.want([
      { kind: 'book', market: btc('binance'), group: '1' },
      { kind: 'compare', base: 'BTC' as Base },
    ])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    expect(sockets.map((socket) => socket.url).sort()).toEqual(
      Object.values(VENUES)
        .map((adapter) => adapter.url)
        .sort(),
    )
    const book = first.frames.get(`book|${btc('binance')}|1`) as BookFrame
    expect(book.status).toBe('live')
    expect(book.bids).toHaveLength(14)
    expect(book.bids.every((row) => row.px !== '')).toBe(true)
    expect(Number(book.bids[0]!.px.replaceAll(',', ''))).toBeLessThan(Number(book.asks[0]!.px.replaceAll(',', '')))
    expect(second.frames.get(`book|${btc('binance')}|1`)).toEqual(book)
    const compare = second.frames.get('compare|BTC')
    expect(compare?.kind === 'compare' && compare.rows.filter((row) => row.bid !== '').length).toBe(4)
    hub.dispose()
  })

  it("opens every venue's book without reading the venue's market list", async () => {
    const lists = /\/perpetualMarkets$|\/public\/info$|exchangeInfo\?permissions=/
    const { hub, sockets } = setup({
      fetch: (input, init) =>
        lists.test(input instanceof Request ? input.url : input.toString())
        || /"type":"(?:allPerpMetas|perpDexs)"/.test(typeof init?.body === 'string' ? init.body : '')
          ? Promise.reject(new Error('no list'))
          : recordedFetch(input, init),
    })
    const tab = openTab(hub, 'a')
    tab.want([{ kind: 'compare', base: 'BTC' as Base }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    const compare = tab.frames.get('compare|BTC')
    expect(compare?.kind === 'compare' && compare.rows.map((row) => row.status)).toEqual([
      'live',
      'live',
      'live',
      'live',
    ])
    hub.dispose()
  })

  it('marks the venues that do not list a market as unlisted in the venues table', async () => {
    const { hub } = setup()
    const tab = openTab(hub, 'a')
    tab.want([{ kind: 'compare', base: 'kPEPE' as Base }])
    await vi.advanceTimersByTimeAsync(1500)

    const compare = tab.frames.get('compare|kPEPE')
    const rows = compare?.kind === 'compare' ? compare.rows : []
    expect(Object.fromEntries(rows.map((row) => [row.venue, row.status === 'unlisted']))).toEqual({
      binance: true,
      hyperliquid: false,
      dydx: true,
      orderly: true,
    })
    hub.dispose()
  })

  it('sends the exact touch in a book grouped wider than the spread', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([
      { kind: 'book', market: btc('binance'), group: '100' },
      { kind: 'compare', base: 'BTC' as Base },
    ])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    const wide = tab.frames.get(`book|${btc('binance')}|100`) as BookFrame
    const compare = tab.frames.get('compare|BTC')
    const venue = compare?.kind === 'compare' ? compare.rows.find((row) => row.venue === 'binance') : undefined
    expect(wide.touch.bid).not.toBe('')
    expect(wide.touch).toEqual({ bid: venue?.bid, ask: venue?.ask })
    hub.dispose()
  })

  it('sends depth as prices and running totals from the mid outward', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([{ kind: 'depth', market: btc('binance') }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    const depth = tab.frames.get(`depth|${btc('binance')}`) as DepthFrame
    for (const [side, away] of [
      [depth.bids, -1],
      [depth.asks, 1],
    ] as const) {
      expect(side.px.length).toBeGreaterThan(1)
      expect(side.cum).toHaveLength(side.px.length)
      expect((side.px[0]! - depth.mid) * away).toBeGreaterThan(0)
      for (let index = 1; index < side.px.length; index++) {
        expect((side.px[index]! - side.px[index - 1]!) * away).toBeGreaterThan(0)
        expect(side.cum[index]!).toBeGreaterThan(side.cum[index - 1]!)
      }
    }
    hub.dispose()
  })

  it('unsubscribes a stream only after its last tab dies and the linger passes', async () => {
    const { hub, sockets, gone } = setup()
    const first = openTab(hub, 'a')
    const second = openTab(hub, 'b')
    first.want([{ kind: 'trades', market: btc('hyperliquid') }])
    second.want([
      { kind: 'trades', market: btc('hyperliquid') },
      { kind: 'book', market: btc('hyperliquid'), group: '1' },
    ])
    await vi.advanceTimersByTimeAsync(1100)
    const socket = sockets[0]!
    gone.get('b' as TabId)!()
    await vi.advanceTimersByTimeAsync(2000)
    expect(socket.sent.some((message) => message.includes('unsubscribe'))).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    const unsubs = socket.sent.filter((message) => message.includes('unsubscribe'))
    expect(unsubs).toEqual([
      '{"method":"unsubscribe","subscription":{"type":"l2Book","coin":"BTC"}}',
      '{"method":"unsubscribe","subscription":{"type":"l2Book","coin":"BTC","fast":true}}',
    ])
    expect(hub.inspect().tabs).toBe(1)
    hub.dispose()
  })

  it('reconnects a dropped socket, resubscribes and resyncs the Binance book', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([{ kind: 'book', market: btc('binance'), group: '1' }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(200)
    expect(hub.inspect().phases[btc('binance')]).toBe('live')

    sockets[0]!.closed = true
    sockets[0]!.onclose?.()
    await vi.advanceTimersByTimeAsync(300)
    expect((tab.frames.get(`book|${btc('binance')}|1`) as BookFrame).status).toBe('stale')

    await vi.advanceTimersByTimeAsync(3000)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]!.sent.join()).toContain('btcusdt@depth@100ms')
    replay(sockets)
    await vi.advanceTimersByTimeAsync(200)
    expect((tab.frames.get(`book|${btc('binance')}|1`) as BookFrame).status).toBe('live')
    hub.dispose()
  })

  it('resyncs a Binance book after a diff that comes without its bids', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([bookTopic(btc('binance'))])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(200)
    expect(hub.inspect().phases[btc('binance')]).toBe('live')

    sockets.find((socket) => socket.url.includes('binance'))!.onmessage!(binanceDiffWithoutBids)
    expect(hub.inspect().phases[btc('binance')]).toBe('awaiting-snapshot')
    replay(sockets)
    await vi.advanceTimersByTimeAsync(200)
    expect((tab.frames.get(`book|${btc('binance')}|1`) as BookFrame).status).toBe('live')
    hub.dispose()
  })

  it('marks the venue comparison stale once every venue socket drops', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([{ kind: 'compare', base: 'BTC' as Base }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)
    expect(tab.frames.get('compare|BTC')?.status).toBe('live')

    sockets[0]!.closed = true
    sockets[0]!.onclose?.()
    await vi.advanceTimersByTimeAsync(300)
    expect(tab.frames.get('compare|BTC')?.status).toBe('live')

    for (const socket of sockets.slice(1)) {
      socket.closed = true
      socket.onclose?.()
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(tab.frames.get('compare|BTC')?.status).toBe('stale')
    hub.dispose()
  })

  it('stops sending frames to a hidden tab and catches it up when it returns', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([{ kind: 'book', market: btc('hyperliquid'), group: '1' }])
    tab.send({ t: 'visible', visible: false })
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(500)
    expect(tab.frames.size).toBe(0)
    tab.send({ t: 'visible', visible: true })
    await vi.advanceTimersByTimeAsync(200)
    expect(tab.frames.size).toBe(1)
    hub.dispose()
  })

  it('sends nothing to a tab that opens in the background', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a', false)
    tab.want([{ kind: 'book', market: btc('hyperliquid'), group: '1' }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(500)
    expect(tab.frames.size).toBe(0)
    hub.dispose()
  })

  it('posts no pre-drop book as live while a new socket resets its books', async () => {
    const { hub, sockets } = setup({ openAtOnce: false })
    const tab = openTab(hub, 'a')
    const eth = marketKey('hyperliquid', 'ETH' as Base)
    tab.want([bookTopic(eth), bookTopic(btc('hyperliquid'))])
    await vi.advanceTimersByTimeAsync(1100)
    sockets[0]!.onopen!()
    sockets[0]!.onmessage!(hyperliquidBook('BTC'))
    sockets[0]!.onmessage!(hyperliquidBook('ETH'))
    await vi.advanceTimersByTimeAsync(300)
    expect(hub.inspect().phases).toMatchObject({ [eth]: 'live', [btc('hyperliquid')]: 'live' })

    sockets[0]!.onclose!()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(150)
    const from = tab.posted.length
    sockets[1]!.onopen!()
    await vi.advanceTimersByTimeAsync(300)
    expect(liveSince(tab.posted, from)).toEqual([])
    hub.dispose()
  })

  it('dates a frame by when its market was last live, also for a tab that wants it after the drop', async () => {
    const { hub, sockets } = setup({ openAtOnce: false })
    const first = openTab(hub, 'a')
    const topic = bookTopic(btc('hyperliquid'))
    const key = `book|${btc('hyperliquid')}|1`
    first.want([topic])
    await vi.advanceTimersByTimeAsync(1100)
    sockets[0]!.onopen!()
    await vi.advanceTimersByTimeAsync(300)
    expect(first.frames.get(key)?.liveAt ?? null).toBeNull()
    const live = Date.now()
    sockets[0]!.onmessage!(hyperliquidBook('BTC'))
    await vi.advanceTimersByTimeAsync(300)
    expect(first.frames.get(key)).toMatchObject({ status: 'live', liveAt: live })

    sockets[0]!.onclose!()
    await vi.advanceTimersByTimeAsync(20_000)
    const second = openTab(hub, 'b')
    second.want([topic])
    await vi.advanceTimersByTimeAsync(300)
    expect(second.frames.get(key)).toMatchObject({ status: 'stale', liveAt: live })
    hub.dispose()
  })

  it('keeps a dYdX book off live when its snapshot lands after a held resubscribe', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([bookTopic(btc('dydx'))])
    await vi.advanceTimersByTimeAsync(1100)
    const socket = sockets.find((candidate) => candidate.url.includes('dydx'))!
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(200)
    socket.onmessage!(dydxCorrupt)
    socket.onmessage!(dydxCorrupt)
    expect(socket.sent.at(-1)).toContain('unsubscribe')
    const from = tab.posted.length
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(1000)
    expect(liveSince(tab.posted, from)).toEqual([])
    hub.dispose()
  })

  it('keeps a dYdX book off live when a tab wants it back during its hold', async () => {
    const { hub, sockets } = setup()
    const tab = openTab(hub, 'a')
    tab.want([bookTopic(btc('dydx'))])
    await vi.advanceTimersByTimeAsync(1100)
    const socket = sockets.find((candidate) => candidate.url.includes('dydx'))!
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(200)
    tab.want([bookTopic(marketKey('dydx', 'ETH' as Base))])
    await vi.advanceTimersByTimeAsync(9000)
    socket.onmessage!(dydxCorrupt)
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(1200)
    expect(socket.sent.at(-1)).toContain('unsubscribe')
    const from = tab.posted.length
    tab.want([bookTopic(btc('dydx'))])
    await vi.advanceTimersByTimeAsync(500)
    expect(liveSince(tab.posted, from)).toEqual([])
    hub.dispose()
  })

  it('hands each worker error to one tab, and holds it until a tab says hello', async () => {
    const { hub } = setup()
    const error = (value: string): ExceptionEvent => ({
      event: '$exception',
      type: 'TypeError',
      value,
      handled: false,
      source: 'hub',
      frames: [{ file: 'https://tape.kegler.dev/assets/worker-abc.js', fn: 'apply', line: 1, col: 10 }],
    })
    hub.report(error('before any tab'))
    const hidden = openTab(hub, 'a', false)
    const visible = openTab(hub, 'b')
    hub.report(error('with two tabs'))
    await vi.advanceTimersByTimeAsync(50)
    expect(hidden.exceptions.map((exception) => exception.value)).toEqual(['before any tab'])
    expect(visible.exceptions.map((exception) => exception.value)).toEqual(['with two tabs'])
    hub.dispose()
  })
})
