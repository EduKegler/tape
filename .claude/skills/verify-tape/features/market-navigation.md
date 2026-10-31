# Market navigation

A user picks any market a venue lists on one of four venues (Binance, Hyperliquid, dYdX, Orderly), from the `Market` nav or the header search. Hyperliquid's HIP-3 markets carry their dex, as in `xyz:TSLA`. The route is `/$venue/$base`, the page title follows it, and `interval` and `group` ride along in the URL. `/` redirects to Hyperliquid BTC. An unknown venue or a name no venue could list shows `Not Found`. A market the venue does not list says so.

## Sub-features

- `nav-root` redirects `/` to `/hyperliquid/BTC?interval=1m`.
- `nav-market` switches base from the `Market` nav and keeps the venue and search params. The nav holds BTC, ETH, SOL and the current market.
- `nav-search` filters the venue's markets in `Search markets` as the user types, Hyperliquid's grouped by dex, and opens one with the arrows and Enter. A query with no match shows `No market matches`.
- `nav-venue` switches venue from the `Venue` nav and keeps the base and search params.
- `nav-compare` switches venue by clicking a row in the `Venues` table.
- `nav-interval` switches the chart interval from the `Interval` radio group and writes `interval=<i>`.
- `nav-title` sets the title to `<BASE> on <Venue> · Tape`.
- `nav-404` shows `Not Found` for an unknown venue or a name no venue could list.
- `nav-unlisted` shows `<BASE> is not listed on <Venue>` for a market the venue does not list, and the `Venues` table shows `Not listed` on each venue that does not list the market.

## How to get to it (user POV)

- Type a URL, such as `/dydx/SOL?interval=15m`.
- Click `BTC`, `ETH` or `SOL` in the header.
- Type in `Search markets` in the header.
- Click `Binance`, `Hyperliquid` or `dYdX` in the header.
- Click a row in the `Venues` panel.
- Click `1m`, `5m`, `15m` or `1h` in the `Chart` panel header.

## Driving it with verify-tape

Preconditions:

- Baseline from `features/README.md`.

- **Root redirect.** Run `vt open "/"` and `vt wait --url "/hyperliquid/BTC\\?interval=1m"`. `vt eval "document.title"` returns `BTC on Hyperliquid · Tape`.
- **Market nav.** Run `vt click --nav Market --role link --name ETH --exact` and `vt wait --url "/hyperliquid/ETH"`. Run `vt aria --nav Market`. `link "ETH"` is the current page.
- **Search.** Run `vt fill --role combobox --name "Search markets" --value doge`, `vt press --key Enter` and `vt wait --url "/hyperliquid/DOGE"`. `vt aria --nav Market` lists `link "DOGE"` as the current page.
- **Venue nav.** Run `vt click --nav Venue --role link --name Binance` and `vt wait --url "/binance/ETH"`. The title is `ETH on Binance · Tape`.
- **Interval.** Run `vt click --role radio --name 5m --exact` and `vt wait --url "interval=5m"`. `vt aria --panel Chart` shows `radio "5m" [checked]`.
- **Venues table.** Run `vt click --panel Venues --role row --name dYdX` and `vt wait --url "/dydx/ETH"`. The URL keeps `interval=5m`.
- **Params survive.** After the steps above the URL still carries `interval` and any `group` set before. Check with `vt eval "location.search"`.
- **Unknown route.** Run `vt open "/kraken/BTC"` and `vt text`. The body text is `Not Found` and the title is `Tape`.
- **Unlisted market.** Run `vt open "/hyperliquid/NOTAMARKET"` and `vt text --role heading --name NOTAMARKET`. It reads `NOTAMARKET is not listed on Hyperliquid`.
- **Proof.** Run `vt aria --css header --path nav/header.aria.txt` and `vt shot --path nav/page.png` on the final market.

## Gotchas

- Venue links are named `<Venue> <chain>`, such as `Binance Spot` and `Hyperliquid Hyperliquid L1`. Match without `--exact`.
- `Market` is also the name of the ticket's order type radio. Scope with `--nav Market` or `--panel "Order ticket"`.
- A `group` carried from one venue can be invalid on another. The book then falls back to its own options. Clear it with a fresh `open` when the recipe needs the default.
- Base in the URL is case sensitive, since Hyperliquid lists `kPEPE`. `/hyperliquid/btc` says `btc is not listed on Hyperliquid`.
- With the search list open, Base UI marks the rest of the page `aria-hidden`. Run axe and `vt aria` with the list closed.
- The `Not Found` page still holds a hub connection, so it counts in `Tabs`.
