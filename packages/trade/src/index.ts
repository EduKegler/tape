import type { DepositVenue } from './deposit'
import { dydx } from './dydx'
import { hyperliquid } from './hyperliquid'
import { hyperliquidDeposit } from './hyperliquid/deposit'
import { orderly } from './orderly'
import type { TradeVenueId, TradingRegistry } from './types'

export const TRADING: TradingRegistry = { hyperliquid, dydx, orderly }

export const DEPOSITS: Partial<Record<TradeVenueId, DepositVenue>> = { hyperliquid: hyperliquidDeposit }
