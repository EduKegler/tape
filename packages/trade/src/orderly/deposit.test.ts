import { describe, expect, it } from 'vitest'
import {
  bytesToHex,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  stringToBytes,
  toFunctionSelector,
} from 'viem'
import type { Address, Hex } from 'viem'
import { DEPOSITS } from '../index'
import type { DepositRoute, DepositTerms, ProgressIo, SentDeposit } from '../deposit'
import type { StoredKey, TradeConfig } from '../types'
import { vaultDeposit } from './deposit'
import { accountId, orderlyKey } from './sign'

const VAULT: Address = '0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9'
const ARBITRUM_USDC: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const config = (mainnet: string | null): TradeConfig => ({
  mainnet: true,
  hyperliquid: { builder: null },
  dydx: { builder: null },
  orderly: { brokerId: { mainnet, testnet: 'demo' } },
})
const routes = (network: 'mainnet' | 'testnet', broker: string | null = 'woofi_pro') =>
  DEPOSITS.orderly!.routes(network, config(broker))
const arbitrum = (): DepositRoute => routes('mainnet').find((r) => r.chainId === 42161)!

/** Deposit 0x6f865b3d…7ff6 on Arbitrum: 33,049.576128 USDC to the sender's woofi_pro account. */
const recorded = {
  owner: '0xc9afb0282b542445314d8720475b226baa4badeb' as Address,
  amount: 33_049_576_128n,
  value: 125_145_020_823_749n,
  input:
    '0x322dda6dd92cec4a6215db1659b7bf72baa91f29af164ca817f7bd53e373d140292d24526ca2f644ef7bd6d75953318c7f2580014941e753b3c6d54da56b3bf75dd14dfcd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa00000000000000000000000000000000000000000000000000000007b1e882c0' as Hex,
  /** `account_id` from Orderly's /v1/get_account for the owner and woofi_pro. */
  account: '0xd92cec4a6215db1659b7bf72baa91f29af164ca817f7bd53e373d140292d2452',
}

/** Orderly's /v1/get_account replies, recorded on 2026-10-30. Both come with a 200. */
const ACCOUNT = {
  registered: { success: true, data: { user_id: 1481221, account_id: recorded.account }, timestamp: 1793409853535 },
  unknown: { success: false, code: -1607, message: 'Account not found.' },
}

/** Orderly's Vault functions, as `Vault.sol` in OrderlyNetwork/contract-evm declares them. */
const VAULT_ABI = parseAbi([
  'function deposit((bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) payable',
  'function getDepositFee(address receiver, (bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) view returns (uint256)',
])
const GET_DEPOSIT_FEE = toFunctionSelector(VAULT_ABI[1])
const DEPOSIT_LIMIT = toFunctionSelector('tokenAddress2DepositLimit(address)')
const BALANCE_OF = toFunctionSelector('balanceOf(address)')

/** The Arbitrum Vault's eth_call results at block 519847684. */
const VAULT_READS: Record<string, bigint> = {
  [GET_DEPOSIT_FEE]: 108_553_163_301_856n,
  [DEPOSIT_LIMIT]: 0n,
  [BALANCE_OF]: 544_572_879_201n,
}

function chainAnswering(reads: Record<string, bigint>) {
  const asked: { to: string; data: Hex }[] = []
  const chain = createPublicClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params: [{ to: string; data: Hex }] }) => {
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
        const [call] = params
        asked.push(call)
        const answer = reads[call.data.slice(0, 10)]
        if (answer === undefined) throw new Error(`unexpected call ${call.data.slice(0, 10)}`)
        return encodeAbiParameters([{ type: 'uint256' }], [answer])
      },
    }),
  })
  return { chain, asked }
}

function orderlyAnswering(body: unknown) {
  const asked: { url: string; headers: Record<string, string> }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(JSON.stringify(body))
  }) as typeof globalThis.fetch
  return { fetch, asked }
}

