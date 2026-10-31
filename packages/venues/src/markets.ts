import { isBase, marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import { DecimalError, decimalsOf, parsePx, parseQty, plainDecimal } from '@tape/core/fixed'
import type { Decimals, Scale } from '@tape/core/fixed'
import type { MarketGroup, MarketSpec } from '@tape/core/market'
import { getExactJson, getJson } from './types'

type Fetch = typeof globalThis.fetch

const HYPERLIQUID_MIN_ORDER_USDC = '10'

/** Hyperliquid prices carry at most 6 decimals minus the size decimals. */
const HYPERLIQUID_PX_DECIMALS = 6

function specOf<T>(row: T, spec: (row: T) => MarketSpec | null): MarketSpec | null {
  try {
    return spec(row)
  } catch (e) {
    if (e instanceof DecimalError) return null
    throw e
  }
}

const specs = <T>(rows: readonly T[], spec: (row: T) => MarketSpec | null): MarketSpec[] =>
  rows.flatMap((row) => specOf(row, spec) ?? [])

const own = (markets: readonly MarketSpec[]): readonly MarketGroup[] => [{ name: null, markets }]

const baseOf = (name: string): Base | null => (isBase(name) ? name : null)

/** The reply, or null for a 400, which dYdX's indexer and Binance send for a market they do not list. */
async function listedJson<T>(fetch: Fetch, url: string, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(url, { signal: signal ?? null })
  if (response.status === 400) return null
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return (await response.json()) as T
}

interface HyperliquidAsset {
  name: string
  szDecimals: number
  isDelisted?: boolean
}

function hyperliquidSpec(asset: HyperliquidAsset): MarketSpec | null {
  const base = baseOf(asset.name)
  if (!base || asset.isDelisted) return null
  const qty = asset.szDecimals as Decimals
  const scale = { px: (HYPERLIQUID_PX_DECIMALS - qty) as Decimals, qty }
  return {
    key: marketKey('hyperliquid', base),
    venue: 'hyperliquid',
    base,
    quote: 'USDC',
    kind: 'perp',
    venueSymbol: asset.name,
    scale,
    tick: { kind: 'sigfig', figures: 5 },
    step: 1 as MarketSpec['step'],
    minNotional: parsePx(HYPERLIQUID_MIN_ORDER_USDC, scale),
  }
}

const hyperliquidMeta = (fetch: Fetch, info: string, signal?: AbortSignal) =>
  getJson<{ universe: HyperliquidAsset[] }>(fetch, info, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
    signal: signal ?? null,
  })

export async function readHyperliquidMarkets(
  fetch: Fetch,
  info: string,
  signal?: AbortSignal,
): Promise<readonly MarketGroup[]> {
  return own(specs((await hyperliquidMeta(fetch, info, signal)).universe, hyperliquidSpec))
}

export async function readHyperliquidMarket(
  fetch: Fetch,
  info: string,
  base: Base,
  signal?: AbortSignal,
): Promise<MarketSpec | null> {
  const asset = (await hyperliquidMeta(fetch, info, signal)).universe.find((u) => u.name === base)
  return asset ? specOf(asset, hyperliquidSpec) : null
}

interface DydxMarket {
  ticker: string
  tickSize: string
  stepSize: string
  status: string
}

const DYDX_TICKER = /^(.+)-USD$/

function dydxSpec(m: DydxMarket): MarketSpec | null {
  const base = baseOf(DYDX_TICKER.exec(m.ticker)?.[1] ?? '')
  if (!base || m.status !== 'ACTIVE') return null
  const scale = { px: decimalsOf(m.tickSize), qty: decimalsOf(m.stepSize) }
  return {
    key: marketKey('dydx', base),
    venue: 'dydx',
    base,
    quote: 'USD',
    kind: 'perp',
    venueSymbol: m.ticker,
    scale,
    tick: { kind: 'fixed', tick: parsePx(m.tickSize, scale) },
    step: parseQty(m.stepSize, scale),
  }
}

export async function readDydxMarkets(
  fetch: Fetch,
  indexer: string,
  signal?: AbortSignal,
): Promise<readonly MarketGroup[]> {
  const json = await getJson<{ markets: Record<string, DydxMarket> }>(fetch, `${indexer}/perpetualMarkets`, {
    signal: signal ?? null,
  })
  return own(specs(Object.values(json.markets), dydxSpec))
}

