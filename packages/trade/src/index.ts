import { dydx } from './dydx'
import { hyperliquid } from './hyperliquid'
import { orderly } from './orderly'
import type { TradingRegistry } from './types'

/** A trade venue without a module, or a module under the wrong key, fails the build. */
export const TRADING: TradingRegistry = { hyperliquid, dydx, orderly }
