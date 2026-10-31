import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { ACCEPTED, fakeHyperliquid, resting } from './hyperliquid'
import type { Answer, ExchangeBody } from './hyperliquid'
import { ACCOUNTS } from './wallet'

const ARBITRUM_SEPOLIA = 421614
const BTC = (
  JSON.parse(
    readFileSync(new URL('../packages/venues/src/__fixtures__/hyperliquid.meta.json', import.meta.url), 'utf8'),
  ) as { universe: { name: string }[] }
).universe.findIndex((asset) => asset.name === 'BTC')

/** Hyperliquid's names for the ticket's time in force. */
const TIF: Record<string, string> = { 'Good til canceled': 'Gtc', 'Immediate or cancel': 'Ioc', 'Post only': 'Alo' }

async function connect(page: Page) {
  const hyperliquid = await fakeHyperliquid(page, 'testnet')
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await ticket.getByRole('button', { name: 'Connect wallet' }).click()
  await expect(ticket.getByText('Approve a trading key')).toBeVisible()
  return { hyperliquid, ticket }
}

async function enable(page: Page) {
  const connected = await connect(page)
  await connected.ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(connected.ticket.getByRole('button', { name: 'Enable trading' })).toHaveCount(0)
  await expect(connected.ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()
  return connected
}

const orders = (sent: readonly ExchangeBody[]) => sent.filter((body) => body.action.type === 'order')

async function shownOnTicket(ticket: Locator) {
  return {
    buy: (await ticket.getByRole('button', { name: 'buy', exact: true }).getAttribute('aria-pressed')) === 'true',
    price: await ticket.getByRole('textbox', { name: 'Price (USDC)' }).inputValue(),
    size: await ticket.getByRole('textbox', { name: 'Size (BTC)' }).inputValue(),
    tif: TIF[await ticket.getByRole('combobox').locator('option:checked').innerText()],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

test('enabling Hyperliquid has the wallet approve an agent and sends that approval', async ({ page, wallet }) => {
  const { hyperliquid, ticket } = await connect(page)
  await expectAccessible(page)
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toHaveCount(0)
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()
  await expectAccessible(page)

  const [approval, ...more] = wallet.askedFor('sign')
  expect(more).toEqual([])
  // The domain and message of a user-signed action, from Hyperliquid's signing docs.
  expect(approval).toEqual({
    kind: 'sign',
    from: 'alice',
    selected: 'alice',
    chainId: 1,
    typedData: {
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: 1,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      message: {
        hyperliquidChain: 'Testnet',
        agentAddress: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        agentName: 'tape',
        nonce: expect.any(Number),
      },
    },
  })
  const { agentAddress, nonce } = approval!.typedData.message
  expect(hyperliquid.sent).toEqual([
    {
      action: {
        type: 'approveAgent',
        signatureChainId: '0x1',
        hyperliquidChain: 'Testnet',
        agentAddress,
        agentName: 'tape',
        nonce,
      },
      nonce,
      signature: { r: expect.any(String), s: expect.any(String), v: expect.any(Number) },
    },
  ])
})

test('a network switch with the ticket open signs the approval for the new network', async ({ page, wallet }) => {
  const { hyperliquid, ticket } = await connect(page)
  await wallet.switchChain(ARBITRUM_SEPOLIA)
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toHaveCount(0)
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()

  const [approval] = wallet.askedFor('sign')
  expect(approval?.chainId).toBe(ARBITRUM_SEPOLIA)
  expect(approval?.typedData.domain.chainId).toBe(ARBITRUM_SEPOLIA)
  expect(hyperliquid.sent.map((body) => body.action.signatureChainId)).toEqual(['0x66eee'])
})

for (const side of ['Buy', 'Sell'] as const)
  test(`a ${side.toLowerCase()} limit order goes out with the side, price and size the ticket shows`, async ({
    page,
    wallet,
  }) => {
    const { hyperliquid, ticket } = await enable(page)
    hyperliquid.exchange = () => resting(7)
    await ticket.getByRole('button', { name: side.toLowerCase(), exact: true }).click()
    await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill(side === 'Buy' ? '70000' : '90000')
    await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
    await expect(ticket.getByText('Notional')).toBeVisible()
    const screen = await shownOnTicket(ticket)
    expect(screen).toEqual({
      buy: side === 'Buy',
      price: side === 'Buy' ? '70000' : '90000',
      size: '0.002',
      tif: 'Gtc',
    })

    await ticket.getByRole('button', { name: `${side} BTC` }).click()
    await expect(ticket.getByRole('status')).toHaveText('Order resting. Resting as order 7')
    await expectAccessible(page)
    expect(orders(hyperliquid.sent).map((body) => body.action)).toEqual([
      {
        type: 'order',
        orders: [
          {
            a: BTC,
            b: screen.buy,
            p: screen.price,
            s: screen.size,
            r: false,
            t: { limit: { tif: screen.tif } },
            c: expect.stringMatching(/^0x[0-9a-f]{32}$/),
          },
        ],
        grouping: 'na',
      },
    ])
    expect(wallet.askedFor('sign')).toHaveLength(1)
  })

test('a scale order sends one leg per row of the list the ticket shows', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({
    json: {
      status: 'ok',
      response: { type: 'order', data: { statuses: [1, 2, 3].map((oid) => ({ resting: { oid } })) } },
    },
  })
  await page.getByRole('radio', { name: 'Scale', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Start price' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'End price' }).fill('72000')
  await ticket.getByRole('textbox', { name: 'Orders' }).fill('3')
  await ticket.getByRole('textbox', { name: 'Total size (BTC)' }).fill('0.003')
  const legs = ticket.getByRole('list', { name: 'Scale orders' }).getByRole('listitem')
  await expect(legs).toHaveCount(3)
  const rows = (await legs.allInnerTexts()).map((row) =>
    row.split(/\s+/).map((cell) => Number(cell.replaceAll(',', ''))),
  )

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('status')).toContainText('3 resting')
  const [action] = orders(hyperliquid.sent).map((body) => body.action)
  expect(action?.orders?.map((leg) => [Number(leg.p), Number(leg.s)])).toEqual(rows)
  expect(new Set(action?.orders?.map((leg) => leg.c)).size).toBe(3)
})

test('a market buy goes out as an IOC limit at the ask plus the slippage the ticket shows', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({
    json: {
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.002', avgPx: '80000.0', oid: 9 } }] } },
    },
  })
  await page.getByRole('radio', { name: 'Market', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await expect(ticket.getByRole('radio', { name: '1%', exact: true })).toBeChecked()

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('status')).toHaveText('Order filled. Filled 0.002 at 80000.0')
  await expectAccessible(page)
  // Hyperliquid has no market order type: its own UI sends an IOC limit. The ask 80000 plus 1% is 80800.
  expect(orders(hyperliquid.sent).map((body) => body.action.orders)).toEqual([
    [{ a: BTC, b: true, p: '80800', s: '0.002', r: false, t: { limit: { tif: 'Ioc' } }, c: expect.any(String) }],
  ])
})

test('take profit and stop loss ride with the order as reduce-only market triggers', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({
    json: {
      status: 'ok',
      response: {
        type: 'order',
        data: { statuses: [{ resting: { oid: 1 } }, 'waitingForTrigger', 'waitingForTrigger'] },
      },
    },
  })
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('checkbox', { name: 'Take profit and stop loss' }).check()
  await ticket.getByRole('textbox', { name: 'Take profit' }).fill('75000')
  await ticket.getByRole('textbox', { name: 'Stop loss' }).fill('65000')

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('status')).toHaveText('Order resting. Resting as order 1')
  await expectAccessible(page)
  // A trigger fills at market, bounded 10% past the trigger as Hyperliquid's UI does: 75000 and 65000 less 10%.
  const trigger = (tpsl: 'tp' | 'sl', triggerPx: string, bound: string) => ({
    a: BTC,
    b: false,
    p: bound,
    s: '0.002',
    r: true,
    t: { trigger: { isMarket: true, triggerPx, tpsl } },
  })
  expect(orders(hyperliquid.sent).map((body) => body.action)).toEqual([
    {
      type: 'order',
      orders: [
        { a: BTC, b: true, p: '70000', s: '0.002', r: false, t: { limit: { tif: 'Gtc' } }, c: expect.any(String) },
        trigger('tp', '75000', '67500'),
        trigger('sl', '65000', '58500'),
      ],
      grouping: 'normalTpsl',
    },
  ])
})

test('two take profits ride with the order, each closing its share of the size', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({
    json: {
      status: 'ok',
      response: {
        type: 'order',
        data: { statuses: [{ resting: { oid: 1 } }, 'waitingForFill', 'waitingForFill'] },
      },
    },
  })
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('checkbox', { name: 'Take profit and stop loss' }).check()
  await ticket.getByRole('button', { name: 'Add take profit' }).click()
  await expect(ticket.getByRole('button', { name: 'Add take profit' })).toHaveCount(0)
  for (const [n, price, share] of [
    [1, '75000', '60'],
    [2, '76000', '40'],
  ] as const) {
    await ticket.getByRole('textbox', { name: `Take profit ${n}`, exact: true }).fill(price)
    await ticket.getByRole('textbox', { name: `Size ${n} (%)` }).fill(share)
  }
  await expect(ticket.getByRole('list', { name: 'Take profit sizes' }).getByRole('listitem')).toHaveText([
    /^75000\s*0\.00120$/,
    /^76000\s*0\.00080$/,
  ])
  await expectAccessible(page)

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('status')).toHaveText('Order resting. Resting as order 1')
  const takeProfit = (triggerPx: string, bound: string, size: string) => ({
    a: BTC,
    b: false,
    p: bound,
    s: size,
    r: true,
    t: { trigger: { isMarket: true, triggerPx, tpsl: 'tp' } },
  })
  expect(orders(hyperliquid.sent).map((body) => body.action)).toEqual([
    {
      type: 'order',
      orders: [
        { a: BTC, b: true, p: '70000', s: '0.002', r: false, t: { limit: { tif: 'Gtc' } }, c: expect.any(String) },
        takeProfit('75000', '67500', '0.0012'),
        takeProfit('76000', '68400', '0.0008'),
      ],
      grouping: 'normalTpsl',
    },
  ])
})

