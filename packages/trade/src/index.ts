import { dydx } from './dydx'
import { hyperliquid } from './hyperliquid'
import { orderly } from './orderly'
import type { TradingRegistry } from './types'

export const TRADING: TradingRegistry = { hyperliquid, dydx, orderly }
