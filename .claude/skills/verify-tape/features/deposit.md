# Deposit

On Hyperliquid the `Account` panel has a `Deposit` button. It opens a dialog that moves USDC from the connected wallet to Hyperliquid perps: from Arbitrum through Hyperliquid's bridge, or from Base, OP Mainnet and Ethereum over Circle CCTP on mainnet builds. Before the wallet signs, the dialog shows the route, where the USDC lands, the fee, gas, time and what the wallet asks for, and stops a deposit that would lose funds. After the send it follows the deposit to the credit and keeps a receipt.

## Sub-features

- `deposit-open` shows `Deposit` next to the network tag once a wallet is connected, and opens `Deposit USDC to Hyperliquid perps`.
- `deposit-from` lists each source chain with the wallet's USDC there. A status line says when the wallet sits on another chain and that Tape asks it to switch.
- `deposit-summary` shows Route, Credited to, Fee, You receive, Gas, Time and Wallet asks for the amount typed.
- `deposit-below-minimum` on the Arbitrum bridge under 5 USDC: `You receive` says `Nothing, under the minimum`, an alert says the venue keeps it, and the button is disabled.
- `deposit-insufficient` alerts with the wallet's USDC on that chain when the amount is more, and with the gas needed when the native balance is short.
- `deposit-chain-rejects` alerts with the chain's revert reason when simulating the first call fails, such as USDC's blacklist.
- `deposit-high-fee` shows the fee as a share of the deposit at 1% or more, without blocking.
- `deposit-approve` on CCTP asks for an exact approval first when the allowance falls short. `Wallet asks` says so.
- `deposit-send` switches the wallet to the source chain and sends. A refusal shows `You declined in the wallet. Nothing was sent.`
- `deposit-receipt` follows the deposit from the source chain's receipt to the credit on Hyperliquid, with the explorer link, gas paid, fee, amount credited and the venue's record. A deposit past its worst case time shows a late warning.
- `deposit-recent` lists the last 5 deposits of this wallet on this device. Each row opens its receipt.

## How to get to it (user POV)

- Open a Hyperliquid market, click `Connect wallet` in the ticket.
- Click `Deposit` in the `Account` panel header.
- Pick `From`, type `Amount (USDC)` or click `Max`, read the summary, click `Deposit <amount> USDC from <chain>`.
- After a send, or from a row under `Recent deposits`, the dialog shows the receipt. `New deposit` goes back to the form.

## Driving it with verify-tape

Preconditions:

- `up` with `VITE_TRADE_MAINNET=1` for the CCTP routes, or `up --network testnet` for the Arbitrum Sepolia bridge only.
- `VERIFY_TAPE_WATCH=<address>` on `up` makes the test wallet a watch-only copy of a funded address. It refuses every signature and every `eth_sendTransaction`, and logs the transaction it refused in `wallet.jsonl`. Without it the fresh wallet has no USDC, and only the empty and insufficient states show.
- Pick a watched address with USDC on the chains you test, and one whose USDC is not blacklisted.

- **Open.** `vt open "/hyperliquid/BTC?interval=1m"`, `vt click --panel "Order ticket" --role button --name "Connect wallet"`, `vt click --panel Account --role button --name Deposit`, `vt aria --role dialog`. The dialog lists every route with a balance.
- **Bridge.** `vt select --role combobox --name From --value 42161`. `vt fill --role textbox --name "Amount (USDC)" --value 3` shows the minimum alert and a disabled button. `--value 100000000` shows the balance alert. A value the wallet holds turns the button on.
- **CCTP.** `vt select --role combobox --name From --value 8453`, fill `10`. Fee shows a nonzero USDC amount from Circle, `You receive` is the amount less that fee, and `Wallet asks` names the approval when the address has no allowance.
- **Send.** Click `Deposit <amount> USDC from <chain>`. The watch-only wallet refuses, the dialog shows the decline, and `wallet.jsonl` has a `refused` line with the `tx` and `walletChainId`. The `chainId` in the tx is the source chain, and `to` is the USDC contract for the bridge and approvals, or TokenMessengerV2 for the burn.
- **Receipt.** The harness never sends, so replay a deposit that address already made. Seed it with `vt eval "localStorage.setItem('tape:trade:v1:hyperliquid:mainnet:<lowercase address>:deposits', JSON.stringify([{chainId:8453,amount:'<base units>',fee:{expected:'0',max:'0'},hash:'<tx hash>',sentAt:<block ms>,gasPaid:null,outcome:null}]))"`, open `Deposit`, click the row under `Recent deposits`, then `vt wait --css '[data-deposit-stage="credited"]'`. Gas paid comes from the chain, the credit from Hyperliquid's ledger, and for CCTP the fee from Circle.
- **Proof.** `vt aria --role dialog --path deposit/NN.aria.txt` after each state and `vt shot --role dialog`.

## Gotchas

- Another worktree's harness may hold the default ports. Export `VERIFY_TAPE_PORT`, `VERIFY_TAPE_CDP_PORT` and `VERIFY_TAPE_WALLET_PORT` for every command of the run.
- Run `down` before `pnpm verify`. The Chrome profile under `.state/` breaks lint and knip.
- Circle blacklists some exchange hot wallets on USDC. Those addresses show `deposit-chain-rejects` on that chain.
- `sentAt` for a replayed deposit must be near the block time. The ledger lookup starts 10 min before it.
- A replay states nothing about the send itself. Only the refused `eth_sendTransaction` in `wallet.jsonl` proves what Tape would sign.
