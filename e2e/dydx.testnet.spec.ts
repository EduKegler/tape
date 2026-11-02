import { fakeDydx } from './dydx'
import { connectWallet, expect, expectAccessible, openMarket, panel, settled, test } from './fixtures'

const SEPOLIA = 11155111

test('enabling dYdX asks the wallet for the onboarding signature on Sepolia', async ({ page, wallet }) => {
  const dydx = await fakeDydx(page, 'testnet')
  await openMarket(page, '/dydx/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await connectWallet(page, ticket.getByRole('button', { name: 'Connect wallet' }))
  await expect(ticket.getByText('Unlock your dYdX key in this tab')).toBeVisible()
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toHaveCount(0)
  await expect(ticket.getByRole('button', { name: 'Buy / Long BTC' })).toBeVisible()
  await expect(panel(page, 'Account').getByText('No account on this venue yet. Deposit to start.')).toBeVisible()
  await expectAccessible(page)

  // What dYdX's own frontend, v4-web, asks the wallet to sign to derive the key on testnet.
  expect(wallet.asked()).toEqual([
    { kind: 'connect', account: 'alice' },
    { kind: 'switch-chain', from: 1, to: SEPOLIA },
    {
      kind: 'sign',
      from: 'alice',
      selected: 'alice',
      chainId: SEPOLIA,
      typedData: {
        domain: { name: 'dYdX Chain', chainId: SEPOLIA },
        primaryType: 'dYdX',
        message: { action: 'dYdX Chain Onboarding' },
      },
    },
  ])
  expect(dydx.asked).toEqual([expect.stringMatching(/^\/v4\/addresses\/dydx1[0-9a-z]{38}\/subaccountNumber\/0$/)])
})

/** A dYdX subaccount holding 0.01 BTC long, in the shape of the indexer's `/addresses/{address}/subaccountNumber/0`. */
const HOLDING = {
  address: 'dydx1',
  subaccountNumber: 0,
  equity: '1000',
  freeCollateral: '960',
  openPerpetualPositions: {
    'BTC-USD': {
      market: 'BTC-USD',
      status: 'OPEN',
      side: 'LONG',
      size: '0.01',
      maxSize: '0.01',
      entryPrice: '80000',
      realizedPnl: '0',
      unrealizedPnl: '0',
    },
  },
}

test('dYdX closes only what fills now and sizes its TP/SL legs', async ({ page, wallet: _wallet }) => {
  await fakeDydx(page, 'testnet', HOLDING)
  await openMarket(page, '/dydx/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await connectWallet(page, ticket.getByRole('button', { name: 'Connect wallet' }))
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  const account = panel(page, 'Account')
  await account.getByRole('button', { name: 'Close', exact: true }).click()
  const ruler = page.getByRole('dialog', { name: /^BTC Long/ })
  await expect(ruler.getByRole('radio', { name: 'Limit' })).toBeVisible()
  await expect(ruler.getByRole('radio', { name: 'Mid' })).toHaveCount(0)
  await ruler.getByRole('radio', { name: 'Limit' }).click()
  await expect(ruler).toContainText('Fills now or not at all, dYdX rests no reduce-only close')

  await ruler.getByRole('radio', { name: 'TP / SL' }).click()
  await expect(ruler).toContainText(/Each closes 0\.01\d* BTC at market, the size held now\./)
  await expect(ruler.getByRole('textbox', { name: 'Take profit return on margin' })).toHaveCount(0)
  await settled(page)
  await expectAccessible(page)
})
