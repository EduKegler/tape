import { encodeFunctionData, erc20Abi } from 'viem'
import type { Page } from '@playwright/test'
import { fakeChains } from './chain'
import { connectWallet, expect, expectAccessible, openMarket, panel, settled, test } from './fixtures'
import { fakeOrderly } from './orderly'
import { RECORDED_AT } from './replay/clock'
import { ACCOUNTS, answerSend, holdSends } from './wallet'

/** Orderly's testnet Vault and the USDC it takes on Arbitrum Sepolia, from Orderly's testnet addresses. */
const ARBITRUM_SEPOLIA = 421614
const VAULT = '0x0EaC556c0C2321BA25b9DC01e4e3c95aD5CDCd2f'
const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'

async function openDeposit(page: Page, registered: boolean) {
  const orderly = await fakeOrderly(page, 'testnet')
  orderly.registered.value = registered
  const chains = await fakeChains(page, 'testnet')
  chains.fund(ARBITRUM_SEPOLIA, ACCOUNTS.alice, { native: 10n ** 16n, tokens: { [USDC]: 50_000_000n } })
  await openMarket(page, '/orderly/BTC?interval=1m')
  await connectWallet(page, panel(page, 'Order ticket').getByRole('button', { name: 'Connect wallet' }))
  await panel(page, 'Account').getByRole('button', { name: 'Deposit', exact: true }).click()
  await settled(page)
  const dialog = page.getByRole('dialog', { name: 'Deposit USDC to Orderly' })
  return { dialog, chains, amount: dialog.getByRole('textbox', { name: 'Amount' }) }
}

test('the Orderly deposit waits until Orderly registers the address', async ({ page, wallet }) => {
  const { dialog, chains, amount } = await openDeposit(page, false)
  await amount.fill('10')
  await expect(dialog.getByRole('alert')).toHaveText(
    'The venue has no account for this address yet. Enable trading first, which registers it, then deposit.',
  )
  await expect(dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' })).toBeDisabled()
  await expectAccessible(page)
  expect(wallet.askedFor('send')).toEqual([])
  expect(chains.unanswered()).toEqual([])
})

test('a registered address sees the LayerZero fee and the wallet is asked to approve the Vault', async ({
  page,
  wallet,
}) => {
  const { dialog, chains, amount } = await openDeposit(page, true)
  await amount.fill('10')
  await expect(dialog.getByRole('definition')).toHaveText([
    'Arbitrum Sepolia → Orderly Vault → LayerZero → Orderly',
    '0xf39f…2266, the same address',
    '0.0001 ETH to LayerZero',
    '10 USDC',
    // The address holds nothing on Orderly yet, so there is no balance to add to.
    '—',
    // Two calls of 60,000 gas at viem's max fee: a 1 gwei base fee times its 1.2 headroom, plus the 0.1 gwei tip.
    'About 0.00016 ETH on Arbitrum Sepolia',
    'Under a minute, at most 10 min',
    'Twice: approve exactly 10 USDC, then deposit',
  ])
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expectAccessible(page)

  await dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('You declined in the wallet. Nothing was sent.')
  expect(wallet.askedFor('send')).toEqual([
    {
      kind: 'send',
      from: 'alice',
      chainId: ARBITRUM_SEPOLIA,
      tx: {
        to: USDC,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [VAULT, 10_000_000n] }),
        chainId: ARBITRUM_SEPOLIA,
      },
    },
  ])
  expect(chains.unanswered()).toEqual([])
})

