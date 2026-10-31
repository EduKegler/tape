import { encodeFunctionData, erc20Abi, hexToBytes, keccak256, parseAbi, stringToBytes } from 'viem'
import type { Address } from 'viem'
import { z } from 'zod'
import type { Network } from '@tape/core/ids'
import { isRecord } from '@tape/core/json'
import { approveCall, parseUsdc } from '../deposit'
import type {
  DepositCall,
  DepositProgress,
  DepositRefusal,
  DepositRoute,
  DepositVenue,
  ProgressIo,
  SentDeposit,
} from '../deposit'
import { readReply, send } from '../send'
import type { Classify } from '../send'
import { secretHex } from '../types'
import { accountId, orderlyKey, signRequest } from './sign'

const API: Record<Network, string> = { mainnet: 'https://api.orderly.org', testnet: 'https://testnet-api.orderly.org' }
const LAYERZERO_SCAN: Record<Network, string> = {
  mainnet: 'https://layerzeroscan.com',
  testnet: 'https://testnet.layerzeroscan.com',
}

interface Source {
  readonly chainId: number
  readonly vault: Address
  /** The USDC that the Vault's `allowedToken` returns for the USDC token hash. */
  readonly token: Address
}

const MAINNET_VAULT: Address = '0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9'
const SOURCES: Record<Network, readonly Source[]> = {
  mainnet: [
    { chainId: 42161, vault: MAINNET_VAULT, token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
    { chainId: 8453, vault: MAINNET_VAULT, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { chainId: 10, vault: MAINNET_VAULT, token: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  ],
  testnet: [
    {
      chainId: 421614,
      vault: '0x0EaC556c0C2321BA25b9DC01e4e3c95aD5CDCd2f',
      token: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    },
  ],
}

const vault = parseAbi([
  'function deposit((bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) payable',
  'function getDepositFee(address receiver, (bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) view returns (uint256)',
  'function tokenAddress2DepositLimit(address token) view returns (uint256)',
])

const depositData = (owner: Address, brokerId: string, amount: bigint) => ({
  accountId: accountId(owner, brokerId),
  brokerHash: keccak256(stringToBytes(brokerId)),
  tokenHash: keccak256(stringToBytes('USDC')),
  tokenAmount: amount,
})

/** The Vault pulls the USDC and sends the deposit to Orderly over LayerZero. The call pays LayerZero's fee as its value. */
export function vaultDeposit(to: Address, owner: Address, brokerId: string, amount: bigint, fee: bigint): DepositCall {
  return {
    kind: 'deposit',
    to,
    data: encodeFunctionData({ abi: vault, functionName: 'deposit', args: [depositData(owner, brokerId, amount)] }),
    value: fee,
    gasFallback: 600_000n,
  }
}

/** Orderly answers an address it never registered with `success: false` and a 200. */
async function registered(fetch: typeof globalThis.fetch, network: Network, owner: Address, brokerId: string) {
  const url = `${API[network]}/v1/get_account?address=${owner}&broker_id=${brokerId}`
  const body = await send('orderly', fetch, url, { mutates: false }, unreadable)
  return readReply('orderly', Registration, body, false).success
}

const Registration = z.object({ success: z.boolean() })

const unreadable: Classify = (status, body, text) =>
  status < 400 && !(isRecord(body) && typeof body.success === 'boolean')
    ? { kind: 'unreachable', detail: `Unreadable reply: ${text}` }
    : null

/** The Vault reverts with DepositExceedLimit once its USDC plus the deposit passes a limit other than zero. */
function overLimit(amount: bigint, limit: bigint, held: bigint): DepositRefusal | null {
  if (limit === 0n || amount + held <= limit) return null
  return { kind: 'over-limit', room: limit > held ? limit - held : 0n }
}

const unsuccessful: Classify = (_s, body, text) =>
  isRecord(body) && body.success === false ? { kind: 'rejected', detail: text } : null

const History = z.object({
  data: z.object({
    rows: z.array(
      z.object({
        id: z.string(),
        tx_id: z.string(),
        amount: z.string(),
        trans_status: z.string(),
        updated_time: z.coerce.number(),
      }),
    ),
  }),
})

/** Orderly's `trans_status` values for a deposit it has seen and not yet credited. */
const CREDITING = new Set(['PENDING', 'PENDING_REBALANCE', 'PROCESSING', 'NEW', 'CONFIRM'])
/** The wallet's clock and Orderly's can disagree. */
const HISTORY_SLACK_MS = 10 * 60_000

async function progress(
  network: Network,
  brokerId: string,
  { fetch, keys }: ProgressIo,
  sent: SentDeposit,
): Promise<DepositProgress> {
  const key = keys.read()
  if (key?.status !== 'linked' || !key.secret)
    return { stage: 'unwatched', detail: 'Enable trading on Orderly to follow the credit here' }
  const path = `/v1/asset/history?side=DEPOSIT&start_t=${sent.sentAt - HISTORY_SLACK_MS}`
  const account = accountId(sent.ref.owner, brokerId)
  const headers = signRequest(orderlyKey(hexToBytes(secretHex(key.secret))), account, Date.now(), 'GET', path)
  const body = await send('orderly', fetch, `${API[network]}${path}`, { headers, mutates: false }, unsuccessful)
  const row = History.parse(body).data.rows.find((entry) => entry.tx_id.toLowerCase() === sent.hash.toLowerCase())
  if (!row) return { stage: 'relaying', detail: 'Waiting for Orderly to see the deposit' }
  if (CREDITING.has(row.trans_status)) return { stage: 'relaying', detail: 'Orderly is crediting it' }
  const amount = parseUsdc(row.amount)
  if (row.trans_status === 'COMPLETED' && amount)
    return { stage: 'credited', amount, at: row.updated_time, receipt: row.id }
  return {
    stage: 'unresolved',
    detail:
      row.trans_status === 'FAILED'
        ? 'Orderly reports the deposit as failed'
        : `Orderly reports the deposit as ${row.trans_status}, a state Tape does not know`,
    check: { label: 'LayerZero message', url: `${LAYERZERO_SCAN[network]}/tx/${sent.hash}` },
  }
}

const route =
  (network: Network, brokerId: string) =>
  ({ chainId, vault: to, token }: Source): DepositRoute => ({
    chainId,
    token,
    spender: to,
    hops: ['Orderly Vault', 'LayerZero'],
    minimum: null,
    // LayerZero delivered three Vault deposits in 19 to 24 s on 2026-10-30.
    eta: { typical: 60, worst: 600 },
    // Orderly takes 10 asset history requests a minute.
    pollEvery: 10_000,
    terms: async ({ fetch, chain }, owner, amount) => {
      const [account, fee, limit, held] = await Promise.all([
        registered(fetch, network, owner, brokerId),
        chain.readContract({
          address: to,
          abi: vault,
          functionName: 'getDepositFee',
          args: [owner, depositData(owner, brokerId, amount)],
        }),
        chain.readContract({ address: to, abi: vault, functionName: 'tokenAddress2DepositLimit', args: [token] }),
        chain.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [to] }),
      ])
      return {
        fee: { expected: 0n, max: 0n },
        message: { via: 'LayerZero', wei: fee },
        refusal: account ? overLimit(amount, limit, held) : { kind: 'no-account' },
      }
    },
    calls: (owner, amount, terms, allowance) => [
      ...(allowance < amount ? [approveCall(token, to, amount)] : []),
      vaultDeposit(to, owner, brokerId, amount, terms.message?.wei ?? 0n),
    ],
    progress: (io, sent) => progress(network, brokerId, io, sent),
  })

export const orderlyDeposit: DepositVenue = {
  destination: 'Orderly',
  routes: (network, config) => {
    const brokerId = config.orderly.brokerId[network]
    return brokerId ? SOURCES[network].map(route(network, brokerId)) : []
  },
}
