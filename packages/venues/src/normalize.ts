import { parsePx, parseQty } from '@tape/core/fixed'
import type { Level } from '@tape/core/book'
import type { Candle, MarketSpec, Trade } from '@tape/core/market'
import type { RawCandle, RawLevel, RawTrade } from './types'

/** Throws DecimalError on anything the spec does not allow. */
export function toLevels(raw: readonly RawLevel[], spec: MarketSpec): Level[] {
  return raw.map(([px, qty]) => [parsePx(px, spec.scale), parseQty(qty, spec.scale)] as const)
}

export function toTrades(raw: readonly RawTrade[], spec: MarketSpec): Trade[] {
  return raw.map((trade) => ({
    id: trade.id,
    side: trade.side,
    time: trade.time,
    px: parsePx(trade.px, spec.scale),
    qty: parseQty(trade.qty, spec.scale),
  }))
}

export function toCandle(raw: RawCandle, spec: MarketSpec): Candle {
  const px = (value: string) => parsePx(value, spec.scale)
  return { open: raw.open, o: px(raw.o), h: px(raw.h), l: px(raw.l), c: px(raw.c), v: parseQty(raw.v, spec.scale) }
}
