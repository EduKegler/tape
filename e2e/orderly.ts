import type { Page, Route } from '@playwright/test'
import type { Network } from '@tape/core/ids'

const API: Record<Network, string> = { mainnet: 'https://api.orderly.org', testnet: 'https://testnet-api.orderly.org' }

interface OrderlyWrite {
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
}

/** Orderly's replies from its API docs, for an address it has never registered. */
const ok = (data: unknown) => ({ success: true, data, timestamp: 0 })
const EMPTY: Record<string, unknown> = {
  '/v1/positions': ok({ total_collateral_value: 0, free_collateral: 0, rows: [] }),
  '/v1/orders': ok({ rows: [] }),
  '/v1/trades': ok({ rows: [] }),
}

export async function fakeOrderly(page: Page, network: Network) {
  const sent: OrderlyWrite[] = []
  const registered = { value: false }
  const venue = { sent, nonce: '194528949540', registered }
  const reply = (route: Route, json: unknown) =>
    route.fulfill({ json, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
  await page.route(`${API[network]}/v1/**`, (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return reply(route, {})
    if (request.method() === 'POST') {
      sent.push({ path, body: request.postDataJSON() as Record<string, unknown> })
      if (path === '/v1/register_account') registered.value = true
      return reply(route, ok({ account_id: '0x01', id: 1, order_id: 5 }))
    }
    if (path === '/v1/get_account')
      return reply(
        route,
        registered.value ? ok({ account_id: '0x01' }) : { success: false, code: -1003, message: 'account not exist' },
      )
    if (path === '/v1/registration_nonce') return reply(route, ok({ registration_nonce: venue.nonce }))
    if (path in EMPTY) return reply(route, EMPTY[path])
    return route.fallback()
  })
  return venue
}
