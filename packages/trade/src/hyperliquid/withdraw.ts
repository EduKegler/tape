import { z } from 'zod'
import { wireDecimal } from '@tape/core/fixed'
import type { Network } from '@tape/core/ids'
import { USDC_DECIMALS, parseUsdc } from '../deposit'
import { post, readReply, send } from '../send'
import type { VenueContext, WalletSigner } from '../types'
import type { SentWithdrawal, WithdrawProgress, WithdrawVenue } from '../withdraw'
import { userAction } from './index'

const API: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
}
const EXPLORER: Record<Network, string> = {
  mainnet: 'https://app.hyperliquid.xyz/explorer',
  testnet: 'https://app.hyperliquid-testnet.xyz/explorer',
}
const CHAIN = { mainnet: 'Mainnet', testnet: 'Testnet' } as const
/** Hyperliquid's bridge pays out on Arbitrum. */
const ARRIVAL: Record<Network, number> = { mainnet: 42161, testnet: 421614 }

/** Hyperliquid's withdrawal fee from its exchange endpoint docs, taken out of the amount. */
const FEE = 1_000_000n
/** "Withdrawals take approximately 5 minutes to finalize", from the same docs. */
const ETA_SECONDS = 300
const POLL_EVERY = 15_000
/** Hyperliquid's ledger keeps a withdrawal's nonce in microseconds, the signed millisecond times 1000. */
const LEDGER_NONCE = 1000

const Ledger = z.array(
  z.object({
    time: z.coerce.number(),
    delta: z.looseObject({ type: z.string(), usdc: z.string().optional(), nonce: z.coerce.number().optional() }),
  }),
)

async function withdraw(ctx: VenueContext, wallet: WalletSigner, amount: bigint): Promise<SentWithdrawal> {
  const time = Date.now()
  const message = {
    hyperliquidChain: CHAIN[ctx.ref.network],
    destination: ctx.ref.owner,
    amount: wireDecimal(amount, USDC_DECIMALS),
    time,
  }
  await userAction(ctx, wallet, 'HyperliquidTransaction:Withdraw', message, { type: 'withdraw3' }, time)
  return { amount, nonce: time }
}

/** The ledger shows a withdrawal once Hyperliquid finalizes it, with what it sends after the fee. */
async function progress(ctx: VenueContext, sent: SentWithdrawal): Promise<WithdrawProgress> {
  const body = await send(
    'hyperliquid',
    ctx.fetch,
    `${API[ctx.ref.network]}/info`,
    { ...post({ type: 'userNonFundingLedgerUpdates', user: ctx.ref.owner, startTime: sent.nonce }), mutates: false },
    () => null,
  )
  const entry = readReply('hyperliquid', Ledger, body, false).find(
    (update) => update.delta.type === 'withdraw' && update.delta.nonce === sent.nonce * LEDGER_NONCE,
  )
  const received = entry?.delta.usdc ? parseUsdc(entry.delta.usdc) : null
  return entry && received ? { stage: 'finalized', received, at: entry.time } : { stage: 'pending' }
}

export const hyperliquidWithdraw: WithdrawVenue = {
  source: 'Hyperliquid perps',
  chainId: ARRIVAL,
  hops: ['Hyperliquid bridge'],
  fee: FEE,
  eta: ETA_SECONDS,
  pollEvery: POLL_EVERY,
  check: (ref) => ({ label: 'Hyperliquid explorer', url: `${EXPLORER[ref.network]}/address/${ref.owner}` }),
  withdraw,
  progress,
}