test('a stop loss takes one of the two trigger slots, and two take profits with it send nothing', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('checkbox', { name: 'Take profit and stop loss' }).check()
  const stopLoss = ticket.getByRole('textbox', { name: 'Stop loss' })
  await stopLoss.fill('65000')
  await expect(ticket.getByRole('button', { name: 'Add take profit' })).toHaveCount(0)
  await stopLoss.fill('')
  await ticket.getByRole('button', { name: 'Add take profit' }).click()
  await ticket.getByRole('textbox', { name: 'Take profit 1', exact: true }).fill('75000')
  await ticket.getByRole('textbox', { name: 'Take profit 2', exact: true }).fill('76000')
  await stopLoss.fill('65000')

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('alert')).toContainText('Take profits: At most 1 with a stop loss on this venue')
  expect(orders(hyperliquid.sent)).toEqual([])
})

test('take profit sizes that miss the order size stop in the ticket and send nothing', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('checkbox', { name: 'Take profit and stop loss' }).check()
  await ticket.getByRole('button', { name: 'Add take profit' }).click()
  await ticket.getByRole('textbox', { name: 'Take profit 1', exact: true }).fill('75000')
  await ticket.getByRole('textbox', { name: 'Take profit 2', exact: true }).fill('76000')
  await ticket.getByRole('textbox', { name: 'Size 2 (%)' }).fill('20')

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('alert')).toContainText(
    'Take profits: Sizes add up to 70%, so 0.00060 BTC has no take profit',
  )
  expect(orders(hyperliquid.sent)).toEqual([])
})

