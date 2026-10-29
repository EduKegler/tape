# Live panels

Around the book, four panels stream live data: the header ticker with last price, 24h change, volume and, on perps, funding and index; the `Trades` feed; the `Depth` chart of cumulative bids and asks; and the `Chart` panel with candles and volume. Depth and candles draw on canvas, so their proof is a screenshot plus a non-empty state check.

## Sub-features

- `live-ticker` shows a last price and 24h stats in the header. Perps also show `Funding 1h` and `Index`.
- `live-trades` lists recent trades with price, size and local time, newest first.
- `live-depth` draws two stepped areas and the low and high price labels.
- `live-candles` loads candle history and keeps updating the last bar.

## How to get to it (user POV)

- Open any market page. The ticker is in the header, `Trades` is the third column, `Depth` sits under `Chart`.
- Change `Interval` in the `Chart` header to reload candle history.

## Driving it with verify-tape

Preconditions:

- Baseline from `features/README.md`, on `/hyperliquid/BTC?interval=1m`.
- The book is live. Run `vt wait --js "document.querySelector('section div[data-status]')?.dataset.status === 'live'"`.

- **Ticker.** Run `vt text --css "header dl"`. It has `Last price` (screen reader only) with a price, `24h`, `Volume`, `Funding 1h` and `Index`. On `/binance/BTC` the last two are absent, since Binance is spot.
- **Trades.** Run `vt wait --panel Trades --text "Waiting for trades" --state hidden`, then `vt text --panel Trades`. Rows read `<price> <size> <hh:mm:ss>`. Run it again a few seconds later and the first row changes on a busy market.
- **Depth.** Run `vt wait --js "(() => { const c = document.querySelector('canvas[aria-label=\"Cumulative order book depth\"]'); return c && c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v) })()"`. Then `vt shot --panel Depth --path live/depth.png`. Green area on the left, red on the right, two price labels at the bottom.
- **Candles.** Run `vt wait --panel Chart --text "Could not load history" --state hidden` and `vt shot --panel Chart --path live/candles-1m.png`. Click `vt click --role radio --name 1h --exact` and take `live/candles-1h.png`. The bars are wider apart in time.
- **Proof.** Run `vt shot --path live/page.png`. All four panels show data.

## Gotchas

- Depth is a canvas with `role="img"` and an accessible name, but its content is pixels. The ARIA snapshot only proves it exists.
- The chart has no accessible content. Prove it with screenshots and the absence of `Could not load history.`.
- Trades are virtualized. Only the visible rows are in the DOM.
- The trade clock is local time. The chart's time axis is UTC, so the two disagree by the machine's offset.
- Hidden tabs get no frames. A tab you are not looking at in headless Chrome is still visible, so this does not bite here.
