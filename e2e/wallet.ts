import { concat, getAddress, hashDomain, hashStruct, keccak256, numberToHex } from 'viem'
import type { Address, Hex, TypedDataDomain, TypedDataParameter } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import type { BrowserContext } from '@playwright/test'

/** Foundry's default mnemonic, so the addresses are the ones Anvil prints. */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
const signers = {
  alice: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 }),
  bob: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 }),
}
type TestAccount = keyof typeof signers
export const ACCOUNTS = { alice: signers.alice.address, bob: signers.bob.address } as const

interface TypedData {
  readonly domain: Readonly<Record<string, unknown>>
  readonly primaryType: string
  readonly message: Readonly<Record<string, unknown>>
}

interface SignRequest extends TypedData {
  readonly domain: TypedDataDomain
  readonly types: Record<string, readonly TypedDataParameter[]>
  readonly message: Record<string, unknown>
}

interface Transaction {
  readonly to: Address
  readonly data: Hex
  readonly chainId: number | null
}

type Asked =
  | { readonly kind: 'connect'; readonly account: TestAccount }
  | { readonly kind: 'switch-chain'; readonly from: number; readonly to: number }
  | {
      readonly kind: 'sign'
      readonly from: TestAccount
      readonly selected: TestAccount
      readonly chainId: number
      readonly typedData: TypedData
    }
  | {
      readonly kind: 'send'
      readonly from: TestAccount
      readonly chainId: number
      readonly tx: Transaction
    }
type AskedOf<TKind extends Asked['kind']> = Extract<Asked, { kind: TKind }>

export interface Wallet {
  asked: () => readonly Asked[]
  askedFor: <TKind extends Asked['kind']>(kind: TKind) => readonly AskedOf<TKind>[]
  switchAccount: (to: TestAccount) => Promise<void>
  switchChain: (chainId: number) => Promise<void>
  unanswered: () => readonly string[]
}

type Emit = readonly ['accountsChanged', readonly Address[]] | readonly ['chainChanged', Hex]
type Reply =
  | { readonly result: unknown; readonly emit: readonly Emit[] }
  | { readonly error: { readonly code: number; readonly message: string } }
interface Request {
  readonly method: string
  readonly params?: readonly unknown[]
}

const BINDING = '__tapeTestWallet'
const EVENT = 'tape-test-wallet'
/** EIP-1193 codes for a refusal, an account the wallet does not hold and a method it does not support. */
const USER_REJECTED = 4001
const UNAUTHORIZED = 4100
const UNSUPPORTED = 4200

/** viem's hashTypedData without its name check, which refuses Hyperliquid's `HyperliquidTransaction:` types. */
const typedDataHash = ({ domain, types, primaryType, message }: SignRequest) =>
  keccak256(concat(['0x1901', hashDomain({ domain, types }), hashStruct({ data: message, primaryType, types })]))

const accountOf = (address: unknown) =>
  (Object.keys(signers) as TestAccount[]).find(
    (name) => typeof address === 'string' && signers[name].address.toLowerCase() === address.toLowerCase(),
  )

