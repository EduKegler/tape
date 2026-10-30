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

test('a take profit under the ask stops in the ticket and sends nothing', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, ticket } = await enable(page)
  await page.getByRole('radio', { name: 'Market', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('checkbox', { name: 'Take profit and stop loss' }).check()
  await ticket.getByRole('textbox', { name: 'Take profit' }).fill('70000')

  await ticket.getByRole('button', { name: 'Buy BTC' }).click()
  await expect(ticket.getByRole('alert')).toContainText('Take profit: Must be above the ask')
  await expectAccessible(page)
  expect(orders(hyperliquid.sent)).toEqual([])
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
})

test('while the venue is asked about a timed out order, the ticket sends nothing', async ({
  page,
  wallet: _wallet,
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
