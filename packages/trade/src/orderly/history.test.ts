import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { orderly } from '.'

interface Recording {
  address: string
  exchanges: { url: string; body: { type: string }; response: { data: { rows?: { side?: string }[] } } }[]
}

const recording = JSON.parse(
  readFileSync(new URL('../__fixtures__/history.orderly.json', import.meta.url), 'utf8'),
) as Recording
const rowsOf = (type: string) => recording.exchanges.find((e) => e.body.type === type)?.response.data.rows ?? []

describe('orderly history rows', () => {
  it('keeps the side, venue, asset and liquidation flag Orderly records on each row', async () => {
    const fetch = (async (_url: string, init?: RequestInit) => {
      const { type } = JSON.parse(init?.body as string) as { type: string }
      return new Response(JSON.stringify(recording.exchanges.find((e) => e.body.type === type)?.response))
    }) as typeof globalThis.fetch
    const h = await orderly.history({ network: 'mainnet', address: recording.address, fetch })
    const trades = rowsOf('trades')
    expect(h.fills).toHaveLength(trades.length)
    expect(h.fills.filter((f) => f.side === 'sell')).toHaveLength(trades.filter((t) => t.side === 'SELL').length)
    expect(h.fills.filter((f) => f.side === 'buy')).toHaveLength(trades.filter((t) => t.side === 'BUY').length)
    expect(h.fills.some((f) => f.liquidation)).toBe(false)
    expect(h.funding.length).toBeGreaterThan(0)
    expect([...h.fills, ...h.funding].every((e) => e.venue === 'orderly')).toBe(true)
    expect(h.funding.every((p) => p.asset === 'USDC')).toBe(true)
    expect(h.gaps).toEqual([])
  })
})
