import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@tape/core/ids'
import { marketKey } from '@tape/core/ids'
import type { HubToTab, TabToHub } from '#/core/protocol'
import type { BookFrame, DepthFrame, Frame, Topic } from '#/core/topics'
import { recordedFetch, wsFrames } from '@tape/venues/fixtures'
import { venues } from '@tape/venues/index'
import { createHub } from './hub'
import type { Hub, SocketLike } from './hub'

const VENUES = venues('mainnet')

interface FakeSocket extends SocketLike {
  readonly url: string
  readonly sent: string[]
  closed: boolean
}

function setup({ openAtOnce = true } = {}) {
  const sockets: FakeSocket[] = []
  const gone = new Map<TabId, () => void>()
  const hub = createHub({
    mode: 'shared',
    venues: VENUES,
    fetch: recordedFetch,
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

function tab(hub: Hub, id: string, visible = true) {
  const frames = new Map<string, Frame>()
  const posted: Frame[] = []
  let deliver: (data: unknown) => void = () => {}
  hub.connect({
    post: (m: HubToTab) => {
      if (m.t !== 'frames') return
      for (const f of structuredClone(m.frames)) {
        frames.set(f.key, f)
        posted.push(f)
      }
    },
    listen: (fn) => (deliver = fn),
    close: () => {},
  })
  const send = (m: TabToHub) => deliver(structuredClone(m))
  send({ t: 'hello', tab: id as TabId, visible })
  return { frames, posted, want: (topics: Topic[]) => send({ t: 'want', topics }), send }
}

function replay(sockets: FakeSocket[]) {
  for (const s of sockets.filter((x) => !x.closed)) {
    const venue = Object.values(VENUES).find((v) => v.url === s.url)!.id
    for (const raw of wsFrames(venue)) s.onmessage?.(raw)
  }
}

const btc = (venue: 'binance' | 'hyperliquid' | 'dydx') => marketKey(venue, 'BTC')

const hyperliquidBook = (coin: 'BTC' | 'ETH') =>
  wsFrames('hyperliquid')
    .find((r) => r.includes('"l2Book"') && r.includes('"levels"'))!
    .replaceAll('"coin":"BTC"', `"coin":"${coin}"`)
    .replace(/"sz":"[0-9.]+"/g, '"sz":"1.0"')
const dydxBook = wsFrames('dydx').find((r) => r.includes('"subscribed"') && r.includes('v4_orderbook'))!
const dydxCorrupt = wsFrames('dydx')
  .find((r) => r.includes('channel_data') && r.includes('v4_orderbook'))!
  .replace(/\["\d+"/, '["8x"')
const bookTopic = (market: ReturnType<typeof btc>) => ({ kind: 'book', market, group: '1' }) as const
const liveSince = (posted: readonly Frame[], from: number) =>
  posted.slice(from).filter((f) => f.kind === 'book' && f.status === 'live')

describe('hub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('serves two tabs from one socket per venue and sends render-ready books', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    const b = tab(hub, 'b')
    a.want([
      { kind: 'book', market: btc('binance'), group: '1' },
      { kind: 'book', market: btc('binance'), group: '100' },
      { kind: 'trades', market: btc('dydx') },
    ])
    b.want([
      { kind: 'book', market: btc('binance'), group: '1' },
      { kind: 'compare', base: 'BTC' },
    ])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    expect(sockets.map((s) => s.url).sort()).toEqual(
      Object.values(VENUES)
        .map((v) => v.url)
        .sort(),
    )
    const book = a.frames.get(`book|${btc('binance')}|1`) as BookFrame
    expect(book.status).toBe('live')
    expect(book.bids).toHaveLength(14)
    expect(book.bids.every((r) => r.px !== '')).toBe(true)
    expect(Number(book.bids[0]!.px.replaceAll(',', ''))).toBeLessThan(Number(book.asks[0]!.px.replaceAll(',', '')))
    expect(b.frames.get(`book|${btc('binance')}|1`)).toEqual(book)
    const compare = b.frames.get('compare|BTC')
    expect(compare?.kind === 'compare' && compare.rows.filter((r) => r.bid !== '').length).toBe(4)
    hub.dispose()
  })

  it('sends the exact touch in a book grouped wider than the spread', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    a.want([
      { kind: 'book', market: btc('binance'), group: '100' },
      { kind: 'compare', base: 'BTC' },
    ])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    const wide = a.frames.get(`book|${btc('binance')}|100`) as BookFrame
    const compare = a.frames.get('compare|BTC')
    const venue = compare?.kind === 'compare' ? compare.rows.find((r) => r.venue === 'binance') : undefined
    expect(wide.touch.bid).not.toBe('')
    expect(wide.touch).toEqual({ bid: venue?.bid, ask: venue?.ask })
    hub.dispose()
  })

  it('sends depth as prices and running totals from the mid outward', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    a.want([{ kind: 'depth', market: btc('binance') }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    const depth = a.frames.get(`depth|${btc('binance')}`) as DepthFrame
    for (const [side, away] of [
      [depth.bids, -1],
      [depth.asks, 1],
    ] as const) {
      expect(side.px.length).toBeGreaterThan(1)
      expect(side.cum).toHaveLength(side.px.length)
      expect((side.px[0]! - depth.mid) * away).toBeGreaterThan(0)
      for (let i = 1; i < side.px.length; i++) {
        expect((side.px[i]! - side.px[i - 1]!) * away).toBeGreaterThan(0)
        expect(side.cum[i]!).toBeGreaterThan(side.cum[i - 1]!)
      }
    }
    hub.dispose()
  })

  it('unsubscribes a stream only after its last tab dies and the linger passes', async () => {
    const { hub, sockets, gone } = setup()
    const a = tab(hub, 'a')
    const b = tab(hub, 'b')
    a.want([{ kind: 'trades', market: btc('hyperliquid') }])
    b.want([
      { kind: 'trades', market: btc('hyperliquid') },
      { kind: 'book', market: btc('hyperliquid'), group: '1' },
    ])
    await vi.advanceTimersByTimeAsync(1100)
    const socket = sockets[0]!
    gone.get('b' as TabId)!()
    await vi.advanceTimersByTimeAsync(2000)
    expect(socket.sent.some((s) => s.includes('unsubscribe'))).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    const unsubs = socket.sent.filter((s) => s.includes('unsubscribe'))
    expect(unsubs).toHaveLength(1)
    expect(unsubs[0]).toContain('l2Book')
    expect(hub.inspect().tabs).toBe(1)
    hub.dispose()
  })

  it('reconnects a dropped socket, resubscribes and resyncs the Binance book', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    a.want([{ kind: 'book', market: btc('binance'), group: '1' }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(200)
    expect(hub.inspect().phases[btc('binance')]).toBe('live')

    sockets[0]!.closed = true
    sockets[0]!.onclose?.()
    await vi.advanceTimersByTimeAsync(300)
    expect((a.frames.get(`book|${btc('binance')}|1`) as BookFrame).status).toBe('stale')

    await vi.advanceTimersByTimeAsync(3000)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]!.sent.join()).toContain('btcusdt@depth@100ms')
    replay(sockets)
    await vi.advanceTimersByTimeAsync(200)
    expect((a.frames.get(`book|${btc('binance')}|1`) as BookFrame).status).toBe('live')
    hub.dispose()
  })

  it('stops sending frames to a hidden tab and catches it up when it returns', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    a.want([{ kind: 'book', market: btc('hyperliquid'), group: '1' }])
    a.send({ t: 'visible', visible: false })
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(500)
    expect(a.frames.size).toBe(0)
    a.send({ t: 'visible', visible: true })
    await vi.advanceTimersByTimeAsync(200)
    expect(a.frames.size).toBe(1)
    hub.dispose()
  })

  it('sends nothing to a tab that opens in the background', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a', false)
    a.want([{ kind: 'book', market: btc('hyperliquid'), group: '1' }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(500)
    expect(a.frames.size).toBe(0)
    hub.dispose()
  })

  it('posts no pre-drop book as live while a new socket resets its books', async () => {
    const { hub, sockets } = setup({ openAtOnce: false })
    const a = tab(hub, 'a')
    const eth = marketKey('hyperliquid', 'ETH')
    a.want([bookTopic(eth), bookTopic(btc('hyperliquid'))])
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
    const from = a.posted.length
    sockets[1]!.onopen!()
    await vi.advanceTimersByTimeAsync(300)
    expect(liveSince(a.posted, from)).toEqual([])
    hub.dispose()
  })

  it('keeps a dYdX book off live when its snapshot lands after a held resubscribe', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    a.want([bookTopic(btc('dydx'))])
    await vi.advanceTimersByTimeAsync(1100)
    const socket = sockets.find((s) => s.url.includes('dydx'))!
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(200)
    socket.onmessage!(dydxCorrupt)
    socket.onmessage!(dydxCorrupt)
    expect(socket.sent.at(-1)).toContain('unsubscribe')
    const from = a.posted.length
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(1000)
    expect(liveSince(a.posted, from)).toEqual([])
    hub.dispose()
  })

  it('keeps a dYdX book off live when a tab wants it back during its hold', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    a.want([bookTopic(btc('dydx'))])
    await vi.advanceTimersByTimeAsync(1100)
    const socket = sockets.find((s) => s.url.includes('dydx'))!
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(200)
    a.want([bookTopic(marketKey('dydx', 'ETH'))])
    await vi.advanceTimersByTimeAsync(9000)
    socket.onmessage!(dydxCorrupt)
    socket.onmessage!(dydxBook)
    await vi.advanceTimersByTimeAsync(1200)
    expect(socket.sent.at(-1)).toContain('unsubscribe')
    const from = a.posted.length
    a.want([bookTopic(btc('dydx'))])
    await vi.advanceTimersByTimeAsync(500)
    expect(liveSince(a.posted, from)).toEqual([])
    hub.dispose()
  })
})
