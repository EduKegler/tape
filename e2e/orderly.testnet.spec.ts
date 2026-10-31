import type { Page } from '@playwright/test'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { fakeOrderly } from './orderly'
import { ACCOUNTS } from './wallet'

const ARBITRUM_SEPOLIA = 421614
/** Orderly's EIP-712 domain on testnet and its public testnet broker, from Orderly's account docs. */
const DOMAIN = {
  name: 'Orderly',
  version: '1',
  chainId: ARBITRUM_SEPOLIA,
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
}
const BROKER = 'demo'

async function enable(page: Page) {
  const orderly = await fakeOrderly(page, 'testnet')
  await openMarket(page, '/orderly/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await ticket.getByRole('button', { name: 'Connect wallet' }).click()
  await expect(ticket.getByText('Register an Orderly account')).toBeVisible()
  await expectAccessible(page)
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toHaveCount(0)
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toBeVisible()
  return { orderly, ticket }
}

test('enabling Orderly registers the account and adds a key that cannot withdraw', async ({ page, wallet }) => {
  const { orderly } = await enable(page)
  await expect(panel(page, 'Account').getByText('No account on this venue yet. Deposit to start.')).toBeVisible()
  await expectAccessible(page)

  const [connect, toArbitrum, registration, addKey, ...more] = wallet.asked()
  expect(more).toEqual([])
  expect([connect, toArbitrum]).toEqual([
    { kind: 'connect', account: 'alice' },
    { kind: 'add-chain', from: 1, to: ARBITRUM_SEPOLIA },
  ])
  expect(registration).toEqual({
    kind: 'sign',
    from: 'alice',
    selected: 'alice',
    chainId: ARBITRUM_SEPOLIA,
    typedData: {
      domain: DOMAIN,
      primaryType: 'Registration',
      message: {
        brokerId: BROKER,
        chainId: ARBITRUM_SEPOLIA,
        timestamp: expect.any(Number),
        registrationNonce: orderly.nonce,
      },
    },
  })
  // Orderly's scopes: `trading` places orders and `asset` withdraws, so a key Tape adds never carries `asset`.
  expect(addKey).toEqual({
    kind: 'sign',
    from: 'alice',
    selected: 'alice',
    chainId: ARBITRUM_SEPOLIA,
    typedData: {
      domain: DOMAIN,
      primaryType: 'AddOrderlyKey',
      message: {
        brokerId: BROKER,
        chainId: ARBITRUM_SEPOLIA,
        orderlyKey: expect.stringMatching(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
        scope: 'read,trading',
        timestamp: expect.any(Number),
        expiration: expect.any(Number),
      },
    },
  })
  const signed = [registration, addKey].map((ask) => (ask?.kind === 'sign' ? ask.typedData.message : null))
  expect(orderly.sent).toEqual([
    {
      path: '/v1/register_account',
      body: { message: signed[0], signature: expect.any(String), userAddress: ACCOUNTS.alice.toLowerCase() },
    },
    {
      path: '/v1/orderly_key',
      body: { message: signed[1], signature: expect.any(String), userAddress: ACCOUNTS.alice.toLowerCase() },
    },
  ])
})

test('an Orderly limit order goes out with the side, price and size the ticket shows', async ({
  page,
  wallet: _wallet,
}) => {
  const { orderly, ticket } = await enable(page)
  await ticket.getByRole('button', { name: 'Sell / Short', exact: true }).click()
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('90000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  const price = await ticket.getByRole('textbox', { name: 'Price (USDC)' }).inputValue()
  const size = await ticket.getByRole('textbox', { name: 'Size (BTC)' }).inputValue()

  await ticket.getByRole('button', { name: 'Sell BTC' }).click()
  await expect(ticket.getByRole('status')).toHaveText('Order resting. Order 5')
  await expectAccessible(page)
  // Orderly's create-order fields. A good-til-canceled limit is LIMIT.
  expect(orderly.sent.filter((write) => write.path === '/v1/order').map((write) => write.body)).toEqual([
    {
      symbol: 'PERP_BTC_USDC',
      client_order_id: expect.stringMatching(/^0x[0-9a-f]{32}$/),
      order_type: 'LIMIT',
      order_price: Number(price),
      order_quantity: Number(size),
      side: 'SELL',
      reduce_only: false,
    },
  ])
})

test('a setup step already done reads done in text', async ({ page, wallet: _wallet }) => {
  const orderly = await fakeOrderly(page, 'testnet')
  orderly.registered.value = true
  await openMarket(page, '/orderly/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await ticket.getByRole('button', { name: 'Connect wallet' }).click()
  const steps = ticket.getByRole('listitem')
  await expect(steps).toHaveText(['✓Register an Orderly account, done', 'Add a trading key'])
})
