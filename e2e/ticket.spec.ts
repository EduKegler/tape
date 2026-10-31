import type { Page } from '@playwright/test'
import type { Network } from '@tape/core/ids'
import { CONTROL } from './replay/control'
import type { Command } from './replay/control'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'

const ticketOf = (page: Page) => panel(page, 'Order ticket')
const notionalOf = (page: Page) =>
  ticketOf(page)
    .getByRole('term')
    .filter({ hasText: /^Notional$/ })
    .locator('xpath=following-sibling::dd[1]')

async function touchField(page: Page, name: string, value: string) {
  const field = ticketOf(page).getByRole('textbox', { name, exact: true })
  await field.fill(value)
  await field.blur()
  return field
}

test('the Binance ticket starts as a read only limit buy', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  const ticket = ticketOf(page)
  await expect(ticket.getByRole('button', { name: 'Buy / Long', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(ticket.getByRole('radio', { name: 'Limit', exact: true })).toBeChecked()
  await expect(ticket.getByRole('combobox', { name: 'Time in force' }).getByRole('option')).toHaveText([
    'Good til canceled',
    'Immediate or cancel',
    'Post only',
  ])
  await expect(notionalOf(page)).toHaveText('—')
  await expect(ticket.getByText('Binance is read only in Tape. It never signs or sends an order here.')).toBeVisible()
  await expect(ticket.getByRole('button', { name: 'Buy BTC' })).toHaveCount(0)
  await expectAccessible(page)
})

test('the ticket refuses a price with more decimals than the market has', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  const size = ticketOf(page).getByRole('textbox', { name: 'Size (BTC)' })
  const before = await size.boundingBox()
  const price = await touchField(page, 'Price (USDT)', '1.234')
  await expect(ticketOf(page).getByText('At most 2 decimals')).toBeVisible()
  await expect(price).toHaveAttribute('aria-invalid', 'true')
  expect((await size.boundingBox())?.y).toBe(before?.y)
  await expectAccessible(page)
})

test('the ticket refuses a price that is not a number, zero or empty', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  const ticket = ticketOf(page)
  await touchField(page, 'Price (USDT)', 'abc')
  await expect(ticket.getByText('Not a number')).toBeVisible()
  await touchField(page, 'Price (USDT)', '0')
  await expect(ticket.getByText('Price must be above zero')).toBeVisible()
  await touchField(page, 'Price (USDT)', '')
  await expect(ticket.getByText('Enter a price')).toBeVisible()
})

test('the ticket refuses a price between two Hyperliquid ticks', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await touchField(page, 'Price (USDC)', '80595.5')
  await expect(ticketOf(page).getByText('Price must be a multiple of 1')).toBeVisible()
})

test('the ticket refuses a size finer than the Binance step or below it', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  const ticket = ticketOf(page)
  const size = await touchField(page, 'Size (BTC)', '0.000001')
  await expect(ticket.getByText('At most 5 decimals')).toBeVisible()
  await expect(size).toHaveAttribute('aria-invalid', 'true')
  await touchField(page, 'Size (BTC)', '0')
  await expect(ticket.getByText('Minimum is 0.00001')).toBeVisible()
  await touchField(page, 'Size (BTC)', '')
  await expect(ticket.getByText('Enter a size')).toBeVisible()
})

test('the touch hint fills the price with the best bid, or the best ask on a sell', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = ticketOf(page)
  const price = ticket.getByRole('textbox', { name: 'Price (USDC)' })
  await ticket.getByRole('button', { name: 'Bid 80,595', exact: true }).click()
  await expect(price).toHaveValue('80595')
  await ticket.getByRole('button', { name: 'Sell / Short', exact: true }).click()
  await ticket.getByRole('button', { name: 'Ask 80,596', exact: true }).click()
  await expect(price).toHaveValue('80596')
})

test('clicking a trade puts its price into the ticket', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await panel(page, 'Trades').getByRole('button', { name: 'Buy 80,589 size 0.00062', exact: false }).first().click()
  await expect(ticketOf(page).getByRole('textbox', { name: 'Price (USDC)' })).toHaveValue('80589')
})