test('the wallet is asked for the deposit only once the chain confirms the approval', async ({
  page,
  wallet: _wallet,
}) => {
  const approval = `0x${'a1'.repeat(32)}` as const
  const sent = `0x${'d2'.repeat(32)}` as const
  await page.addInitScript(holdSends)
  const { dialog, chains, amount } = await openDeposit(page, true)
  await amount.fill('10')
  await dialog.getByRole('button', { name: 'Deposit 10 USDC from Arbitrum Sepolia' }).click()
  await expect(dialog.getByRole('button', { name: 'Approve in Test Wallet…' })).toBeDisabled()
  await expect(dialog.getByRole('status')).toHaveText(
    'Approve exactly 10 USDC in Test Wallet. It asks once more for the deposit. Esc stays here until the wallet answers, and closing keeps this deposit.',
  )

  await answerSend(page, approval)
  await expect(dialog.getByRole('button', { name: 'Arbitrum Sepolia is confirming the approval…' })).toBeDisabled()
  chains.mine(approval)
  await page.clock.fastForward(5_000)
  await expect(dialog.getByRole('button', { name: 'Waiting for Test Wallet…' })).toBeDisabled()
  await expect(dialog.getByRole('status')).toHaveText(
    'Confirm the deposit in Test Wallet. Esc stays here until the wallet answers, and closing keeps this deposit.',
  )

  chains.mine(sent)
  await answerSend(page, sent)
  await expect(dialog.getByRole('region', { name: 'Deposit slip' }).getByRole('status')).toHaveText(
    'Tape cannot follow the credit from here.Enable trading on Orderly to follow the credit here',
  )
  expect(chains.unanswered()).toEqual([])
})

test('a receipt kept before Tape stored the LayerZero fee still opens', async ({ page, wallet }) => {
  const storedBeforeTheFee = {
    chainId: ARBITRUM_SEPOLIA,
    amount: '10000000',
    fee: { expected: '0', max: '0' },
    hash: `0x${'ab'.repeat(32)}`,
    replacement: null,
    sentAt: RECORDED_AT,
    gasPaid: '20000000000000',
    outcome: null,
  }
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [`tape:trade:v1:orderly:testnet:${ACCOUNTS.alice.toLowerCase()}:deposits`, JSON.stringify([storedBeforeTheFee])],
  )
  const { dialog, chains } = await openDeposit(page, true)
  await dialog.getByRole('button', { name: /^10 USDC · Arbitrum Sepolia · / }).click()
  const receipt = dialog.getByRole('region', { name: 'Deposit slip' })
  await expect(receipt.getByRole('status')).toHaveText(
    'Tape cannot follow the credit from here.Enable trading on Orderly to follow the credit here',
  )
  await expect(receipt.getByRole('definition')).toHaveText([
    'Arbitrum Sepolia',
    'Orderly Vault → LayerZero',
    'Orderly',
    '0xf39f…2266, on both',
    '10 USDC',
    'None',
    '10 USDC',
  ])
  await expectAccessible(page)
  expect(wallet.askedFor('send')).toEqual([])
  expect(chains.unanswered()).toEqual([])
})

test('a receipt Tape cannot follow without an Orderly key never reads as late', async ({ page, wallet: _wallet }) => {
  const sentAnHourAgo = {
    chainId: ARBITRUM_SEPOLIA,
    amount: '10000000',
    fee: { expected: '0', max: '0' },
    hash: `0x${'ab'.repeat(32)}`,
    replacement: null,
    sentAt: RECORDED_AT - 60 * 60_000,
    gasPaid: '20000000000000',
    outcome: null,
  }
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [`tape:trade:v1:orderly:testnet:${ACCOUNTS.alice.toLowerCase()}:deposits`, JSON.stringify([sentAnHourAgo])],
  )
  const { dialog } = await openDeposit(page, true)
  const row = dialog.getByRole('button', { name: /^10 USDC · Arbitrum Sepolia · / })
  await expect(row).toContainText('Not followed')
  await row.click()
  const receipt = dialog.getByRole('region', { name: 'Deposit slip' })
  await expect(receipt.getByRole('status')).toHaveText(
    'Tape cannot follow the credit from here.Enable trading on Orderly to follow the credit here',
  )
  await expect(row).toContainText('Not followed')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByText(/^Not credited/)).toHaveCount(0)
})
