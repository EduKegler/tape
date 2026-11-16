import { encodeFunctionData, erc20Abi } from 'viem'
import type { Page } from '@playwright/test'
import { fakeChains } from './chain'
import { connectWallet, expect, expectAccessible, openMarket, panel, settled, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'
import { RECORDED_AT } from './replay/clock'
import { ACCOUNTS, answerSend, holdSends } from './wallet'

/** Hyperliquid's testnet bridge and the USDC it takes on Arbitrum Sepolia, from Hyperliquid's bridge docs. */
const ARBITRUM_SEPOLIA = 421614
const BRIDGE_USDC = '0x1baAbB04529D43a73232B713C0FE471f7c7334d5'
const BRIDGE = '0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89'

async function openDeposit(page: Page) {
  const hyperliquid = await fakeHyperliquid(page, 'testnet')
  const chains = await fakeChains(page, 'testnet')
  chains.fund(ARBITRUM_SEPOLIA, ACCOUNTS.alice, { native: 10n ** 16n, tokens: { [BRIDGE_USDC]: 50_000_000n } })
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await connectWallet(page, panel(page, 'Order ticket').getByRole('button', { name: 'Connect wallet' }))
  await panel(page, 'Account').getByRole('button', { name: 'Deposit' }).click()
  await settled(page)
  const dialog = page.getByRole('dialog', { name: 'Deposit USDC to Hyperliquid perps' })
  return { dialog, chains, hyperliquid, amount: dialog.getByRole('textbox', { name: 'Amount' }) }
}

test('the deposit form stops an amount the bridge keeps or the wallet lacks', async ({ page, wallet }) => {
  const { dialog, chains, amount } = await openDeposit(page)
  await expect(dialog.getByRole('combobox', { name: 'From' })).toContainText('Arbitrum Sepolia · 50 USDC')

  await expectAccessible(page)
  await amount.fill('3')
  await expect(dialog.locator('dt:text-is("You receive") + dd')).toHaveText('Nothing, under the minimum')
  await expect(dialog.getByRole('alert')).toHaveText(
    'Deposits under 5 USDC on this route are kept and never credited. Send at least 5.',
  )
  await expect(dialog.getByRole('button', { name: 'Deposit 3 USDC from Arbitrum Sepolia' })).toBeDisabled()

  await amount.fill('60')
  await expect(dialog.getByRole('alert')).toHaveText('The wallet has 50 USDC on Arbitrum Sepolia.')
  await expect(dialog.getByRole('button', { name: 'Deposit 60 USDC from Arbitrum Sepolia' })).toBeDisabled()

  await amount.fill('10')
  await expect(dialog.getByRole('definition')).toHaveText([
    'Arbitrum Sepolia → Hyperliquid bridge on Arbitrum → Hyperliquid perps',
    '0xf39f…2266, the same address',
    'None',
    '10 USDC',
    // The address has no Hyperliquid account yet, so there is no balance to add to.
    '—',
    // 60,000 gas at viem's max fee: a 1 gwei base fee times its 1.2 headroom, plus the 0.1 gwei tip.
    'About 0.000078 ETH on Arbitrum Sepolia',
    'Under a minute, at most 10 min',
    'Once, for the deposit',
  ])
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' })).toBeEnabled()
  await expectAccessible(page)
  expect(wallet.askedFor('send')).toEqual([])
  expect(chains.unanswered()).toEqual([])
})

test('a wallet that refuses the deposit gets the bridge transfer and nothing is sent', async ({ page, wallet }) => {
  const { dialog, chains, amount } = await openDeposit(page)
  await amount.fill('10')
  await dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' }).click()

  await expect(dialog.getByRole('alert')).toHaveText('You declined in the wallet. Nothing was sent.')
  await expect(dialog.getByRole('region', { name: 'Recent deposits' })).toHaveCount(0)
  await expectAccessible(page)
  expect(wallet.asked()).toEqual([
    { kind: 'connect', account: 'alice' },
    { kind: 'add-chain', from: 1, to: ARBITRUM_SEPOLIA },
    {
      kind: 'send',
      from: 'alice',
      chainId: ARBITRUM_SEPOLIA,
      tx: {
        to: BRIDGE_USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BRIDGE, 10_000_000n] }),
        chainId: ARBITRUM_SEPOLIA,
      },
    },
  ])
  expect(chains.unanswered()).toEqual([])
})

test('a deposit clicked offline goes to the wallet at once, not when the network returns', async ({
  page,
  context,
  wallet,
}) => {
  const { dialog, amount } = await openDeposit(page)
  await amount.fill('10')
  const deposit = dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' })
  await expect(deposit).toBeEnabled()
  await context.setOffline(true)
  await deposit.click()

  await expect(dialog.getByRole('alert')).toHaveText('You declined in the wallet. Nothing was sent.')
  expect(wallet.askedFor('send')).toHaveLength(1)
})