/** Starts on Ethereum, as a fresh MetaMask does. */
export async function installWallet(context: BrowserContext): Promise<Wallet> {
  const state = {
    selected: 'alice' as TestAccount,
    chainId: 1,
    connected: false,
    asked: [] as Asked[],
    unanswered: [] as string[],
  }
  const accounts = () => (state.connected ? [ACCOUNTS[state.selected]] : [])
  const emit = async (events: readonly Emit[]) => {
    for (const page of context.pages())
      await page.evaluate(([event, list]) => window.dispatchEvent(new CustomEvent(event, { detail: list })), [
        EVENT,
        events,
      ] as const)
  }

  const answer = async ({ method, params = [] }: Request): Promise<Reply> => {
    switch (method) {
      case 'eth_accounts':
        return { result: accounts(), emit: [] }
      case 'eth_chainId':
        return { result: numberToHex(state.chainId), emit: [] }
      case 'eth_requestAccounts':
      case 'wallet_requestPermissions': {
        state.connected = true
        state.asked.push({ kind: 'connect', account: state.selected })
        const result =
          method === 'eth_requestAccounts'
            ? accounts()
            : [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: accounts() }] }]
        return { result, emit: [] }
      }
      case 'wallet_getPermissions':
        return { result: state.connected ? [{ parentCapability: 'eth_accounts' }] : [], emit: [] }
      case 'wallet_revokePermissions':
        state.connected = false
        return { result: null, emit: [['accountsChanged', []]] }
      case 'wallet_switchEthereumChain': {
        const to = Number((params[0] as { chainId: Hex }).chainId)
        state.asked.push({ kind: 'switch-chain', from: state.chainId, to })
        if (to === state.chainId) return { result: null, emit: [] }
        state.chainId = to
        return { result: null, emit: [['chainChanged', numberToHex(to)]] }
      }
      case 'eth_signTypedData_v4': {
        const [address, json] = params as [string, string]
        const from = accountOf(address)
        if (!from) return { error: { code: UNAUTHORIZED, message: `The test wallet does not hold ${address}` } }
        const request = JSON.parse(json) as SignRequest
        const { domain, primaryType, message } = request
        state.asked.push({
          kind: 'sign',
          from,
          selected: state.selected,
          chainId: state.chainId,
          typedData: { domain, primaryType, message },
        })
        return { result: await signers[from].sign({ hash: typedDataHash(request) }), emit: [] }
      }
      case 'eth_sendTransaction': {
        const tx = params[0] as { from: string; to: Address; data: Hex; chainId?: Hex }
        const from = accountOf(tx.from)
        if (!from) return { error: { code: UNAUTHORIZED, message: `The test wallet does not hold ${tx.from}` } }
        state.asked.push({
          kind: 'send',
          from,
          chainId: state.chainId,
          tx: { to: getAddress(tx.to), data: tx.data, chainId: tx.chainId ? Number(tx.chainId) : null },
        })
        return { error: { code: USER_REJECTED, message: 'The test wallet only reads' } }
      }
      default:
        state.unanswered.push(method)
        return { error: { code: UNSUPPORTED, message: `The test wallet does not answer ${method}` } }
    }
  }

  await context.exposeBinding(BINDING, (_source, request: Request) => answer(request))
  await context.addInitScript(provider, { binding: BINDING, event: EVENT })

  return {
    asked: () => [...state.asked],
    askedFor: (kind) => state.asked.filter((a): a is AskedOf<typeof kind> => a.kind === kind),
    switchAccount: async (to) => {
      if (to === state.selected) return
      state.selected = to
      if (state.connected) await emit([['accountsChanged', accounts()]])
    },
    switchChain: async (chainId) => {
      if (chainId === state.chainId) return
      state.chainId = chainId
      await emit([['chainChanged', numberToHex(chainId)]])
    },
    unanswered: () => [...state.unanswered],
  }
}

/** Playwright's addInitScript sends this function as source, so it closes over nothing. */
function provider({ binding, event }: { binding: string; event: string }) {
  type Listener = (value: unknown) => void
  const listeners = new Map<string, Set<Listener>>()
  const dispatch = (events: readonly (readonly [string, unknown])[]) => {
    for (const [name, value] of events) for (const listener of listeners.get(name) ?? []) listener(value)
  }
  window.addEventListener(event, (e) => dispatch((e as CustomEvent<readonly [string, unknown][]>).detail))
  const ethereum = {
    async request(request: { method: string; params?: unknown[] }) {
      const reply = await (window as unknown as Record<string, (request: unknown) => Promise<Reply>>)[binding]!(request)
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- MetaMask rejects with a plain { code, message }, not an Error
      if ('error' in reply) throw { ...reply.error }
      dispatch(reply.emit)
      return reply.result
    },
    on(name: string, listener: Listener) {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(listener))
      return ethereum
    },
    removeListener(name: string, listener: Listener) {
      listeners.get(name)?.delete(listener)
      return ethereum
    },
  }
  Object.assign(window, { ethereum })
}