describe('Orderly Vault deposit', () => {
  it('calls the Vault exactly as the recorded deposit did, paying the LayerZero fee as value', () => {
    expect(vaultDeposit(VAULT, recorded.owner, 'woofi_pro', recorded.amount, recorded.value)).toEqual({
      kind: 'deposit',
      to: VAULT,
      data: recorded.input,
      value: recorded.value,
      gasFallback: expect.any(BigInt) as bigint,
    })
  })

  it('derives the account id Orderly reports, keccak(abi.encode(address, keccak(broker)))', () => {
    const byHand = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [recorded.owner, keccak256(stringToBytes('woofi_pro'))],
      ),
    )
    expect(byHand).toBe(recorded.account)
    expect(accountId(recorded.owner, 'woofi_pro')).toBe(recorded.account)
  })

  it('leaves from Arbitrum, Base and OP on mainnet and from Arbitrum Sepolia on testnet', () => {
    expect(routes('mainnet').map((r) => [r.chainId, r.spender])).toEqual([
      [42161, VAULT],
      [8453, VAULT],
      [10, VAULT],
    ])
    expect(routes('testnet').map((r) => r.chainId)).toEqual([421614])
  })

  it('offers no route on a network the build has no broker for', () => {
    expect(routes('mainnet', null)).toEqual([])
  })

  it('quotes the Vault fee for a registered account with nothing to refuse', async () => {
    const orderly = orderlyAnswering(ACCOUNT.registered)
    const { chain, asked } = chainAnswering(VAULT_READS)
    expect(await arbitrum().terms({ fetch: orderly.fetch, chain }, recorded.owner, recorded.amount)).toEqual({
      fee: { expected: 0n, max: 0n },
      message: { via: 'LayerZero', wei: 108_553_163_301_856n },
      refusal: null,
    } satisfies DepositTerms)
    expect(orderly.asked.map((a) => a.url)).toEqual([
      `https://api.orderly.org/v1/get_account?address=${recorded.owner}&broker_id=woofi_pro`,
    ])
    const feeCall = asked.find((c) => c.data.startsWith(GET_DEPOSIT_FEE))!
    expect(feeCall.to).toBe(VAULT)
    const [deposited] = decodeFunctionData({ abi: VAULT_ABI, data: recorded.input }).args
    expect(decodeFunctionData({ abi: VAULT_ABI, data: feeCall.data }).args).toEqual([
      getAddress(recorded.owner),
      deposited,
    ])
  })

  it('refuses an address Orderly never registered', async () => {
    const { fetch } = orderlyAnswering(ACCOUNT.unknown)
    const { chain } = chainAnswering(VAULT_READS)
    const terms = await arbitrum().terms({ fetch, chain }, recorded.owner, recorded.amount)
    expect(terms.refusal).toEqual({ kind: 'no-account' })
  })

  it('refuses a deposit that takes the Vault past its USDC limit, and says how much still fits', async () => {
    const { fetch } = orderlyAnswering(ACCOUNT.registered)
    const { chain } = chainAnswering({ ...VAULT_READS, [DEPOSIT_LIMIT]: 1_000_000_000n, [BALANCE_OF]: 900_000_000n })
    const route = arbitrum()
    expect((await route.terms({ fetch, chain }, recorded.owner, 100_000_000n)).refusal).toBeNull()
    expect((await route.terms({ fetch, chain }, recorded.owner, 100_000_001n)).refusal).toEqual({
      kind: 'over-limit',
      room: 100_000_000n,
    })
  })

  it('approves the Vault for exactly the amount when the allowance falls short', () => {
    const terms: DepositTerms = {
      fee: { expected: 0n, max: 0n },
      message: { via: 'LayerZero', wei: recorded.value },
      refusal: null,
    }
    const route = arbitrum()
    const short = route.calls(recorded.owner, recorded.amount, terms, recorded.amount - 1n)
    expect(short.map((c) => [c.kind, c.to, c.value])).toEqual([
      ['approve', ARBITRUM_USDC, 0n],
      ['deposit', VAULT, recorded.value],
    ])
    expect(short[1]!.data).toBe(recorded.input)
    expect(route.calls(recorded.owner, recorded.amount, terms, recorded.amount).map((c) => c.kind)).toEqual(['deposit'])
  })
})

