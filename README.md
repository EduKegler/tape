# Tape

Live order books for BTC, ETH and SOL on Binance, Hyperliquid and dYdX. Read-only. Built with TanStack Start on TanStack Redact.

Demo: [tape.kegler.dev](https://tape.kegler.dev)

![Tape showing the BTC book on Hyperliquid](docs/screenshot.png)

The screen has an order book with price grouping, a trade feed, a depth chart, candles, a venues table with best bid, best ask and basis, and an order ticket that validates price and size against each venue's tick and step. A wallet connects read-only and shows USDC on Ethereum, Arbitrum, Base and Optimism. Nothing is ever signed or sent.

## Four decisions

### 1. One WebSocket per venue, shared across tabs

A SharedWorker hub owns the sockets. Each tab sends its full want set, for example "the BTC book on Binance grouped by 1". The hub derives the streams it needs from all tabs, counts references, and keeps a stream for 10 s after the last tab lets go, so switching BTC to ETH and back skips a resync.

SharedWorker ports never fire a close event. Each tab holds a Web Lock named after its id, and the hub asks for the same lock. The browser grants it when the tab dies, and the hub drops that tab's wants. `pagehide` sends a goodbye as the fast path.

Reconnects go through a pure state machine in `src/hub/connection.ts`: backoff with jitter, a silence watchdog, keepalive and resubscribe. A venue that accepts the socket and drops it at once keeps backing off, and a book that keeps failing to parse waits out a doubling hold instead of resubscribing in a loop. The status bar shows the hub's own numbers. Open a second tab and it reads `Tabs 2 · Sockets 3`.

Chrome Android has no SharedWorker. There each tab runs the same hub in a dedicated worker, so you get one socket per venue per tab. `?hub=dedicated` forces that mode anywhere.

### 2. Order book render without jank

The hub does the work off the main thread: book sync, grouping, formatting, cumulative totals and depth bar ratios. It ships render-ready frames at most every 100 ms per topic, throttled with TanStack Pacer. Hidden tabs get no frames.

The tab keeps only the latest frame per topic and flushes once per animation frame inside a TanStack Store batch. The book has 28 fixed rows keyed by index, so DOM nodes never move. Each row subscribes to its own slice with a shallow compare. The depth bar is a `scaleX` transform, the depth chart is a canvas, and candles go straight to `series.update`. None of those three render React.

Measured in headless Chrome on 2026-10-28, 20 s per market:

| Market | Venue messages in | Book flushes | Rows touched per flush | Long tasks |
| --- | --- | --- | --- | --- |
| Binance BTC | 564/s | 176 | 25 of 28 | 0 |
| dYdX ETH | 333/s | 163 | 27 of 28 | 0 |

In a busy book most rows change every flush, because a new level shifts every cumulative total below it. The win is the cap on how often the DOM is touched, not skipping rows.

### 3. Decimals, not floats

Prices and sizes parse into safe integers at each market's scale, branded as `Px` and `Qty` in `src/core/fixed.ts`. The parser rejects digits beyond the scale and values past `Number.MAX_SAFE_INTEGER` instead of rounding. Notional and spread run in `bigint`. Tick and step checks in the ticket are integer modulo.

Floats exist only in display data: chart coordinates, depth bar ratios, the basis column, candle history and the 24h stats line in the header. Prices in the book, the trade feed, the ticket and the venues table are exact, and best bid and ask across venues compare rescaled integers. Inside the data path, `toDisplayFloat` is the one exit.

Integers instead of `bigint` everywhere keep book levels fast as `Map` keys and in sorts. A BTC price at 8 decimals is about 8e12, far from the safe limit.

### 4. One model for three protocols

| Venue | Market | Book feed | What it needs |
| --- | --- | --- | --- |
| Binance | spot | REST snapshot plus sequenced diffs | Buffer diffs, fetch the snapshot after the first diff, replay, refetch on a gap |
| Hyperliquid | perps | Full 20-level snapshot every message | Tick is 5 significant figures, so it depends on the price |
| dYdX v4 | perps | Snapshot on subscribe, then deltas | The indexer book can cross, so a fresher write evicts the stale side, and a corrupt book resubscribes |

Each venue is one adapter behind `VenueAdapter` in `src/venues/types.ts`: market rules, subscribe frames, a parser from raw messages to one event type, 24h stats and candle history. Everything after the parser is venue-agnostic. One pure function, `stepBook` in `src/core/book.ts`, runs all three book protocols. A fourth venue is one adapter file plus recorded fixtures.

The tests replay frames recorded from each venue in `src/venues/__fixtures__` until each book is live and uncrossed. `pnpm fixtures` records fresh ones.

## Stack

- TanStack Start on TanStack Redact, the alternative React runtime
- TanStack Router with typed params and validated search, Query for market rules, stats and candle history, Store, Pacer, Virtual for the trade feed, Form for the ticket, Table v9 for the venues table
- wagmi and viem for the read-only wallet
- lightweight-charts for candles
- Tailwind 4, TypeScript strict with `noUncheckedIndexedAccess`, Vitest

## Limits

- Chrome Android falls back to one socket per venue per tab.
- Tab death through Web Locks is verified in Chrome. Safari and Firefox support Web Locks, but this path is not tested there yet.
- Hyperliquid sends 20 levels per side, so wide grouping shows fewer rows.
- The ticket checks tick and step, not each venue's minimum order value.
- Market data only, from public endpoints. Binance comes from the `data-api.binance.vision` mirrors.

## Run it

```bash
pnpm install
pnpm dev
```

```bash
pnpm verify   # typecheck and tests
pnpm build
pnpm fixtures # re-record venue fixtures
node scripts/capture.mjs # screenshot and social preview from a running preview server
```

## Layout

```
src/core     domain: ids, fixed point, market rules, book sync, frames
src/venues   one adapter per venue, plus recorded fixtures
src/hub      the worker: sockets, connection state machine, projections
src/client   the tab side: hub connection, store registry, hooks
src/ui       screen components
src/wallet   wagmi config and the read-only wallet
```
