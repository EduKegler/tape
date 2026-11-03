# Tape

Live order books for Binance's USDT spot pairs and the perps Hyperliquid, dYdX and Orderly list, Hyperliquid's USDC HIP-3 dexes included, with order entry on Hyperliquid's main dex, dYdX and Orderly. Orderly's Community Listed markets and markets whose tick or step needs more than 8 decimals, such as dYdX PEPE-USD, stay out. Built with TanStack Start on TanStack Redact.

Demo: [tape.kegler.dev](https://tape.kegler.dev) reads mainnet. [tape.testnet.kegler.dev](https://tape.testnet.kegler.dev) trades on testnet.

![Tape showing the BTC book on Hyperliquid](docs/screenshot.png)

The screen has an order book with price grouping, a trade feed, a depth chart, candles, a venues table with best bid, best ask and basis, and an order ticket that validates price and size against each venue's tick and step. A wallet connects and shows USDC on Ethereum, Arbitrum, Base and Optimism. On Hyperliquid, dYdX and Orderly the ticket sends orders, and an Account panel shows positions, orders and fills. It deposits USDC to Hyperliquid from Arbitrum, Base, OP Mainnet or Ethereum, and to Orderly from Arbitrum, Base or OP Mainnet. Binance stays read only. A History page reads every fill and funding payment those three venues still serve, totals realized PnL, fees and funding, and exports a CSV.

See [How Tape works](docs/architecture.md) for the design and the stack.

## Limits

- Chrome Android falls back to one socket per venue per tab.
- Tab death through Web Locks is verified in Chrome. Safari and Firefox support Web Locks, but this path is not tested there yet.
- Hyperliquid sends 20 levels per side, so wide grouping shows fewer rows.
- The ticket refuses an order worth less than the venue minimum on Hyperliquid and Orderly, each scale leg too. Reduce-only orders, closes of a whole position and TP/SL legs go to the venue unchecked.
- Market data comes from public endpoints. Binance comes from the `data-api.binance.vision` mirrors.
- Trading was verified on testnets with an unfunded wallet, so the proof is each venue naming the signer it recovered. Orderly orders past registration and mainnet are not verified.
- No take profit or stop loss on dYdX and Orderly, and no leverage change on dYdX.
- Deposits go to Hyperliquid and Orderly only. Tape never sent one in verification: the proof is the transaction the wallet was asked for, and real Hyperliquid deposits by other wallets replayed through the receipt. Following an Orderly credit needs the depositor's own key, so it was checked only against the reply in Orderly's docs.
- Deposit gas shows in the chain's native token, without USD.
- History has no deposits, withdrawals, transfers or vaults. Hyperliquid serves only its 10,000 most recent fills, dYdX's indexer pages through 25,000 fills, and only dYdX subaccount 0 is read.

The History export is specified in [History CSV](docs/history-csv.md).

## Run it

```bash
pnpm install
pnpm dev
```

```bash
VITE_NETWORK=testnet pnpm dev
```

The commands, the layout and the rules for a change are in [CONTRIBUTING.md](CONTRIBUTING.md).
