import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { bytesToHex, hexToBytes } from 'viem'
import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { decimalsOf, parsePx, parseQty, plainDecimal } from '@tape/core/fixed'
import type { Qty } from '@tape/core/fixed'
import { marketKey } from '@tape/core/ids'
import type { Base } from '@tape/core/ids'
import type { MarketSpec } from '@tape/core/market'
import { buildIntent, newClientId } from './intent'
import type { IntentDraft } from './intent'
import { dydx } from './dydx'
import { deriveKey, onboarding, sdk, validatorOf, walletOf } from './dydx/client'
import { clientIdOf, quantums, subticks } from './dydx/wire'
import { hyperliquid } from './hyperliquid'
import { signL1Action } from './hyperliquid/sign'
import { orderAction, orderWire } from './hyperliquid/wire'
import { orderly } from './orderly'
import { accountId, orderlyKey, signRequest } from './orderly/sign'
import { orderBody } from './orderly/wire'
import { localSigner } from './typed-data'
import type { TypedData } from './typed-data'
import { TradeFailure } from './types'
import type {
  Bps,
  Command,
  KeySlot,
  OrderIntent,
  OrderRef,
  StoredKey,
  TradingVenue,
  VenueContext,
  WalletSigner,
} from './types'

interface Exchange {
  readonly method: string
  readonly url: string
  readonly request: unknown
  readonly status: number
  readonly response: unknown
}

function recorder(keep: (url: string, body: unknown) => boolean) {
  let exchanges: Exchange[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const response = await globalThis.fetch(url, init)
    const text = await response.text()
    const sent = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    if (keep(url, sent)) {
      const { signature: _signature, ...request } = sent ?? {}
      exchanges.push({
        method: init?.method ?? 'GET',
        url,
        request: sent ? request : null,
        status: response.status,
        response: JSON.parse(text),
      })
    }
    return new Response(text, { status: response.status })
  }) as typeof globalThis.fetch
  const take = () => {
    const taken = exchanges
    exchanges = []
    return taken
  }
  return { fetch, take }
}

const ignoreVerdict = (p: Promise<unknown>) =>
  p.then(
    () => {},
    (e: unknown) => {
      if (!(e instanceof TradeFailure)) throw e
    },
  )

const leftNothing = { orders: [], positions: [] }

const draft: IntentDraft = {
  side: 'buy',
  kind: 'limit',
  price: '',
  size: '',
  tif: 'gtc',
  reduceOnly: false,
  takeProfits: [],
  stopLoss: '',
  slippage: 500 as Bps,
  bid: '',
  ask: '',
  start: '',
  end: '',
  count: '',
  skew: '1',
  retracement: '',
  retracementUnit: 'pct',
  activation: '',
}

function intentOf(venue: TradingVenue, spec: MarketSpec, changes: Partial<IntentDraft>): OrderIntent {
  const built = buildIntent(spec, { ...draft, ...changes }, venue.capabilities)
  if (!built.ok) throw new Error(`draft refused: ${JSON.stringify(built.errors)}`)
  return built.intent
}

/** The dYdX and Orderly testnet faucets rate-limit by IP, so a rerun trades on the account they already paid. */
const ACCOUNTS = process.env.RECORD_WRITES_ACCOUNTS ?? join(tmpdir(), 'tape-writes')

