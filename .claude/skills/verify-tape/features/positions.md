# Positions

A position row in the `Account` panel opens a popover with a price ruler. `TP / SL` sets, moves and cancels the take profit and stop loss, `Close` closes a share at market, at a limit or at mid, and `Move` on an order row moves a resting order. `Close all` and `Cancel all` in the account bar act on every position or order and report each answer. Only a funded Hyperliquid testnet run holds positions to drive.

## Sub-features

- `pos-tpsl` sets a take profit and a stop loss from the ruler or the price fields. The return on margin field and the price field move together. Set sends one `positionTpsl` order action.
- `pos-tpsl-move` moves an armed leg with the arrows or a typed price. The submit reads `Replace TP <price>` and sends a `batchModify`.
- `pos-close` closes 25 %, 50 %, 75 % or all of a position at market, at a limit or at mid. The terms line says what is kept and the estimated PnL.
- `pos-move` moves a resting limit from the `Orders` tab. The line under the fields says how the venue moves it.
- `pos-close-all` closes every position, those in profit or those in loss, and reports each fill or refusal with a retry for the refused ones.
- `pos-cancel-all` cancels the orders of this market or of all markets and warns when TP/SL legs go with them.
- `pos-gating` hides Mid and says the TP/SL legs carry the size held now on dYdX. The replay spec `e2e/dydx.testnet.spec.ts` covers it, since an unfunded dYdX account holds nothing.

## How to get to it (user POV)

- Hold a position on a Hyperliquid testnet market and enable trading.
- In `Account`, `Positions`, click the TP / SL cell of a row, or its `Close` button.
- In `Orders`, click `Move` on a resting order.
- `Close all <n>` sits in the account bar on `Positions`, `Cancel all` on `Orders`.

## Driving it with verify-tape

Preconditions:

- `VERIFY_TAPE_KEY_FILE=<path> vt up --network testnet`, enabled as in `features/trading.md` under Hyperliquid funded.
- The account starts clean. Open a position with a market order from the ticket, worth at least 10 USDC, and wait for it in `vt text --panel Account`.

- **TP / SL.** `vt click --panel Account --role button --regex --name "^Add TP/SL to BTC$"`. The dialog is named after the position, such as `BTC Long 0.00100 · PnL +0.12`. Fill `Take profit price` above the ask and `Stop loss price` below the bid, then click the button that starts with `Set TP`. Wait for `vt text --panel Account` to show both prices in the TP / SL cell.
- **Move a leg.** Open the cell again, focus the `Take profit` slider and press `ArrowRight`, or fill `Take profit price`. The button reads `Replace TP <price>`.
- **Close.** Click `Close` on the row. Click `50%`, then `Limit` with `--css "[role=dialog] [aria-label='How to close'] [role=radio]:nth-child(2)"`, and fill `Limit price`. The terms line reads `Rests as reduce only until it fills · Keeps <size> <base> · Est. PnL <signed>`. The button names size and price.
- **Move an order.** Rest a limit well under the bid from the ticket, open `Orders`, click `Move`, fill `Price`. The line reads `Hyperliquid moves it in place`, and `Move to <price>` sends it.
- **Cancel all.** On `Orders`, click `Cancel all`, then `All markets <n>`. A TP/SL leg in the list adds the amber note. `Cancel <n> orders` sends one cancel.
- **Close all.** On `Positions`, click `Close all <n>`, then `Close <n> positions at market`. The dialog turns into `Closed <k> of <n> on Hyperliquid`, one line per position, and stays open after the last position goes.
- **Proof.** `vt aria --panel Account` before and after each send, and a full page `vt shot` with the popover open.

## Gotchas

- The popover is portalled out of the panel, so scope dialog steps without `--panel`, by the dialog's role and name.
- `Limit` also names the ticket's order type, so a bare `--role radio --name Limit` matches two radios. Use the `--css` above.
- Hyperliquid refuses a partial close worth less than 10 USDC, so the Close panel says `Must be worth at least 10.0 USDC` on the size and sends nothing. Hold at least 25 USDC to close half.
- Testnet books are thin. A market close can come back refused with `Order could not immediately match against any resting orders`, which is the refusal line `Close all` reports.
- Leave the account clean: cancel every order and close every position before `down`, because the next funded run starts from this account.
