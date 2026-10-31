import type { Network } from '@tape/core/ids'
import { ZERO, abs, add, amount, divide, format, multiply, negate, plain, subtract, sum } from './money'
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
    .sort((left, right) => left.time - right.time)
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
    let tally = groups.get(key)
    if (!tally) {
      tally = { group, asset: entry.asset, fills: 0, pnl: [], fees: [], funding: [] }
      groups.set(key, tally)
    }
    return tally
  }
  for (const fill of fills) {
    const tally = acc(fill)
    tally.fills += 1
    tally.pnl.push(amount(fill.pnl))
    tally.fees.push(amount(fill.fee))
  }
  for (const payment of funding) acc(payment).funding.push(amount(payment.amount))
  return [...groups.values()]
    .sort((left, right) =>
      left.group === right.group ? left.asset.localeCompare(right.asset) : left.group.localeCompare(right.group),
    )
    .map((tally) => {
      const realized = sum(tally.pnl)
      const fees = sum(tally.fees)
      const paid = sum(tally.funding)
      return {
        group: tally.group,
        asset: tally.asset,
        fills: tally.fills,
        payments: tally.funding.length,
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
  const common = (entry: HistoryFill | FundingPayment) => ({
    time_utc: new Date(entry.time).toISOString(),
    timestamp_ms: String(entry.time),
    venue: entry.venue,
    network,
    account: entry.account,
    market: entry.symbol,
    asset: entry.asset,
  })
  const rows: { time: number; row: CsvRow }[] = [
    ...fills.map((fill) => ({
      time: fill.time,
      row: {
        ...common(fill),
        type: 'fill',
        side: fill.side,
        size: fill.size,
        price: fill.px,
        notional: plain(multiply(amount(fill.px), amount(fill.size))),
        fee: fill.fee,
        realized_pnl: fill.pnl,
        realized_pnl_source: fill.pnlSource,
        funding: '',
        funding_rate: '',
        liquidation: String(fill.liquidation),
        venue_id: fill.id,
      },
    })),
    ...funding.map((payment) => ({
      time: payment.time,
      row: {
        ...common(payment),
        type: 'funding',
        side: '',
        size: payment.position ?? '',
        price: '',
        notional: '',
        fee: '',
        realized_pnl: '',
        realized_pnl_source: '',
        funding: payment.amount,
        funding_rate: payment.rate ?? '',
        liquidation: '',
        venue_id: '',
      },
    })),
  ].sort((left, right) => left.time - right.time)
  return [
    CSV_COLUMNS.join(','),
    ...rows.map(({ row }) => CSV_COLUMNS.map((column) => field(row[column])).join(',')),
  ].join('\r\n')
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
    const fresh = got.filter((row) => !seen.has(walk.keyOf(row)))
    for (const row of fresh) {
      seen.add(walk.keyOf(row))
      rows.push(row)
    }
    if (got.length < walk.size) return { rows, stalled: false }
    if (fresh.length === 0) return { rows, stalled: true }
    start = walk.timeOf(got[got.length - 1]!)
  }
}

/** A venue, market and period to keep. `from` and `to` are UTC days, both kept whole. */
export interface HistoryFilter {
  readonly venue: TradeVenueId | null
  readonly market: string | null
  readonly from: string | null
  readonly to: string | null
}

const DAY_MS = 86_400_000

/**
 * Realizes every fill over the whole history first, so a period that starts with a position open
 * still realizes against the entry it had.
 */
export function selectHistory(histories: readonly VenueHistory[], filter: HistoryFilter) {
  const from = filter.from ? Date.parse(`${filter.from}T00:00:00Z`) : -Infinity
  const to = filter.to ? Date.parse(`${filter.to}T00:00:00Z`) + DAY_MS : Infinity
  const onVenue = (entry: HistoryFill | FundingPayment) => filter.venue === null || entry.venue === filter.venue
  const keep = (entry: HistoryFill | FundingPayment) =>
    onVenue(entry)
    && (filter.market === null || entry.symbol === filter.market)
    && entry.time >= from
    && entry.time < to
  const fills = realize(histories.flatMap((history) => history.fills))
  const funding = histories.flatMap((history) => history.funding)
  return {
    fills: fills.filter(keep),
    funding: funding.filter(keep),
    markets: [...new Set([...fills, ...funding].filter(onVenue).map((entry) => entry.symbol))].sort(),
  }
}