function throwaway(name: string, make: () => string): string {
  const file = join(ACCOUNTS, `${name}.key`)
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(ACCOUNTS, { recursive: true })
  const secret = make()
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

const write = (venue: string, recording: unknown) =>
  writeFileSync(
    new URL(`./__fixtures__/writes.${venue}.json`, import.meta.url),
    `${JSON.stringify(recording, null, 2)}\n`,
  )

const HL = 'https://api.hyperliquid-testnet.xyz'

async function hlInfo<T>(body: unknown): Promise<T> {
  const response = await fetch(`${HL}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

/** The 5 significant figures Hyperliquid allows, cut down, at most at the market's price decimals. */
function sigfig(value: number, decimals: number): string {
  const digits = Math.max(0, Math.min(decimals, 5 - Math.floor(Math.log10(value)) - 1))
  const unit = 10 ** digits
  return (Math.floor(value * unit) / unit).toFixed(digits)
}

async function recordHyperliquid(keyFile: string) {
  const secret = readFileSync(keyFile, 'utf8').trim() as Hex
  const owner = privateKeyToAccount(secret).address.toLowerCase() as Address
  const coin = process.env.RECORD_WRITES_HL_COIN ?? 'BTC'
  type Meta = { universe: { name: string; szDecimals: number }[] }
  type State = {
    marginSummary: { accountValue: string }
    assetPositions: { position: { coin: string; szi: string } }[]
  }
  const state = () =>
    Promise.all([
      hlInfo<State>({ type: 'clearinghouseState', user: owner }),
      hlInfo<{ coin: string; oid: number }[]>({ type: 'frontendOpenOrders', user: owner }),
    ]).then(([s, orders]) => ({
      equity: s.marginSummary.accountValue,
      positions: s.assetPositions.map((p) => `${p.position.coin} ${p.position.szi}`),
      orders: orders.map((o) => `${o.coin} ${o.oid}`),
    }))
  const before = await state()
  if (before.positions.some((p) => p.startsWith(`${coin} `)))
    throw new Error(`${coin} already has a position; pick another coin with RECORD_WRITES_HL_COIN`)

  const meta = await hlInfo<Meta>({ type: 'meta' })
  const index = meta.universe.findIndex((u) => u.name === coin)
  const qty = meta.universe[index]!.szDecimals
  const spec = {
    key: marketKey('hyperliquid', coin as Base),
    venue: 'hyperliquid',
    base: coin as Base,
    quote: 'USDC',
    kind: 'perp',
    venueSymbol: coin,
    scale: { px: 6 - qty, qty },
    tick: { kind: 'sigfig', figures: 5 },
    step: 1 as Qty,
  } as MarketSpec
  const book = await hlInfo<{ levels: [{ px: string }[], { px: string }[]] }>({ type: 'l2Book', coin })
  const bid = Number(book.levels[0][0]!.px)
  const ask = Number(book.levels[1][0]!.px)
  const far = sigfig(bid * 0.6, spec.scale.px)
  // Hyperliquid's minimum order value is $10, so the size is worth about $12 at the far price.
  const size = (Math.ceil((12 / Number(far)) * 10 ** qty) / 10 ** qty).toFixed(qty)
  const touch = { bid: String(bid), ask: String(ask) }

  const { fetch, take } = recorder(
    (url, body) => url.endsWith('/exchange') || (body as { type?: string } | null)?.type === 'orderStatus',
  )
  const ctx = (key: Hex, user: Address): VenueContext => ({
    ref: { venue: 'hyperliquid', network: 'testnet', owner: user },
    config: {
      mainnet: false,
      hyperliquid: { builder: null },
      dydx: { builder: null },
      orderly: { brokerId: { mainnet: null, testnet: 'demo' } },
    },
    keys: {
      read: () => ({ status: 'linked', public: { agent: user }, secret: key }),
      write: () => {},
      clear: () => {},
    },
    fetch,
  })
  const funded = ctx(secret, owner)
  const cases: Record<string, { exchanges: Exchange[] }> = {}
  const run = async (name: string, work: Promise<unknown>) => {
    await ignoreVerdict(work)
    cases[name] = { exchanges: take() }
  }
  const place = (intent: OrderIntent): Command => ({ kind: 'place', intent })
  const cancel = (oid: string): Command => ({ kind: 'cancel', order: `${index}:${oid}` as OrderRef })
  const oidOf = (name: string) => {
    const reply = cases[name]?.exchanges[0]?.response as { response?: { data?: { statuses?: unknown[] } } } | undefined
    const status = reply?.response?.data?.statuses?.[0] as
      { resting?: { oid: number }; filled?: { oid: number } } | undefined
    const oid = status?.resting?.oid ?? status?.filled?.oid
    if (oid === undefined) throw new Error(`${name} has no oid`)
    return String(oid)
  }

  const rest = intentOf(hyperliquid, spec, { price: far, size, ...touch })
  await run('rest', hyperliquid.execute(funded, place(rest)))
  await run('lookupResting', hyperliquid.lookup(funded, rest))
  await run('cancel', hyperliquid.execute(funded, cancel(oidOf('rest'))))
  await run('cancelCanceled', hyperliquid.execute(funded, cancel(oidOf('rest'))))
  await run('lookupCanceled', hyperliquid.lookup(funded, rest))
  await run('lookupUnknown', hyperliquid.lookup(funded, intentOf(hyperliquid, spec, { price: far, size, ...touch })))

  const buy = intentOf(hyperliquid, spec, { kind: 'market', size, ...touch })
  await run('fill', hyperliquid.execute(funded, place(buy)))
  await run('lookupFilled', hyperliquid.lookup(funded, buy))
  await run('cancelFilled', hyperliquid.execute(funded, cancel(oidOf('fill'))))
  const close = intentOf(hyperliquid, spec, { kind: 'market', side: 'sell', size, reduceOnly: true, ...touch })
  await run('close', hyperliquid.execute(funded, place(close)))

  await run(
    'minimumValue',
    hyperliquid.execute(funded, place(intentOf(hyperliquid, spec, { price: far, size: (1 / 10 ** qty).toFixed(qty) }))),
  )
  await run(
    'reduceOnly',
    hyperliquid.execute(
      funded,
      place(
        intentOf(hyperliquid, spec, { side: 'sell', price: sigfig(ask * 1.4, spec.scale.px), size, reduceOnly: true }),
      ),
    ),
  )
  await run(
    'insufficientMargin',
    hyperliquid.execute(
      funded,
      place(intentOf(hyperliquid, spec, { price: far, size: (1_000_000 / Number(far)).toFixed(qty) })),
    ),
  )
  const stranger = generatePrivateKey()
  await run(
    'unknownSigner',
    hyperliquid.execute(
      ctx(stranger, privateKeyToAccount(stranger).address.toLowerCase() as Address),
      place(intentOf(hyperliquid, spec, { price: far, size, ...touch })),
    ),
  )

  const unfunded = privateKeyToAccount(generatePrivateKey())
  await run(
    'approveUnfunded',
    hyperliquid.enable(
      { ...ctx(stranger, unfunded.address.toLowerCase() as Address), keys: memoryKeys() },
      walletFor(unfunded, 421_614),
      () => {},
    ),
  )

  const pastTapeChecks = async (name: string, px: string, sz: string) => {
    const nonce = Date.now()
    const action = orderAction(
      [orderWire(index, true, px, sz, false, { limit: { tif: 'Gtc' } }, newClientId())],
      'na',
      null,
    )
    const signature = await signL1Action(localSigner(privateKeyToAccount(secret)), action, nonce, 'Testnet')
    await run(
      name,
      fetch(`${HL}/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      }).then((r) => r.status),
    )
  }
  // A sixth significant figure inside the market's price decimals, and a size one decimal finer than szDecimals.
  const figures = far.split('.')[1]?.length ?? 0
  if (figures >= spec.scale.px) throw new Error(`${far} leaves no decimal to put a sixth figure in`)
  await pastTapeChecks('offTick', (Number(far) + 10 ** -figures / 2).toFixed(figures + 1), size)
  await pastTapeChecks('offStep', far, (Number(size) + 10 ** -qty / 2).toFixed(qty + 1))

  write('hyperliquid', { network: 'testnet', recordedAt: new Date().toISOString(), owner, coin, asset: index, cases })
  const after = await state()
  const ours = ['rest', 'fill'].map(oidOf)
  return {
    orders: after.orders.filter((o) => ours.some((oid) => o.endsWith(` ${oid}`))),
    positions: after.positions.filter((p) => p.startsWith(`${coin} `)),
  }
}

