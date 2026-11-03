# History CSV

`/history` exports what the filters show: one row per fill and one per funding payment, oldest first. The file is RFC 4180 with CRLF line ends, UTF-8, and a header row. Columns keep their names and order. A new column goes at the end.

Amounts are exact decimals with a dot and no grouping, as the venue sent them, except `notional` and a computed `realized_pnl`. An empty cell means the column does not apply to that row.

| Column | Fill | Funding |
| --- | --- | --- |
| `time_utc` | ISO 8601 in UTC, to the millisecond | same |
| `timestamp_ms` | Unix time in milliseconds | same |
| `venue` | `hyperliquid`, `dydx` or `orderly` | same |
| `network` | `mainnet` or `testnet` | same |
| `account` | The venue account: the wallet on Hyperliquid, the `dydx1` address on dYdX, the account id on Orderly | same |
| `type` | `fill` | `funding` |
| `market` | The venue's symbol, like `BTC`, `BTC-USD` or `PERP_BTC_USDC` | same |
| `side` | `buy` or `sell` | empty |
| `size` | Filled size, always positive | Position size when funding settled, negative for a short |
| `price` | Fill price | empty |
| `notional` | `price` × `size`, exact | empty |
| `fee` | Positive is paid, negative is a rebate | empty |
| `asset` | What the fee and the PnL settle in, usually `USDC` | What the payment settles in |
| `realized_pnl` | PnL this fill realized, before fees and funding. `0` on a fill that opens or adds | empty |
| `realized_pnl_source` | `venue` when the venue reports it, `computed` when Tape computed it by average cost | empty |
| `funding` | empty | Positive is received, negative is paid |
| `funding_rate` | empty | The rate the venue applied |
| `liquidation` | `true` when the venue closed the position: a liquidation, or a deleverage on dYdX | empty |
| `venue_id` | The venue's id for the fill | empty |

Net PnL over a period is the sum of `realized_pnl`, minus the sum of `fee`, plus the sum of `funding`, per `asset`.

## Per venue

- Hyperliquid reports `realized_pnl` on each fill. It serves only its 10,000 most recent fills, so an account with a long history starts partway, and `/history` says so. Spot fills are left out.
- dYdX reports no PnL per fill. Tape computes it by average cost from the first fill, rounded to 6 decimals. Subaccount 0 only. The indexer pages through 25,000 fills at most.
- Orderly reports `realized_pnl` on each fill. One address can hold an account per broker, and each one is its own `account`. Funding still accruing is left out until it settles.

Deposits, withdrawals, transfers and vault flows are not in the file.

