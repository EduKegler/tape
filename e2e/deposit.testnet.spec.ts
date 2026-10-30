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
    { kind: 'switch-chain', from: 1, to: ARBITRUM_SEPOLIA },
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
