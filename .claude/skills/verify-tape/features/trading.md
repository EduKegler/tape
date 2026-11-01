# Trading

On Hyperliquid, dYdX and Orderly a connected wallet enables trading, sends orders from the ticket, and reads positions, orders and fills in the `Account` panel. Every rejection shows the venue's own words. The harness wallet has no funds by default, so the venue's rejection is the proof: it names the address the venue recovered from the signature. A funded run with `VERIFY_TAPE_KEY_FILE` proves Hyperliquid orders past the rejection.

## Sub-features

- `trade-connect` connects the harness test wallet from `Connect wallet` in the ticket.
- `trade-enable-hl` asks the wallet to approve a Tape agent key. An unfunded wallet gets `Must deposit before performing actions. User: <wallet>`. The key stays on the device as a draft and `Buy / Long BTC` appears.
- `trade-order-hl` signs the order with that agent. The venue answers `User or API Wallet <agent> does not exist.`, with the agent the wallet approved.
- `trade-market-hl` sends a market order as an IOC limit priced from the testnet book. Same answer.
- `trade-double-submit` sends one order for three clicks inside the same tick, and a second one only after the first answer. Count `/exchange` calls with a `window.fetch` wrapper installed by `vt eval` before filling the form.
- `trade-tpsl-hl` sends the order, limit or market, with take profit and stop loss in one `normalTpsl` action. Same answer.
- `trade-scale-hl` sends every leg of a scale order as one action with `grouping` `na`, each leg with its own cloid. Same answer.
- `trade-enable-dydx` asks the wallet for the dYdX onboarding signature and derives the dYdX key in the tab. The ticket turns ready. `wallet.jsonl` shows the domain `{"name":"dYdX Chain","chainId":11155111}`, the one dYdX's own frontend uses on testnet (1 on mainnet), so the wallet gets the same dYdX account as on dydx.trade.
- `trade-lookup` asks the venue for the order by its client id after a send with no answer. Make `/exchange` fail with a `window.fetch` wrapper installed by `vt eval`, submit, and wait for `[data-order-lookup]`. On Hyperliquid testnet it says `The venue does not show this order. Hyperliquid answered unknownOid`.
- `trade-order-dydx` gets `account dydx1… not found` from the chain, with the derived address. The client looks the account up before it signs, so an unfunded wallet never reaches the order signature. This proves the derivation, not the order encoding.
- `trade-enable-orderly` switches the wallet to Arbitrum Sepolia, signs `Registration`, and the guard blocks the POST. The ticket shows the 451 text and `wallet.jsonl` holds the signed body.
- `trade-funded-hl` signs with the funded testnet key from `VERIFY_TAPE_KEY_FILE`. Enable trading approves the agent, the `Account` panel shows the funded equity, a limit order rests with an `oid`, and its cancel answers `canceled`.
- `trade-account` shows `No account on this venue yet. Deposit to start.` for an unfunded wallet, after setup on dYdX and right away on Hyperliquid.

## How to get to it (user POV)

- Open a Hyperliquid, dYdX or Orderly market on the testnet site. The header and the ticket say `Testnet`.
- Click `Connect wallet` in the ticket, then `Enable trading` under the checklist.
- Fill price and size, click `Buy <base>`.
- The `Account` panel spans the bottom of the page, with `Positions`, `Orders` and `Fills`.

## Driving it with verify-tape

Preconditions:

- `up --network testnet`. A mainnet build never shows `Enable trading`.
- Baseline from `features/README.md`. `up` printed a `wallet` line, and `doctor` shows the wallet pid alive.
- Each run gets a fresh wallet key, so nothing carries over between runs.