const DYDX = 'https://indexer.v4testnet.dydx.exchange/v4'
const DYDX_FAUCET = 'https://faucet.v4testnet.dydx.exchange/faucet/tokens'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** What v4-client-js resolves or throws, with its byte arrays and bigints written so JSON keeps them. */
function chainReply(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      v instanceof Uint8Array ? { bytes: bytesToHex(v) } : typeof v === 'bigint' ? { bigint: v.toString() } : v,
    ),
  )
}

async function recordDydx() {
  const evm = privateKeyToAccount(throwaway('dydx-evm', generatePrivateKey) as Hex)
  const { mnemonic, address } = await deriveKey(await evm.signTypedData(onboarding('testnet')))
  const subaccount0 = `${DYDX}/addresses/${address}/subaccountNumber/0`
  const funded = async () => {
    if ((await fetch(subaccount0)).ok) return true
    const faucet = await fetch(DYDX_FAUCET, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, subaccountNumber: 0, amount: 1000 }),
    })
    if (!faucet.ok) return false
    for (let i = 0; !(await fetch(subaccount0)).ok; i++) {
      if (i === 60) throw new Error(`the indexer never showed a funded subaccount for ${address}`)
      await sleep(10_000)
    }
    return true
  }
  const holdsUsdc = await funded()

  const ticker = 'BTC-USD'
  type M = {
    clobPairId: string
    oraclePrice: string
    atomicResolution: number
    quantumConversionExponent: number
    stepBaseQuantums: number
    subticksPerTick: number
    tickSize: string
    stepSize: string
  }
  const m = (
    (await (await fetch(`${DYDX}/perpetualMarkets?ticker=${ticker}`)).json()) as { markets: Record<string, M> }
  ).markets[ticker]!
  const scale = { px: decimalsOf(m.tickSize), qty: decimalsOf(m.stepSize) }
  const spec = {
    key: marketKey('dydx', 'BTC' as Base),
    venue: 'dydx',
    base: 'BTC' as Base,
    quote: 'USD',
    kind: 'perp',
    venueSymbol: ticker,
    scale,
    tick: { kind: 'fixed', tick: parsePx(m.tickSize, scale) },
    step: parseQty(m.stepSize, scale),
  } as MarketSpec
  const book = (await (await fetch(`${DYDX}/orderbooks/perpetualMarket/${ticker}`)).json()) as {
    asks: { price: string }[]
  }
  const ask = Number(book.asks[0]!.price)
  const tick = Number(m.tickSize)
  const atTick = (px: number) => (Math.floor(px / tick) * tick).toFixed(scale.px)
  const far = atTick(Number(m.oraclePrice) * 0.6)
  const size = '0.001'

  const validator = await validatorOf('testnet')
  let calls: unknown[] = []
  for (const method of ['placeOrder', 'cancelOrder'] as const) {
    const real = validator.post[method].bind(validator.post) as (...args: unknown[]) => Promise<unknown>
    ;(validator.post as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      try {
        const reply = await real(...args)
        calls.push({ method, reply: chainReply(reply) })
        return reply
      } catch (e) {
        calls.push({ method, thrown: { name: (e as Error).name, message: (e as Error).message } })
        throw e
      }
    }
  }
  const { fetch: indexer, take } = recorder(
    (url) => url.startsWith(`${DYDX}/orders?`) || url.startsWith(`${DYDX}/addresses/`),
  )
  const ctx = (secret: string, dydxAddress: string): VenueContext => ({
    ref: { venue: 'dydx', network: 'testnet', owner: evm.address.toLowerCase() as Address },
    config: {
      mainnet: false,
      hyperliquid: { builder: null },
      dydx: { builder: null },
      orderly: { brokerId: { mainnet: null, testnet: 'demo' } },
    },
    keys: {
      read: () => ({ status: 'linked', public: { address: dydxAddress }, secret }),
      write: () => {},
      clear: () => {},
    },
    fetch: indexer,
  })
  const account = ctx(mnemonic, address)
  const cases: Record<string, { chain: unknown[]; exchanges: Exchange[] }> = {}
  const run = async (name: string, work: () => Promise<unknown>) => {
    await ignoreVerdict(work())
    cases[name] = { chain: calls, exchanges: take() }
    calls = []
    // dYdX limits stateful orders per block, about one a second on testnet.
    await sleep(2500)
  }
  /** The indexer trails the chain by a few blocks, so a lookup waits until it shows the status asked for. */
  const lookupUntil = (intent: OrderIntent, detail: string) => async () => {
    for (let i = 0; ; i++) {
      const found = await dydx.lookup(account, intent)
      if (found.detail === detail || i === 20) return found
      take()
      await sleep(2000)
    }
  }
  const place = (intent: OrderIntent): Command => ({ kind: 'place', intent })
  const refOf = (intent: OrderIntent, flags: 0 | 64) =>
    `${ticker}:${clientIdOf(intent.clientId)}:${flags}:${m.clobPairId}` as OrderRef

  const stranger = await deriveKey(await privateKeyToAccount(generatePrivateKey()).signTypedData(onboarding('testnet')))
  const strangerCtx = ctx(stranger.mnemonic, stranger.address)
  await run('unknownAddress', () => dydx.account(strangerCtx))
  await run('lookupUnknown', () => dydx.lookup(account, intentOf(dydx, spec, { price: far, size })))
  await run('unknownAccount', () => dydx.execute(strangerCtx, place(intentOf(dydx, spec, { price: far, size }))))

  if (holdsUsdc) {
    const rest = intentOf(dydx, spec, { price: far, size })
    await run('rest', () => dydx.execute(account, place(rest)))
    await run('lookupResting', lookupUntil(rest, 'Order open'))
    await run('cancel', () => dydx.execute(account, { kind: 'cancel', order: refOf(rest, 64) }))
    await run('lookupCanceled', lookupUntil(rest, 'Order canceled'))
    await run('cancelCanceled', () => dydx.execute(account, { kind: 'cancel', order: refOf(rest, 64) }))

    const taker = intentOf(dydx, spec, { price: atTick(ask * 1.02), size })
    await run('fill', () => dydx.execute(account, place(taker)))
    await run('lookupFilled', lookupUntil(taker, 'Order filled'))
    await run('cancelFilled', () => dydx.execute(account, { kind: 'cancel', order: refOf(taker, 64) }))
    const close = intentOf(dydx, spec, { kind: 'market', side: 'sell', size, reduceOnly: true })
    await run('close', () => dydx.execute(account, place(close)))
    await run('cancelShortTermFilled', () => dydx.execute(account, { kind: 'cancel', order: refOf(close, 0) }))

    await run('insufficientMargin', () =>
      dydx.execute(account, place(intentOf(dydx, spec, { price: far, size: '10' }))),
    )

    const { default: Long } = await import('long')
    const { SubaccountInfo } = await sdk()
    const subaccount = SubaccountInfo.forLocalWallet(await walletOf(mnemonic), 0)
    const clob = {
      clobPairId: Number(m.clobPairId),
      atomicResolution: m.atomicResolution,
      quantumConversionExponent: m.quantumConversionExponent,
      stepBaseQuantums: m.stepBaseQuantums,
      subticksPerTick: m.subticksPerTick,
    }
    const q = quantums(parseQty(size, scale), scale, clob)
    const s = subticks(parsePx(far, scale), scale, clob)
    const pastTapeChecks = (name: string, rawQuantums: bigint, rawSubticks: bigint) =>
      run(name, () =>
        validator.post.placeOrder(
          subaccount,
          clientIdOf(newClientId()),
          clob.clobPairId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- Order_Side lives in @dydxprotocol/v4-proto, which trade does not depend on
          1,
          Long.fromString(rawQuantums.toString(), true),
          Long.fromString(rawSubticks.toString(), true),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- Order_TimeInForce lives in @dydxprotocol/v4-proto, which trade does not depend on
          0,
          64,
          false,
          undefined,
          Math.floor(Date.now() / 1000) + 3600,
        ),
      )
    await pastTapeChecks('offTick', q, s + BigInt(m.subticksPerTick) / 2n)
    await pastTapeChecks('offStep', q + BigInt(m.stepBaseQuantums) / 2n, s)
  }

  write('dydx', { network: 'testnet', recordedAt: new Date().toISOString(), address, ticker, holdsUsdc, cases })
  if (!holdsUsdc) return leftNothing
  const open = (await (
    await fetch(`${DYDX}/orders?address=${address}&subaccountNumber=0&status=OPEN,BEST_EFFORT_OPENED&limit=50`)
  ).json()) as unknown[]
  const sub = (await (await fetch(subaccount0)).json()) as {
    subaccount: { openPerpetualPositions: Record<string, unknown> }
  }
  return { orders: open, positions: Object.keys(sub.subaccount.openPerpetualPositions) }
}

