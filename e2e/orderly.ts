import type { Page, Route } from '@playwright/test'
import type { Network } from '@tape/core/ids'
import { recordedWrite } from '@tape/trade/fixtures'

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

/** Orderly testnet's recorded replies while a fresh wallet registered, added a key and was read back. */
const [UNREGISTERED, NONCE, REGISTER, KEY_ADDED] = recordedWrite('orderly', 'enable').exchanges.map((e) => e.response)
const REGISTERED = recordedWrite('orderly', 'stepsDone').exchanges[0]!.response
const SETUP_WRITES: Record<string, unknown> = { '/v1/register_account': REGISTER, '/v1/orderly_key': KEY_ADDED }

export async function fakeOrderly(page: Page, network: Network) {
  const sent: OrderlyWrite[] = []
  const registered = { value: false }
  const nonce = (NONCE as { data: { registration_nonce: string } }).data.registration_nonce
  const venue = { sent, nonce, registered }
  const reply = (route: Route, json: unknown) =>
    route.fulfill({ json, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
  await page.route(`${API[network]}/v1/**`, (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return reply(route, {})
    if (request.method() === 'POST') {
      sent.push({ path, body: request.postDataJSON() as Record<string, unknown> })
      if (path === '/v1/register_account') registered.value = true
      return reply(route, SETUP_WRITES[path] ?? ok({ order_id: 5 }))
    }
    if (path === '/v1/get_account') return reply(route, registered.value ? REGISTERED : UNREGISTERED)
    if (path === '/v1/registration_nonce') return reply(route, NONCE)
    if (path in EMPTY) return reply(route, EMPTY[path])
    return route.fallback()
  })
  return venue
}
