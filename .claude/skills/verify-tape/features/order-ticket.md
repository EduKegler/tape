# Order ticket

The order ticket builds a buy or sell, limit, market, scale or trailing stop order. Price and size are checked against the market's tick and step as the user types. On Hyperliquid, dYdX and Orderly the ticket sends the order once trading is enabled, see [Trading](./trading.md). On Binance it is read only and has no submit button.

## Sub-features

- `ticket-side` switches between buy and sell and relabels the submit button.
- `ticket-kind` switches between limit, market and, where the venue offers them, scale and trailing stop. Market hides the price field, shows `Max slippage`, and prices the notional at the far touch.
- `ticket-scale` spreads the total size over `Orders` limit orders from `Start price` to `End price`, the last one `Size skew` times the first. The `Scale orders` list shows each price and size. Hyperliquid offers up to 20, Orderly up to 10, dYdX none.
- `ticket-trailing` sends a stop that trails the best price by `Retracement`, in percent or in the quote as picked under `Retracement in`. It waits for `Activation price` before it trails, or trails at once when that field is empty. It hides the price, `Time in force` and `Take profit and stop loss`, ticks `Reduce only`, and prices the notional at the far touch. Only Hyperliquid offers it.
- `ticket-validate-price` rejects empty, non-numeric, too precise, zero and off-tick prices.
- `ticket-validate-size` rejects empty, too precise, below-minimum and off-step sizes.
- `ticket-hint` fills the price from the `Bid` or `Ask` hint next to the price label.
- `ticket-propose` fills the price from a click on a book row or a trade row.
- `ticket-tif` offers `Good til canceled`, `Immediate or cancel` and `Post only` for limit orders.
- `ticket-tpsl` shows `Take profit` and `Stop loss` behind the `Take profit and stop loss` checkbox, on limit and market orders, on venues that offer them (Hyperliquid). `Add take profit` adds a row while the take profits plus a filled `Stop loss` stay under 2, the most Hyperliquid takes on one order. Two take profits with a stop loss stop on submit with `Take profits: At most 1 with a stop loss on this venue`. With more than one, each row is `Take profit <n>` with `Size <n> (%)` and `Remove`, the shares start even, and `Take profit sizes` lists the size each one closes. Shares that miss 100% show `Sizes add up to <n>%, not 100%`. A market order's take profit must clear the far touch and its stop the near touch, and a limit that crosses the book keeps its stop below the bid (above the ask for a sell).
- `ticket-read-only` says `Binance is read only in Tape.` on Binance.
- `ticket-network` says which network the build is. A mainnet build shows `Read only` and `Mainnet is read only in Tape.`, with a `testnet` link when the build sets `VITE_TESTNET_SITE`. A testnet build shows `Testnet` and hides `Wallet USDC`, which is a mainnet balance.

## How to get to it (user POV)

- The `Order ticket` panel sits in the right column on every market page.
- Click a row in `Order book` or `Trades` to propose its price.
- Click the `Bid <price>` or `Ask <price>` hint above the price input.

## Driving it with verify-tape

Preconditions:

- Baseline from `features/README.md`, on `/binance/BTC?interval=1m` (tick 0.01, step 0.00001).
- The ticket shows its form, not `Loading market rules…`. Run `vt wait --panel "Order ticket" --text "read only in Tape"`.
- The book is live. Run `vt wait --js "document.querySelector('section div[data-status]')?.dataset.status === 'live'"`.

- **Starting state.** Run `vt aria --panel "Order ticket" --path ticket/01-start.aria.txt`. `button "buy" [pressed]`, `radio "Limit" [checked]`, Notional `—`, Wallet USDC `Not connected`, and the read only paragraph. No `Buy BTC` button.
- **Too many decimals.** Run `vt fill --panel "Order ticket" --role textbox --name "Price (USDT)" --value 1.234 --blur`. The panel shows `At most 2 decimals` and the input has `aria-invalid="true"`. Check with `vt attr --panel "Order ticket" --role textbox --name "Price (USDT)" --attr aria-invalid`.
- **Not a number.** Fill the price with `abc`. The panel shows `Not a number`.
- **Size below step.** Run `vt fill --panel "Order ticket" --role textbox --name Size --value 0.000001 --blur`. The panel shows `At most 5 decimals`. Fill `0` and the panel shows `Minimum is 0.00001`.
- **Bid hint.** Run `vt click --panel "Order ticket" --text "Bid "`, then `vt attr --panel "Order ticket" --role textbox --name "Price (USDT)" --attr value`. The price is the best bid.
- **Market.** Run `vt click --panel "Order ticket" --role radio --name Market --exact`. The price input is gone, `Max slippage` shows `1%` checked, and Notional is a number in `USDT` once a size is filled.
- **Propose from trades.** Switch back to `Limit`, then run `vt click --panel Trades --css "button"` and read the price input. It equals the first trade row's price without separators.
- **Off tick on a coarse market.** On `/hyperliquid/BTC?interval=1m`, read the tick from a book price, then fill a price between two ticks. The panel shows `Price must be a multiple of <tick>`. Hyperliquid's tick depends on the price (5 significant figures).
- **Scale.** On a trading venue with a connected wallet, run `vt click --panel "Order ticket" --role radio --name Scale --exact`, fill `Start price`, `End price`, `Size skew` and `Total size (BTC)`, then `vt wait --panel "Order ticket" --role list --name "Scale orders"`. The list has `Orders` rows whose sizes sum to the total. `Orders` above the venue limit shows `From 2 to <limit>`. `Time in force` has no `Immediate or cancel`.
- **Network.** On a mainnet build at `/hyperliquid/BTC?interval=1m`, the ticket and the `Account` panel say `Mainnet is read only in Tape.` Build with `VITE_TESTNET_SITE=https://tape.testnet.kegler.dev vt up` to check the link with `vt attr --panel "Order ticket" --role link --name testnet --attr href`. On `vt up --network testnet` the ticket header says `Testnet`.
- **Proof.** Run `vt aria --panel "Order ticket" --path ticket/02-after.aria.txt` and `vt shot --panel "Order ticket" --path ticket/02-after.png`.

## Gotchas

- The price textbox is named after its quote, such as `Price (USDT)`. The hint is a separate button, matched with `--text "Bid "` or `--text "Ask "`.
- The side buttons' text is lowercase in the DOM (`buy`, `sell`) and capitalized by CSS. Match with `--exact` on the lowercase name.
- Errors only show after the field is touched. Pass `--blur` to `fill`, or click submit.
- With a `group` in the URL, the book rows are grouped but the `Bid` and `Ask` hints stay on the exact touch.
- Quote currency depends on venue: `USDT` on Binance, `USDC` on Hyperliquid and Orderly, `USD` on dYdX.
- Mainnet trading needs `VITE_TRADE_MAINNET=1` at build time. The harness build has it off, so mainnet is never sendable here.
- The ticket resets when the market or the wallet changes, because it remounts on each.
- `Scale` and `Trailing stop` only show once the wallet is connected, because the venue's capabilities come with the session.
- With TP/SL open the ticket is taller than the panel. The panel scrolls, and `vt click` scrolls to its target.
