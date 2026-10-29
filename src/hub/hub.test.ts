import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '#/core/ids'
import { marketKey } from '#/core/ids'
import type { HubToTab, TabToHub } from '#/core/protocol'
import type { BookFrame, Frame, Topic } from '#/core/topics'
import { recordedFetch, wsFrames } from '#/venues/fixtures'
import { VENUES } from '#/venues/index'
import { createHub } from './hub'
import type { Hub, SocketLike } from './hub'

interface FakeSocket extends SocketLike {
  readonly url: string
  readonly sent: string[]
  closed: boolean
}

function setup() {
  const sockets: FakeSocket[] = []
  const gone = new Map<TabId, () => void>()
  const hub = createHub({
    mode: 'shared',
    venues: VENUES,
    fetch: recordedFetch,
    now: () => Date.now(),
    random: () => 0.5,
    watchTabGone: (tab) => new Promise<void>((resolve) => gone.set(tab, resolve)),
    openSocket(url) {
      const socket: FakeSocket = {
        url, sent: [], closed: false, onopen: null, onmessage: null, onclose: null,
        send(data) { this.sent.push(data) },
        close() { this.closed = true },
      }
      sockets.push(socket)
      queueMicrotask(() => socket.onopen?.())
      return socket
    },
  })
  return { hub, sockets, gone }
}

/** A tab on the far side of a structured-clone boundary, like a MessagePort. */
function tab(hub: Hub, id: string) {
  const frames = new Map<string, Frame>()
  let deliver: (data: unknown) => void = () => {}
  hub.connect({
    post: (m: HubToTab) => {
      if (m.t === 'frames') for (const f of structuredClone(m.frames)) frames.set(f.key, f)
    },
    listen: (fn) => (deliver = fn),
    close: () => {},
  })
  const send = (m: TabToHub) => deliver(structuredClone(m))
  send({ t: 'hello', tab: id as TabId })
  return { frames, want: (topics: Topic[]) => send({ t: 'want', topics }), send }
}

function replay(sockets: FakeSocket[]) {
  for (const s of sockets.filter((x) => !x.closed)) {
    const venue = Object.values(VENUES).find((v) => v.url === s.url)!.id
    for (const raw of wsFrames(venue)) s.onmessage?.(raw)
  }
}

const btc = (venue: 'binance' | 'hyperliquid' | 'dydx') => marketKey(venue, 'BTC')

describe('hub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('serves two tabs from one socket per venue and sends render-ready books', async () => {
    const { hub, sockets } = setup()
    const a = tab(hub, 'a')
    const b = tab(hub, 'b')
    a.want([{ kind: 'book', market: btc('binance'), group: '1' }, { kind: 'trades', market: btc('dydx') }])
    b.want([{ kind: 'book', market: btc('binance'), group: '1' }, { kind: 'compare', base: 'BTC' }])
    await vi.advanceTimersByTimeAsync(50)
    replay(sockets)
    await vi.advanceTimersByTimeAsync(1500)

    expect(sockets.map((s) => s.url).sort()).toEqual([VENUES.binance.url, VENUES.dydx.url, VENUES.hyperliquid.url].sort())
    const book = a.frames.get(`book|${btc('binance')}|1`) as BookFrame
    expect(book.status).toBe('live')
    expect(book.bids).toHaveLength(14)
    expect(book.bids.every((r) => r.px !== '')).toBe(true)
    expect(Number(book.bids[0]!.px.replaceAll(',', ''))).toBeLessThan(Number(book.asks.at(-1)!.px.replaceAll(',', '')))
    expect(b.frames.get(`book|${btc('binance')}|1`)).toEqual(book)
    const compare = b.frames.get('compare|BTC')
    expect(compare?.kind === 'compare' && compare.rows.filter((r) => r.bid !== '').length).toBe(3)
    hub.dispose()
  })

  it('unsubscribes a stream only after its last tab dies and the linger passes', async () => {
    const { hub, sockets, gone } = setup()
    const a = tab(hub, 'a')
    const b = tab(hub, 'b')
    a.want([{ kind: 'trades', market: btc('hyperliquid') }])
    b.want([{ kind: 'trades', market: btc('hyperliquid') }, { kind: 'book', market: btc('hyperliquid'), group: '1' }])
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
})
