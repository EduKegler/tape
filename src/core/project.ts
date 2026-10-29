import { bestAsk, bestBid, visibleBook } from '@tape/core/book'
import type { BookSide, BookSync } from '@tape/core/book'
import { formatMid, formatPx, formatQty, rescalePx, spreadBps, toDisplayFloat } from '@tape/core/fixed'
import type { Decimals, Px, Qty } from '@tape/core/fixed'
import { VENUE_IDS } from '@tape/core/ids'
import type { Base, Interval, TopicKey, VenueId } from '@tape/core/ids'
import { effectiveTick, groupDecimals, groupOptions, snapGroup } from '@tape/core/market'
import type { Candle, MarketSpec, TradeTape } from '@tape/core/market'
import { BOOK_ROWS, EMPTY_ROW } from './topics'
import type { BookFrame, BookRow, CandleFrame, CompareFrame, CompareRow, DepthFrame, FrameStatus, TradesFrame } from './topics'

/** Hub state for one market, read by the projections. */
export interface MarketView {
  readonly spec: MarketSpec
  readonly sync: BookSync
  readonly trades: TradeTape
  readonly candles: ReadonlyMap<Interval, readonly Candle[]>
  readonly status: FrameStatus
  readonly uncrossed: number
}

const DEPTH_LEVELS = 400

/** Bids floor to the step and asks ceil to it, so grouping never collapses the spread. */
function grouped(side: BookSide, step: number, rows: number): { px: number; qty: number }[] {
  const out: { px: number; qty: number }[] = []
  for (const px of side.prices) {
    const bucket = side.side === 'bid' ? Math.floor(px / step) * step : Math.ceil(px / step) * step
    const qty = side.qty.get(px) as number
    const last = out.at(-1)
    if (last && last.px === bucket) last.qty += qty
    else if (out.length === rows) break
    else out.push({ px: bucket, qty })
  }
  return out
}

export function projectBook(key: TopicKey, market: MarketView, group: string, version: number): BookFrame {
  const { spec } = market
  const book = visibleBook(market.sync)
  const bid = book && bestBid(book)
  const ask = book && bestAsk(book)
  const mid = (bid !== null && ask !== null ? Math.round((bid + ask) / 2) : (bid ?? ask ?? 0)) as Px
  const step = snapGroup(spec, mid, group)
  const decimals = groupDecimals(spec, step)
  const options = groupOptions(spec, mid).map((s) => formatPx(s, spec.scale, groupDecimals(spec, s)))
  const bids = book ? grouped(book.bids, step, BOOK_ROWS) : []
  const asks = book ? grouped(book.asks, step, BOOK_ROWS) : []
  const cum = (levels: { qty: number }[]) => {
    let total = 0
    return levels.map((l) => (total += l.qty))
  }
  const bidCum = cum(bids)
  const askCum = cum(asks)
  const max = Math.max(bidCum.at(-1) ?? 0, askCum.at(-1) ?? 0) || 1
  const row = (l: { px: number; qty: number } | undefined, c: number | undefined): BookRow =>
    l && c !== undefined
      ? { px: formatPx(l.px as Px, spec.scale, decimals), qty: formatQty(l.qty as Qty, spec.scale), cum: formatQty(c as Qty, spec.scale), fill: c / max }
      : EMPTY_ROW
  const ladder = (levels: { px: number; qty: number }[], c: number[]) => Array.from({ length: BOOK_ROWS }, (_, i) => row(levels[i], c[i]))
  return {
    kind: 'book', key, version, status: market.status, venueTime: book?.time ?? 0,
    group: formatPx(step, spec.scale, decimals), groupOptions: options,
    asks: ladder(asks, askCum).reverse(), bids: ladder(bids, bidCum),
    bid: bid !== null ? formatPx(bid, spec.scale, tradeDecimals(spec, bid)) : '',
    ask: ask !== null ? formatPx(ask, spec.scale, tradeDecimals(spec, ask)) : '',
    mid: bid !== null && ask !== null ? formatMid(bid, ask, spec.scale) : '',
    spread: bid !== null && ask !== null ? formatPx((ask - bid) as Px, spec.scale) : '',
    spreadBps: bid !== null && ask !== null ? spreadBps(bid, ask) : '',
    uncrossed: market.uncrossed,
  }
}

function depthSide(side: BookSide, pxDecimals: Decimals, qtyDecimals: Decimals): Float64Array {
  const n = Math.min(side.prices.length, DEPTH_LEVELS)
  const out = new Float64Array(n * 2)
  let cum = 0
  for (let i = 0; i < n; i++) {
    const px = side.prices[i] as Px
    cum += side.qty.get(px) as number
    out[i * 2] = toDisplayFloat(px, pxDecimals)
    out[i * 2 + 1] = toDisplayFloat(cum as Qty, qtyDecimals)
  }
  return out
}

