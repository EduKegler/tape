# How Tape works

Six design decisions behind Tape, and the stack it runs on.

## 1. One WebSocket per venue, shared across tabs

A SharedWorker hub owns the sockets. Each tab sends its full want set, for example "the BTC book on Binance grouped by 1". The hub derives the streams it needs from all tabs, counts references, and keeps a stream for 10 s after the last tab lets go, so switching BTC to ETH and back skips a resync.

SharedWorker ports never fire a close event. Each tab holds a Web Lock named after its id, and the hub asks for the same lock. The browser grants it when the tab dies, and the hub drops that tab's wants. `pagehide` sends a goodbye as the fast path.

Reconnects go through a pure state machine in `src/hub/connection.ts`: backoff with jitter, a silence watchdog, keepalive and resubscribe. A venue that accepts the socket and drops it at once keeps backing off, and a book that keeps failing to parse waits out a doubling hold instead of resubscribing in a loop. The status bar shows the hub's own numbers. Open a second tab and it reads `Tabs 2 · Sockets 4`.

Chrome Android has no SharedWorker. There each tab runs the same hub in a dedicated worker, so you get one socket per venue per tab. `?hub=dedicated` forces that mode anywhere.

## 2. Order book render without jank

The hub does the work off the main thread: book sync, grouping, formatting, cumulative totals and depth bar ratios. It ships render-ready frames to each tab at most every 100 ms, throttled with TanStack Pacer. Hidden tabs get no frames.

The tab keeps only the latest frame per topic and flushes once per animation frame inside a TanStack Store batch. The book has 28 fixed rows keyed by index, so DOM nodes never move. Each row subscribes to its own slice with a shallow compare. The depth bar is a `scaleX` transform, the depth chart is a canvas, and candles go straight to `series.update`. None of those three render React.

In a busy book most rows change every flush, because a new level shifts every cumulative total below it: 25 to 27 of the 28 rows on Binance BTC and dYdX ETH. The win is the cap on how often the DOM is touched, not skipping rows.

## 3. Decimals, not floats

Prices and sizes parse into safe integers at each market's scale, branded as `Px` and `Qty` in `packages/core/src/fixed.ts`. The parser rejects digits beyond the scale and values past `Number.MAX_SAFE_INTEGER` instead of rounding. Notional and spread run in `bigint`. Tick and step checks in the ticket are integer modulo.

Floats exist only in display data: chart coordinates, depth bar ratios, the basis column, candle history and the 24h stats line in the header. Prices in the book, the trade feed, the ticket and the venues table are exact, and best bid and ask across venues compare rescaled integers. Inside the data path, `toDisplayFloat` is the one exit.

Integers instead of `bigint` everywhere keep book levels fast as `Map` keys and in sorts. A BTC price at 8 decimals is about 8e12, far from the safe limit.

## 4. One model for three protocols

| Venue | Market | Book feed | What it needs |
| --- | --- | --- | --- |
| Binance | spot | REST snapshot plus sequenced diffs | Buffer diffs, fetch the snapshot after the first diff, replay, refetch on a gap |
| Hyperliquid | perps | Full 20-level snapshot every message | Tick is 5 significant figures, so it depends on the price |
| dYdX v4 | perps | Snapshot on subscribe, then deltas | The indexer book can cross, so a fresher write evicts the stale side, and a corrupt book resubscribes |
| Orderly | perps | Full snapshot every second | Numbers come as JSON numbers, so they are read from the source text, not as doubles |

Each venue is one adapter behind `VenueAdapter` in `packages/venues/src/types.ts`: market rules, subscribe frames, a parser from raw messages to one event type, 24h stats and candle history. Everything after the parser is venue-agnostic. One pure function, `stepBook` in `packages/core/src/book.ts`, runs all three book protocols. A new venue is one adapter file plus recorded fixtures.

The tests replay frames recorded from each venue in `packages/venues/src/__fixtures__` until each book is live and uncrossed.

## 5. Orders signed in the browser, judged by the venue

Tape has no server between the user and the venue. Each trading venue is one module behind `TradingVenue` in `packages/trade/src/types.ts`: setup steps, enable, account reads, commands and an order lookup.

