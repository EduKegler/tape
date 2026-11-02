import { isHex } from 'viem'
import type { Address, Hex } from 'viem'
import { wireDecimal } from '@tape/core/fixed'
import type { Brand, Network } from '@tape/core/ids'
import type { Px, Qty } from '@tape/core/fixed'
import type { MarketSpec } from '@tape/core/market'
import type { VenueHistory } from './history'
import type { MarginState } from './liquidation'

import type { TradeVenueId } from './venue-ids'

export type { TradeVenueId } from './venue-ids'

export interface AccountRef {
  readonly venue: TradeVenueId
  readonly network: Network
  /** Lowercase. */
  readonly owner: Address
}
export type AccountKey = Brand<string, 'AccountKey'>
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place an AccountKey is made, from a typed ref
export const accountKey = (ref: AccountRef) => `${ref.venue}:${ref.network}:${ref.owner}` as AccountKey

export type Side = 'buy' | 'sell'

const TIFS = ['gtc', 'ioc', 'post-only'] as const
export type Tif = (typeof TIFS)[number]

export function isTif(value: string): value is Tif {
  return (TIFS as readonly string[]).includes(value)
}

export type Bps = Brand<number, 'Bps'>

export function isBps(value: number): value is Bps {
  return Number.isSafeInteger(value)
}

/** Throws RangeError on a count that is not a whole number of basis points. */
export function toBps(value: number): Bps {
  if (!isBps(value)) throw new RangeError(`${value} is not a whole number of basis points`)
  return value
}

/** An exact decimal string as the venue sent it, for display values that never go back into an order. */
export type Decimal = Brand<string, 'Decimal'>

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/

/** A plain decimal such as `-12.5`, with no exponent and no grouping. */
export function isDecimal(text: string): text is Decimal {
  return PLAIN_DECIMAL.test(text)
}

/** Throws TypeError on text that is not a plain decimal. */
export function toDecimal(text: string): Decimal {
  if (!isDecimal(text)) throw new TypeError(`${text} is not a plain decimal`)
  return text
}

/** 128 random bits. Hyperliquid takes it as cloid, Orderly as client_order_id, dYdX folds it to uint32. */
export type ClientOrderId = Brand<Hex, 'ClientOrderId'>

/** 32 lowercase hex digits after `0x`. */
export function isClientOrderId(value: Hex): value is ClientOrderId {
  return /^0x[0-9a-f]{32}$/.test(value)
}

/**
 * What the user asked for, in the units of the market on screen. The venue module re-reads the
 * same decimals against the rules of the network it sends to, which can differ on testnet.
 */
export type OrderIntent = Brand<IntentFields & { readonly clientId: ClientOrderId }, 'OrderIntent'>

/** What a venue module reads of a market to check and price an order on the network it sends to. */
export type OrderRules = Pick<MarketSpec, 'venueSymbol' | 'scale' | 'tick' | 'step'>

