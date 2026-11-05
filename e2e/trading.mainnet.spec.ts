import { readFileSync } from 'node:fs'
import { recoverTypedDataAddress, zeroAddress } from 'viem'
import type { Hex } from 'viem'
import { actionHash } from '@tape/trade/hyperliquid/sign'
import { TEST_BUILDER } from './builds'
import { fakeChains } from './chain'
import { connectWallet, expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { fakeHyperliquid, replyOf, resting } from './hyperliquid'
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
  test(`a connected ${venue} ticket on mainnet has no form and asks the wallet for nothing`, async ({
    page,
    wallet,
  }) => {
    const hyperliquid = await fakeHyperliquid(page, 'mainnet')
    const chains = await fakeChains(page, 'mainnet')
    chains.fund(1, ACCOUNTS.alice, { native: 0n, tokens: { [USDC]: 25_000_000n } })
    await openMarket(page, `/${venue}/BTC?interval=1m`)
    await connectWallet(page, page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }))

    const ticket = panel(page, 'Order ticket')
    await expect(ticket.getByText('Read only', { exact: true })).toBeVisible()
    await expect(ticket.getByText(`You can't trade on ${label} in Tape.`)).toBeVisible()
    await expect(ticket.getByRole('textbox')).toHaveCount(0)
    await expect(panel(page, 'Account').getByText(`${label} is read only in Tape.`)).toBeVisible()
    await expect(page.getByRole('contentinfo')).toContainText('Market data comes straight from the venues.')
    await expect(ticket.getByRole('button')).toHaveCount(0)
    await expect(panel(page, 'Account').getByRole('button', { name: 'Deposit' })).toHaveCount(0)
    await expectAccessible(page)

    expect(wallet.asked()).toEqual([{ kind: 'connect', account: 'alice' }])
    expect(hyperliquid.sent).toEqual([])
    expect(chains.unanswered()).toEqual([])
  })

test('a connected Hyperliquid ticket on mainnet shows what the venue has free, not the USDC in the wallet', async ({
  page,
  wallet,
}) => {
  const hyperliquid = await fakeHyperliquid(page, 'mainnet')
  const chains = await fakeChains(page, 'mainnet')
  chains.fund(1, ACCOUNTS.alice, { native: 0n, tokens: { [USDC]: 25_000_000n } })
  // An account that holds 1234.56 USDC free, in the shape of Hyperliquid's clearinghouseState docs.
  const summary = { accountValue: '1234.56', totalNtlPos: '0.0', totalRawUsd: '1234.56', totalMarginUsed: '0.0' }
  hyperliquid.account.clearinghouseState = {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: '0.0',
    withdrawable: '1234.56',
    assetPositions: [],
    time: 0,
  }
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await connectWallet(page, ticket.getByRole('button', { name: 'Connect wallet' }))

  await expect(ticket.getByRole('term')).toHaveText(['Notional', 'Est. liquidation', 'Available'])
  await expect(ticket.getByRole('definition').last()).toHaveText('1,234.56 USDC')
  await expect(ticket.getByText('25 · Ethereum')).toHaveCount(0)
  await expectAccessible(page)
  expect(wallet.asked()).toEqual([{ kind: 'connect', account: 'alice' }])
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

test('a Hyperliquid order refused for a builder fee above the approved one reopens the fee step alone', async ({
  page,
  wallet,
}) => {
  const hyperliquid = await fakeHyperliquid(page, 'mainnet')
  await fakeChains(page, 'mainnet')
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = panel(page, 'Order ticket')
  await connectWallet(page, ticket.getByRole('button', { name: 'Connect wallet' }))
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByText("Approve Tape's fee of 1 bp")).toHaveCount(0)
  const [agentApproval] = wallet.askedFor('sign')
  hyperliquid.account.extraAgents = [
    {
      name: 'tape',
      address: agentApproval?.typedData.message.agentAddress,
      validUntil: String(Date.now() + 86_400_000),
    },
  ]

  hyperliquid.exchange = () => replyOf('builderFeeAboveApproved')
  await ticket.getByRole('textbox', { name: 'Price (USDC)' }).fill('70000')
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill('0.002')
  await ticket.getByRole('button', { name: 'Buy / Long BTC' }).click()
  await expect(ticket.getByRole('alert')).toContainText('The venue is missing a setup step. Enable trading again.')
  await expect(ticket.getByRole('button', { name: 'Enable trading' })).toBeVisible()
  await expect(ticket.getByText("Approve Tape's fee of 1 bp")).toBeVisible()
  await expectAccessible(page)

  hyperliquid.exchange = () => ({ json: { status: 'ok', response: { type: 'default' } } })
  await ticket.getByRole('button', { name: 'Enable trading' }).click()
  await expect(ticket.getByText("Approve Tape's fee of 1 bp")).toHaveCount(0)
  expect(wallet.askedFor('sign').map((sign) => sign.typedData.primaryType)).toEqual([
    'HyperliquidTransaction:ApproveAgent',
    'HyperliquidTransaction:ApproveBuilderFee',
    'HyperliquidTransaction:ApproveBuilderFee',
  ])
})
