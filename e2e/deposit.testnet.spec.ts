import { encodeFunctionData, erc20Abi } from 'viem'
import type { Page } from '@playwright/test'
import { fakeChains } from './chain'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { fakeHyperliquid } from './hyperliquid'
import { ACCOUNTS } from './wallet'

/** Hyperliquid's testnet bridge and the USDC it takes on Arbitrum Sepolia, from Hyperliquid's bridge docs. */
const ARBITRUM_SEPOLIA = 421614
const BRIDGE_USDC = '0x1baAbB04529D43a73232B713C0FE471f7c7334d5'
const BRIDGE = '0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89'

async function openDeposit(page: Page) {
  await fakeHyperliquid(page, 'testnet')
  const chains = await fakeChains(page, 'testnet')
  chains.fund(ARBITRUM_SEPOLIA, ACCOUNTS.alice, { native: 10n ** 16n, tokens: { [BRIDGE_USDC]: 50_000_000n } })
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await panel(page, 'Order ticket').getByRole('button', { name: 'Connect wallet' }).click()
  await panel(page, 'Account').getByRole('button', { name: 'Deposit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Deposit USDC to Hyperliquid perps' })
  return { dialog, chains, amount: dialog.getByRole('textbox', { name: 'Amount (USDC)' }) }
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
    // 60,000 gas at viem's max fee: a 1 gwei base fee times its 1.2 headroom, plus the 0.1 gwei tip.
    '≈0.000078 ETH on Arbitrum Sepolia',
    'Under a minute, up to 10 min',
    'One transaction',
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

function holdSends() {
  const hold = () => {
    const wallet = (window as { ethereum?: { request: (r: { method: string }) => Promise<unknown> } }).ethereum
    if (!wallet) return void setTimeout(hold, 0)
    const ask = wallet.request.bind(wallet)
    wallet.request = (args) =>
      args.method === 'eth_sendTransaction'
        ? new Promise((resolve) => Object.assign(window, { answerSend: resolve }))
        : ask(args)
  }
  hold()
}

test('Escape and close keep the amount, and while the wallet signs only close leaves, keeping the receipt', async ({
  page,
  wallet: _wallet,
}) => {
  await page.addInitScript(holdSends)
  const { dialog, amount } = await openDeposit(page)
  const reopen = () => panel(page, 'Account').getByRole('button', { name: 'Deposit' }).click()
  await amount.fill('10')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await reopen()
  await expect(amount).toHaveValue('10')

  await dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' }).click()
  await expect(dialog.getByRole('status')).toHaveText(
    'Confirm in your wallet. Esc stays here until you answer it, and closing keeps this deposit.',
  )
  await page.keyboard.press('Escape')
  await page.mouse.click(4, 4)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Waiting for your wallet…' })).toBeDisabled()
  await expectAccessible(page)

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  await page.evaluate(
    (hash) => (window as unknown as { answerSend: (hash: string) => void }).answerSend(hash),
    `0x${'cd'.repeat(32)}`,
  )
  await reopen()
  await expect(dialog.getByRole('region', { name: 'Deposit receipt' }).getByRole('definition').first()).toHaveText(
    /^10 USDC from Arbitrum Sepolia at /,
  )
})
