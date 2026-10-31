# Deposit

On Hyperliquid and Orderly the `Account` panel has a `Deposit` button. It opens a dialog that moves USDC from the connected wallet to the venue. To Hyperliquid perps it goes from Arbitrum through Hyperliquid's bridge, or from Base, OP Mainnet and Ethereum over Circle CCTP on mainnet builds. To Orderly it goes from Arbitrum, Base or OP Mainnet, or Arbitrum Sepolia on testnet, into Orderly's Vault, which pays LayerZero to carry the credit. Before the wallet signs, the dialog shows the route, where the USDC lands, the fee, gas, time and what the wallet asks for, and stops a deposit that would lose funds. After the send it follows the deposit to the credit and keeps a receipt.

## Sub-features

- `deposit-open` shows `Deposit` next to the network tag once a wallet is connected, and opens `Deposit USDC to Hyperliquid perps` or `Deposit USDC to Orderly`. A mainnet build with no `VITE_ORDERLY_BROKER_ID` has no Orderly route and no button there.
- `deposit-from` lists each source chain with the wallet's USDC there. A status line says when the wallet sits on another chain and that Tape asks it to switch.
- `deposit-summary` shows Route, Credited to, Fee, You receive, Gas, Time and Wallet asks for the amount typed. On Orderly the Fee is `<n> ETH to LayerZero`, which the wallet pays as the deposit's value on top of gas.
- `deposit-below-minimum` on the Arbitrum bridge under 5 USDC: `You receive` says `Nothing, under the minimum`, an alert says the venue keeps it, and the button is disabled.
- `deposit-no-account` on Orderly for an address Orderly has not registered under the broker: an alert says to enable trading first, and the button is disabled.
- `deposit-over-limit` on Orderly when the Vault caps USDC and the amount passes the room left: an alert names the room on that chain. Every mainnet Vault has no cap today, so this state shows only in tests.
- `deposit-insufficient` alerts with the wallet's USDC on that chain when the amount is more, and with the gas needed when the native balance is short. On Orderly the gas includes the LayerZero fee.
- `deposit-chain-rejects` alerts with the chain's revert reason when simulating the first call fails, such as USDC's blacklist.
- `deposit-high-fee` shows the fee as a share of the deposit at 1% or more, without blocking.
- `deposit-approve` on CCTP and Orderly asks for an exact approval first when the allowance falls short. `Wallet asks` says so.
- `deposit-send` switches the wallet to the source chain and sends. A refusal shows `You declined in the wallet. Nothing was sent.`
- `deposit-receipt` follows the deposit from the source chain's receipt to the credit, with the explorer link, gas paid, fee, amount credited and the venue's record. Hyperliquid's credit comes from its ledger, Orderly's from its asset history. A deposit past its worst case time shows a late warning.
- `deposit-check-manually` ends the watch when Tape cannot tell where the deposit is: a CCTP forward Circle has not completed after 30 min or reports in a state Tape does not know, or an Orderly deposit Orderly reports as `FAILED` or in an undocumented state. The receipt says `Check manually.` with the reason, links the Circle or LayerZero message, and shows the transaction hash for support. Recent marks the row `Check manually`.
- `deposit-recent` lists the last 5 deposits of this wallet on this device. Each row opens its receipt.

## How to get to it (user POV)

- Open a Hyperliquid or Orderly market, click `Connect wallet` in the ticket.
- Click `Deposit` in the `Account` panel header.
- Pick `From`, type `Amount (USDC)` or click `Max`, read the summary, click `Deposit <amount> USDC from <chain>`.
- After a send, or from a row under `Recent deposits`, the dialog shows the receipt. `New deposit` goes back to the form.

## Driving it with verify-tape

Preconditions:

