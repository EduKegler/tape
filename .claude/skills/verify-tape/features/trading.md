# Trading

On Hyperliquid, dYdX and Orderly a connected wallet enables trading, sends orders from the ticket, and reads positions, orders and fills in the `Account` panel. Every rejection shows the venue's own words. The harness wallet has no funds, so the venue's rejection is the proof: it names the address the venue recovered from the signature.

## Sub-features

- `trade-connect` connects the harness test wallet from `Connect wallet` in the ticket.
- `trade-enable-hl` asks the wallet to approve a Tape agent key. An unfunded wallet gets `Must deposit before performing actions. User: <wallet>`. The key stays on the device as a draft and `Buy BTC` appears.
- `trade-order-hl` signs the order with that agent. The venue answers `User or API Wallet <agent> does not exist.`, with the agent the wallet approved.
- `trade-market-hl` sends a market order as an IOC limit priced from the testnet book. Same answer.
- `trade-double-submit` sends one order for three clicks inside the same tick, and a second one only after the first answer. Count `/exchange` calls with a `window.fetch` wrapper installed by `vt eval` before filling the form.
- `trade-tpsl-hl` sends the order with take profit and stop loss in one action. Same answer.
- `trade-enable-dydx` asks the wallet for the dYdX onboarding signature and derives the dYdX key in the tab. The ticket turns ready.
- `trade-order-dydx` gets `account dydx1… not found` from the chain, with the derived address. The client looks the account up before it signs, so an unfunded wallet never reaches the order signature. This proves the derivation, not the order encoding.
- `trade-enable-orderly` switches the wallet to Arbitrum Sepolia, signs `Registration`, and the guard blocks the POST. The ticket shows the 451 text and `wallet.jsonl` holds the signed body.
- `trade-account` shows `No account on this venue yet. Deposit to start.` for an unfunded wallet, after setup on dYdX and right away on Hyperliquid.

## How to get to it (user POV)

- Open a Hyperliquid, dYdX or Orderly market with `?net=testnet`, or click `Testnet` in the ticket header.
- Click `Connect wallet` in the ticket, then `Enable trading` under the checklist.
- Fill price and size, click `Buy <base>`.
- The `Account` panel spans the bottom of the page, with `Positions`, `Orders` and `Fills`.

## Driving it with verify-tape

Preconditions:

- Baseline from `features/README.md`. `up` printed a `wallet` line, and `doctor` shows the wallet pid alive.
- Each run gets a fresh wallet key, so nothing carries over between runs.

- **Hyperliquid enable.** `vt open "/hyperliquid/BTC?interval=1m&net=testnet"`, `vt click --panel "Order ticket" --role button --name "Connect wallet"`, `vt wait --panel "Order ticket" --text "Approve a trading key"`, `vt click --panel "Order ticket" --role button --name "Enable trading"`, `vt wait --panel "Order ticket" --role alert`. The alert holds `Must deposit before performing actions. User: <wallet>`, lowercase, equal to the `wallet` line from `up`. `wallet.jsonl` has the `HyperliquidTransaction:ApproveAgent` request with the `agentAddress`.
- **Hyperliquid order.** Fill `Price (USDC)` with `70000` and `Size (BTC)` with `0.001`, click `Buy BTC`, then `vt wait --panel "Order ticket" --js "[...document.querySelectorAll('[data-trade-error]')].some(e => /API Wallet/.test(e.textContent))"`. The second alert names the same `agentAddress` the wallet approved.
- **Hyperliquid market and TP/SL.** Click `Market`, then `Buy BTC`, and wait as above. For TP/SL, back on `Limit`, tick `Take profit and stop loss`, fill `90000` and `65000`, and submit.
- **dYdX.** `vt open "/dydx/BTC?interval=1m&net=testnet"`, connect, wait for `Unlock your dYdX key`, click `Enable trading`, `vt wait --panel "Order ticket" --role button --name "Buy BTC"`. Fill `Price (USD)` and size, submit, wait for `[data-trade-error]`. The alert says `account dydx1… not found`.
- **Orderly.** `vt open "/orderly/BTC?interval=1m&net=testnet"`, connect, wait for `Register an Orderly account`, click `Enable trading`, wait for the alert. It shows `451` and `Orderly account and key registration is blocked in verification`. Check the signature with `node .claude/skills/verify-tape/.cache/probes/orderly-recover.ts <artifacts>/wallet.jsonl` when that probe exists, or recover it with viem from the logged body.
- **Proof.** `vt aria --panel "Order ticket" --path <venue>/NN.aria.txt` after each alert, `vt aria --panel Account`, and a full page `vt shot`.

## Gotchas

- The guard blocks Hyperliquid mainnet `/exchange`, every Orderly `register_account` and `orderly_key`, Orderly mainnet order writes, and dYdX mainnet broadcasts, with a 451. CORS preflights pass. Blocks land in `wallet.jsonl` as `blocked` lines with the body.
- Orderly registration creates an account at the venue, so it stays blocked. Orderly orders cannot be proven past setup here. Unit tests cover the signed body.
- The dYdX key lives in sessionStorage. A new tab asks for the onboarding signature again. That is by design.
- The `Account` panel polls every 10 s. Right after setup it can say `Enable trading to read this account.` for one poll.
- The book on screen is mainnet. Testnet orders are priced by the testnet book, which can be far from it.
- A Hyperliquid testnet address that deposited elsewhere has a real account. The fresh harness wallet never has one.
