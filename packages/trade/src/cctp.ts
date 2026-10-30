import { encodeFunctionData, pad, parseAbi, stringToHex } from 'viem'
import type { Address, Hex } from 'viem'
import { z } from 'zod'
import type { DepositCall, DepositFee } from './deposit'
import { TradeFailure } from './types'
import type { TradeVenueId } from './types'

const HYPEREVM_DOMAIN = 19
/** The same address on every EVM chain Circle lists. */
export const TOKEN_MESSENGER_V2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
/** Circle's contract on HyperEVM that receives the mint and credits HyperCore. Both mint recipient and caller must be it, or the USDC is stuck for good. */
const CCTP_FORWARDER: Address = '0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757'
/** Circle's HyperEVM contract that sends the forwarded USDC on HyperCore. */
export const CORE_DEPOSIT_WALLET: Address = '0x6b9e773128f453f5c2c60935ee2de2cbc5390a24'
const IRIS = 'https://iris-api.circle.com'
const FAST_FINALITY = 1000
const PERPS_DEX = 0

const tokenMessenger = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
])

/** Circle's forwarder hook: "cctp-forward" in 24 bytes, version 0, length 24, then the HyperCore recipient and dex. */
function hyperCoreHook(recipient: Address): Hex {
  const magic = pad(stringToHex('cctp-forward'), { dir: 'right', size: 24 })
  const header = '0000000000000018'
  const dex = PERPS_DEX.toString(16).padStart(8, '0')
  return `${magic}${header}${recipient.slice(2).toLowerCase()}${dex}`
}

/** Burns on the source chain with a Fast Transfer, minted on HyperEVM and credited to the owner's HyperCore perps. */
export function burnToHyperCore(token: Address, owner: Address, amount: bigint, maxFee: bigint): DepositCall {
  const forwarder = pad(CCTP_FORWARDER)
  return {
    kind: 'deposit',
    to: TOKEN_MESSENGER_V2,
    data: encodeFunctionData({
      abi: tokenMessenger,
      functionName: 'depositForBurnWithHook',
      args: [amount, HYPEREVM_DOMAIN, forwarder, token, forwarder, maxFee, FAST_FINALITY, hyperCoreHook(owner)],
    }),
    gasFallback: 250_000n,
  }
}

const Fees = z.array(
  z.object({
    finalityThreshold: z.number(),
    /** Basis points of the amount, sometimes fractional. */
    minimumFee: z.number().nonnegative(),
    forwardFee: z.object({ high: z.number().int().nonnegative() }),
  }),
)

const Messages = z.object({
  messages: z.array(
    z.object({
      status: z.string(),
      forwardState: z.string().nullish(),
      forwardTxHash: z.string().nullish(),
      decodedMessage: z
        .object({ decodedMessageBody: z.object({ feeExecuted: z.string().nullish() }).nullish() })
        .nullish(),
    }),
  ),
})

export type BurnMessage = {
  readonly attested: boolean
  readonly forward: 'pending' | 'done' | 'failed'
  readonly feeExecuted: bigint | null
}

async function iris(venue: TradeVenueId, fetch: typeof globalThis.fetch, path: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${IRIS}${path}`)
  } catch (e) {
    throw new TradeFailure(venue, { kind: 'unreachable', detail: e instanceof Error ? e.message : String(e) })
  }
  if (response.status === 404) return null
  if (!response.ok) throw new TradeFailure(venue, { kind: 'unreachable', detail: `Circle ${response.status}` })
  return response.json()
}

/** Circle's fast fee for the amount, padded by a fifth as Circle advises, plus its high HyperCore forwarding quote. Circle takes the whole maxFee when it forwards, so the quote is what the deposit pays. */
export async function hyperCoreFee(
  venue: TradeVenueId,
  fetch: typeof globalThis.fetch,
  sourceDomain: number,
  amount: bigint,
): Promise<DepositFee> {
  const body = await iris(
    venue,
    fetch,
    `/v2/burn/USDC/fees/${sourceDomain}/${HYPEREVM_DOMAIN}?forward=true&hyperCoreDeposit=true`,
  )
  const fast = Fees.safeParse(body).data?.find((f) => f.finalityThreshold === FAST_FINALITY)
  if (!fast) throw new TradeFailure(venue, { kind: 'unreachable', detail: 'Circle sent no Fast Transfer fee' })
  const hundredthsBps = BigInt(Math.round(fast.minimumFee * 100))
  const protocol = ceilDiv(amount * hundredthsBps, 1_000_000n)
  const fee = ceilDiv(protocol * 6n, 5n) + BigInt(fast.forwardFee.high)
  return { expected: fee, max: fee }
}

/** Null until Circle has indexed the burn. */
export async function burnMessage(
  venue: TradeVenueId,
  fetch: typeof globalThis.fetch,
  sourceDomain: number,
  hash: Hex,
): Promise<BurnMessage | null> {
  const body = await iris(venue, fetch, `/v2/messages/${sourceDomain}?transactionHash=${hash}`)
  const m = body === null ? undefined : Messages.safeParse(body).data?.messages[0]
  if (!m) return null
  const fee = m.decodedMessage?.decodedMessageBody?.feeExecuted
  return {
    attested: m.status === 'complete',
    forward: m.forwardState === 'FAILED' ? 'failed' : m.forwardTxHash ? 'done' : 'pending',
    feeExecuted: fee ? BigInt(fee) : null,
  }
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
