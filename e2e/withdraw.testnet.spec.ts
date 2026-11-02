import type { Page } from '@playwright/test'
import { connectWallet, expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { ACCEPTED, fakeHyperliquid } from './hyperliquid'
import type { ExchangeBody } from './hyperliquid'
import { ACCOUNTS } from './wallet'

const DIALOG = 'Withdraw USDC from Hyperliquid perps'

/** An account that holds 50 USDC and nothing else, in the shape of Hyperliquid's clearinghouseState docs. */
async function openWithdraw(page: Page) {
  const hyperliquid = await fakeHyperliquid(page, 'testnet')
  const summary = { accountValue: '50.0', totalNtlPos: '0.0', totalRawUsd: '50.0', totalMarginUsed: '0.0' }
  hyperliquid.account.clearinghouseState = {
    marginSummary: summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: '0.0',
    withdrawable: '50.0',
    assetPositions: [],
    time: 0,
  }
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  await connectWallet(page, panel(page, 'Order ticket').getByRole('button', { name: 'Connect wallet' }))
  await panel(page, 'Account').getByRole('button', { name: 'Withdraw', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: DIALOG })
  return { hyperliquid, dialog, amount: dialog.getByRole('textbox', { name: 'Amount (USDC)' }) }
}

const withdrawals = (sent: readonly ExchangeBody[]) => sent.filter((body) => body.action.type === 'withdraw3')

test('the withdraw form stops an amount the fee eats or the account lacks', async ({ page, wallet }) => {
  const { hyperliquid, dialog, amount } = await openWithdraw(page)
  await amount.fill('1')
  await expect(dialog.getByRole('alert')).toHaveText('The fee is 1 USDC. Withdraw more than that.')
  await expectAccessible(page)
  await expect(dialog.getByRole('button', { name: 'Withdraw 1 USDC to Arbitrum Sepolia' })).toBeDisabled()

  await amount.fill('60')
  await expect(dialog.getByRole('alert')).toHaveText('Hyperliquid perps has 50 USDC free to withdraw.')
  await expect(dialog.getByRole('button', { name: 'Withdraw 60 USDC to Arbitrum Sepolia' })).toBeDisabled()

  await dialog.getByRole('button', { name: 'Max 50' }).click()
  await expect(amount).toHaveValue('50')
  await expect(dialog.getByRole('definition')).toHaveText([
    'Hyperliquid perps → Hyperliquid bridge → Arbitrum Sepolia',
    '0xf39f…2266, the same address',
    '1 USDC',
    '49 USDC',
    'About 5 min',
    'One signature, no gas',
  ])
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Withdraw 50 USDC to Arbitrum Sepolia' })).toBeEnabled()
  expect(wallet.askedFor('sign')).toEqual([])
  expect(withdrawals(hyperliquid.sent)).toEqual([])
})

test('a withdrawal the wallet signs is followed until Hyperliquid sends it', async ({ page, wallet }) => {
  const { hyperliquid, dialog, amount } = await openWithdraw(page)
  hyperliquid.account.userNonFundingLedgerUpdates = []
  await amount.fill('10')
  await dialog.getByRole('button', { name: 'Withdraw 10 USDC to Arbitrum Sepolia' }).click()

  const receipt = dialog.getByRole('region', { name: 'Withdrawal receipt' })
  await expect(receipt.getByRole('status')).toHaveText(
    /^Hyperliquid perps took the withdrawal at [\d:]{8}\. 9 USDC goes to 0xf39f…2266 on Arbitrum Sepolia in about 5 min\.$/,
  )
  const [sent] = withdrawals(hyperliquid.sent) as [ExchangeBody]
  expect(sent.action).toEqual({
    type: 'withdraw3',
    signatureChainId: '0x1',
    hyperliquidChain: 'Testnet',
    destination: ACCOUNTS.alice.toLowerCase(),
    amount: '10',
    time: sent.nonce,
  })
  expect(wallet.askedFor('sign').map((asked) => asked.typedData.primaryType)).toEqual([
    'HyperliquidTransaction:Withdraw',
  ])

  // Hyperliquid's ledger names a finalized withdrawal by its nonce in thousandths, with what it sent after the fee.
  hyperliquid.account.userNonFundingLedgerUpdates = [
    {
      time: sent.nonce + 240_000,
      hash: '0x43968ea34cebe624c1ec093f57a8743182afc51d87367e518a9393e68b9e3244',
      delta: { type: 'withdraw', usdc: '9.0', nonce: sent.nonce * 1000, fee: '1.0' },
    },
  ]
  await page.clock.fastForward(15_000)
  await expect(receipt.getByRole('status')).toHaveText(
    /^Hyperliquid perps sent 9 USDC to 0xf39f…2266 on Arbitrum Sepolia at [\d:]{8}\.$/,
  )
  await expect(receipt.getByRole('link', { name: 'Hyperliquid explorer' })).toHaveAttribute(
    'href',
    `https://app.hyperliquid-testnet.xyz/explorer/address/${ACCOUNTS.alice.toLowerCase()}`,
  )
  await expectAccessible(page)
})

test('a withdrawal Hyperliquid refuses says the USDC stayed, with the venue words', async ({
  page,
  wallet: _wallet,
}) => {
  const { hyperliquid, dialog, amount } = await openWithdraw(page)
  // Hyperliquid testnet's answer to a withdraw3 on 2026-11-02, while its bridge paid out nothing.
  hyperliquid.exchange = () => ({ json: { status: 'err', response: 'Error withdrawing from bridge' } })
  await amount.fill('10')
  await dialog.getByRole('button', { name: 'Withdraw 10 USDC to Arbitrum Sepolia' }).click()

  await expect(dialog.getByRole('alert')).toHaveText(
    'Hyperliquid perps refused the withdrawal. The USDC stayed in the account.Error withdrawing from bridge',
  )
  await expect(dialog.getByRole('button', { name: 'Withdraw 10 USDC to Arbitrum Sepolia' })).toBeEnabled()
  await expectAccessible(page)
})

test('a withdrawal with no answer sends again only when the trader asks', async ({ page, wallet: _wallet }) => {
  const { hyperliquid, dialog, amount } = await openWithdraw(page)
  hyperliquid.exchange = () => ({ abort: 'timedout' })
  await amount.fill('10')
  await dialog.getByRole('button', { name: 'Withdraw 10 USDC to Arbitrum Sepolia' }).click()

  await expect(dialog.getByRole('alert')).toHaveText(
    'No answer came back, so the withdrawal may have gone through. Open the Hyperliquid explorer before you withdraw again.',
  )
  await expect.poll(() => withdrawals(hyperliquid.sent).length).toBe(1)
  await amount.fill('12')
  await expect(dialog.getByRole('alert')).toHaveCount(1)

  hyperliquid.exchange = () => ACCEPTED
  await dialog.getByRole('button', { name: 'Withdraw again 12 USDC to Arbitrum Sepolia' }).click()
  await expect(dialog.getByRole('region', { name: 'Withdrawal receipt' })).toBeVisible()
  expect(withdrawals(hyperliquid.sent).map((body) => body.action.amount)).toEqual(['10', '12'])
})
