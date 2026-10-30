import { z } from 'zod'
import type { Address } from 'viem'
import type { Network } from '@tape/core/ids'
import { parseUsdc, transferCall } from '../deposit'
import type { DepositProgress, DepositRoute, DepositVenue, SentDeposit } from '../deposit'
import { post, send } from '../send'

const API: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
}

/** Hyperliquid's own bridge on Arbitrum. It credits the sender, and keeps anything under 5 USDC without crediting it. */
const BRIDGE: Record<Network, { readonly chainId: number; readonly token: Address; readonly bridge: Address }> = {
  mainnet: {
    chainId: 42161,
    token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    bridge: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7',
  },
  testnet: {
    chainId: 421614,
    token: '0x1baAbB04529D43a73232B713C0FE471f7c7334d5',
    bridge: '0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89',
  },
}
const BRIDGE_MINIMUM = 5_000_000n

const bridgeRoute = (network: Network): DepositRoute => ({
  chainId: BRIDGE[network].chainId,
  token: BRIDGE[network].token,
  spender: null,
  hops: ['Hyperliquid bridge on Arbitrum'],
  minimum: { amount: BRIDGE_MINIMUM, lost: true },
  eta: { typical: 60, worst: 600 },
  fee: () => Promise.resolve({ expected: 0n, max: 0n }),
  calls: (_owner, amount) => [transferCall(BRIDGE[network].token, BRIDGE[network].bridge, amount)],
  progress: bridgeProgress,
})

const Ledger = z.array(
  z.object({
    time: z.coerce.number(),
    hash: z.string(),
    delta: z.looseObject({ type: z.string(), usdc: z.string().optional() }),
  }),
)

/** Looks back past the send, since the wallet's clock and Hyperliquid's can disagree. */
const LEDGER_SLACK_MS = 10 * 60_000

async function ledger(fetch: typeof globalThis.fetch, sent: SentDeposit) {
  const body = await send<unknown>(
    'hyperliquid',
    fetch,
    `${API[sent.ref.network]}/info`,
    {
      ...post({ type: 'userNonFundingLedgerUpdates', user: sent.ref.owner, startTime: sent.sentAt - LEDGER_SLACK_MS }),
      mutates: false,
    },
    () => null,
  )
  return Ledger.parse(body)
}

/** Hyperliquid's ledger names the bridge deposit by the Arbitrum transaction hash. */
async function bridgeProgress(fetch: typeof globalThis.fetch, sent: SentDeposit): Promise<DepositProgress> {
  const entry = (await ledger(fetch, sent)).find(
    (e) => e.delta.type === 'deposit' && e.hash.toLowerCase() === sent.hash.toLowerCase(),
  )
  const amount = entry?.delta.usdc ? parseUsdc(entry.delta.usdc) : null
  return entry && amount
    ? { stage: 'credited', amount, at: entry.time, receipt: entry.hash }
    : { stage: 'relaying', detail: 'Waiting for Hyperliquid to credit the bridge deposit' }
}

export const hyperliquidDeposit: DepositVenue = {
  destination: 'Hyperliquid perps',
  routes: (network) => [bridgeRoute(network)],
}
