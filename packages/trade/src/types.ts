import type { Address, Hex } from 'viem'
import type { Brand, Network, VenueId } from '@tape/core/ids'
import type { Px, Qty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import type { VenueHistory } from './history'
import type { MarginState } from './liquidation'

export const READ_ONLY_VENUES = ['binance'] as const
export type TradeVenueId = Exclude<VenueId, (typeof READ_ONLY_VENUES)[number]>

export function isTradeVenue(venue: VenueId): venue is TradeVenueId {
  return !(READ_ONLY_VENUES as readonly VenueId[]).includes(venue)
}

export interface AccountRef {
  readonly venue: TradeVenueId
  readonly network: Network
  /** Lowercase. */
  readonly owner: Address
}
export type AccountKey = Brand<string, 'AccountKey'>
export const accountKey = (ref: AccountRef) => `${ref.venue}:${ref.network}:${ref.owner}` as AccountKey

export type Side = 'buy' | 'sell'
export type Tif = 'gtc' | 'ioc' | 'post-only'
export type Bps = Brand<number, 'Bps'>

/** An exact decimal string as the venue sent it, for display values that never go back into an order. */
export type Decimal = Brand<string, 'Decimal'>

/** 128 random bits. Hyperliquid takes it as cloid, Orderly as client_order_id, dYdX folds it to uint32. */
export type ClientOrderId = Brand<Hex, 'ClientOrderId'>

/**
 * What the user asked for, in the units of the market on screen. The venue module re-reads the
 * same decimals against the rules of the network it sends to, which can differ on testnet.
 */
export type OrderIntent = Brand<IntentFields & { readonly clientId: ClientOrderId }, 'OrderIntent'>

export type IntentFields = {
  readonly spec: MarketSpec
  readonly side: Side
  readonly size: Qty
  readonly reduceOnly: boolean
  /** Market carries no price: the module reads the touch from the network it sends to. */
  readonly order:
    | { readonly kind: 'limit'; readonly px: Px; readonly tif: Tif }
    | { readonly kind: 'market'; readonly slippage: Bps }
    | { readonly kind: 'scale'; readonly tif: Exclude<Tif, 'ioc'>; readonly legs: readonly ScaleLeg[] }
    | { readonly kind: 'trailing'; readonly retracement: Retracement; readonly activation: Px | null }
  readonly triggers: { readonly takeProfits: readonly TakeProfit[]; readonly stopLoss: Px | null }
}

/** One reduce-only trigger that closes `size` of the order at `px`. The sizes of an intent's take profits sum to its size. */
export interface TakeProfit {
  readonly px: Px
  readonly size: Qty
}

/**
 * How far the price comes back from its best since activation before the venue fires the stop: a
 * share of that best price, or a distance in price. The venue holds the best price, not the browser.
 */
export type Retracement = { readonly pct: Bps } | { readonly px: Px }

/** One limit order of a scale order. The first leg carries the intent's clientId. */
export interface ScaleLeg {
  readonly px: Px
  readonly size: Qty
  readonly clientId: ClientOrderId
}

/** Opaque outside the module that made it. Carries what that venue needs to cancel. */
export type OrderRef = Brand<string, 'OrderRef'>

export type Command =
  | { readonly kind: 'place'; readonly intent: OrderIntent }
  | { readonly kind: 'cancel'; readonly order: OrderRef }
  | { readonly kind: 'cancel-all'; readonly symbol: string }
  | { readonly kind: 'leverage'; readonly symbol: string; readonly leverage: number }

/** What the venue says about an order whose send had no answer. `absent` is the venue's own reply, not a timeout. */
export type OrderLookup =
  { readonly kind: 'found'; readonly detail: string } | { readonly kind: 'absent'; readonly detail: string }

export type CommandOutcome =
  | { readonly kind: 'placed'; readonly status: 'resting' | 'filled' | 'accepted'; readonly detail: string }
  | { readonly kind: 'done'; readonly detail: string }

export interface Position {
  readonly symbol: string
  readonly side: 'long' | 'short'
  readonly size: Decimal
  readonly entry: Decimal
  readonly unrealizedPnl: Decimal
  readonly liquidation: Decimal | null
  readonly leverage: string | null
}

export interface OpenOrder {
  readonly ref: OrderRef
  readonly symbol: string
  readonly side: Side
  readonly kind: string
  readonly px: Decimal | null
  readonly size: Decimal
  readonly reduceOnly: boolean
  readonly placedAt: number
}

export interface Fill {
  readonly id: string
  readonly symbol: string
  readonly side: Side
  readonly px: Decimal
  readonly size: Decimal
  readonly fee: Decimal
  readonly time: number
}

export interface AccountSnapshot {
  readonly equity: Decimal
  readonly available: Decimal
  readonly positions: readonly Position[]
  readonly orders: readonly OpenOrder[]
  readonly fills: readonly Fill[]
}

/** unknown: the venue account cannot be located before setup (dYdX's address comes from the key). */
export type AccountView =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'live'; readonly snapshot: AccountSnapshot }

