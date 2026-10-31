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
const rowsOf = (type: string) =>
  recording.exchanges.find((exchange) => exchange.body.type === type)?.response.data.rows ?? []

describe('orderly history rows', () => {
  it('keeps the side, venue, asset and liquidation flag Orderly records on each row', async () => {
    const fetch = (async (_url: string, init?: RequestInit) => {
      const { type } = JSON.parse(init?.body as string) as { type: string }
      return new Response(JSON.stringify(recording.exchanges.find((exchange) => exchange.body.type === type)?.response))
    }) as typeof globalThis.fetch
    const history = await orderly.history({ network: 'mainnet', address: recording.address, fetch })
    const trades = rowsOf('trades')
    expect(history.fills).toHaveLength(trades.length)
    expect(history.fills.filter((fill) => fill.side === 'sell')).toHaveLength(
      trades.filter((trade) => trade.side === 'SELL').length,
    )
    expect(history.fills.filter((fill) => fill.side === 'buy')).toHaveLength(
      trades.filter((trade) => trade.side === 'BUY').length,
    )
    expect(history.fills.some((fill) => fill.liquidation)).toBe(false)
    expect(history.funding.length).toBeGreaterThan(0)
    expect([...history.fills, ...history.funding].every((row) => row.venue === 'orderly')).toBe(true)
    expect(history.funding.every((payment) => payment.asset === 'USDC')).toBe(true)
    expect(history.gaps).toEqual([])
  })
})
