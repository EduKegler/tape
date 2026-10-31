import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'
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
  await ticket.getByRole('button', { name: 'Connect wallet' }).click()
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()
  const account = panel(page, 'Account')
  await expect(account.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
  return { hyperliquid, account }
}

const writes = (sent: readonly ExchangeBody[]) => sent.filter((body) => body.action.type !== 'approveAgent')

test('one click on Close only asks, and Confirm sends one reduce-only close', async ({ page, wallet }) => {
  const { hyperliquid, account } = await holding(page)
  await account.getByRole('button', { name: 'Close', exact: true }).click()
  const step = account.getByRole('group', { name: 'Close 0.01 BTC long on Hyperliquid?' })
  await expect(step).toBeVisible()
  await expect(step.getByRole('button', { name: 'Confirm' })).toBeFocused()
  await expectAccessible(page)
  expect(writes(hyperliquid.sent)).toEqual([])

  await step.getByRole('button', { name: 'Confirm' }).click()
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

test('the close step shows its size, the bid it sells into and its own slippage', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page)
  await account.getByRole('button', { name: 'Close', exact: true }).click()
  const step = account.getByRole('group', { name: 'Close 0.01 BTC long on Hyperliquid?' })
  await expect(step).toContainText(/Size 0\.01 · Expected \d{2},\d{3}/)
  await expect(step.getByRole('radio', { name: '1%', exact: true })).toHaveAttribute('aria-checked', 'true')
  await step.getByRole('radio', { name: '0.5%', exact: true }).click()

  await step.getByRole('button', { name: 'Confirm close' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  // The bid 79990 less 0.5% is 79590.05, rounded up to the whole dollar five significant figures allow: 79591.
  expect(writes(hyperliquid.sent).map((body) => body.action.orders?.[0]?.p)).toEqual(['79591'])
  const ticket = panel(page, 'Order ticket')
  await ticket.getByRole('radio', { name: 'Market', exact: true }).click()
  await expect(ticket.getByRole('radio', { name: '1%', exact: true })).toHaveAttribute('aria-checked', 'true')
})

test('Escape and a click outside put Close back and send nothing', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page)
  const close = account.getByRole('button', { name: 'Close', exact: true })
  const step = account.getByRole('group', { name: 'Close 0.01 BTC long on Hyperliquid?' })

  await close.click()
  await expect(step).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(step).toHaveCount(0)
  await expect(close).toBeFocused()

  await close.click()
  await expect(step).toBeVisible()
  await panel(page, 'Order book').click()
  await expect(step).toHaveCount(0)
  expect(writes(hyperliquid.sent)).toEqual([])
})

test('positions and orders spell their side out', async ({ page, wallet: _wallet }) => {
  const { account } = await holding(page)
  await expect(account.getByRole('row', { name: /^BTC Long 0\.01 / })).toBeVisible()
  await account.getByRole('radio', { name: 'Orders 1' }).click()
  await expect(account.getByRole('row', { name: /^BTC Buy / })).toBeVisible()
})

test('Cancel all BTC asks first, then sends one cancel for the BTC orders', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page)
  await account.getByRole('button', { name: 'Cancel all BTC' }).click()
  const step = account.getByRole('group', { name: 'Cancel 1 BTC order on Hyperliquid?' })
  await expect(step).toBeVisible()
  expect(writes(hyperliquid.sent)).toEqual([])

  await step.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  expect(writes(hyperliquid.sent).map((body) => body.action)).toEqual([
    { type: 'cancel', cancels: [{ a: BTC, o: 41 }] },
  ])
})

test('forgetting the trading key sits in the account bar and asks first', async ({ page, wallet: _wallet }) => {
  const { account } = await holding(page)
  const ticket = panel(page, 'Order ticket')
  await expect(ticket.getByRole('button', { name: /Forget/ })).toHaveCount(0)
  await account.getByRole('button', { name: 'Forget trading key' }).click()
  const step = account.getByRole('group', { name: 'Forget the trading key for Hyperliquid on this device?' })
  await expect(step.getByRole('button', { name: 'Forget key' })).toBeFocused()
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()

  await step.getByRole('button', { name: 'Forget key' }).click()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toBeVisible()
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