const ORDERLY = 'https://testnet-api.orderly.org'
const ORDERLY_FAUCET = 'https://testnet-operator-evm.orderly.org/v1/faucet/usdc'
const ORDERLY_BROKER = 'demo'

function memoryKeys(): KeySlot {
  let key: StoredKey | null = null
  return { read: () => key, write: (k) => void (key = k), clear: () => void (key = null) }
}

function walletFor(account: ReturnType<typeof privateKeyToAccount>, chainId: number): WalletSigner {
  return {
    address: account.address,
    chainId: async () => chainId,
    switchChain: async () => {},
    signTypedData: (data) => localSigner(account).signTypedData(data as unknown as TypedData),
  }
}

async function recordOrderly() {
  const symbol = 'PERP_BTC_USDC'
  const keep = (url: string) =>
    url.startsWith(ORDERLY) && !url.startsWith(`${ORDERLY}/v1/public/`) && !url.includes('/v1/positions')
  const { fetch, take } = recorder(keep)
  const ctxOf = (evm: ReturnType<typeof privateKeyToAccount>, keys: KeySlot): VenueContext => ({
    ref: { venue: 'orderly', network: 'testnet', owner: evm.address.toLowerCase() as Address },
    config: {
      mainnet: false,
      hyperliquid: { builder: null },
      dydx: { builder: null },
      orderly: { brokerId: { mainnet: null, testnet: ORDERLY_BROKER } },
    },
    keys,
    fetch,
  })
  const cases: Record<string, { exchanges: Exchange[] }> = {}
  const run = async (name: string, work: () => Promise<unknown>) => {
    await ignoreVerdict(work())
    cases[name] = { exchanges: take() }
  }

  const fresh = privateKeyToAccount(generatePrivateKey())
  const freshCtx = ctxOf(fresh, memoryKeys())
  await run('steps', () => orderly.steps(freshCtx))
  await run('enable', () => orderly.enable(freshCtx, walletFor(fresh, 421_614), () => {}))
  await run('stepsDone', () => orderly.steps(freshCtx))

  const evm = privateKeyToAccount(throwaway('orderly-evm', generatePrivateKey) as Hex)
  const secret = throwaway('orderly-key', () => bytesToHex(orderlyKey().secret))
  const keys = memoryKeys()
  keys.write({ status: 'linked', public: { key: orderlyKey(hexToBytes(secret as Hex)).id }, secret })
  const ctx = ctxOf(evm, keys)
  if ((await orderly.steps(ctx)).some((step) => !step.done))
    await orderly.enable(ctx, walletFor(evm, 421_614), () => {})
  const available = async () => {
    const view = await orderly.account(ctx).catch((e: unknown) => {
      if (e instanceof TradeFailure && e.error.kind === 'unreachable') return null
      throw e
    })
    take()
    return view?.kind === 'live' ? Number(view.snapshot.available) : 0
  }
  const funded = async () => {
    if ((await available()) > 0) return true
    const faucet = await globalThis.fetch(ORDERLY_FAUCET, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain_id: '421614', user_address: evm.address, broker_id: ORDERLY_BROKER }),
    })
    const granted = await faucet.text()
    if (!faucet.ok || !(JSON.parse(granted) as { success: boolean }).success) return false
    // The faucet credits the account some time after it answers.
    for (let i = 0; (await available()) === 0; i++) {
      if (i === 60) throw new Error(`the faucet USDC never reached ${evm.address}`)
      await sleep(10_000)
    }
    return true
  }
  const holdsUsdc = await funded()
  take()

  type Info = { quote_tick: number; base_tick: number; price_scope: number }
  const info = ((await (await globalThis.fetch(`${ORDERLY}/v1/public/info/${symbol}`)).json()) as { data: Info }).data
  const mark = (
    (await (await globalThis.fetch(`${ORDERLY}/v1/public/futures/${symbol}`)).json()) as {
      data: { mark_price: number }
    }
  ).data.mark_price
  const scale = { px: decimalsOf(String(info.quote_tick)), qty: decimalsOf(plainDecimal(String(info.base_tick))) }
  const spec = {
    key: marketKey('orderly', 'BTC' as Base),
    venue: 'orderly',
    base: 'BTC' as Base,
    quote: 'USDC',
    kind: 'perp',
    venueSymbol: symbol,
    scale,
    tick: { kind: 'fixed', tick: parsePx(String(info.quote_tick), scale) },
    step: parseQty(plainDecimal(String(info.base_tick)), scale),
  } as MarketSpec
  // Orderly refuses a buy priced below mark * (1 - price_scope), so the resting order sits inside that.
  const far = (mark * (1 - info.price_scope / 2)).toFixed(scale.px)
  const size = (Math.ceil((12 / Number(far)) * 10 ** scale.qty) / 10 ** scale.qty).toFixed(scale.qty)
  const place = (intent: OrderIntent): Command => ({ kind: 'place', intent })
  const orderIdOf = (name: string) => {
    const id = (cases[name]?.exchanges.at(-1)?.response as { data?: { order_id?: number } } | undefined)?.data?.order_id
    if (id === undefined) throw new Error(`${name} has no order_id`)
    return id
  }
  const cancel = (id: number): Command => ({ kind: 'cancel', order: `${symbol}:${id}` as OrderRef })

  const rest = intentOf(orderly, spec, { price: far, size })
  if (holdsUsdc) {
    await run('rest', () => orderly.execute(ctx, place(rest)))
    await run('lookupResting', () => orderly.lookup(ctx, rest))
    await run('cancel', () => orderly.execute(ctx, cancel(orderIdOf('rest'))))
    await sleep(1000)
    await run('cancelCanceled', () => orderly.execute(ctx, cancel(orderIdOf('rest'))))
    await run('lookupCanceled', () => orderly.lookup(ctx, rest))

    const buy = intentOf(orderly, spec, { kind: 'market', size })
    await run('fill', () => orderly.execute(ctx, place(buy)))
    await sleep(2000)
    await run('lookupFilled', () => orderly.lookup(ctx, buy))
    await run('cancelFilled', () => orderly.execute(ctx, cancel(orderIdOf('fill'))))
    await run('close', () =>
      orderly.execute(ctx, place(intentOf(orderly, spec, { kind: 'market', side: 'sell', size, reduceOnly: true }))),
    )
  }
  await run('lookupUnknown', () => orderly.lookup(ctx, intentOf(orderly, spec, { price: far, size })))
  await run('cancelUnknown', () => orderly.execute(ctx, cancel(1)))

  await run('minimumValue', () =>
    orderly.execute(
      ctx,
      place(intentOf(orderly, spec, { price: far, size: (1 / 10 ** scale.qty).toFixed(scale.qty) })),
    ),
  )
  await run('insufficientMargin', () => orderly.execute(ctx, place(intentOf(orderly, spec, { price: far, size: '5' }))))
  await run('reduceOnly', () =>
    orderly.execute(
      ctx,
      place(intentOf(orderly, spec, { side: 'sell', price: (mark * 1.2).toFixed(scale.px), size, reduceOnly: true })),
    ),
  )
  const strayKey = { status: 'linked', public: {}, secret: bytesToHex(orderlyKey().secret) } as const
  await run('lookupUnknownKey', () => orderly.lookup({ ...ctx, keys: { ...keys, read: () => strayKey } }, rest))
  await run('unregistered', () =>
    orderly.execute(
      ctxOf(privateKeyToAccount(generatePrivateKey()), { read: () => strayKey, write: () => {}, clear: () => {} }),
      place(intentOf(orderly, spec, { price: far, size })),
    ),
  )

  const key = orderlyKey(hexToBytes(keys.read()!.secret as Hex))
  const pastTapeChecks = (name: string, price: string, quantity: string) =>
    run(name, async () => {
      const body = orderBody({
        symbol,
        clientOrderId: newClientId(),
        type: 'LIMIT',
        side: 'BUY',
        price,
        quantity,
        reduceOnly: false,
      })
      const headers = signRequest(key, accountId(ctx.ref.owner, ORDERLY_BROKER), Date.now(), 'POST', '/v1/order', body)
      await fetch(`${ORDERLY}/v1/order`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      })
    })
  await pastTapeChecks('offTick', (Number(far) + 10 ** -scale.px / 2).toFixed(scale.px + 1), size)
  await pastTapeChecks('offStep', far, (Number(size) + 10 ** -scale.qty / 2).toFixed(scale.qty + 1))

  const view = await orderly.account(ctx)
  write('orderly', {
    network: 'testnet',
    recordedAt: new Date().toISOString(),
    owner: ctx.ref.owner,
    brokerId: ORDERLY_BROKER,
    symbol,
    holdsUsdc,
    cases,
  })
  if (view.kind === 'live') return { orders: view.snapshot.orders, positions: view.snapshot.positions }
  if (view.kind === 'empty') return leftNothing
  throw new Error(`account reads ${view.kind}`)
}

const only = process.env.RECORD_WRITES

describe.runIf(only)('record write fixtures', () => {
  it.runIf(only === 'hyperliquid')('records hyperliquid on testnet', { timeout: 120_000 }, async () => {
    const keyFile = process.env.RECORD_WRITES_HL_KEY_FILE
    expect(keyFile, 'RECORD_WRITES_HL_KEY_FILE names a funded testnet key').toBeTruthy()
    expect(await recordHyperliquid(keyFile!)).toEqual(leftNothing)
  })

  it.runIf(only === 'dydx')('records dydx on testnet with a faucet account', { timeout: 900_000 }, async () => {
    expect(await recordDydx()).toEqual(leftNothing)
  })

  it.runIf(only === 'orderly')('records orderly on testnet with a faucet account', { timeout: 900_000 }, async () => {
    expect(await recordOrderly()).toEqual(leftNothing)
  })
})
