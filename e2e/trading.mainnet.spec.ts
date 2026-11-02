import { readFileSync } from 'node:fs'
import { recoverTypedDataAddress, zeroAddress } from 'viem'
import type { Hex } from 'viem'
import { actionHash } from '@tape/trade/hyperliquid/sign'
import { TEST_BUILDER } from './builds'
import { fakeChains } from './chain'
import { connectWallet, expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { fakeHyperliquid, resting } from './hyperliquid'
import { ACCOUNTS } from './wallet'

/** Circle's USDC on Ethereum. */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

const BTC = (
  JSON.parse(
    readFileSync(new URL('../packages/venues/src/__fixtures__/hyperliquid.meta.json', import.meta.url), 'utf8'),
  ) as { universe: { name: string }[] }
).universe.findIndex((asset) => asset.name === 'BTC')

const MAINNET_EXCHANGE = 'https://api.hyperliquid.xyz/exchange'

const OFF_ON_MAINNET = { dydx: 'dYdX', orderly: 'Orderly' } as const

for (const [venue, label] of Object.entries(OFF_ON_MAINNET))
  test(`a filled ${venue} ticket on mainnet asks the wallet for nothing and sends nothing`, async ({
    page,
    wallet,
  }) => {
    const hyperliquid = await fakeHyperliquid(page, 'mainnet')
    const chains = await fakeChains(page, 'mainnet')
    chains.fund(1, ACCOUNTS.alice, { native: 0n, tokens: { [USDC]: 25_000_000n } })
    await openMarket(page, `/${venue}/BTC?interval=1m`)
    await connectWallet(page, page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }))

    const ticket = panel(page, 'Order ticket')
    const testnetOnly = `${label} trades only on testnet in Tape.`
    await expect(ticket.getByText(testnetOnly)).toBeVisible()
    await expect(ticket.getByText('Read only', { exact: true })).toBeVisible()
    await expect(ticket.getByText('25 · Ethereum')).toBeVisible()
    await expect(panel(page, 'Account').getByText(testnetOnly)).toBeVisible()
    await expect(page.getByRole('contentinfo')).toContainText('Market data comes straight from the venues.')
    await ticket.getByRole('textbox', { name: /^Price/ }).fill('70000')
    await ticket.getByRole('textbox', { name: /^Size/ }).fill('0.002')
    await ticket.getByRole('textbox', { name: /^Size/ }).press('Enter')
    await expect(ticket.getByRole('button', { name: /Enable trading|BTC$/ })).toHaveCount(0)
    await expect(panel(page, 'Account').getByRole('button', { name: 'Deposit' })).toHaveCount(0)
    await expectAccessible(page)

    expect(wallet.asked()).toEqual([{ kind: 'connect', account: 'alice' }])
    expect(hyperliquid.sent).toEqual([])
    expect(chains.unanswered()).toEqual([])
  })

test('Hyperliquid on mainnet signs for Mainnet and sends the ticket limit to the mainnet API with the builder', async ({
  page,
  wallet,
}) => {
  const hyperliquid = await fakeHyperliquid(page, 'mainnet')
  const chains = await fakeChains(page, 'mainnet')
  const exchangePosts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/exchange')
      exchangePosts.push(request.url())
  })
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await expect(ticket.getByText('Mainnet', { exact: true })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toContainText('Orders are signed in your browser')
  await connectWallet(page, ticket.getByRole('button', { name: 'Connect wallet' }))
  await expect(ticket.getByText('Approve a trading key')).toBeVisible()
  await expect(ticket.getByText("Approve Tape's fee of 1 bp")).toBeVisible()
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByText("Approve Tape's fee of 1 bp")).toHaveCount(0)
  await expect(ticket.getByRole('button', { name: 'Buy / Long BTC' })).toBeVisible()

  const [agentApproval, feeApproval, ...more] = wallet.askedFor('sign')
  expect(more).toEqual([])
  // The messages of the two user-signed actions, from Hyperliquid's signing and builder codes docs.
  expect(agentApproval?.typedData).toMatchObject({
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: { hyperliquidChain: 'Mainnet', agentName: 'tape' },
  })
  expect(feeApproval?.typedData).toMatchObject({
    primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
    message: { hyperliquidChain: 'Mainnet', maxFeeRate: '0.01%', builder: TEST_BUILDER },
  })
  expect(hyperliquid.sent.map((body) => [body.action.type, body.action.hyperliquidChain])).toEqual([
    ['approveAgent', 'Mainnet'],
    ['approveBuilderFee', 'Mainnet'],
  ])

  hyperliquid.exchange = () => resting(7)
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await expect(ticket.getByText('Notional')).toBeVisible()
  const shown = {
    buy:
      (await ticket.getByRole('button', { name: 'Buy / Long', exact: true }).getAttribute('aria-pressed')) === 'true',
    price: await ticket.getByRole('textbox', { name: 'Price (USDC)' }).inputValue(),
    size: await ticket.getByRole('textbox', { name: 'Size (BTC)' }).inputValue(),
  }
  expect(shown).toEqual({ buy: true, price: '70000', size: '0.002' })
  await ticket.getByRole('button', { name: 'Buy / Long BTC' }).click()
  await expect(ticket.getByRole('status')).toHaveText('Order resting. Resting as order 7')
  await expectAccessible(page)

  const order = hyperliquid.sent.find((body) => body.action.type === 'order')!
  expect(order.action).toEqual({
    type: 'order',
    orders: [
      {
        a: BTC,
        b: shown.buy,
        p: shown.price,
        s: shown.size,
        r: false,
        t: { limit: { tif: 'Gtc' } },
        c: expect.stringMatching(/^0x[0-9a-f]{32}$/),
      },
    ],
    grouping: 'na',
    builder: { b: TEST_BUILDER, f: 10 },
  })
  // An L1 action is signed by the agent as a phantom agent whose source is 'a' on mainnet and 'b' on testnet,
  // per signing.py in Hyperliquid's Python SDK.
  const signature = order.signature as { r: Hex; s: Hex; v: number }
  const signer = (source: 'a' | 'b') =>
    recoverTypedDataAddress({
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: zeroAddress },
      types: {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' },
        ],
      },
      primaryType: 'Agent',
      message: { source, connectionId: actionHash(order.action, null, order.nonce, null) },
      signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) },
    })
  const agent = String(agentApproval?.typedData.message.agentAddress).toLowerCase()
  expect((await signer('a')).toLowerCase()).toBe(agent)
  expect((await signer('b')).toLowerCase()).not.toBe(agent)
  expect(exchangePosts).toEqual([MAINNET_EXCHANGE, MAINNET_EXCHANGE, MAINNET_EXCHANGE])
  expect(chains.unanswered()).toEqual([])
})
