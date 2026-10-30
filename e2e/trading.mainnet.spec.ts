import { VENUE_IDS } from '@tape/core/ids'
import { isTradeVenue } from '@tape/trade/types'
import { fakeChains } from './chain'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'
import { ACCOUNTS } from './wallet'

/** Circle's USDC on Ethereum. */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

for (const venue of VENUE_IDS.filter(isTradeVenue))
  test(`a filled ${venue} ticket on mainnet asks the wallet for nothing and sends nothing`, async ({
    page,
    wallet,
  }) => {
    const hyperliquid = await fakeHyperliquid(page, 'mainnet')
    const chains = await fakeChains(page, 'mainnet')
    chains.fund(1, ACCOUNTS.alice, { native: 0n, tokens: { [USDC]: 25_000_000n } })
    await openMarket(page, `/${venue}/BTC?interval=1m`)
    await page.getByRole('button', { name: 'Connect wallet' }).click()

    const ticket = panel(page, 'Order ticket')
    await expect(ticket.getByText('Mainnet is read only in Tape.')).toBeVisible()
    await expect(ticket.getByText('25 · Ethereum')).toBeVisible()
    await expect(panel(page, 'Account').getByText('Mainnet is read only in Tape.')).toBeVisible()
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
