import type { Network } from '@tape/core/ids'
import { ZERO, abs, add, amount, divide, format, multiply, negate, plain as plainAmount, subtract, sum } from './money'
import type { Amount } from './money'
import type { Decimal, Fill, TradeVenueId } from './types'

/** `fee` is positive when paid and negative for a rebate. */
export interface HistoryFill extends Fill {
  readonly venue: TradeVenueId
  /** The venue account the fill belongs to. An address can hold several, and each keeps its own positions. */
  readonly account: string
  /** What the fee and the PnL settle in. */
  readonly asset: string
  readonly liquidation: boolean
  /** Realized PnL as the venue reports it, before fees and funding. Null where the venue reports none. */
  readonly venuePnl: Decimal | null
}

export interface FundingPayment {
  readonly venue: TradeVenueId
  readonly account: string
  readonly symbol: string
  readonly time: number
  /** Received is positive, paid negative. */
  readonly amount: Decimal
  readonly asset: string
  readonly rate: Decimal | null
  /** Signed: long positive. */
  readonly position: Decimal | null
}

export interface VenueHistory {
  readonly fills: readonly HistoryFill[]
  readonly funding: readonly FundingPayment[]
  /** What the venue does not serve or cut short, in words for the user. */
  readonly gaps: readonly string[]
}

export interface RealizedFill extends HistoryFill {
  readonly pnl: Decimal
  readonly pnlSource: 'venue' | 'computed'
}

interface Book {
  signedSize: Amount
  entryCost: Amount
}

const plain = (value: Amount) => plainAmount(value) as Decimal
/** USDC, which every venue here settles PnL in, has 6 decimals. */
const SETTLED_PLACES = 6
const settled = (value: Amount) => plain(amount(format(value, SETTLED_PLACES)))

function realizeAtAverageCost(book: Book, fill: HistoryFill): Amount {
  const px = amount(fill.px)
  const size = amount(fill.size)
  const signed = fill.side === 'buy' ? size : negate(size)
  if (book.signedSize === ZERO || book.signedSize > 0n === signed > 0n) {
    book.signedSize = add(book.signedSize, signed)
    book.entryCost = add(book.entryCost, multiply(size, px))
    return ZERO
  }
  const open = abs(book.signedSize)
  const closed = size < open ? size : open
  const closedCost = divide(multiply(book.entryCost, closed), open)
  const gross = subtract(multiply(closed, px), closedCost)
  const realized = book.signedSize > 0n ? gross : negate(gross)
  book.entryCost = subtract(book.entryCost, closedCost)
  book.signedSize = add(book.signedSize, fill.side === 'buy' ? closed : negate(closed))
  const rest = subtract(size, closed)
  if (rest > 0n) {
    book.signedSize = fill.side === 'buy' ? rest : negate(rest)
    book.entryCost = multiply(rest, px)
  }
  if (book.signedSize === ZERO) book.entryCost = ZERO
  return realized
}

/** Sorts by time, then realizes each fill. Correct only from a flat start, so callers pass an account's whole history. */
export function realize(fills: readonly HistoryFill[]): RealizedFill[] {
  const books = new Map<string, Book>()
  return [...fills]
    .sort((a, b) => a.time - b.time)
    .map((fill) => {
      const key = `${fill.venue}:${fill.account}:${fill.symbol}`
      let book = books.get(key)
      if (!book) {
        book = { signedSize: ZERO, entryCost: ZERO }
        books.set(key, book)
      }
      const computed = realizeAtAverageCost(book, fill)
      return fill.venuePnl === null
        ? { ...fill, pnl: settled(computed), pnlSource: 'computed' }
        : { ...fill, pnl: fill.venuePnl, pnlSource: 'venue' }
    })
}

export interface Totals {
  readonly group: string
  readonly asset: string
  readonly fills: number
  readonly payments: number
  readonly realized: Decimal
  readonly fees: Decimal
  readonly funding: Decimal
  /** Realized minus fees plus funding. */
  readonly net: Decimal
}

/** One row per group and settlement asset, sorted by both. */
export function summarize(
  fills: readonly RealizedFill[],
  funding: readonly FundingPayment[],
  groupOf: (entry: HistoryFill | FundingPayment) => string,
): Totals[] {
  type Acc = { group: string; asset: string; fills: number; pnl: Amount[]; fees: Amount[]; funding: Amount[] }
  const groups = new Map<string, Acc>()
  const acc = (entry: HistoryFill | FundingPayment) => {
    const group = groupOf(entry)
    const key = `${group}\u0000${entry.asset}`
    let a = groups.get(key)
    if (!a) {
      a = { group, asset: entry.asset, fills: 0, pnl: [], fees: [], funding: [] }
      groups.set(key, a)
    }
    return a
  }
  for (const f of fills) {
    const a = acc(f)
    a.fills += 1
    a.pnl.push(amount(f.pnl))
    a.fees.push(amount(f.fee))
  }
  for (const p of funding) acc(p).funding.push(amount(p.amount))
  return [...groups.values()]
    .sort((x, y) => (x.group === y.group ? x.asset.localeCompare(y.asset) : x.group.localeCompare(y.group)))
    .map((a) => {
      const realized = sum(a.pnl)
      const fees = sum(a.fees)
      const paid = sum(a.funding)
      return {
        group: a.group,
        asset: a.asset,
        fills: a.fills,
        payments: a.funding.length,
        realized: plain(realized),
        fees: plain(fees),
        funding: plain(paid),
        net: plain(add(subtract(realized, fees), paid)),
      }
    })
}