export function projectDepth(key: TopicKey, market: MarketView, version: number): DepthFrame {
  const { scale } = market.spec
  const book = visibleBook(market.sync)
  const bid = book && bestBid(book)
  const ask = book && bestAsk(book)
  return {
    kind: 'depth', key, version, status: market.status, venueTime: book?.time ?? 0,
    bids: book ? depthSide(book.bids, scale.px, scale.qty) : new Float64Array(),
    asks: book ? depthSide(book.asks, scale.px, scale.qty) : new Float64Array(),
    mid: bid !== null && ask !== null ? toDisplayFloat(((bid + ask) / 2) as Px, scale.px) : 0,
  }
}

function tradeDecimals(spec: MarketSpec, ref: Px): Decimals {
  return groupDecimals(spec, effectiveTick(spec, ref))
}

export function projectTrades(key: TopicKey, market: MarketView, version: number): TradesFrame {
  const { spec } = market
  const items = market.trades.items
  const first = items[0]
  const decimals = first ? tradeDecimals(spec, first.px) : spec.scale.px
  return {
    kind: 'trades', key, version, status: market.status, venueTime: first?.time ?? 0,
    rows: items.map((t) => ({ id: t.id, side: t.side, time: t.time, px: formatPx(t.px, spec.scale, decimals), qty: formatQty(t.qty, spec.scale) })),
    last: first ? formatPx(first.px, spec.scale, decimals) : '',
    lastSide: first?.side ?? null,
  }
}

export function projectCandle(key: TopicKey, market: MarketView, interval: Interval, version: number): CandleFrame {
  const { scale } = market.spec
  const bars = market.candles.get(interval) ?? []
  return {
    kind: 'candle', key, version, status: market.status, venueTime: bars.at(-1)?.open ?? 0,
    bars: bars.map((b) => ({
      time: Math.floor(b.open / 1000),
      open: toDisplayFloat(b.o, scale.px), high: toDisplayFloat(b.h, scale.px), low: toDisplayFloat(b.l, scale.px),
      close: toDisplayFloat(b.c, scale.px), volume: toDisplayFloat(b.v, scale.qty),
    })),
  }
}

/**
 * Cross-venue view. Prices are rescaled to the finest scale among the venues, so the best bid
 * and best ask flags are exact integer comparisons, not string or float ones.
 */
export function projectCompare(key: TopicKey, _base: Base, markets: Readonly<Partial<Record<VenueId, MarketView>>>, version: number): CompareFrame {
  const fine = Math.max(...Object.values(markets).map((m) => m.spec.scale.px), 0) as Decimals
  const quotes = VENUE_IDS.map((venue) => {
    const m = markets[venue]
    const book = m && visibleBook(m.sync)
    const bid = book && bestBid(book)
    const ask = book && bestAsk(book)
    if (!m || bid === null || ask === null || bid === undefined || ask === undefined) return { venue, m, bid: null, ask: null }
    return { venue, m, bid: rescalePx(bid, m.spec.scale.px, fine), ask: rescalePx(ask, m.spec.scale.px, fine) }
  })
  const bids = quotes.flatMap((q) => (q.bid === null ? [] : [q.bid]))
  const asks = quotes.flatMap((q) => (q.ask === null ? [] : [q.ask]))
  const mids = quotes.flatMap((q) => (q.bid === null ? [] : [(q.bid + q.ask) / 2])).sort((a, b) => a - b)
  const median = mids.length ? (mids[Math.floor((mids.length - 1) / 2)]! + mids[Math.ceil((mids.length - 1) / 2)]!) / 2 : 0
  const fineScale = { px: fine, qty: 0 } as const
  const rows: CompareRow[] = quotes.map(({ venue, m, bid, ask }) => {
    const last = m?.trades.items[0]
    if (!m || bid === null) {
      return { venue, status: m?.status ?? 'syncing', bid: '', ask: '', mid: '', spreadBps: '', basisBps: '', last: '', bestBid: false, bestAsk: false }
    }
    const mid = (bid + ask) / 2
    const basis = median ? ((mid - median) / median) * 10_000 : 0
    const decimals = tradeDecimals(m.spec, rescalePx(bid, fine, m.spec.scale.px))
    return {
      venue, status: m.status,
      bid: formatPx(bid, fineScale, decimals), ask: formatPx(ask, fineScale, decimals),
      mid: formatMid(bid, ask, fineScale), spreadBps: spreadBps(bid, ask),
      basisBps: `${basis >= 0 ? '+' : ''}${basis.toFixed(2)}`,
      last: last ? formatPx(last.px, m.spec.scale, decimals) : '',
      bestBid: bids.length > 1 && bid === Math.max(...bids), bestAsk: asks.length > 1 && ask === Math.min(...asks),
    }
  })
  const times = Object.values(markets).map((m) => visibleBook(m.sync)?.time ?? 0)
  const status: FrameStatus = rows.some((r) => r.status === 'live') ? 'live' : 'syncing'
  return { kind: 'compare', key, version, status, venueTime: Math.max(0, ...times), rows }
}
