import { encodeFunctionData, erc20Abi } from 'viem'
import type { Page } from '@playwright/test'
import { fakeChains } from './chain'
import { expect, expectAccessible, openMarket, panel, test } from './fixtures'
import { fakeOrderly } from './orderly'
import { ACCOUNTS } from './wallet'

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
  await panel(page, 'Order ticket').getByRole('button', { name: 'Connect wallet' }).click()
  await panel(page, 'Account').getByRole('button', { name: 'Deposit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Deposit USDC to Orderly' })
  return { dialog, chains, amount: dialog.getByRole('textbox', { name: 'Amount (USDC)' }) }
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
    // Two calls of 60,000 gas at viem's max fee: a 1 gwei base fee times its 1.2 headroom, plus the 0.1 gwei tip.
    '≈0.00016 ETH on Arbitrum Sepolia',
    'Under a minute, up to 10 min',
    'Approve exactly 10 USDC, then deposit',
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