test('three clicks in one tick ask the wallet for one deposit', async ({ page, wallet }) => {
  const { dialog, amount } = await openDeposit(page)
  await amount.fill('10')
  const deposit = dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' })
  await expect(deposit).toBeEnabled()
  await deposit.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
    button.click()
  })

  await expect(dialog.getByRole('alert')).toHaveText('You declined in the wallet. Nothing was sent.')
  expect(wallet.askedFor('send')).toHaveLength(1)
})

test('the deposit dialog starts on the amount, keeps Tab inside, and Escape gives the focus back', async ({
  page,
  wallet: _wallet,
}) => {
  const { dialog, amount } = await openDeposit(page)
  await expect(amount).toBeFocused()
  const insideDialog = () => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)
  for (const key of [...Array<string>(12).fill('Tab'), ...Array<string>(12).fill('Shift+Tab')]) {
    await page.keyboard.press(key)
    await expect.poll(insideDialog).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(panel(page, 'Account').getByRole('button', { name: 'Deposit' })).toBeFocused()
})

const SENT = `0x${'cd'.repeat(32)}` as const

test('Escape and close keep the amount, and while the wallet signs only close leaves, keeping the deposit', async ({
  page,
  wallet: _wallet,
}) => {
  await page.addInitScript(holdSends)
  const { dialog, amount } = await openDeposit(page)
  const account = panel(page, 'Account')
  await amount.fill('10')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await account.getByRole('button', { name: 'Deposit', exact: true }).click()
  await expect(amount).toHaveValue('10')

  await dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' }).click()
  await expect(dialog.getByRole('status')).toHaveText(
    'Confirm the deposit in Test Wallet. Esc stays here until the wallet answers, and closing keeps this deposit.',
  )
  await page.keyboard.press('Escape')
  await page.mouse.click(4, 4)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Waiting for Test Wallet…' })).toBeDisabled()
  await expectAccessible(page)

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  await answerSend(page, SENT)
  await expect(account.getByRole('button', { name: 'Depositing 10 USDC confirming' })).toBeVisible()
})

test('a sent deposit lets the trader leave, waits beside Deposit, and Deposit opens the form again', async ({
  page,
  wallet: _wallet,
}) => {
  await page.addInitScript(holdSends)
  const { dialog, chains, hyperliquid, amount } = await openDeposit(page)
  const account = panel(page, 'Account')
  await amount.fill('10')
  await dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' }).click()
  await expect(dialog.getByRole('button', { name: 'Waiting for Test Wallet…' })).toBeDisabled()
  chains.mine(SENT)
  await answerSend(page, SENT)

  const slip = dialog.getByRole('region', { name: 'Deposit slip' })
  const answers = slip.getByRole('list', { name: 'Answers' }).getByRole('listitem')
  await expect(answers).toHaveText([
    /^Sent from Arbitrum Sepolia[\d:]{8}/,
    /^Confirmed on Arbitrum Sepolia[\d:]{8}$/,
    /^Credit due in0:\d\dWaiting for Hyperliquid to credit the bridge deposit$/,
  ])
  await expect(dialog.getByRole('button', { name: 'Close and keep trading' })).toBeFocused()
  await expectAccessible(page)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const trail = account.getByRole('button', { name: /^Depositing 10 USDC 0:\d\d$/ })
  await expect(trail).toBeFocused()

  await page.reload()
  await expect(trail).toBeVisible()

  // Hyperliquid's ledger names a bridge deposit by the Arbitrum transaction hash.
  hyperliquid.account.userNonFundingLedgerUpdates = [
    { time: RECORDED_AT + 30_000, hash: SENT, delta: { type: 'deposit', usdc: '10.0' } },
  ]
  await page.clock.fastForward(5_000)
  const credited = account.getByRole('button', { name: 'Credited 10 USDC' })
  await credited.click()
  await expect(slip.getByRole('definition').last()).toHaveText('10 USDC')
  await expect(answers.nth(2)).toHaveText(/^Credited 10 USDC[\d:]{8}$/)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(credited).toHaveCount(0)

  await account.getByRole('button', { name: 'Deposit', exact: true }).click()
  await expect(amount).toBeFocused()
  await expect(amount).toHaveValue('')
  await expect(dialog.getByRole('region', { name: 'Recent deposits' }).getByRole('button')).toHaveText(
    /^10 USDC · Arbitrum Sepolia · [\d:]{8}Credited$/,
  )
})
