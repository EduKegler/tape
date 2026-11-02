import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { connectWallet, expect, expectAccessible, openMarket, panel, settled, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'
import type { ExchangeBody } from './hyperliquid'

const UNIVERSE = (
  JSON.parse(
    readFileSync(new URL('../packages/venues/src/__fixtures__/hyperliquid.meta.json', import.meta.url), 'utf8'),
  ) as { universe: { name: string }[] }
).universe.map((asset) => asset.name)
const BTC = UNIVERSE.indexOf('BTC')

const position = (coin: string, szi: string, entryPx: string, positionValue: string, unrealizedPnl: string) => ({
  type: 'oneWay',
  position: {
    coin,
    szi,
    entryPx,
    positionValue,
    unrealizedPnl,
    liquidationPx: null,
    leverage: { type: 'cross', value: 20 },
  },
})
const order = (coin: string, oid: number, fields: Record<string, unknown>) => ({
  coin,
  side: 'B',
  limitPx: '70000.0',
  sz: '0.002',
  oid,
  timestamp: 0,
  orderType: 'Limit',
  reduceOnly: false,
  isTrigger: false,
  triggerPx: '0.0',
  ...fields,
})

/** Hyperliquid's `clearinghouseState` shape from its API docs, holding `positions`. */
const state = (positions: readonly unknown[]) => ({
  marginSummary: { accountValue: '1000.0', totalNtlPos: '800.0', totalRawUsd: '200.0', totalMarginUsed: '40.0' },
  crossMarginSummary: { accountValue: '1000.0', totalNtlPos: '800.0', totalRawUsd: '200.0', totalMarginUsed: '40.0' },
  crossMaintenanceMarginUsed: '8.0',
  withdrawable: '960.0',
  assetPositions: positions,
  time: 0,
})

const BTC_LONG = position('BTC', '0.01', '80000.0', '800.0', '0.0')
const RESTING = order('BTC', 41, {})
const TAKE_PROFIT = order('BTC', 42, {
  side: 'A',
  limitPx: '75600.0',
  sz: '0.0',
  orderType: 'Take Profit Market',
  reduceOnly: true,
  isTrigger: true,
  triggerPx: '84000.0',
  isPositionTpsl: true,
})

async function holding(page: Page, positions: readonly unknown[], orders: readonly unknown[]) {
  const hyperliquid = await fakeHyperliquid(page, 'testnet')
  hyperliquid.account = { ...hyperliquid.account, clearinghouseState: state(positions), frontendOpenOrders: orders }
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await connectWallet(page, ticket.getByRole('button', { name: 'Connect wallet' }))
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Buy / Long BTC' })).toBeVisible()
  const account = panel(page, 'Account')
  await expect(account.getByRole('button', { name: 'Close', exact: true }).first()).toBeVisible()
  return { hyperliquid, account }
}

const writes = (sent: readonly ExchangeBody[]) => sent.filter((body) => body.action.type !== 'approveAgent')

test('a take profit set on the ruler goes out for the whole position', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [])
  await account.getByRole('button', { name: 'Add TP/SL to BTC' }).click()
  const ruler = page.getByRole('dialog', { name: /^BTC Long/ })
  await expect(ruler.getByRole('slider', { name: 'Take profit' })).toHaveAttribute('aria-valuetext', 'not set')
  await expect(ruler.getByRole('button', { name: 'Set TP/SL' })).toBeDisabled()
  await settled(page)
  await expectAccessible(page)

  await ruler.getByRole('textbox', { name: 'Take profit price' }).fill('84000')
  // 20x on 0.01 at 80,000 puts 40 USDC of margin up, so 4,000 up on 0.01 earns 40 USDC, 100% of it.
  await expect(ruler.getByRole('textbox', { name: 'Take profit return on margin' })).toHaveValue('100')
  await expect(ruler.getByText('Profit +40.00 USDC')).toBeVisible()
  await ruler.getByRole('button', { name: 'Set TP 84,000' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  const [sent] = writes(hyperliquid.sent)
  expect(sent?.action).toMatchObject({ type: 'order', grouping: 'positionTpsl' })
  expect(sent?.action.orders).toEqual([
    expect.objectContaining({
      a: BTC,
      b: false,
      s: '0',
      r: true,
      t: { trigger: expect.objectContaining({ triggerPx: '84000', tpsl: 'tp' }) },
    }),
  ])
})

test('an armed take profit moves five ticks per arrow and goes out as a modify', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [TAKE_PROFIT])
  await account.getByRole('button', { name: 'BTC take profit and stop loss 84,000 / —' }).click()
  const ruler = page.getByRole('dialog', { name: /^BTC Long/ })
  await expect(ruler.getByText('Armed 84,000')).toBeVisible()
  const handle = ruler.getByRole('slider', { name: 'Take profit' })
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  // Five significant figures leave a one dollar tick at 84,000.
  await expect(handle).toHaveAttribute('aria-valuenow', '84005')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '83955')
  await ruler.getByRole('button', { name: 'Replace TP 83,955' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  expect(writes(hyperliquid.sent)[0]?.action).toMatchObject({
    type: 'batchModify',
    modifies: [
      { oid: 42, order: { a: BTC, t: { trigger: expect.objectContaining({ triggerPx: '83955', tpsl: 'tp' }) } } },
    ],
  })
})

