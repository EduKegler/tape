import { z } from 'zod'
import type { Address } from 'viem'
import type { Network } from '@tape/core/ids'
import {
  CORE_DEPOSIT_WALLET,
  FORWARD_WORST,
  TOKEN_MESSENGER_V2,
  burnToHyperCore,
  followForward,
  hyperCoreFee,
} from '../cctp'
import { approveCall, parseUsdc, transferCall } from '../deposit'
import type { DepositFee, DepositProgress, DepositRoute, DepositTerms, DepositVenue, SentDeposit } from '../deposit'
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
const POLL_EVERY = 4_000
const feeOnly = (fee: DepositFee): DepositTerms => ({ fee, message: null, refusal: null })

const bridgeRoute = (network: Network): DepositRoute => ({
  chainId: BRIDGE[network].chainId,
  token: BRIDGE[network].token,
  spender: null,
  hops: ['Hyperliquid bridge on Arbitrum'],
  minimum: { amount: BRIDGE_MINIMUM, lost: true },
  eta: { typical: 60, worst: 600 },
  pollEvery: POLL_EVERY,
  terms: () => Promise.resolve(feeOnly({ expected: 0n, max: 0n })),
  calls: (_owner, amount) => [transferCall(BRIDGE[network].token, BRIDGE[network].bridge, amount)],
  progress: ({ fetch }, sent) => bridgeProgress(fetch, sent),
})

/** `domain` is Circle's CCTP id for the chain. */
const CCTP_SOURCES = [
  { chainId: 8453, domain: 6, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { chainId: 10, domain: 2, token: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  { chainId: 1, domain: 0, token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
] as const satisfies readonly { chainId: number; domain: number; token: Address }[]

const cctpRoute = ({ chainId, domain, token }: (typeof CCTP_SOURCES)[number]): DepositRoute => ({
  chainId,
  token,
  spender: TOKEN_MESSENGER_V2,
  hops: ['Circle CCTP', 'HyperEVM'],
  minimum: null,
  eta: { typical: 60, worst: FORWARD_WORST },
  pollEvery: POLL_EVERY,
  terms: ({ fetch }, _owner, amount) => hyperCoreFee('hyperliquid', fetch, domain, amount).then(feeOnly),
  calls: (owner, amount, terms, allowance) => [
    ...(allowance < amount ? [approveCall(token, TOKEN_MESSENGER_V2, amount)] : []),
    burnToHyperCore(token, owner, amount, terms.fee.max),
  ],
  progress: ({ fetch }, sent) => cctpProgress(fetch, sent, domain),
})

const Ledger = z.array(
  z.object({
    time: z.coerce.number(),
    hash: z.string(),
    delta: z.looseObject({
      type: z.string(),
      usdc: z.string().optional(),
      user: z.string().optional(),
      destination: z.string().optional(),
      destinationDex: z.string().optional(),
      token: z.string().optional(),
      amount: z.string().optional(),
    }),
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
    (update) => update.delta.type === 'deposit' && update.hash.toLowerCase() === sent.hash.toLowerCase(),
  )
  const amount = entry?.delta.usdc ? parseUsdc(entry.delta.usdc) : null
  return entry && amount
    ? { stage: 'credited', amount, at: entry.time, receipt: entry.hash }
    : { stage: 'relaying', detail: 'Waiting for Hyperliquid to credit the bridge deposit' }
}

function firstFrom<T extends { time: number }>(entries: readonly T[], at: number): T | undefined {
  const byTime = entries.toSorted((left, right) => left.time - right.time)
  return byTime.find((entry) => entry.time >= at) ?? byTime.at(-1)
}

/** CCTP credits arrive as a send from Circle's CoreDepositWallet to the perps dex, which Hyperliquid names "". */
async function cctpProgress(
  fetch: typeof globalThis.fetch,
  sent: SentDeposit,
  domain: number,
): Promise<DepositProgress> {
  const forward = await followForward('hyperliquid', fetch, domain, sent)
  if (forward.stage !== 'forwarded') return forward
  const expected = forward.feeExecuted === null ? null : sent.amount - forward.feeExecuted
  const credits = (await ledger(fetch, sent)).filter(
    (update) =>
      update.delta.type === 'send'
      && update.delta.user?.toLowerCase() === CORE_DEPOSIT_WALLET.toLowerCase()
      && update.delta.destination?.toLowerCase() === sent.ref.owner
      && update.delta.destinationDex === ''
      && update.delta.token === 'USDC'
      && update.time >= sent.sentAt - LEDGER_SLACK_MS
      && !sent.claimed.has(update.hash)
      && (expected === null || parseUsdc(update.delta.amount ?? '') === expected),
  )
  const entry = firstFrom(credits, sent.sentAt)
  const amount = entry?.delta.amount ? parseUsdc(entry.delta.amount) : null
  return entry && amount
    ? { stage: 'credited', amount, at: entry.time, receipt: entry.hash }
    : { stage: 'relaying', detail: 'Minted on HyperEVM. Waiting for Hyperliquid to show it' }
}

export const hyperliquidDeposit: DepositVenue = {
  destination: 'Hyperliquid perps',
  routes: (network) => [bridgeRoute(network), ...(network === 'mainnet' ? CCTP_SOURCES.map(cctpRoute) : [])],
}