test('a take profit or stop loss on the wrong side of the touch shows on its field and sends nothing', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  await page.getByRole('radio', { name: 'Market', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('checkbox', { name: 'Take profit and stop loss' }).check()
  const takeProfit = ticket.getByRole('textbox', { name: 'Take profit' })
  await takeProfit.fill('70000')
  await expect(takeProfit).toHaveAccessibleDescription('Must be above the ask')
  const stopLoss = ticket.getByRole('textbox', { name: 'Stop loss' })
  await stopLoss.fill('90000')
  await expect(stopLoss).toHaveAccessibleDescription('Must be below the bid')

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('alert')).toContainText('Take profit: Must be above the ask')
  await expectAccessible(page)
  expect(orders(hyperliquid.sent)).toEqual([])
})

const trailingStops = (sent: readonly ExchangeBody[]) =>
  sent.filter((body) => body.action.type === 'trailingStop').map((body) => body.action)

test('a trailing stop goes out as a native trailingStop action with the retracement the ticket shows', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({ json: { status: 'ok', response: { type: 'trailingStop', data: { oid: 77738308 } } } })
  await ticket.getByRole('button', { name: 'sell', exact: true }).click()
  await page.getByRole('radio', { name: 'Trailing stop', exact: true }).click()
  await expect(ticket.getByRole('checkbox', { name: 'Reduce only' })).toBeChecked()
  await expect(ticket.getByRole('combobox')).toHaveCount(0)
  await expect(ticket.getByRole('checkbox', { name: 'Take profit and stop loss' })).toHaveCount(0)
  await ticket.getByRole('textbox', { name: 'Retracement (%)' }).fill('1.5')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  const sell = ticket.getByRole('button', { name: 'Sell BTC' })
  await sell.click()
  await expect(ticket.getByRole('status')).toHaveText('Order resting. Resting as order 77738308')
  await expectAccessible(page)

  await ticket.getByRole('radio', { name: 'USDC', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Retracement (USDC)' }).fill('800')
  await ticket.getByRole('textbox', { name: 'Activation price (USDC)' }).fill('82000')
  await sell.click()
  await expect.poll(() => trailingStops(hyperliquid.sent)).toHaveLength(2)
  expect(trailingStops(hyperliquid.sent)).toEqual([
    {
      type: 'trailingStop',
      asset: BTC,
      isBuy: false,
      sz: '0.002',
      reduceOnly: true,
      retracement: { pct: '1.5%' },
      activationPx: null,
    },
    {
      type: 'trailingStop',
      asset: BTC,
      isBuy: false,
      sz: '0.002',
      reduceOnly: true,
      retracement: { px: '800' },
      activationPx: '82000',
    },
  ])
})

test('a retracement of 0 or 100% stops in the ticket and sends nothing', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, ticket } = await enable(page)
  await page.getByRole('radio', { name: 'Trailing stop', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  const retracement = ticket.getByRole('textbox', { name: 'Retracement (%)' })
  const buy = ticket.getByRole('button', { name: 'Buy BTC' })
  for (const value of ['0', '100']) {
    await retracement.fill(value)
    await expect(retracement).toHaveAccessibleDescription('Above 0 and below 100%')
    await expect(buy).toBeDisabled()
  }
  await retracement.fill('1')
  await expect(buy).toBeEnabled()
  expect(trailingStops(hyperliquid.sent)).toEqual([])
})

test('switching the retracement unit checks the value against the unit picked', async ({ page, wallet: _wallet }) => {
  const { ticket } = await enable(page)
  await page.getByRole('radio', { name: 'Trailing stop', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  const buy = ticket.getByRole('button', { name: 'Buy BTC' })
  const percent = ticket.getByRole('textbox', { name: 'Retracement (%)' })
  await percent.fill('800')
  await expect(percent).toHaveAccessibleDescription('Above 0 and below 100%')
  await expect(buy).toBeDisabled()
  await ticket.getByRole('radio', { name: 'USDC', exact: true }).click()
  await expect(ticket.getByRole('textbox', { name: 'Retracement (USDC)' })).toHaveAccessibleDescription('')
  await expect(buy).toBeEnabled()
})

test('a trailing stop write that times out shows an unknown outcome and lets the trader send again', async ({
  page,
  wallet: _wallet,
  consoleErrors,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({ abort: 'timedout' })
  const asked: string[] = []
  hyperliquid.orderStatus = (cloid) => {
    asked.push(cloid)
    return { status: 'unknownOid' }
  }
  await page.getByRole('radio', { name: 'Trailing stop', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Retracement (%)' }).fill('1')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  const buy = ticket.getByRole('button', { name: 'Buy BTC' })
  await buy.click()

  const alert = ticket.getByRole('alert')
  await expect(alert).toContainText(
    'Sent, but no answer came back. Check positions, orders and fills before sending again.',
  )
  await expect(buy).toBeEnabled()
  await expect(alert).not.toContainText(/about this order|Asking the venue/)
  expect(asked).toEqual([])
  expect(trailingStops(hyperliquid.sent)).toHaveLength(1)
  expect(consoleErrors.splice(0).filter((error) => !error.includes(hyperliquid.exchangeUrl))).toEqual([])
})

test('three clicks in one tick send one order, and the next goes after the answer', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  const answer = deferred<Answer>()
  hyperliquid.exchange = () => answer.promise
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  const buy = ticket.getByRole('button', { name: 'Buy BTC' })
  await buy.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
    button.click()
  })
  await expect(buy).toBeDisabled()
  expect(orders(hyperliquid.sent)).toHaveLength(1)

  answer.resolve(resting(7))
  await expect(ticket.getByRole('status')).toHaveText('Order resting. Resting as order 7')
  hyperliquid.exchange = () => resting(8)
  await buy.click()
  await expect(ticket.getByRole('status')).toHaveText('Order resting. Resting as order 8')
  expect(orders(hyperliquid.sent)).toHaveLength(2)
})

test('a write that times out shows an unknown outcome and asks the venue by client id', async ({
  page,
  wallet: _wallet,
  consoleErrors,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({ abort: 'timedout' })
  const asked: string[] = []
  hyperliquid.orderStatus = (cloid) => {
    asked.push(cloid)
    return { status: 'unknownOid' }
  }
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('button', { name: 'Buy BTC' }).click()

  const alert = ticket.getByRole('alert')
  await expect(alert).toContainText(
    'Sent, but no answer came back. Check positions, orders and fills before sending again.',
  )
  await expect(alert).toContainText('The venue does not show this order. Hyperliquid answered unknownOid')
  await expectAccessible(page)
  const [order] = orders(hyperliquid.sent).map((body) => body.action)
  expect(asked).toEqual([order?.orders?.[0]?.c])
  expect(consoleErrors.splice(0).filter((error) => !error.includes(hyperliquid.exchangeUrl))).toEqual([])
})

test('while the venue is asked about a timed out order, the ticket sends nothing', async ({
  page,
  wallet: _wallet,
  consoleErrors,
}) => {
  const { hyperliquid, ticket } = await enable(page)
  hyperliquid.exchange = () => ({ abort: 'timedout' })
  const status = deferred<unknown>()
  const asked: string[] = []
  hyperliquid.orderStatus = (cloid) => {
    asked.push(cloid)
    return status.promise
  }
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  const buy = ticket.getByRole('button', { name: 'Buy BTC' })
  await buy.click()

  await expect(ticket.getByRole('alert')).toContainText('Asking the venue for this order…')
  await expect.poll(() => asked).toHaveLength(1)
  await expect(buy).toBeDisabled()
  await ticket.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit())
  expect(orders(hyperliquid.sent)).toHaveLength(1)

  status.resolve({ status: 'unknownOid' })
  await expect(ticket.getByRole('alert')).toContainText('The venue does not show this order.')
  await expect(buy).toBeEnabled()
  expect(consoleErrors.splice(0).filter((error) => !error.includes(hyperliquid.exchangeUrl))).toEqual([])
})

test('an account switch with the ticket open sends nothing for the old account', async ({ page, wallet }) => {
  const { hyperliquid, ticket } = await enable(page)
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')

  await wallet.switchAccount('bob')
  await expect(
    page.getByRole('button', { name: `${ACCOUNTS.bob.slice(0, 6)}…${ACCOUNTS.bob.slice(-4)}`.toLowerCase() }),
  ).toBeVisible()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toBeVisible()
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toHaveCount(0)
  await expect(ticket.getByRole('textbox', { name: 'Price (USDC)' })).toHaveValue('')
  await ticket.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit())
  await expectAccessible(page)
  expect(orders(hyperliquid.sent)).toEqual([])

  hyperliquid.exchange = () => ACCEPTED
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toHaveCount(0)
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()
  expect(wallet.askedFor('sign').map((sign) => [sign.from, sign.selected])).toEqual([
    ['alice', 'alice'],
    ['bob', 'bob'],
  ])
})

test('a Hyperliquid spot order lists with no cancel, while a perp order keeps its cancel', async ({ page, wallet }) => {
  const hyperliquid = await fakeHyperliquid(page, 'testnet')
  // Info endpoint docs: frontendOpenOrders lists spot orders too, with "@" and the spot pair index as the coin.
  const order = (coin: string, oid: number) => ({
    coin,
    side: 'B',
    limitPx: '20.0',
    sz: '1.0',
    oid,
    timestamp: 1793248070251,
    orderType: 'Limit',
    reduceOnly: false,
    isTrigger: false,
    triggerPx: '0.0',
  })
  hyperliquid.account.frontendOpenOrders = [order('BTC', 11), order('@107', 12)]
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await panel(page, 'Order ticket').getByRole('button', { name: 'Connect wallet' }).click()
  const account = panel(page, 'Account')
  await account.getByRole('radio', { name: 'Orders 2' }).click()
  const row = (coin: string) => account.getByRole('row').filter({ hasText: coin })
  await expect(row('BTC').getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await expect(row('@107')).toBeVisible()
  await expect(row('@107').getByRole('button')).toHaveCount(0)
  expect(wallet.askedFor('sign')).toEqual([])
})
