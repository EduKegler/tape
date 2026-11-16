import { fakeChains } from './chain'
import { connectWallet, expect, expectAccessible, openMarket, panel, settled, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'
import { ACCOUNTS } from './wallet'

/** Circle's USDC on Base, from Circle's contract addresses page. */
const BASE = 8453
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

test('a CCTP deposit reads the fee Circle expects and its ceiling, never the ceiling as the fee', async ({
  page,
  wallet,
}) => {
  const hyperliquid = await fakeHyperliquid(page, 'mainnet')
  const chains = await fakeChains(page, 'mainnet')
  chains.fund(BASE, ACCOUNTS.alice, { native: 10n ** 16n, tokens: { [BASE_USDC]: 800_000_000n } })
  // The shape of Circle's burn fee reply in its CCTP v2 docs: 1 bps for a Fast Transfer, and the HyperCore forward in USDC units.
  await page.route('https://iris-api.circle.com/v2/burn/USDC/fees/**', (route) =>
    route.fulfill({
      json: [
        { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 150_000, med: 200_000, high: 250_000 } },
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 150_000, med: 200_000, high: 250_000 } },
      ],
      headers: { 'access-control-allow-origin': '*' },
    }),
  )
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await connectWallet(page, page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }))
  await panel(page, 'Account').getByRole('button', { name: 'Deposit', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Deposit USDC to Hyperliquid perps' })
  await settled(page)
  await dialog.getByRole('combobox', { name: 'From' }).selectOption({ label: 'Base · 800 USDC' })
  await dialog.getByRole('textbox', { name: 'Amount' }).fill('500')

  // 1 bps of 500 is 0.05, plus the 0.2 forward. The ceiling pads the 0.05 by a fifth and takes the 0.25 forward.
  await expect(dialog.locator('dt:text-is("Fee") + dd')).toHaveText('About 0.25 USDC, at most 0.31')
  await expect(dialog.locator('dt:text-is("You receive") + dd')).toHaveText('About 499.75 USDC, at least 499.69')
  await expect(dialog.locator('dt:text-is("Wallet asks") + dd')).toHaveText(
    'Twice: approve exactly 500 USDC, then deposit',
  )
  await expectAccessible(page)
  expect(wallet.askedFor('send')).toEqual([])
  expect(hyperliquid.sent).toEqual([])
  expect(chains.unanswered()).toEqual([])
})