- `up` with `VITE_TRADE_MAINNET=1` for the CCTP and mainnet Orderly routes, plus `VITE_ORDERLY_BROKER_ID=<broker>` for Orderly, or `up --network testnet` for the Arbitrum Sepolia routes only.
- `VERIFY_TAPE_WATCH=<address>` on `up` makes the test wallet a watch-only copy of a funded address. It refuses every signature and every `eth_sendTransaction`, and logs the transaction it refused in `wallet.jsonl`. Without it the fresh wallet has no USDC, and only the empty and insufficient states show.
- Pick a watched address with USDC on the chains you test, and one whose USDC is not blacklisted. For Orderly past `deposit-no-account`, pick one with an Orderly account under that broker: `/v1/get_account?address=<address>&broker_id=<broker>` on Orderly's API answers `success: true`.

- **Open.** `vt open "/hyperliquid/BTC?interval=1m"`, `vt click --panel "Order ticket" --role button --name "Connect wallet"`, `vt click --panel Account --role button --name Deposit`, `vt aria --role dialog`. The dialog lists every route with a balance. For Orderly open `/orderly/BTC?interval=1m` instead.
- **Bridge.** `vt select --role combobox --name From --value 42161`. `vt fill --role textbox --name "Amount (USDC)" --value 3` shows the minimum alert and a disabled button. `--value 100000000` shows the balance alert. A value the wallet holds turns the button on.
- **CCTP.** `vt select --role combobox --name From --value 8453`, fill `10`. Fee shows a nonzero USDC amount from Circle, `You receive` is the amount less that fee, and `Wallet asks` names the approval when the address has no allowance.
- **Orderly.** Fill `10`. An address with no Orderly account shows the no-account alert and a disabled button. A registered one shows Fee `<n> ETH to LayerZero`, `You receive` the full amount, and the approval in `Wallet asks` when the Vault has no allowance. Each source chain reads its own Vault fee and gas.
- **Send.** Click `Deposit <amount> USDC from <chain>`. The watch-only wallet refuses, the dialog shows the decline, and `wallet.jsonl` has a `refused` line with the `tx` and `walletChainId`. The `chainId` in the tx is the source chain. `to` is the USDC contract for the bridge and approvals, TokenMessengerV2 for the burn, and Orderly's Vault for its deposit, with the LayerZero fee as `value`.
- **Receipt.** The harness never sends, so replay a deposit that address already made. Seed it with `vt eval "localStorage.setItem('tape:trade:v1:<venue>:mainnet:<lowercase address>:deposits', JSON.stringify([{chainId:8453,amount:'<base units>',fee:{expected:'0',max:'0'},hash:'<tx hash>',sentAt:<block ms>,gasPaid:null,outcome:null}]))"`, open `Deposit`, click the row under `Recent deposits`, then `vt wait --css '[data-deposit-stage="credited"]'`. Gas paid comes from the chain, the credit from the venue, and for CCTP the fee from Circle. An Orderly replay stays at `Enable trading on Orderly to follow the credit here`, because the asset history needs the depositor's own linked key.
- **Check manually.** Replay on a CCTP chain a mined transaction Circle never forwarded to Hyperliquid, such as a plain CCTP burn, with `sentAt` more than 30 min before now, then `vt wait --css '[data-deposit-stage="unresolved"]'`. The receipt links the Circle message and shows the hash.
- **Proof.** `vt aria --role dialog --path deposit/NN.aria.txt` after each state and `vt shot --role dialog`.

## Gotchas

- Another worktree's harness may hold the default ports. Export `VERIFY_TAPE_PORT`, `VERIFY_TAPE_CDP_PORT` and `VERIFY_TAPE_WALLET_PORT` for every command of the run.
- Run `down` before `pnpm verify`. The Chrome profile under `.state/` breaks lint and knip.
- Circle blacklists some exchange hot wallets on USDC. Those addresses show `deposit-chain-rejects` on that chain.
- `sentAt` for a replayed deposit must be near the block time. The ledger and asset history lookups start 10 min before it.
- Orderly's asset history takes only requests signed by the account's ed25519 key, 10 a minute, so an Orderly receipt polls every 10 s.
- A replay states nothing about the send itself. Only the refused `eth_sendTransaction` in `wallet.jsonl` proves what Tape would sign.
