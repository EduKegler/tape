# Glossary

The words Tape's code, docs and screens share. Why the parts work the way they do is in the [overview](overview.md), not here.

## Venues and markets

| Term | Meaning |
| --- | --- |
| Venue | One exchange Tape reads, a `VenueId` in `packages/core/src/ids.ts`: `binance`, `hyperliquid`, `dydx` or `orderly`. Its market data comes through a `VenueAdapter` in `packages/venues`, and its trading, where it has any, through a `TradingVenue` in `packages/trade`. |
| Network | `mainnet` or `testnet`. Each build serves one network, set by `VITE_NETWORK`. |
| Read-only venue | A venue the build sends no orders on: Binance always, and on a mainnet build each venue `VITE_TRADE_MAINNET` leaves out. `sendsOrders` in `src/trade/config.ts` decides it. Its tab says `Read only` and its ticket has no form. It still shows market data and history. |
| Base | The venue's own name for what a market trades, such as `BTC`, `kPEPE` or Hyperliquid's HIP-3 `xyz:TSLA`. Case matters. |
| Market | One base on one venue, keyed by a `MarketKey` such as `hyperliquid:BTC`. The same base on the four venues is four markets. |
| Market rules | A market's `MarketSpec` in `packages/core/src/market.ts`: its scale, tick, step, quote and minimum notional. The ticket says `Market rules unavailable.` when they cannot be read. |
| Tick | The smallest price increment. Binance, dYdX and Orderly publish a fixed tick. Hyperliquid allows 5 significant figures, so its tick depends on the price. |
| Step | The smallest size increment, `MarketSpec.step`. |
| Group | The price step the book is grouped by, a multiple of the tick picked from the book's menu. Bids floor to it and asks ceil to it. |
| Px and Qty | A price and a size as safe integers at the market's scale, branded types in `packages/core/src/fixed.ts`. Floats appear only in display data. |
| Touch, mid, basis | The best bid and ask, the price halfway between them, and how far one venue's mid sits from the median mid of the venues, in basis points. |

## Hub and frames

| Term | Meaning |
| --- | --- |
| Hub | The worker that owns the venue sockets for every tab, syncs the books and sends frames, built by `createHub` in `src/hub/hub.ts`. It runs as a SharedWorker, or as a dedicated worker per tab where the browser has no SharedWorker. |
| Tab | One page connected to the hub, with its own `TabId`. The hub drops its wants when the tab's Web Lock is released. |
| Topic | One thing a tab shows, a `Topic` in `src/core/topics.ts`: a market's book at a group, its depth, its trades, its candles at an interval, or one base compared across venues. |
| Want | A tab's full set of topics, sent whole in a `want` message each time it changes. |
| Stream | One venue channel for one market that the hub subscribes to on a socket, a `StreamKey` such as `binance:BTC:book`. The hub derives the streams from every tab's wants, so several topics and tabs share one stream. A stream lingers 10 s after the last want lets go. |
| Frame | The render-ready data for one topic that the hub sends to the tabs, at most every 100 ms, with a version, a status and the time it was last live. |
| Projection | The pure step in `src/core/project.ts` that turns the hub's state for a market into the frame for a topic. |
| Book sync | How the hub keeps a venue's book in step with the venue, `stepBook` in `packages/core/src/book.ts`, one function for the three book protocols. |

## Freshness

A frame's status says whether its data still follows the venue. `panelState` in `src/ui/panel-state.ts` turns that status, the frame's age and the hub's socket count into the line beside a panel's title.

| Term | Meaning |
| --- | --- |
| Live | The data follows the venue. The panel shows no status line. |
| Syncing | The hub is building a book from the venue. Before the first live frame the panel says `Loading…`, and a resync after one says `Reconnecting`. |
| Old data | Data that stopped following the venue and stays on screen, in amber with its age, such as `Reconnecting · 4 s old`. The code calls this state `stale`, in `FrameStatus` and in `PanelState.data`, and the screen says `old`. The book, the depth and the ticket's price hint also turn old on an open socket after 15 s with no update, and say `No updates`. |
| Reconnecting | The venue's socket is down, or a book that was live is resyncing, and the hub is getting it back. With no socket open at all the panel says `Offline`. |
| Late snapshot | A Binance REST snapshot that comes back after the book was reset, so it belongs to an earlier sync. `stepBook` drops it by its epoch. It is not old data, which is about what the screen shows. |

## Trading

| Term | Meaning |
| --- | --- |
| Client id | The id Tape puts on each order it sends, `ClientOrderId` in `packages/trade/src/types.ts`. A send never repeats itself, and the client id is how Tape finds out later whether an order went in. |
| Unknown outcome | A write that got no answer Tape can read: a 5xx, a timeout or an unreadable reply. Its error is `unknown-outcome`, the screen says `No answer`, and Tape asks the venue for the order by its client id. |
| Unreachable | A read that failed the same ways. It means the venue could not be reached, never that the order or the account is missing. |