export const CSV_COLUMNS = [
  'time_utc',
  'timestamp_ms',
  'venue',
  'network',
  'account',
  'type',
  'market',
  'side',
  'size',
  'price',
  'notional',
  'fee',
  'asset',
  'realized_pnl',
  'realized_pnl_source',
  'funding',
  'funding_rate',
  'liquidation',
  'venue_id',
] as const

type CsvRow = Record<(typeof CSV_COLUMNS)[number], string>

const field = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

/** RFC 4180 with CRLF, oldest first. The README's History CSV section is the column contract. */
export function toCsv(fills: readonly RealizedFill[], funding: readonly FundingPayment[], network: Network): string {
  const common = (e: HistoryFill | FundingPayment) => ({
    time_utc: new Date(e.time).toISOString(),
    timestamp_ms: String(e.time),
    venue: e.venue,
    network,
    account: e.account,
    market: e.symbol,
    asset: e.asset,
  })
  const rows: { time: number; row: CsvRow }[] = [
    ...fills.map((f) => ({
      time: f.time,
      row: {
        ...common(f),
        type: 'fill',
        side: f.side,
        size: f.size,
        price: f.px,
        notional: plain(multiply(amount(f.px), amount(f.size))),
        fee: f.fee,
        realized_pnl: f.pnl,
        realized_pnl_source: f.pnlSource,
        funding: '',
        funding_rate: '',
        liquidation: String(f.liquidation),
        venue_id: f.id,
      },
    })),
    ...funding.map((p) => ({
      time: p.time,
      row: {
        ...common(p),
        type: 'funding',
        side: '',
        size: p.position ?? '',
        price: '',
        notional: '',
        fee: '',
        realized_pnl: '',
        realized_pnl_source: '',
        funding: p.amount,
        funding_rate: p.rate ?? '',
        liquidation: '',
        venue_id: '',
      },
    })),
  ].sort((a, b) => a.time - b.time)
  return [CSV_COLUMNS.join(','), ...rows.map(({ row }) => CSV_COLUMNS.map((c) => field(row[c])).join(','))].join('\r\n')
}

/**
 * Reads a history the venue pages by start time. Each page restarts at the last time it returned, so
 * rows sharing that moment come back and are dropped by key. A full page with nothing new cannot move
 * past its moment, and the walk stops there with `stalled`.
 */
export async function walkByTime<T>(
  page: (start: number) => Promise<readonly T[]>,
  walk: { readonly size: number; readonly timeOf: (row: T) => number; readonly keyOf: (row: T) => string },
): Promise<{ rows: T[]; stalled: boolean }> {
  const seen = new Set<string>()
  const rows: T[] = []
  let start = 0
  for (;;) {
    const got = await page(start)
    const fresh = got.filter((r) => !seen.has(walk.keyOf(r)))
    for (const r of fresh) {
      seen.add(walk.keyOf(r))
      rows.push(r)
    }
    if (got.length < walk.size) return { rows, stalled: false }
    if (fresh.length === 0) return { rows, stalled: true }
    start = walk.timeOf(got[got.length - 1] as T)
  }
}

/** A venue, market and period to keep. `from` and `to` are UTC days, both kept whole. */
export interface HistoryFilter {
  readonly venue: TradeVenueId | null
  readonly market: string | null
  readonly from: string | null
  readonly to: string | null
  readonly kind: 'all' | 'fills' | 'funding'
}

const DAY_MS = 86_400_000

/**
 * Realizes every fill over the whole history first, so a period that starts with a position open
 * still realizes against the entry it had.
 */
export function selectHistory(histories: readonly VenueHistory[], filter: HistoryFilter) {
  const from = filter.from ? Date.parse(`${filter.from}T00:00:00Z`) : -Infinity
  const to = filter.to ? Date.parse(`${filter.to}T00:00:00Z`) + DAY_MS : Infinity
  const onVenue = (e: HistoryFill | FundingPayment) => filter.venue === null || e.venue === filter.venue
  const keep = (e: HistoryFill | FundingPayment) =>
    onVenue(e) && (filter.market === null || e.symbol === filter.market) && e.time >= from && e.time < to
  const fills = realize(histories.flatMap((h) => h.fills))
  const funding = histories.flatMap((h) => h.funding)
  return {
    fills: filter.kind === 'funding' ? [] : fills.filter(keep),
    funding: filter.kind === 'fills' ? [] : funding.filter(keep),
    markets: [...new Set([...fills, ...funding].filter(onVenue).map((e) => e.symbol))].sort(),
  }
}
