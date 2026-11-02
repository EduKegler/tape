import type { Page } from '@playwright/test'
import { fakeChains } from './chain'
import { TEST_WALLET, connectPanel, expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { ACCOUNTS } from './wallet'

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  )

const ALICE = `${ACCOUNTS.alice.slice(0, 6)}…${ACCOUNTS.alice.slice(-4)}`

test.describe('with two browser wallets', () => {
  test.use({ walletNames: ['Rabby Wallet', 'MetaMask'] })

  test('the header Connect lists each wallet the browser announces, and Escape hands focus back', async ({
    page,
    wallet,
  }) => {
    await openMarket(page, '/hyperliquid/BTC?interval=1m')
    const connect = page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true })
    await connect.click()

    const dialog = connectPanel(page)
    await expect(dialog.getByRole('button', { name: /^(Rabby Wallet|MetaMask) Detected$/ })).toHaveCount(2)
    await expect(dialog.getByRole('button', { name: /WalletConnect/ })).toHaveCount(0)
    await expect(dialog.getByText('In this browser')).toBeVisible()
    await expect(
      dialog.getByText('Connecting shares your address. Nothing is signed until you enable trading on a venue.'),
    ).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Rabby Wallet/ })).toBeFocused()
    await settled(page)
    await expectAccessible(page)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(connect).toBeFocused()
    expect(wallet.asked()).toEqual([])
  })
})

test('a browser with no wallet says so and points at two to install', async ({ page }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }).click()
  const dialog = connectPanel(page)
  await expect(dialog.getByText('No wallet in this browser')).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Rabby' })).toHaveAttribute('href', 'https://rabby.io')
  await expect(dialog.getByRole('link', { name: 'MetaMask' })).toHaveAttribute('href', 'https://metamask.io')
  await page.mouse.click(20, 600)
  await expect(dialog).toHaveCount(0)
})

test('a refused connection says the wallet said no, and Try again connects into the header chip', async ({
  page,
  wallet,
}) => {
  await fakeChains(page, 'mainnet')
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  wallet.rejectNextConnect()
  await page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }).click()
  const dialog = connectPanel(page)
  await dialog.getByRole('button', { name: new RegExp(`^${TEST_WALLET}`) }).click()

  await expect(dialog.getByRole('alert')).toHaveText(`Connection rejected${TEST_WALLET} said no. Nothing was shared.`)
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Other wallet' })).toBeVisible()
  await settled(page)
  await expectAccessible(page)
  expect(wallet.asked()).toEqual([])

  await dialog.getByRole('button', { name: 'Try again' }).click()
  await expect(dialog).toHaveCount(0)
  const chip = page.getByRole('banner').getByRole('button', { name: ALICE })
  await expect(chip).toBeFocused()
  await expect(chip).toHaveText(ALICE)
  await expect(page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
  await expect(panel(page, 'Order ticket').getByText('Mainnet is read only in Tape.')).toBeVisible()
  expect(wallet.asked()).toEqual([{ kind: 'connect', account: 'alice' }])
})

test('the wait names the wallet and counts up, and Cancel goes back to the list', async ({ page, wallet }) => {
  await fakeChains(page, 'mainnet')
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const release = wallet.holdNextConnect()
  await page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }).click()
  const dialog = connectPanel(page)
  await dialog.getByRole('button', { name: new RegExp(`^${TEST_WALLET}`) }).click()

  await expect(dialog.getByRole('status')).toHaveText(
    `Waiting for ${TEST_WALLET}Approve the connection in the ${TEST_WALLET} popup.`,
  )
  await expect(dialog.getByRole('timer')).toHaveText(/^0:0[1-9]\.\dsince the request$/)
  await settled(page)
  await expectAccessible(page)

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.getByRole('button', { name: new RegExp(`^${TEST_WALLET}`) })).toBeFocused()
  release()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('button', { name: ALICE })).toBeVisible()
})