const replay = (page: Page, command: Command) =>
  page.evaluate(
    ({ control, message }) => {
      const channel = new BroadcastChannel(control)
      channel.postMessage(message)
      channel.close()
    },
    { control: CONTROL, message: command },
  )

test('a book row from a stale book warns under the price without blocking', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = ticketOf(page)
  const price = ticket.getByRole('textbox', { name: 'Price (USDC)' })
  const row = panel(page, 'Order book').getByRole('button', { name: /^Bid 80,595 / })
  await row.click()
  await expect(price).toHaveValue('80595')
  await expect(price).toHaveAccessibleDescription('')

  await replay(page, { drop: 'hyperliquid' })
  await expect(panel(page, 'Order book').getByText(/^Reconnecting · \d+ s old$/)).toBeVisible()
  await page.clock.fastForward(20_000)
  await row.click()
  await expect(price).toHaveAccessibleDescription(/^Book 2\d s old\. Check the market\.$/)
  const note = ticket.getByText(/^Book 2\d s old/)
  expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(price).toHaveAttribute('aria-invalid', 'false')

  await price.fill('80590')
  await expect(price).toHaveAccessibleDescription('')
})

test('a book row from a market opened after its venue dropped warns under the price', async ({ page }) => {
  await openMarket(page, '/binance/BTC?interval=1m')
  await expect(panel(page, 'Venues').getByRole('row', { name: /^Hyperliquid .*\d/ })).toBeVisible()
  await replay(page, { drop: 'hyperliquid' })
  await page
    .getByRole('navigation', { name: 'Venue' })
    .getByRole('link', { name: /Hyperliquid/ })
    .click()
  const book = panel(page, 'Order book')
  await expect(book.getByText(/^Reconnecting · \d+ s old$/)).toBeVisible()
  await page.clock.fastForward(20_000)
  await book.getByRole('button', { name: /^Bid / }).first().click()
  const price = ticketOf(page).getByRole('textbox', { name: 'Price (USDC)' })
  await expect(price).not.toHaveValue('')
  await expect(price).toHaveAccessibleDescription(/^Book 2\d s old\. Check the market\.$/)
})

test('a market buy hides the price, offers slippage and prices the notional at the ask', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = ticketOf(page)
  await ticket.getByRole('radio', { name: 'Market', exact: true }).click()
  await expect(ticket.getByRole('textbox', { name: 'Price (USDC)' })).toHaveCount(0)
  await expect(ticket.getByRole('combobox', { name: 'Time in force' })).toHaveCount(0)
  const slippage = ticket.getByRole('radiogroup', { name: 'Max slippage' })
  await expect(slippage.getByRole('radio', { name: '1%', exact: true })).toBeChecked()
  await slippage.getByRole('radio', { name: '0.5%', exact: true }).click()
  await expect(slippage.getByRole('radio', { name: '0.5%', exact: true })).toBeChecked()
  await touchField(page, 'Size (BTC)', '0.01')
  await expect(notionalOf(page)).toHaveText('805.96 USDC')
  await expectAccessible(page)
})

const NETWORK_COPY: Record<Network, { aside: string; mainnetNotes: number; walletUsdc: number }> = {
  mainnet: { aside: 'Read only', mainnetNotes: 1, walletUsdc: 1 },
  testnet: { aside: 'Testnet', mainnetNotes: 0, walletUsdc: 0 },
}

test('the ticket says which network the build is', async ({ page, network }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const ticket = ticketOf(page)
  const copy = NETWORK_COPY[network]
  await expect(ticket.getByText(copy.aside, { exact: true })).toBeVisible()
  await expect(ticket.getByText('Mainnet is read only in Tape.')).toHaveCount(copy.mainnetNotes)
  await expect(ticket.getByRole('term').filter({ hasText: 'Wallet USDC' })).toHaveCount(copy.walletUsdc)
  await expectAccessible(page)
})
