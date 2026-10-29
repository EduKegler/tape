# Order ticket

The order ticket lets a user build a buy or sell, limit or market order and preview it. Price and size are checked against the market's tick and step as the user types. Previewing shows a sentence that ends with `Nothing was sent.` Tape never signs or sends anything.

## Sub-features

- `ticket-side` switches between buy and sell and relabels the submit button.
- `ticket-kind` switches between limit and market. Market hides the price field and prices the notional at the far touch.
- `ticket-validate-price` rejects empty, non-numeric, too precise, zero and off-tick prices.
- `ticket-validate-size` rejects empty, too precise, below-minimum and off-step sizes.
- `ticket-hint` fills the price from the `Bid` or `Ask` hint next to the price label.
- `ticket-propose` fills the price from a click on a book row or a trade row.
- `ticket-preview` shows the order sentence in a status after a valid submit.
- `ticket-wallet` shows `Not connected` for Wallet USDC without a wallet.

## How to get to it (user POV)

- The `Order ticket` panel sits in the right column on every market page.
- Click a row in `Order book` or `Trades` to propose its price.
- Click the `Bid <price>` or `Ask <price>` hint above the price input.

## Driving it with verify-tape

Preconditions:

- Baseline from `features/README.md`, on `/binance/BTC?interval=1m` (tick 0.01, step 0.00001).
- The ticket shows its form, not `Loading market rules…`. Run `vt wait --panel "Order ticket" --role button --name "Preview buy BTC"`.
- The book is live. Run `vt wait --js "document.querySelector('section div[data-status]')?.dataset.status === 'live'"`.

- **Starting state.** Run `vt aria --panel "Order ticket" --path ticket/01-start.aria.txt`. `button "buy" [pressed]`, `radio "Limit" [checked]`, Notional `—`, Wallet USDC `Not connected`.
- **Too many decimals.** Run `vt fill --panel "Order ticket" --role textbox --name "Price (USDT)" --value 1.234 --blur`. The panel shows `At most 2 decimals` and the input has `aria-invalid="true"`, with the error tied to it by `aria-describedby`. Check with `vt attr --panel "Order ticket" --role textbox --name "Price (USDT)" --attr aria-invalid`.
- **Not a number.** Fill the price with `abc`. The panel shows `Not a number`.
- **Size below step.** Run `vt fill --panel "Order ticket" --role textbox --name Size --value 0.000001 --blur`. The panel shows `At most 5 decimals`. Fill `0` and the panel shows `Minimum is 0.00001`.
- **Bid hint.** Run `vt click --panel "Order ticket" --text "Bid "` and `vt eval "document.querySelector('input[name=price]').value"`. The price is the best bid, such as `79790.00`.
- **Valid preview.** Run `vt fill --panel "Order ticket" --role textbox --name Size --value 0.001`, `vt click --panel "Order ticket" --role button --name "Preview buy BTC"` and `vt text --panel "Order ticket" --role status`. The status reads `Buy 0.001 BTC at <price> on Binance. Nothing was sent.`
- **Market sell.** Run `vt click --panel "Order ticket" --role radio --name Market --exact` and `vt click --panel "Order ticket" --role button --name sell --exact`. The price input is gone, the submit reads `Preview sell BTC`, and Notional is a number in `USDT`.
- **Propose from trades.** Switch back to `Limit`, then run `vt click --panel Trades --css "button"` and read the price input. It equals the first trade row's price without separators.
- **Off tick on a coarse market.** On `/hyperliquid/BTC?interval=1m`, read the tick from a book price, then fill a price between two ticks. The panel shows `Price must be a multiple of <tick>`. Hyperliquid's tick depends on the price (5 significant figures).
- **Proof.** Run `vt aria --panel "Order ticket" --path ticket/02-preview.aria.txt` and `vt shot --panel "Order ticket" --path ticket/02-preview.png` while the status is shown.

## Gotchas

- The price textbox is named after its quote, such as `Price (USDT)`. The hint is a separate button, matched with `--text "Bid "` or `--text "Ask "`.
- The side buttons' text is lowercase in the DOM (`buy`, `sell`) and capitalized by CSS. Match with `--exact` on the lowercase name.
- Errors only show after the field is touched. Pass `--blur` to `fill`, or click submit.
- Submit with an empty price runs validation and shows `Enter a price`. No status appears. That is correct.
- With a `group` in the URL, the book rows are grouped but the `Bid` and `Ask` hints stay on the exact touch. They match the venue's row in `Venues`.
- Quote currency depends on venue: `USDT` on Binance, `USDC` on Hyperliquid, `USD` on dYdX.
- The wallet needs a browser extension. `ticket-wallet` can only be proven in its disconnected state here.
- The ticket resets when the market changes, because it remounts per market.