export async function readDydxMarket(
  fetch: Fetch,
  indexer: string,
  base: Base,
  signal?: AbortSignal,
): Promise<MarketSpec | null> {
  const ticker = `${base}-USD`
  const json = await listedJson<{ markets: Record<string, DydxMarket> }>(
    fetch,
    `${indexer}/perpetualMarkets?ticker=${encodeURIComponent(ticker)}`,
    signal,
  )
  const market = json?.markets[ticker]
  return market ? specOf(market, dydxSpec) : null
}

function minNotionalOf(value: string | undefined, scale: Scale): Pick<MarketSpec, 'minNotional'> {
  if (!value) return {}
  try {
    return { minNotional: parsePx(plainDecimal(value), scale) }
  } catch (e) {
    if (e instanceof DecimalError) return {}
    throw e
  }
}

interface OrderlyMarket {
  symbol: string
  quote_tick: string
  base_tick: string
  min_notional?: string
  status: string
  broker_id: string | null
}

const ORDERLY_SYMBOL = /^PERP_(.+)_USDC$/

function orderlySpec(m: OrderlyMarket): MarketSpec | null {
  const base = baseOf(ORDERLY_SYMBOL.exec(m.symbol)?.[1] ?? '')
  // A row with a broker_id is a Community Listed market that a Builder runs and Orderly does not vet.
  if (!base || m.status !== 'ACTIVE' || m.broker_id !== null) return null
  const scale = { px: decimalsOf(m.quote_tick), qty: decimalsOf(m.base_tick) }
  return {
    key: marketKey('orderly', base),
    venue: 'orderly',
    base,
    quote: 'USDC',
    kind: 'perp',
    venueSymbol: m.symbol,
    scale,
    tick: { kind: 'fixed', tick: parsePx(m.quote_tick, scale) },
    step: parseQty(m.base_tick, scale),
    ...minNotionalOf(m.min_notional, scale),
  }
}

export async function readOrderlyMarkets(
  fetch: Fetch,
  rest: string,
  signal?: AbortSignal,
): Promise<readonly MarketGroup[]> {
  const json = await getExactJson<{ data: { rows: OrderlyMarket[] } }>(fetch, `${rest}/public/info`, {
    signal: signal ?? null,
  })
  return own(specs(json.data.rows, orderlySpec))
}

/** Orderly answers a symbol it does not list with success and no data. */
export async function readOrderlyMarket(
  fetch: Fetch,
  rest: string,
  base: Base,
  signal?: AbortSignal,
): Promise<MarketSpec | null> {
  const json = await getExactJson<{ data?: OrderlyMarket }>(
    fetch,
    `${rest}/public/info/${encodeURIComponent(`PERP_${base}_USDC`)}`,
    { signal: signal ?? null },
  )
  return json.data ? specOf(json.data, orderlySpec) : null
}

interface BinanceSymbol {
  symbol: string
  status: string
  baseAsset: string
  quoteAsset: string
  filters: { filterType: string; tickSize?: string; stepSize?: string }[]
}

function binanceSpec(s: BinanceSymbol): MarketSpec | null {
  const base = baseOf(s.baseAsset)
  const tick = s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize
  const step = s.filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize
  if (!base || s.status !== 'TRADING' || s.quoteAsset !== 'USDT' || s.symbol !== `${base}USDT` || !tick || !step)
    return null
  const scale = { px: decimalsOf(tick), qty: decimalsOf(step) }
  return {
    key: marketKey('binance', base),
    venue: 'binance',
    base,
    quote: 'USDT',
    kind: 'spot',
    venueSymbol: s.symbol,
    scale,
    tick: { kind: 'fixed', tick: parsePx(tick, scale) },
    step: parseQty(step, scale),
  }
}

export async function readBinanceMarkets(
  fetch: Fetch,
  rest: string,
  signal?: AbortSignal,
): Promise<readonly MarketGroup[]> {
  const info = await getJson<{ symbols: BinanceSymbol[] }>(
    fetch,
    `${rest}/exchangeInfo?permissions=SPOT&symbolStatus=TRADING&showPermissionSets=false`,
    { signal: signal ?? null },
  )
  return own(specs(info.symbols, binanceSpec))
}

export async function readBinanceMarket(
  fetch: Fetch,
  rest: string,
  base: Base,
  signal?: AbortSignal,
): Promise<MarketSpec | null> {
  const symbol = `${base}USDT`
  const info = await listedJson<{ symbols: BinanceSymbol[] }>(
    fetch,
    `${rest}/exchangeInfo?symbol=${encodeURIComponent(symbol)}&showPermissionSets=false`,
    signal,
  )
  const row = info?.symbols.find((s) => s.symbol === symbol)
  return row ? specOf(row, binanceSpec) : null
}
