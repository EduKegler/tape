import { fakeDydx } from './dydx'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

const SEPOLIA = 11155111

test('enabling dYdX asks the wallet for the onboarding signature on Sepolia', async ({ page, wallet }) => {
  const dydx = await fakeDydx(page, 'testnet')
  await openMarket(page, '/dydx/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await ticket.getByRole('button', { name: 'Connect wallet' }).click()
  await expect(ticket.getByText('Unlock your dYdX key in this tab')).toBeVisible()
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()
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