- **Hyperliquid enable.** `vt open "/hyperliquid/BTC?interval=1m"`, `vt click --panel "Order ticket" --role button --name "Connect wallet"`, `vt wait --panel "Order ticket" --text "Approve a trading key"`, `vt click --panel "Order ticket" --role button --name "Enable trading"`, `vt wait --panel "Order ticket" --role alert`. The alert holds `Must deposit before performing actions. User: <wallet>`, lowercase, equal to the `wallet` line from `up`. `wallet.jsonl` has the `HyperliquidTransaction:ApproveAgent` request with the `agentAddress`.
- **Hyperliquid order.** Fill `Price (USDC)` with `70000` and `Size (BTC)` with `0.001`, click `Buy / Long BTC`, then `vt wait --panel "Order ticket" --js "[...document.querySelectorAll('[data-trade-error]')].some(e => /API Wallet/.test(e.textContent))"`. The second alert names the same `agentAddress` the wallet approved.
- **Hyperliquid market and TP/SL.** Click `Market`, then `Buy / Long BTC`, and wait as above. Tick `Take profit and stop loss`, fill a take profit above the ask and a stop below the bid, and submit. A take profit under the ask stops in the ticket with `Take profit: Must be above the ask` and sends nothing.
- **Hyperliquid scale.** Click `Scale`, fill the range, size and skew, submit, and wait as above. Read the sent action with a `window.fetch` wrapper installed by `vt eval`: one action, `grouping` `na`, one order per row of `Scale orders`.
- **dYdX.** `vt open "/dydx/BTC?interval=1m"`, connect, wait for `Unlock your dYdX key`, click `Enable trading`, `vt wait --panel "Order ticket" --role button --name "Buy / Long BTC"`. Fill `Price (USD)` and size, submit, wait for `[data-trade-error]`. The alert says `account dydx1… not found`.
- **Orderly.** `vt open "/orderly/BTC?interval=1m"`, connect, wait for `Register an Orderly account`, click `Enable trading`, wait for the alert. It shows `451` and `Orderly account and key registration is blocked in verification`. Check the signature with `node .claude/skills/verify-tape/.cache/probes/orderly-recover.ts <artifacts>/wallet.jsonl` when that probe exists, or recover it with viem from the logged body.
- **Hyperliquid funded.** `VERIFY_TAPE_KEY_FILE=<path> vt up --network testnet`. The `wallet` line ends in `(funded)`. Enable as above. The ticket turns ready with no alert, and `vt text --panel Account` shows the equity. Fill `Price (USDC)` well under the bid and a size worth at least 10 USDC, click `Buy / Long BTC`, and wait for the status `Resting as order <oid>`. Cancel it from the `Orders` tab of the `Account` panel. Cancel every order and close every position before `down`, because the next funded run starts from this account.
- **Proof.** `vt aria --panel "Order ticket" --path <venue>/NN.aria.txt` after each alert, `vt aria --panel Account`, and a full page `vt shot`.

## Gotchas

- The guard blocks Hyperliquid mainnet `/exchange`, every Orderly `register_account` and `orderly_key`, Orderly mainnet order writes, and dYdX mainnet broadcasts, with a 451. CORS preflights pass. Blocks land in `wallet.jsonl` as `blocked` lines with the body.
- Orderly registration creates an account at the venue, so it stays blocked. Orderly orders cannot be proven past setup here. Unit tests cover the signed body.
- The dYdX key lives in sessionStorage. A new tab asks for the onboarding signature again. That is by design.
- The `Account` panel polls every 10 s. Right after setup it can say `Enable trading to read this account.` for one poll.
- The book on screen is the testnet book, so it can sit far from mainnet prices. The dYdX testnet BTC price has been 20% under mainnet.
- A Hyperliquid testnet address that deposited elsewhere has a real account. The fresh harness wallet never has one.
- One funded run at a time. Two runs on the funded key each approve the agent named `tape`, and the second replaces the first. The replaced run cannot cancel its own orders either: the cancel answers `User or API Wallet <agent> does not exist.` An enable 2 s after another one gets `User has pending agent removal` from Hyperliquid, and a retry 54 s later went through.
