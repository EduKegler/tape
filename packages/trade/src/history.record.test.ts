import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TradeVenueId } from './types'
import { TRADING } from './index'

/** Public mainnet accounts whose whole history the venues still serve, with closes, flips and funding. */
const ACCOUNTS: Record<TradeVenueId, string> = {
  hyperliquid: '0x8c122ca07e29b87ed8ed0f5e0c620a4dfe4b3c1b',
  dydx: 'dydx1cxyq2xdq36swe2mzh2hf66ldj55vlt46cpeh4m',
  orderly: '0xf7069a2afa4c6e74917dfc6b0e29af57342f70a6',
}

const json = async <T>(url: string, body?: unknown) =>
  (await (
    await fetch(
      url,
      body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {},
    )
  ).json()) as T

const REFERENCE: Partial<Record<TradeVenueId, (address: string) => Promise<Record<string, string>>>> = {
  hyperliquid: async (user) => {
    const portfolio = await json<[string, { pnlHistory: [number, string][] }][]>('https://api.hyperliquid.xyz/info', {
      type: 'portfolio',
      user,
    })
    const pnl = portfolio.find(([period]) => period === 'perpAllTime')?.[1].pnlHistory.at(-1)?.[1]
    if (pnl === undefined) throw new Error('no perpAllTime PnL')
    return { perpAllTimePnl: pnl }
  },
  dydx: async (address) => {
    const { historicalPnl } = await json<{ historicalPnl: { totalPnl: string }[] }>(
      `https://indexer.dydx.trade/v4/historical-pnl?address=${address}&subaccountNumber=0&limit=1`,
    )
    return { totalPnl: historicalPnl[0]!.totalPnl }
  },
}

function recording() {
  const exchanges: { url: string; body: unknown; response: unknown }[] = []
  const record = (async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init)
    const text = await response.text()
    if (response.ok)
      exchanges.push({ url, body: init?.body ? JSON.parse(init.body as string) : null, response: JSON.parse(text) })
    return new Response(text, { status: response.status })
  }) as typeof globalThis.fetch
  return { exchanges, record }
}

const only = process.env.RECORD_HISTORY

describe.runIf(only)('record history fixtures', () => {
  for (const [venue, address] of Object.entries(ACCOUNTS) as [TradeVenueId, string][])
    it.runIf(only === '1' || only === venue)(`records ${venue}`, { timeout: 300_000 }, async () => {
      const { exchanges, record } = recording()
      await TRADING[venue].history({ network: 'mainnet', address, fetch: record })
      expect(exchanges.length).toBeGreaterThan(0)
      const reference = (await REFERENCE[venue]?.(address)) ?? {}
      const out = new URL('./__fixtures__/', import.meta.url)
      mkdirSync(out, { recursive: true })
      writeFileSync(
        new URL(`history.${venue}.json`, out),
        JSON.stringify({ address, recordedAt: new Date().toISOString(), reference, exchanges }),
      )
    })
})
