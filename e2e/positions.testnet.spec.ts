import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { connectWallet, expect, expectAccessible, openMarket, panel, settled, test } from './fixtures'
import { fakeHyperliquid, replyOf } from './hyperliquid'
import type { ExchangeBody } from './hyperliquid'

const UNIVERSE = (
  JSON.parse(
    readFileSync(new URL('../packages/venues/src/__fixtures__/hyperliquid.meta.json', import.meta.url), 'utf8'),
  ) as { universe: { name: string }[] }
).universe.map((asset) => asset.name)
const BTC = UNIVERSE.indexOf('BTC')
const ETH = UNIVERSE.indexOf('ETH')

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
const ETH_SHORT = position('ETH', '-0.5', '3000.0', '1500.0', '0.0')
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

/** Answers each order with the next reply queued for its asset. */
const answering = (replies: Record<number, ReturnType<typeof replyOf>[]>) => (body: ExchangeBody) =>
  replies[body.action.orders?.[0]?.a ?? -1]?.shift() ?? replyOf('close')

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

test('a part of a position worth less than the venue minimum shows on the size field and sends nothing', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [])
  await account.getByRole('button', { name: 'Close', exact: true }).click()
  const close = page.getByRole('dialog', { name: /^BTC Long/ })
  await close.getByRole('radio', { name: 'Limit' }).click()
  await close.getByRole('textbox', { name: 'Limit price' }).fill('81000')
  const size = close.getByRole('textbox', { name: 'Size to close' })
  // Hyperliquid refuses an order worth under 10 USDC, as its error responses page says. 0.0001 at 81000 is 8.10.
  await size.fill('0.0001')
  await expect(size).toHaveAccessibleDescription(/^Must be worth at least 10\b/)
  await expect(close.getByRole('button', { name: 'Close', exact: true })).toBeDisabled()
  await size.fill('0.0002')
  await expect(size).toHaveAccessibleDescription('')
  expect(writes(hyperliquid.sent)).toEqual([])
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

test('close all keeps its report after the last position closes', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [])
  hyperliquid.exchange = () => replyOf('close')
  await account.getByRole('button', { name: 'Close all 1' }).click()
  const asking = page.getByRole('dialog', { name: 'Close positions on Hyperliquid' })
  hyperliquid.account = { ...hyperliquid.account, clearinghouseState: state([]) }
  await asking.getByRole('button', { name: 'Close 1 position at market' }).click()

  await expect(account.getByText('No open positions.')).toBeVisible()
  // Hyperliquid testnet's recorded fill of a close: 0.00026 at 77648.0, of a 0.01 long from 80,000,
  // so (77,648 - 80,000) x 0.00026 = -0.61 realized.
  await expect(page.getByRole('dialog', { name: 'Closed 1 of 1 on Hyperliquid' }).getByRole('listitem')).toContainText(
    'Filled 0.00026 BTC at 77,648-0.61',
  )
})

test('close all reports each close and retries only the refused one', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG, ETH_SHORT], [])
  hyperliquid.exchange = answering({ [BTC]: [replyOf('close')], [ETH]: [replyOf('reduceOnly'), replyOf('close')] })
  await account.getByRole('button', { name: 'Close all 2' }).click()
  const asking = page.getByRole('dialog', { name: 'Close positions on Hyperliquid' })
  await expect(asking.getByText(/^One order each, so a refusal leaves the others closed\./)).toBeVisible()
  await asking.getByRole('button', { name: 'Close 2 positions at market' }).click()

  const batch = page.getByRole('dialog', { name: 'Closed 1 of 2 on Hyperliquid' })
  // Hyperliquid testnet's recorded fill of a close: 0.00026 at 77648.0.
  await expect(batch.getByRole('listitem').filter({ hasText: 'BTC' })).toContainText('Filled 0.00026 BTC at 77,648')
  await expect(batch.getByRole('listitem').filter({ hasText: 'ETH' })).toContainText(
    'RefusedReduce only order would increase position. asset=3',
  )
  await batch.getByRole('button', { name: 'Try ETH again' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(3)
  expect(writes(hyperliquid.sent).map((body) => body.action.orders?.[0]?.a)).toEqual([BTC, ETH, ETH])
})

test('cancel all names the TP/SL legs it would take off', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [RESTING, TAKE_PROFIT])
  hyperliquid.exchange = () => replyOf('cancel')
  await account.getByRole('radio', { name: 'Orders 2' }).click()
  await account.getByRole('button', { name: 'Cancel all' }).click()
  const batch = page.getByRole('dialog', { name: 'Cancel orders on Hyperliquid' })
  await expect(batch.getByRole('radio', { name: 'BTC 2' })).toHaveAttribute('aria-checked', 'true')
  await expect(
    batch.getByText('1 of these is a TP/SL leg. Canceling leaves those positions unprotected.'),
  ).toBeVisible()
  await settled(page)
  await expectAccessible(page)
  await batch.getByRole('button', { name: 'Cancel 2 orders' }).click()
  await expect.poll(() => writes(hyperliquid.sent).length).toBe(1)
  expect(writes(hyperliquid.sent)[0]?.action).toEqual({
    type: 'cancel',
    cancels: [
      { a: BTC, o: 41 },
      { a: BTC, o: 42 },
    ],
  })
})

test('cancel all keeps its answer after the last order goes', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, account } = await holding(page, [BTC_LONG], [RESTING])
  hyperliquid.exchange = () => replyOf('cancel')
  await account.getByRole('radio', { name: 'Orders 1' }).click()
  await account.getByRole('button', { name: 'Cancel all' }).click()
  const cancel = page.getByRole('dialog', { name: 'Cancel orders on Hyperliquid' })
  hyperliquid.account = { ...hyperliquid.account, frontendOpenOrders: [] }
  await cancel.getByRole('button', { name: 'Cancel 1 order' }).click()

  await expect(account.getByText('No open orders.')).toBeVisible()
  await expect(cancel.getByRole('button', { name: 'Done' })).toBeVisible()
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

test('a trailing stop row reads its activation and how far it trails', async ({ page, wallet: _wallet }) => {
  // Recorded on testnet: one trailing 800 USDC from 75,563, and one trailing 10% that waits for 90,000.
  const { frontendOpenOrders } = JSON.parse(
    readFileSync(new URL('../packages/trade/src/__fixtures__/trailing.hyperliquid.json', import.meta.url), 'utf8'),
  ) as { frontendOpenOrders: unknown[] }
  const { account } = await holding(page, [BTC_LONG], frontendOpenOrders)
  await account.getByRole('radio', { name: 'Orders 2' }).click()
  await expect(account.getByRole('row', { name: /Trailing stop market/ })).toHaveText([
    /Stops at 75,563 · trails 800 USDC/,
    /Activates 90,000 · trails 10%/,
  ])
})