test('Escape closes the ruler and gives focus back to its trigger', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [])
  const trigger = account.getByRole('button', { name: 'Close', exact: true })
  await trigger.click()
  await expect(page.getByRole('dialog', { name: /^BTC Long/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /^BTC Long/ })).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(writes(hyperliquid.sent)).toEqual([])
})

test('closing half at a limit rests one reduce-only order', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [])
  await account.getByRole('button', { name: 'Close', exact: true }).click()
  const close = page.getByRole('dialog', { name: /^BTC Long/ })
  await expect(close.getByRole('button', { name: 'Close 0.01000 BTC at market' })).toBeVisible()
  await close.getByRole('radio', { name: '50%' }).click()
  await expect(close.getByRole('textbox', { name: 'Size to close' })).toHaveValue('0.00500')
  await close.getByRole('radio', { name: 'Limit' }).click()
  await close.getByRole('textbox', { name: 'Limit price' }).fill('81000')
  // Half of 0.01 closed 1,000 above the 80,000 entry earns 5 USDC.
  await expect(
    close.getByText(/Rests as reduce only until it fills · Keeps 0\.00500 BTC · Est\. PnL \+5\.00 USDC/),
  ).toBeVisible()
  await close.getByRole('button', { name: 'Close 0.00500 BTC at 81,000' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  expect(writes(hyperliquid.sent)[0]?.action.orders).toEqual([
    { a: BTC, b: false, p: '81000', s: '0.005', r: true, t: { limit: { tif: 'Gtc' } }, c: expect.any(String) },
  ])
})

test('a resting order moves to a typed price in place', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [RESTING])
  await account.getByRole('radio', { name: 'Orders 1' }).click()
  await account.getByRole('button', { name: 'Move', exact: true }).click()
  const move = page.getByRole('dialog', { name: 'Move BTC Buy limit' })
  await expect(move.getByText('Hyperliquid moves it in place')).toBeVisible()
  await expect(move.getByRole('button', { name: 'Move order' })).toBeDisabled()
  await move.getByRole('textbox', { name: 'Price', exact: true }).fill('70500')
  await move.getByRole('button', { name: 'Move to 70,500' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  expect(writes(hyperliquid.sent)[0]?.action).toMatchObject({
    type: 'batchModify',
    modifies: [{ oid: 41, order: { a: BTC, b: true, p: '70500', s: '0.002', r: false, t: { limit: { tif: 'Gtc' } } } }],
  })
})

test('the positions table shows mark, return on margin and the legs', async ({ page, wallet: _wallet }) => {
  const { account } = await holding(page, [position('BTC', '0.01', '80000.0', '810.0', '10.0')], [TAKE_PROFIT])
  // A mark of 810 / 0.01 = 81,000, and 10 USDC on 40 of margin is 25%.
  await expect(
    account.getByRole('row', { name: /^BTC Long 0\.01000 BTC 80,000 81,000 \+10\.00 \+25\.00% — / }),
  ).toBeVisible()
  await expect(account.getByRole('button', { name: 'BTC take profit and stop loss 84,000 / —' })).toContainText(
    '84,000 / —',
  )
})
