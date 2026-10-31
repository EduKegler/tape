import { isBase, marketKey, splitBase } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import { DecimalError, decimalsOf, parsePx, parseQty, plainDecimal } from '@tape/core/fixed'
import { parseExactJson } from '@tape/core/json'
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

const isHip3 = (base: Base) => splitBase(base).dex !== ''

/**
 * The reply, or null for a 400, which dYdX's indexer and Binance send for a market they do not list, and Orderly
 * for a symbol it cannot parse.
 */
async function listedJson<T>(
  fetch: Fetch,
  url: string,
  signal?: AbortSignal,
  parse: (text: string) => T = (text) => JSON.parse(text) as T,
): Promise<T | null> {
  const response = await fetch(url, { signal: signal ?? null })
  if (response.status === 400) return null
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return parse(await response.text())
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

interface HyperliquidMeta {
  universe: HyperliquidAsset[]
  collateralToken: number
}

/** Token 0 in Hyperliquid's spot token list is USDC. A HIP-3 dex settled in another token prices in that token. */
const HYPERLIQUID_USDC = 0

const hyperliquidMarkets = (meta: HyperliquidMeta) =>
  meta.collateralToken === HYPERLIQUID_USDC ? specs(meta.universe, hyperliquidSpec) : []

const hyperliquidPost = (fetch: Fetch, info: string, body: unknown, signal?: AbortSignal) =>
  fetch(info, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  })

/** The main dex's markets unnamed, then each HIP-3 dex's markets under the dex's full name. */
export async function readHyperliquidMarkets(
  fetch: Fetch,
  info: string,
  signal?: AbortSignal,
): Promise<readonly MarketGroup[]> {
  const read = async <T>(type: string) => {
    const response = await hyperliquidPost(fetch, info, { type }, signal)
    if (!response.ok) throw new Error(`${response.status} ${info}`)
    return (await response.json()) as T
  }
  const [metas, dexes] = await Promise.all([
    read<HyperliquidMeta[]>('allPerpMetas'),
    read<({ name: string; fullName: string } | null)[]>('perpDexs'),
  ])
  const fullNames = new Map(dexes.flatMap((d) => (d ? [[d.name, d.fullName] as const] : [])))
  return metas.flatMap((meta) => {
    const markets = hyperliquidMarkets(meta)
    const first = markets[0]
    if (!first) return []
    const { dex } = splitBase(first.base)
    return [{ name: dex ? (fullNames.get(dex) ?? dex) : null, markets }]
  })
}

export async function readHyperliquidMarket(
  fetch: Fetch,
  info: string,
  base: Base,
  signal?: AbortSignal,
): Promise<MarketSpec | null> {
  const response = await hyperliquidPost(fetch, info, { type: 'meta', dex: splitBase(base).dex }, signal)
  const text = await response.text()
  // Hyperliquid answers a dex it does not list with a 500 and the body null.
  if (response.status === 500 && text === 'null') return null
  if (!response.ok) throw new Error(`${response.status} ${info}`)
  return hyperliquidMarkets(JSON.parse(text) as HyperliquidMeta).find((m) => m.base === base) ?? null
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
  if (isHip3(base)) return null
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
  if (isHip3(base)) return null
  const json = await listedJson(
    fetch,
    `${rest}/public/info/${encodeURIComponent(`PERP_${base}_USDC`)}`,
    signal,
    parseExactJson<{ data?: OrderlyMarket }>,
  )
  return json?.data ? specOf(json.data, orderlySpec) : null
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

/** Binance refuses any symbol with a lowercase ASCII letter, as the range in its -1100 reply shows: `^[\w\-._&&[^a-z]]{1,50}$`. */
const BINANCE_REFUSED = /[a-z]/

export async function readBinanceMarket(
  fetch: Fetch,
  rest: string,
  base: Base,
  signal?: AbortSignal,
): Promise<MarketSpec | null> {
  const symbol = `${base}USDT`
  if (isHip3(base) || BINANCE_REFUSED.test(symbol)) return null
  let info: { symbols: BinanceSymbol[] } | null
  try {
    info = await listedJson(
      fetch,
      `${rest}/exchangeInfo?symbol=${encodeURIComponent(symbol)}&showPermissionSets=false`,
      signal,
    )
  } catch (e) {
    // Binance sends the 400 for a symbol it does not list without CORS headers, so a browser fetch rejects
    // with a TypeError, as it does offline. Its whole list tells the two apart.
    if (!(e instanceof TypeError)) throw e
    const [all] = await readBinanceMarkets(fetch, rest, signal)
    return all?.markets.find((m) => m.base === base) ?? null
  }
  const row = info?.symbols.find((s) => s.symbol === symbol)
  return row ? specOf(row, binanceSpec) : null
}
