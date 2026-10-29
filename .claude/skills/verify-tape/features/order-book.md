# Order book

The order book shows 28 ask rows above a spread line and 28 bid rows below it, each with price, size and cumulative total and a depth bar. A user can group prices into wider buckets from the `Group` select, and clicking a level puts its price into the order ticket.

## Sub-features

- `book-live` reaches a live, uncrossed book with a spread line after load.
- `book-group` regroups the book from the `Group` select and writes `group=<n>` into the URL.
- `book-group-url` restores the grouping from a URL that already has `group=<n>`.
- `book-click` puts a clicked level's price into the ticket's limit price.
- `book-status` shows `Syncing…` before data and `Reconnecting…` when the feed goes stale.

## How to get to it (user POV)

- Open any market, such as `/hyperliquid/BTC?interval=1m`. The book is the second column, titled `Order book`.
- Choose a value in the `Group` select in the panel header.
- Open a URL with `group=<n>`, such as `/binance/ETH?interval=1m&group=1`.
- Click any filled row in the book.

## Driving it with verify-tape

Preconditions:

- Baseline from `features/README.md`. `doctor` reports the venue under test as reachable.
- The current tab is on `/hyperliquid/BTC?interval=1m`.

- **Live book.** Wait for data. Run `vt wait --js "document.querySelector('section div[data-status]')?.dataset.status === 'live'"`. Then run `vt text --panel "Order book" --css "div[data-status] > div:nth-of-type(3)"`. The text has a mid price and `Spread <x> · <y> bps`.
- **Before grouping.** Run `vt aria --panel "Order book" --path order-book/01-group-1.aria.txt` and `vt shot --panel "Order book" --path order-book/01-group-1.png`. The snapshot shows `combobox "Group"` with option `1` selected and row buttons named `<price> <size> <total>`.
- **Group options.** Run `vt text --panel "Order book" --role combobox --name Group`. On Hyperliquid BTC near 80,000 the options are `1 2 5 10 25 50`. Options depend on venue and price. Pick one from this list for the next step.
- **Group by 10.** Run `vt select --panel "Order book" --role combobox --name Group --value 10` and `vt wait --url "group=10"`. The URL now has `group=10`.
- **Grouped prices.** Run `vt wait --js "document.querySelector('section div[data-status]')?.dataset.status === 'live' && [...document.querySelectorAll('section div[data-status] button span:nth-child(2)')].filter(s => s.textContent).every(s => Number(s.textContent.replaceAll(',', '')) % 10 === 0)"`. It returns at once when every shown price is a multiple of 10.
- **After grouping.** Run `vt aria --panel "Order book" --path order-book/02-group-10.aria.txt` and `vt shot --panel "Order book" --path order-book/02-group-10.png`. Option `10` is `[selected]` and every row name starts with a multiple of 10.
- **Grouping from the URL.** Run `vt open "/hyperliquid/BTC?interval=1m&group=10"`, wait for `live` as above, then `vt aria --panel "Order book" --role combobox --name Group`. Option `10` is `[selected]` on first paint.
- **Click a level.** Run `vt text --panel "Order book" --css "div[data-status] > div:nth-of-type(4) button:first-child"` to read the best bid, then `vt click --panel "Order book" --css "div[data-status] > div:nth-of-type(4) button:first-child"` and `vt eval "document.querySelector('input[name=price]').value"`. The ticket price is the clicked price without thousands separators, and a multiple of 10.
- **Proof.** Run `vt aria --panel "Order ticket" --path order-book/03-ticket-after-click.aria.txt` and `vt shot --path order-book/04-page.png`. The ticket's price textbox holds the clicked price and the book still shows `group=10` rows.

## Gotchas

- `[data-status]` alone matches header links, which carry `data-status="active"`. Use `section div[data-status]`.
- Rows are plain buttons with no per-side label. Asks are `div[data-status] > div:nth-of-type(2)`, the spread line is `nth-of-type(3)`, bids are `nth-of-type(4)`. The best bid is the first button of the bids block, the best ask is the last button of the asks block. This is position-based, so recheck it if `src/ui/OrderBook.tsx` changes.
- Empty rows are buttons with no name. Filter on text before asserting on rows.
- Hyperliquid sends 20 levels per side, so wide grouping leaves only a few filled rows. That is documented in the README, not a bug.
- The group value in the URL is a number. `group=0.1` is valid on markets with decimal prices.
- `book-status` stale and syncing states need a venue outage to observe on purpose. There is no switch for it. Report it as not driven unless the outage happens.
- The ticket ignores a book click that happened before the ticket mounted. Wait for `live` before clicking.
