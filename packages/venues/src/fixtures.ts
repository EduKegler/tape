import { readFileSync } from 'node:fs'
import type { VenueId } from '@tape/core/ids'

const dir = new URL('./__fixtures__/', import.meta.url)
const json = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), 'utf8'))

/** Recorded WebSocket frames, in arrival order. */
export function wsFrames(venue: VenueId): string[] {
  return readFileSync(new URL(`${venue}.ws.jsonl`, dir), 'utf8').trim().split('\n')
}

const ROUTES: [RegExp, string][] = [
  [/binance\.vision\/api\/v3\/exchangeInfo/, 'binance.exchangeInfo.json'],
  [/binance\.vision\/api\/v3\/depth/, 'binance.depth.json'],
  [/binance\.vision\/api\/v3\/klines/, 'binance.klines.json'],
  [/binance\.vision\/api\/v3\/ticker\/24hr/, 'binance.ticker.json'],
  [/perpetualMarkets\?ticker=BTC-USD/, 'dydx.markets-BTC.json'],
  [/perpetualMarkets\?ticker=ETH-USD/, 'dydx.markets-ETH.json'],
  [/perpetualMarkets\?ticker=SOL-USD/, 'dydx.markets-SOL.json'],
  [/indexer\.dydx\.trade\/v4\/candles/, 'dydx.candles.json'],
  [/orderly\.org\/v1\/public\/info\/PERP_BTC_USDC/, 'orderly.info-BTC.json'],
  [/orderly\.org\/v1\/public\/info\/PERP_ETH_USDC/, 'orderly.info-ETH.json'],
  [/orderly\.org\/v1\/public\/info\/PERP_SOL_USDC/, 'orderly.info-SOL.json'],
  [/orderly\.org\/v1\/public\/futures/, 'orderly.futures.json'],
  [/orderly\.org\/v1\/tv\/history/, 'orderly.history.json'],
]

/** A fetch that answers from recorded REST responses and fails loudly on any URL it was not recorded with. */
export const recordedFetch: typeof globalThis.fetch = async (input, init) => {
  const url = String(input)
  let file = ROUTES.find(([re]) => re.test(url))?.[1]
  if (url.includes('api.hyperliquid.xyz/info')) {
    const body = JSON.parse(String(init?.body)) as { type: string }
    file = `hyperliquid.${body.type}.json`
  }
  if (!file) throw new Error(`no recording for ${url}`)
  return new Response(JSON.stringify(json(file)), { status: 200, headers: { 'content-type': 'application/json' } })
}