export type IntentFields = {
  readonly spec: MarketSpec
  readonly side: Side
  readonly size: Qty
  readonly reduceOnly: boolean
  /**
   * Market and mid carry no price: the module reads the touch from the network it sends to. Mid
   * rests at the middle of the touch, on the tick on the passive side.
   */
  readonly order:
    | { readonly kind: 'limit'; readonly px: Px; readonly tif: Tif }
    | { readonly kind: 'market'; readonly slippage: Bps }
    | { readonly kind: 'mid' }
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

/** The parts joined by `:`, in the order the venue module reads them back. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place an OrderRef is made
export const orderRef = (...parts: readonly (string | number)[]) => parts.join(':') as OrderRef

export type Command =
  | { readonly kind: 'place'; readonly intent: OrderIntent }
  | { readonly kind: 'cancel'; readonly order: OrderRef }
  /** Every open order on one market, or on every market when the symbol is null. */
  | { readonly kind: 'cancel-all'; readonly symbol: string | null }
  | { readonly kind: 'leverage'; readonly symbol: string; readonly leverage: number }
  /** Replaces a resting limit with the intent's price and size. The intent carries a new client id. */
  | { readonly kind: 'modify'; readonly order: OrderRef; readonly intent: OrderIntent }
  | { readonly kind: 'protect'; readonly intent: ProtectIntent }
  /** One reduce-only order per position, each sent and reported on its own. */
  | { readonly kind: 'close-all'; readonly intents: readonly OrderIntent[] }

/**
 * One kind of exit on a position: left alone, removed, or set to a trigger price. `legs` are the
 * orders that stand for it now, which a set replaces and a remove cancels.
 */
export type ExitEdit =
  | { readonly kind: 'keep' }
  | { readonly kind: 'remove'; readonly legs: readonly OrderRef[] }
  | { readonly kind: 'set'; readonly px: Px; readonly clientId: ClientOrderId; readonly legs: readonly OrderRef[] }

/** A take profit and a stop loss that close the whole position at market once the trigger trades. */
export interface ProtectIntent {
  readonly spec: MarketSpec
  readonly position: 'long' | 'short'
  /** The position's size, for a venue whose exits carry one. */
  readonly size: Qty
  readonly takeProfit: ExitEdit
  readonly stopLoss: ExitEdit
}

/** What a write sent that its venue can find again, after a send that ended in unknown-outcome. */
export interface SentOrders {
  readonly venueSymbol: string
  readonly clientIds: readonly ClientOrderId[]
  /** Hyperliquid's trailingStop action takes no client id, so its order is found by side, size and the time it went out. */
  readonly trailing?: { readonly side: Side; readonly size: Decimal; readonly sentAt: number }
}

/** Null for a write that carries no order: a cancel or a leverage change. `sentAt` is when the write went out. */
export function sentOrders(command: Command, sentAt = Date.now()): SentOrders | null {
  if (command.kind === 'protect') {
    const { spec, takeProfit, stopLoss } = command.intent
    const clientIds = [takeProfit, stopLoss].flatMap((edit) => (edit.kind === 'set' ? [edit.clientId] : []))
    return clientIds.length > 0 ? { venueSymbol: spec.venueSymbol, clientIds } : null
  }
  if (command.kind !== 'place' && command.kind !== 'modify') return null
  const { intent } = command
  if (intent.order.kind === 'trailing')
    return {
      venueSymbol: intent.spec.venueSymbol,
      clientIds: [],
      trailing: { side: intent.side, size: toDecimal(wireDecimal(intent.size, intent.spec.scale.qty)), sentAt },
    }
  return {
    venueSymbol: intent.spec.venueSymbol,
    clientIds: intent.order.kind === 'scale' ? intent.order.legs.map((leg) => leg.clientId) : [intent.clientId],
  }
}

/** What the venue says about an order whose send had no answer. `absent` is the venue's own reply, not a timeout. */
export type OrderLookup =
  { readonly kind: 'found'; readonly detail: string } | { readonly kind: 'absent'; readonly detail: string }

/** One close of a close-all. An unknown-outcome error is found afterwards through `sent`. */
export type CloseRow = { readonly symbol: string; readonly sent: SentOrders } & (
  { readonly outcome: CommandOutcome } | { readonly error: TradeError }
)

export type CommandOutcome =
  | {
      readonly kind: 'placed'
      readonly status: 'resting' | 'filled' | 'accepted'
      readonly detail: string
      /** The size and average price of an order that filled at once, where the venue's reply says. */
      readonly fill?: { readonly size: Decimal; readonly price: Decimal }
    }
  | { readonly kind: 'done'; readonly detail: string }
  | { readonly kind: 'closed'; readonly rows: readonly CloseRow[]; readonly detail: string }
  | { readonly kind: 'canceled'; readonly orders: readonly OpenOrder[]; readonly detail: string }

export interface Position {
  readonly symbol: string
  readonly side: 'long' | 'short'
  readonly size: Decimal
  readonly entry: Decimal
  /** The venue's mark price, null where its account read sends none. */
  readonly mark: Decimal | null
  readonly unrealizedPnl: Decimal
  readonly liquidation: Decimal | null
  readonly leverage: string | null
}

/** A take profit or a stop loss. `whole` when it closes the whole position at whatever size it has then. */
export interface OrderExit {
  readonly kind: 'tp' | 'sl'
  readonly whole: boolean
}

/** How a trailing stop trails: from its activation price, or at once when that is null, by a share or a price distance. */
export interface Trail {
  readonly activation: Decimal | null
  readonly retracement: { readonly pct: Decimal } | { readonly px: Decimal }
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
  /** False for an order Tape lists but cannot cancel, such as a Hyperliquid spot order. */
  readonly cancelable: boolean
  readonly exit: OrderExit | null
  /** Set on a trailing stop. Its `px` is the stop it trails at, null until it activates. */
  readonly trail?: Trail
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

/** confirm-key: the wallet signs the derive-key request a second time, to show it signs it the same way. */
export type StepId = 'register-account' | 'approve-agent' | 'approve-builder' | 'derive-key' | 'confirm-key' | 'add-key'
export interface SetupStep {
  readonly id: StepId
  readonly label: string
  readonly done: boolean
}

export interface Capabilities {
  readonly tif: readonly Tif[]
  /** The most take profits and stop losses one order carries, counted together. Null where the venue takes none with an order. */
  readonly triggers: { readonly orders: number } | null
  readonly leverage: boolean
  /** The most legs one scale order sends, all in one request. 0 where the venue takes no such request. */
  readonly scaleOrders: number
  /** The venue keeps a stop that trails the price, so it fires with the browser closed. */
  readonly trailingStop: boolean
  /** A reduce-only limit can rest on the book. False where the venue takes reduce-only only as IOC. */
  readonly restingReduceOnly: boolean
  /** A take profit or stop loss can close the whole position at whatever size it reaches. False where each carries a size. */
  readonly wholeExits: boolean
}

export type TradeError =
  | { readonly kind: 'wallet-rejected' }
  /** The wallet signed the same request two ways, so a key derived from its signature would differ per tab. */
  | { readonly kind: 'nondeterministic-wallet' }
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

/** A stored secret as the hex it was written as. Throws on one that is not hex. */
export function secretHex(secret: string): Hex {
  if (!isHex(secret)) throw new Error('The stored secret is not hex')
  return secret
}

export interface KeySlot {
  read: () => StoredKey | null
  write: (key: StoredKey) => void
  clear: () => void
}

/** Mainnet names the venues that send orders on mainnet. Null builder means no fee, null broker means the network is off. */
export interface TradeConfig {
  readonly mainnet: ReadonlySet<TradeVenueId>
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
  /** Has the wallet sign that the venue stops taking orders from the slot's key. Absent where only the device forgets it. */
  revoke?: (ctx: VenueContext, wallet: WalletSigner) => Promise<void>
  account: (ctx: VenueContext) => Promise<AccountView>
  /** Absent where Tape cannot rebuild the venue's liquidation math. */
  margin?: (ctx: VenueContext, symbol: string) => Promise<MarginState>
  /** Signs with the slot's key, draft or linked, and lets the venue judge. */
  execute: (ctx: VenueContext, command: Command) => Promise<CommandOutcome>
  /** Asks the venue for each order it sent, after a send that ended in unknown-outcome. */
  lookup: (ctx: VenueContext, sent: SentOrders) => Promise<OrderLookup>
  /** Every fill and funding payment the venue still serves, read without a key. */
  history: (request: HistoryRequest) => Promise<VenueHistory>
}

export type TradingRegistry = { readonly [V in TradeVenueId]: TradingVenue & { readonly id: V } }