describe('Orderly deposit credit', () => {
  const hash: Hex = '0x6f865b3dac4468ea3b899aecbb23bd8c64423b88e1d08bac9f7a9f5403fa7ff6'
  const sent: SentDeposit = {
    ref: { venue: 'orderly', network: 'mainnet', owner: recorded.owner },
    chainId: 42161,
    amount: recorded.amount,
    hash,
    sentAt: 1_793_400_000_000,
    claimed: new Set(),
  }
  const key = orderlyKey()
  const keys = (stored: StoredKey | null): ProgressIo['keys'] => ({
    read: () => stored,
    write: () => {},
    clear: () => {},
  })
  const linked: StoredKey = { status: 'linked', public: { key: key.id }, secret: bytesToHex(key.secret) }
  /** The row shape of the reply in Orderly's Get asset history docs, for this deposit. */
  const row = (trans_status: string) => ({
    id: '251030030600002',
    tx_id: hash,
    side: 'DEPOSIT',
    token: 'USDC',
    amount: 33049.576128,
    fee: 0,
    trans_status,
    created_time: 1_793_400_005_000,
    updated_time: 1_793_400_031_000,
    chain_id: '42161',
  })
  const history = (rows: unknown[]) => ({
    success: true,
    data: { meta: { total: rows.length, records_per_page: 25, current_page: 1 }, rows },
    timestamp: 1_793_400_040_000,
  })
  const lane = 'https://layerzeroscan.com/tx/0x6f865b3dac4468ea3b899aecbb23bd8c64423b88e1d08bac9f7a9f5403fa7ff6'

  it('asks for a linked Orderly key before reading anything', async () => {
    for (const stored of [null, { ...linked, status: 'draft' as const }]) {
      const { fetch, asked } = orderlyAnswering(history([]))
      expect(await arbitrum().progress({ fetch, keys: keys(stored) }, sent)).toEqual({
        stage: 'relaying',
        detail: 'Enable trading on Orderly to follow the credit here',
      })
      expect(asked).toEqual([])
    }
  })

  it('reads deposits from 10 min before the send, signed for the owner account', async () => {
    const { fetch, asked } = orderlyAnswering(history([]))
    expect(await arbitrum().progress({ fetch, keys: keys(linked) }, sent)).toEqual({
      stage: 'relaying',
      detail: 'Waiting for Orderly to see the deposit',
    })
    expect(asked[0]!.url).toBe(`https://api.orderly.org/v1/asset/history?side=DEPOSIT&start_t=${sent.sentAt - 600_000}`)
    expect(asked[0]!.headers).toMatchObject({ 'orderly-account-id': recorded.account, 'orderly-key': key.id })
  })

  it('keeps relaying while Orderly lists the deposit as on its way', async () => {
    /** Orderly's Get asset history docs: PENDING, PENDING_REBALANCE and PROCESSING from the reply's `trans_status` enum, NEW and CONFIRM from the `status` filter. */
    const onTheWay = ['PENDING', 'PENDING_REBALANCE', 'PROCESSING', 'NEW', 'CONFIRM']
    for (const status of onTheWay) {
      const { fetch } = orderlyAnswering(history([row(status)]))
      expect(await arbitrum().progress({ fetch, keys: keys(linked) }, sent)).toEqual({
        stage: 'relaying',
        detail: 'Orderly is crediting it',
      })
    }
  })

  it('credits the amount Orderly lists once the deposit is COMPLETED', async () => {
    const { fetch } = orderlyAnswering(history([{ ...row('COMPLETED'), tx_id: '0x01' }, row('COMPLETED')]))
    expect(await arbitrum().progress({ fetch, keys: keys(linked) }, sent)).toEqual({
      stage: 'credited',
      amount: 33_049_576_128n,
      at: 1_793_400_031_000,
      receipt: '251030030600002',
    })
  })

  it('ends the watch for a check by hand when Orderly reports FAILED or a state it does not document', async () => {
    for (const [status, detail] of [
      ['FAILED', 'Orderly reports the deposit as failed'],
      ['SOMETHING_NEW', 'Orderly reports the deposit as SOMETHING_NEW, a state Tape does not know'],
    ] as const) {
      const { fetch } = orderlyAnswering(history([row(status)]))
      expect(await arbitrum().progress({ fetch, keys: keys(linked) }, sent)).toEqual({
        stage: 'unresolved',
        detail,
        check: { label: 'LayerZero message', url: lane },
      })
    }
  })
})
