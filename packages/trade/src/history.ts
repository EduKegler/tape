import { ZERO, abs, add, amount, divide, format, multiply, negate, plain as plainAmount, subtract } from './money'
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
