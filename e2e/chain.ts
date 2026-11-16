import { decodeFunctionData, encodeFunctionResult, numberToHex, parseAbi } from 'viem'
import type { Address, Hex } from 'viem'
import type { Page } from '@playwright/test'
import type { Network } from '@tape/core/ids'
import { CHAINS } from '../src/wallet/chains'

interface Call {
  readonly to: Address
  readonly data: Hex
}

export interface Holdings {
  readonly native: bigint
  readonly tokens: Readonly<Record<Address, bigint>>
}

/** The ERC-20, Multicall3, Orderly Vault and OP Stack GasPriceOracle reads wagmi makes, by their published signatures. */
const READS = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function getEthBalance(address addr) view returns (uint256)',
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getDepositFee(address receiver, (bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) view returns (uint256)',
  'function tokenAddress2DepositLimit(address token) view returns (uint256)',
  'function getL1Fee(bytes data) view returns (uint256)',
])

const NOTHING: Holdings = { native: 0n, tokens: {} }
const GAS = 60_000n
const GWEI = 1_000_000_000n
const LAYERZERO_FEE = 10n ** 14n

export async function fakeChains(page: Page, network: Network) {
  const holdings = new Map<string, Holdings>()
  const unanswered: string[] = []
  const mined = new Map<Hex, 'success' | 'reverted'>()
  const held = (chainId: number, owner: Address) => holdings.get(`${chainId}:${owner.toLowerCase()}`) ?? NOTHING

  const call = (chainId: number, { to, data }: Call): Hex => {
    let read
    try {
      read = decodeFunctionData({ abi: READS, data })
    } catch {
      unanswered.push(`eth_call ${data.slice(0, 10)}`)
      return '0x'
    }
    switch (read.functionName) {
      case 'aggregate3': {
        const results = read.args[0].map((request) => ({
          success: true,
          returnData: call(chainId, { to: request.target, data: request.callData }),
        }))
        return encodeFunctionResult({ abi: READS, functionName: 'aggregate3', result: results })
      }
      case 'balanceOf': {
        const tokens = Object.entries(held(chainId, read.args[0]).tokens)
        const balance = tokens.find(([token]) => token.toLowerCase() === to.toLowerCase())?.[1] ?? 0n
        return encodeFunctionResult({ abi: READS, functionName: 'balanceOf', result: balance })
      }
      case 'getEthBalance':
        return encodeFunctionResult({
          abi: READS,
          functionName: 'getEthBalance',
          result: held(chainId, read.args[0]).native,
        })
      case 'allowance':
        return encodeFunctionResult({ abi: READS, functionName: 'allowance', result: 0n })
      case 'getDepositFee':
        return encodeFunctionResult({ abi: READS, functionName: 'getDepositFee', result: LAYERZERO_FEE })
      case 'getL1Fee':
        return encodeFunctionResult({ abi: READS, functionName: 'getL1Fee', result: 0n })
      case 'tokenAddress2DepositLimit':
        return encodeFunctionResult({ abi: READS, functionName: 'tokenAddress2DepositLimit', result: 0n })
    }
  }

  /** A receipt in the shape of the JSON-RPC spec, with the gas the fake chain estimates. */
  const receipt = (chainId: number, hash: Hex) => ({
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: `0x${'b1'.repeat(32)}`,
    blockNumber: numberToHex(1_000_001),
    from: `0x${'0'.repeat(40)}`,
    to: `0x${'0'.repeat(40)}`,
    contractAddress: null,
    cumulativeGasUsed: numberToHex(GAS),
    gasUsed: numberToHex(GAS),
    effectiveGasPrice: numberToHex(GWEI),
    logs: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    status: mined.get(hash) === 'reverted' ? '0x0' : '0x1',
    type: '0x2',
    chainId: numberToHex(chainId),
  })

  /** A transaction still in the pool, in the shape of the JSON-RPC spec, which is how viem tells waiting from replaced. */
  const pending = (chainId: number, hash: Hex) => ({
    hash,
    nonce: '0x0',
    blockHash: null,
    blockNumber: null,
    transactionIndex: null,
    from: `0x${'0'.repeat(40)}`,
    to: `0x${'0'.repeat(40)}`,
    value: '0x0',
    gas: numberToHex(GAS),
    maxFeePerGas: numberToHex(GWEI),
    maxPriorityFeePerGas: numberToHex(GWEI / 10n),
    input: '0x',
    type: '0x2',
    accessList: [],
    chainId: numberToHex(chainId),
    v: '0x0',
    r: `0x${'1'.repeat(64)}`,
    s: `0x${'1'.repeat(64)}`,
  })

  const answer = (chainId: number, method: string, params: readonly unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return numberToHex(chainId)
      case 'eth_blockNumber':
        return numberToHex(1_000_000 + mined.size)
      case 'eth_call':
        return call(chainId, params[0] as Call)
      case 'eth_getBalance':
        return numberToHex(held(chainId, params[0] as Address).native)
      case 'eth_getCode':
        return '0x'
      case 'eth_estimateGas':
        return numberToHex(GAS)
      case 'eth_gasPrice':
        return numberToHex(GWEI)
      case 'eth_maxPriorityFeePerGas':
        return numberToHex(GWEI / 10n)
      case 'eth_getTransactionByHash':
        return pending(chainId, params[0] as Hex)
      case 'eth_getTransactionReceipt':
        return mined.has(params[0] as Hex) ? receipt(chainId, params[0] as Hex) : null
      case 'eth_getBlockByNumber':
        return { number: numberToHex(1_000_000), baseFeePerGas: numberToHex(GWEI), timestamp: '0x0', transactions: [] }
      default:
        unanswered.push(method)
        return null
    }
  }

  for (const chain of CHAINS[network])
    await page.route(chain.rpcUrls.default.http[0], async (route) => {
      const request = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] }
      const result = answer(chain.id, request.method, request.params ?? [])
      return route.fulfill({
        json: { jsonrpc: '2.0', id: request.id, result },
        headers: { 'access-control-allow-origin': '*' },
      })
    })

  return {
    fund: (chainId: number, owner: Address, balances: Holdings) =>
      holdings.set(`${chainId}:${owner.toLowerCase()}`, balances),
    /** The chains hold a receipt for this transaction from now on, one block later. */
    mine: (hash: Hex, status: 'success' | 'reverted' = 'success') => mined.set(hash, status),
    unanswered: () => [...unanswered],
  }
}