export type StepId = 'register-account' | 'approve-agent' | 'approve-builder' | 'derive-key' | 'add-key'
export interface SetupStep {
  readonly id: StepId
  readonly label: string
  readonly done: boolean
}

export interface Capabilities {
  readonly tif: readonly Tif[]
  /** Null where the venue takes no take profit or stop loss with an order. */
  readonly triggers: { readonly takeProfits: number } | null
  readonly leverage: boolean
  /** The most legs one scale order sends, all in one request. 0 where the venue takes no such request. */
  readonly scaleOrders: number
  /** The venue keeps a stop that trails the price, so it fires with the browser closed. */
  readonly trailingStop: boolean
}

export type TradeError =
  | { readonly kind: 'wallet-rejected' }
  | { readonly kind: 'needs-setup'; readonly detail: string }
  | { readonly kind: 'no-account'; readonly detail: string }
  | { readonly kind: 'insufficient-margin'; readonly detail: string }
  | { readonly kind: 'invalid-order'; readonly detail: string }
  | { readonly kind: 'rejected'; readonly detail: string }
  | { readonly kind: 'rate-limited'; readonly detail: string }
  | { readonly kind: 'unsupported'; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'unknown-outcome'; readonly detail: string }
  | { readonly kind: 'unexpected'; readonly detail: string }

export class TradeFailure extends Error {
  constructor(
    readonly venue: TradeVenueId,
    readonly error: TradeError,
  ) {
    super(`${venue}: ${error.kind}${'detail' in error ? `: ${error.detail}` : ''}`)
  }
}

/** EIP-712 JSON as eth_signTypedData_v4 takes it. EIP712Domain is derived from the domain's keys. */
export interface Eip712 {
  readonly domain: Readonly<Record<string, string | number>>
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>
  readonly primaryType: string
  readonly message: Readonly<Record<string, unknown>>
}

export interface WalletSigner {
  readonly address: Address
  /** The wallet's active chain. Wallets refuse a domain chainId that differs. */
  chainId: () => Promise<number>
  switchChain: (chainId: number) => Promise<void>
  signTypedData: (data: Eip712) => Promise<Hex>
}

/** 'tab' is sessionStorage: dYdX's derived key can withdraw, so it never sits on disk. */
export type SecretLifetime = 'device' | 'tab'

/** draft: key made, venue not yet confirmed every step. linked: setup finished with it. */
export interface StoredKey {
  readonly status: 'draft' | 'linked'
  readonly public: Readonly<Record<string, string>>
  readonly secret: string | null
}

export interface KeySlot {
  read: () => StoredKey | null
  write: (key: StoredKey) => void
  clear: () => void
}

/** Null builder means no fee, null broker means the network is off. */
export interface TradeConfig {
  readonly mainnet: boolean
  readonly hyperliquid: { readonly builder: { readonly b: Address; readonly f: number } | null }
  readonly dydx: { readonly builder: { readonly builderAddress: string; readonly feePpm: number } | null }
  readonly orderly: { readonly brokerId: { readonly mainnet: string | null; readonly testnet: string } }
}

export interface VenueContext {
  readonly ref: AccountRef
  readonly config: TradeConfig
  readonly keys: KeySlot
  readonly fetch: typeof globalThis.fetch
}

/** Whose history to read. dYdX takes the account's dydx1 address, the others the wallet address. */
export interface HistoryRequest {
  readonly network: Network
  readonly address: string
  readonly fetch: typeof globalThis.fetch
}

export interface TradingVenue {
  readonly id: TradeVenueId
  readonly label: string
  readonly secrets: SecretLifetime
  readonly capabilities: Capabilities
  /** The chain id the wallet switches to before it signs setup. Absent where any chain works. */
  readonly walletChain?: Readonly<Record<Network, number>>
  /** Null when trading works on this network, otherwise why not. */
  unavailable: (network: Network, config: TradeConfig) => string | null
  /** Read from the venue and the slot. Funding is not a step: an unfunded account gets no-account from the venue. */
  steps: (ctx: VenueContext) => Promise<readonly SetupStep[]>
  /** Runs the undone steps. A new key is written as draft before the wallet signs for it. */
  enable: (ctx: VenueContext, wallet: WalletSigner, onStep: (step: StepId) => void) => Promise<void>
  account: (ctx: VenueContext) => Promise<AccountView>
  /** Absent where Tape cannot rebuild the venue's liquidation math. */
  margin?: (ctx: VenueContext, symbol: string) => Promise<MarginState>
  /** Signs with the slot's key, draft or linked, and lets the venue judge. */
  execute: (ctx: VenueContext, command: Command) => Promise<CommandOutcome>
  /** Asks the venue for the order by its clientId, after a send that ended in unknown-outcome. */
  lookup: (ctx: VenueContext, intent: OrderIntent) => Promise<OrderLookup>
  /** Every fill and funding payment the venue still serves, read without a key. */
  history: (request: HistoryRequest) => Promise<VenueHistory>
}

export type TradingRegistry = { readonly [V in TradeVenueId]: TradingVenue & { readonly id: V } }