| Venue | Setup | Signing |
| --- | --- | --- |
| Hyperliquid | The wallet approves an agent key, plus a builder fee when one is configured | The agent signs msgpack actions. The key stays on the device |
| dYdX v4 | The wallet signs dYdX's onboarding message, and the dYdX key derives from it | The key lives in the tab only, since it can withdraw |
| Orderly | The wallet registers the account and adds an ed25519 key | The key signs each request |

Every send gets a new client id and nothing resends on its own. A send with no answer is an unknown outcome: the ticket says so, asks the venue for that client id, and tells whether the order is there. A rejection always shows the venue's own words.

Deposits leave from the wallet itself, through the routes behind `DepositVenue` in `packages/trade/src/deposit.ts`: to Hyperliquid through its bridge from Arbitrum or, on mainnet, through Circle's CCTP from Base, OP Mainnet and Ethereum, and to Orderly through its Vault, which the wallet pays in ETH for the LayerZero message that credits the account. Before the wallet signs, the dialog shows the route, the fees, the time and each transaction, and blocks a deposit the venue would lose or the chain would revert, such as an amount under the bridge's 5 USDC minimum, which Hyperliquid keeps without crediting. After the send Tape follows the deposit to the credit and keeps the receipt on the device. Orderly serves its asset history only to a request signed by the account's key, so Tape follows an Orderly credit only on a device where trading is enabled. A deposit it cannot follow to the end stops at `Check manually`, with the Circle or LayerZero link and the transaction hash.

Each build is one network, set by `VITE_NETWORK`. A testnet build reads and trades on the testnets, so the price on screen is the price the order meets. A mainnet build trades only on the venues that `VITE_TRADE_MAINNET` names and only reads the others, whose ticket links to a venue that trades. [Deploy](deploy.md) lists every build variable.

The production server sends a Content Security Policy with a nonce per request. Only scripts the server rendered run, and the page connects only to its own network's hosts, listed in `src/csp.ts`, plus Circle's API for CCTP fees and status on mainnet. A new venue host goes there, and `src/csp.test.ts` fails until it does. `pnpm dev` sends no policy, because Vite's dev client injects inline scripts.

Analytics run no third-party script. The page sends events from the fixed list in `src/analytics/events.ts` with `sendBeacon` to `/r1` on its own origin, and the Worker forwards them to PostHog. Events make no person profile and carry no wallet address, and [Deploy](deploy.md) says how the Worker keys them.

Errors take the same route to PostHog error tracking, with stacks and messages cleared of addresses and keys. An uncaught error with no frame on the site's own origin, like one from a wallet extension, stays on the page, and each JS context sends 10 at most.

## 6. History that adds up to the venue's number

Each trading venue also reads its full history from a public endpoint, with no key: Hyperliquid's `userFillsByTime` and `userFunding`, dYdX's indexer `fills` and `fundingPayments`, and Orderly's public query. History is only reads, so it works on the read-only mainnet site and for any address pasted in.

Realized PnL per fill is the venue's own figure where it reports one, Hyperliquid's `closedPnl` and Orderly's `realized_pnl`. dYdX reports none, so `realize` in `packages/trade/src/history.ts` computes it by average cost: increases average the entry, reductions realize against it, and a flip closes everything before it opens the rest. Amounts are `bigint` at 18 places, so sums of venue decimals are exact. Fees and funding stay apart from realized PnL, and net is realized minus fees plus funding.

The tests replay recorded history of public mainnet accounts in `packages/trade/src/__fixtures__` and check the result against each venue's own numbers: average cost reproduces Hyperliquid's `closedPnl` on every fill of one account and Orderly's `realized_pnl` on every fill of another. The net lands within cents of Hyperliquid's perp PnL chart, which samples every 15 minutes and rounds to cents, and on dYdX's `totalPnl` to the micro dollar. The CSV columns are under [History CSV](history-csv.md).

## Stack

- TanStack Start on React 19
- Nitro's `cloudflare-module` preset, one Cloudflare Worker per network
- TanStack Router with typed params and validated search, Query for market rules, stats and candle history, Store, Pacer, Virtual for the trade feed, Form for the ticket, Table v9 for the venues table
- wagmi and viem for the wallet, the dYdX client for its chain, msgpack and noble curves for Hyperliquid and Orderly signing
- lightweight-charts for candles
- Tailwind 4, TypeScript strict with `noUncheckedIndexedAccess`, Vitest

