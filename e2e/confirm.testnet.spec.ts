import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { connectWallet, expect, expectAccessible, openMarket, panel, settled, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'
import type { ExchangeBody } from './hyperliquid'

const BTC = (
  JSON.parse(
    readFileSync(new URL('../packages/venues/src/__fixtures__/hyperliquid.meta.json', import.meta.url), 'utf8'),
  ) as { universe: { name: string }[] }
).universe.findIndex((asset) => asset.name === 'BTC')

/** Hyperliquid's `clearinghouseState` and `frontendOpenOrders` replies from its API docs, holding 0.01 BTC long and one resting BTC order. */
const HOLDING: Record<string, unknown> = {
  clearinghouseState: {
    marginSummary: { accountValue: '1000.0', totalNtlPos: '800.0', totalRawUsd: '200.0', totalMarginUsed: '40.0' },
    crossMarginSummary: { accountValue: '1000.0', totalNtlPos: '800.0', totalRawUsd: '200.0', totalMarginUsed: '40.0' },
    crossMaintenanceMarginUsed: '8.0',
    withdrawable: '960.0',
    assetPositions: [
      {
        type: 'oneWay',
        position: {
          coin: 'BTC',
          szi: '0.01',
          entryPx: '80000.0',
          positionValue: '800.0',
          unrealizedPnl: '0.0',
          liquidationPx: null,
          leverage: { type: 'cross', value: 20 },
        },
      },
    ],
    time: 0,
  },
  frontendOpenOrders: [
    {
      coin: 'BTC',
      side: 'B',
      limitPx: '70000.0',
      sz: '0.002',
      oid: 41,
      timestamp: 0,
      orderType: 'Limit',
      reduceOnly: false,
      isTrigger: false,
      triggerPx: '0.0',
    },
  ],
}

async function holding(page: Page) {
  const hyperliquid = await fakeHyperliquid(page, 'testnet')
  await page.route('https://api.hyperliquid-testnet.xyz/info', async (route) => {
    const { type } = route.request().postDataJSON() as { type: string }
    return type in HOLDING
      ? route.fulfill({ json: HOLDING[type], headers: { 'access-control-allow-origin': '*' } })
      : route.fallback()
  })
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await connectWallet(page, ticket.getByRole('button', { name: 'Connect wallet' }))
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Buy / Long BTC' })).toBeVisible()
  const account = panel(page, 'Account')
  await expect(account.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  return { hyperliquid, account }
}

const writes = (sent: readonly ExchangeBody[]) => sent.filter((body) => body.action.type !== 'approveAgent')

test('Close opens the ruler on its Close tab, and closing at market sends one reduce-only close', async ({
  page,
  wallet,
}) => {
  const { hyperliquid, account } = await holding(page)
  await account.getByRole('button', { name: 'Close', exact: true }).click()
  const ruler = page.getByRole('dialog', { name: /^BTC Long/ })
  await expect(ruler.getByRole('radio', { name: 'Close', exact: true })).toHaveAttribute('aria-checked', 'true')
  await settled(page)
  await expectAccessible(page)
  expect(writes(hyperliquid.sent)).toEqual([])

  await ruler.getByRole('button', { name: 'Close 0.01000 BTC at market' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  // Closing 0.01 long sells it as an IOC limit at the bid 79990 less 1%, 79190.1, rounded up to the
  // whole dollar Hyperliquid's five significant figures allow at this price: 79191.
  expect(writes(hyperliquid.sent).map((body) => body.action.orders)).toEqual([
    [{ a: BTC, b: false, p: '79191', s: '0.01', r: true, t: { limit: { tif: 'Ioc' } }, c: expect.any(String) }],
  ])
  expect(wallet.askedFor('sign').map((ask) => ask.typedData.primaryType)).toEqual([
    'HyperliquidTransaction:ApproveAgent',
  ])
})

test('Escape and a click outside close the ruler and send nothing', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page)
  const close = account.getByRole('button', { name: 'Close', exact: true })
  const ruler = page.getByRole('dialog', { name: /^BTC Long/ })

  await close.click()
  await expect(ruler).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ruler).toHaveCount(0)
  await expect(close).toBeFocused()

  await close.click()
  await expect(ruler).toBeVisible()
  await panel(page, 'Order book').click()
  await expect(ruler).toHaveCount(0)
  expect(writes(hyperliquid.sent)).toEqual([])
})

test('positions and orders spell their side out', async ({ page, wallet: _wallet }) => {
  const { account } = await holding(page)
  await expect(account.getByRole('row', { name: /^BTC Long 0\.01000 BTC / })).toBeVisible()
  await account.getByRole('radio', { name: 'Orders 1' }).click()
  await expect(account.getByRole('row', { name: /^BTC Buy / })).toBeVisible()
})

const agentApprovals = (sent: readonly ExchangeBody[]) =>
  sent.filter((body) => body.action.type === 'approveAgent').map((body) => body.action)

test('revoking the trading key asks first, approves a key no one keeps under its name, then forgets it', async ({
  page,
  wallet,
}) => {
  const { hyperliquid, account } = await holding(page)
  const ticket = panel(page, 'Order ticket')
  await expect(ticket.getByRole('button', { name: /Revoke|Forget/ })).toHaveCount(0)
  await account.getByRole('button', { name: 'Revoke trading key' }).click()
  const step = account.getByRole('group', { name: 'Revoke the trading key on Hyperliquid?' })
  await expect(step.getByRole('button', { name: 'Revoke key' })).toBeFocused()
  await expect(ticket.getByRole('button', { name: 'Buy / Long BTC' })).toBeVisible()
  expect(agentApprovals(hyperliquid.sent)).toHaveLength(1)

  await step.getByRole('button', { name: 'Revoke key' }).click()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toBeVisible()
  // The API wallet docs: approving another address under a named agent's name deregisters that agent.
  const [enabled, revoked] = agentApprovals(hyperliquid.sent)
  expect(revoked).toMatchObject({ agentName: 'tape' })
  expect(revoked?.agentAddress).not.toEqual(enabled?.agentAddress)
  expect(wallet.askedFor('sign').map((ask) => ask.typedData.primaryType)).toEqual([
    'HyperliquidTransaction:ApproveAgent',
    'HyperliquidTransaction:ApproveAgent',
  ])
})

test('a revoke Hyperliquid refuses keeps the key and says so', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page)
  const ticket = panel(page, 'Order ticket')
  hyperliquid.exchange = () => ({ json: { status: 'err', response: 'User has pending agent removal' } })
  await account.getByRole('button', { name: 'Revoke trading key' }).click()
  await account.getByRole('button', { name: 'Revoke key' }).click()
  const alert = account.getByRole('alert')
  await expect(alert).toContainText('Not revoked. The key stays on this device. The venue rejected it.')
  await expect(alert).toContainText('User has pending agent removal')
  await expect(account.getByRole('button', { name: 'Revoke trading key' })).toBeEnabled()
  await expect(ticket.getByRole('button', { name: 'Buy / Long BTC' })).toBeVisible()
  await expectAccessible(page)
})

test('leverage starts at the position leverage and refuses a value out of range in the field', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, account } = await holding(page)
  const field = account.getByRole('textbox', { name: 'Leverage' })
  await expect(field).toHaveValue('20')
  const set = account.getByRole('button', { name: 'Set', exact: true })
  await field.fill('80')
  await expect(field).toHaveAccessibleDescription('Whole number from 1 to 50')
  await expect(set).toBeDisabled()

  await field.fill('10')
  await expect(field).toHaveAccessibleDescription('')
  await set.click()
  await expect
    .poll(() => writes(hyperliquid.sent).map((body) => body.action))
    .toEqual([{ type: 'updateLeverage', asset: BTC, isCross: true, leverage: 10 }])
})
