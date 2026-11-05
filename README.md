# Tape

Live order books from Binance, Hyperliquid, dYdX and Orderly on one screen, with order entry on Hyperliquid, dYdX and Orderly. Your browser signs each order and sends it straight to the venue. No server sits in between.

![Tape showing the BTC book on Hyperliquid](docs/screenshot.png)

Try it at [tape.kegler.dev](https://tape.kegler.dev), which trades on Hyperliquid mainnet with real funds and only reads the other venues, or at [tape.testnet.kegler.dev](https://tape.testnet.kegler.dev), which trades on the testnets.

Tape is for a perps trader who trades on more than one venue and wants the books, the best price and their positions on one screen.

## What it does

- An order book with price grouping, a trade feed, a depth chart and candles for each market.
- A venues table that compares best bid, best ask and basis across the four venues.
- An order ticket that checks price and size against each venue's tick and step. It sends limit, market and scale orders. On Hyperliquid it also sends trailing stops, and take profit and stop loss with the order.
- An Account panel with positions, orders and fills, where a position gets a take profit, a stop loss or a close.
- USDC deposits from the wallet to Hyperliquid and Orderly, and withdrawals from Hyperliquid to Arbitrum.
- A History page that totals realized PnL, fees and funding on the three trading venues, and exports a [CSV](docs/history-csv.md).

The markets are Binance's USDT spot pairs and the perps that Hyperliquid, dYdX and Orderly list, Hyperliquid's USDC HIP-3 dexes included. Orders go to Hyperliquid's main dex only. Orderly's Community Listed markets stay out, and so do markets whose tick or step needs more than 8 decimals, such as dYdX PEPE-USD.

## Status

| Venue | Books | Testnet trading | Mainnet trading | Deposits |
| --- | --- | --- | --- | --- |
| Binance | Spot | No | No | No |
| Hyperliquid | Perps | Yes | On at tape.kegler.dev, verified with real funds on a local build | From Arbitrum, Base, OP Mainnet and Ethereum |
| dYdX | Perps | Yes | Not verified, off | No |
| Orderly | Perps | Yes | Not verified, off | From Arbitrum, Base and OP Mainnet |

A mainnet build with Hyperliquid turned on ran these with real funds on 2026-11-02: a deposit through Hyperliquid's Arbitrum bridge and one through CCTP from Base, enable trading, limit, market, scale and trailing orders, take profit and stop loss, a leverage change, a close and a withdrawal. dYdX and Orderly trading was verified on the testnets with an unfunded wallet, so the proof is each venue naming the signer it recovered. Orderly orders past registration are not verified.

The other deposit routes were never sent with real funds. Their proof is the transaction the wallet was asked for. Following an Orderly credit needs the depositor's own key, so it was checked only against the reply in Orderly's docs.

### Limits

- dYdX and Orderly take no take profit or stop loss with the order, only on an open position. Neither takes a trailing stop. dYdX takes no scale order and no leverage change.
- The ticket refuses an order worth less than the venue minimum on Hyperliquid and Orderly, each scale leg too. Reduce-only orders, closes of a whole position and take profit and stop loss legs go to the venue unchecked.
- Hyperliquid sends 20 levels per side, so wide grouping shows fewer rows.
- History has no deposits, withdrawals, transfers or vaults. Hyperliquid serves only its 10,000 most recent fills, dYdX's indexer pages through 25,000 fills, and only dYdX subaccount 0 is read.
- Deposit gas shows in the chain's native token, without USD.
- Market data comes from public endpoints. Binance comes from the `data-api.binance.vision` mirrors.
- Chrome Android has no SharedWorker, so it opens one socket per venue per tab.
- Tab death through Web Locks is verified in Chrome. Safari and Firefox support Web Locks, but this path is not tested there yet.

## Run it

You need Node 24 and pnpm 10.

```bash
pnpm install
pnpm dev
```

That serves a mainnet build on port 3000, which only reads. For a build that trades on the testnets:

```bash
VITE_NETWORK=testnet pnpm dev
```

The build variables are in [docs/deploy.md](docs/deploy.md).

## How it works

A SharedWorker keeps one socket per venue for every open tab, syncs the books off the main thread and sends each tab render-ready frames. Prices and sizes are exact decimals, never floats. Each venue is one adapter for market data and one module for trading, tested against frames recorded from the venue. [How Tape works](docs/architecture.md) covers the six decisions behind that, and the stack: TanStack Start on TanStack Redact, deployed as a Cloudflare Worker.

Analytics and errors go through the site's own `/r1` route to PostHog. No third-party script loads, and no event carries a wallet address.

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the commands and the rules a change follows.

## Security

Report a vulnerability in private, as [SECURITY.md](SECURITY.md) explains. Do not open a public issue for it.

## Disclaimer

Tape is an interface to the venues. It holds none of your funds and is not affiliated with Binance, Hyperliquid, dYdX or Orderly. A build can add a builder fee to Hyperliquid and dYdX orders. On Hyperliquid the site's Terms page shows the fee, and the wallet approves it before the first order. Trading perps can lose you money. You use Tape at your own risk, without warranty, as the license says.

## License

[MIT](LICENSE)
