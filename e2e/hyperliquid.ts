import type { Page, Route } from '@playwright/test'
import type { Network } from '@tape/core/ids'

const API: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
}

interface OrderWire {
  readonly a: number
  readonly b: boolean
  readonly p: string
  readonly s: string
  readonly r: boolean
  readonly t: unknown
  readonly c?: string
}

export interface ExchangeBody {
  readonly action: {
    readonly type: string
    readonly orders?: readonly OrderWire[]
    readonly [field: string]: unknown
  }
  readonly nonce: number
  readonly signature: unknown
}

export type Answer = { readonly json: unknown } | { readonly abort: 'timedout' }

/** Hyperliquid's replies from its API docs, for an account that holds nothing. */
const EMPTY_ACCOUNT: Record<string, unknown> = {
  clearinghouseState: {
    marginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
    crossMarginSummary: { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' },
    crossMaintenanceMarginUsed: '0.0',
    withdrawable: '0.0',
    assetPositions: [],
    time: 0,
  },
  spotClearinghouseState: { balances: [] },
  userAbstraction: 'default',
  frontendOpenOrders: [],
  userFills: [],
  extraAgents: [],
  activeAssetData: { leverage: { type: 'cross', value: 20 } },
  userNonFundingLedgerUpdates: [],
}

export const ACCEPTED = { json: { status: 'ok', response: { type: 'default' } } } as const
export const resting = (oid: number) => ({
  json: { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid } }] } } },
})

export async function fakeHyperliquid(page: Page, network: Network) {
  const sent: ExchangeBody[] = []
  const venue = {
    sent,
    exchange: (_body: ExchangeBody): Answer | Promise<Answer> => ACCEPTED,
    orderStatus: (_cloid: string): unknown => ({ status: 'unknownOid' }),
  }
  const answer = (route: Route, reply: Answer) =>
    'abort' in reply
      ? route.abort(reply.abort)
      : route.fulfill({ json: reply.json, headers: { 'access-control-allow-origin': '*' } })
  await page.route(`${API[network]}/exchange`, async (route) => {
    const body = route.request().postDataJSON() as ExchangeBody
    sent.push(body)
    return answer(route, await venue.exchange(body))
  })
  await page.route(`${API[network]}/info`, async (route) => {
    const body = route.request().postDataJSON() as { type: string; oid?: string }
    if (body.type === 'orderStatus') return answer(route, { json: await venue.orderStatus(body.oid!) })
    return body.type in EMPTY_ACCOUNT ? answer(route, { json: EMPTY_ACCOUNT[body.type] }) : route.fallback()
  })
  return venue
}
