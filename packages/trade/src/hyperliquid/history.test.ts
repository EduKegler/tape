import { describe, expect, it } from 'vitest'
import { hyperliquid } from '.'

const fill = (time: number, tid: number, side: 'A' | 'B' = 'B') => ({
  coin: 'BTC',
  px: '100',
  sz: '1',
  side,
  time,
  startPosition: '0',
  closedPnl: '0',
  hash: `0x${tid}`,
  oid: tid,
  fee: '0.1',
  feeToken: 'USDC',
  tid,
})
const payment = (time: number) => ({ time, delta: { coin: 'BTC', usdc: '-1', szi: '1', fundingRate: '0.0001' } })

function history(answer: (type: string, startTime: number) => unknown[]) {
  const starts: [string, number][] = []
  const fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { type: string; startTime: number }
    starts.push([body.type, body.startTime])
    return new Response(JSON.stringify(answer(body.type, body.startTime)))
  }) as typeof globalThis.fetch
  return { read: hyperliquid.history({ network: 'mainnet', address: '0xA', fetch }), starts }
}

// Info endpoint docs: userFunding pages hold 500 rows and userFillsByTime pages 2000, each from startTime on.
describe('hyperliquid history pages', () => {
  it('walks funding past a full page of 500 without dropping or repeating payments', async () => {
    const all = Array.from({ length: 501 }, (_, index) => payment(1000 + index))
    const { read, starts } = history((type, start) =>
      type === 'userFunding' ? all.filter((entry) => entry.time >= start).slice(0, 500) : [],
    )
    const { funding } = await read
    expect(funding.map((entry) => [entry.venue, entry.time])).toEqual(all.map((entry) => ['hyperliquid', entry.time]))
    expect(starts.filter(([type]) => type === 'userFunding').map(([, start]) => start)).toEqual([0, 1499])
  })

  it('says when one moment holds more fills than a page', async () => {
    const crowded = Array.from({ length: 2000 }, (_, index) => fill(1000, index))
    const { read } = history((type) => (type === 'userFillsByTime' ? crowded : []))
    expect((await read).gaps).toEqual([
      'Hyperliquid sent more rows for one moment than a page holds, so later rows are missing.',
    ])
  })

  // The recorded history.hyperliquid.json has side A fills as Close Long, which are sells.
  it('reads a fill on the ask side as a sell on Hyperliquid', async () => {
    const { read } = history((type) => (type === 'userFillsByTime' ? [fill(1000, 1, 'A')] : []))
    expect((await read).fills.map((entry) => [entry.venue, entry.side])).toEqual([['hyperliquid', 'sell']])
  })
})
