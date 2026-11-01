# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

An active perps trader who trades on more than one venue. They keep Tape open beside the market, read the book and the tape for seconds at a time, and act on what they read: place an order, close a position, move USDC to a venue. The trader is the bar for every decision. A visitor who opens the demo to see the work comes second.

## Product Purpose

Tape puts the live books of Binance, Hyperliquid, dYdX and Orderly on one screen, with trades, depth, candles and a venues table that compares best bid, best ask and basis. On Hyperliquid, dYdX and Orderly the trader sends orders, reads positions, orders and fills, and deposits USDC. A History page totals realized PnL, fees and funding across those venues and exports a CSV.

Success is a trader who reads the market and acts on it in one screen, trusts every number on it, and wants to come back to it.

## Positioning

Tape has no server between the trader and the venue. One SharedWorker keeps one socket per venue for every tab, orders are signed in the browser and judged by the venue, and every price is an exact decimal, never a float. One screen reads four venues side by side and compares their prices, where each venue's own frontend shows only itself.

## Operating Context

- Desktop browser, beside charts, venue frontends and wallets. Sessions run for hours, and the eye returns to the screen many times a minute. Wide desktop is the primary screen. A phone is for watching a position and closing it, and needs no layout of its own yet.
- The book updates up to 10 times a second across 28 levels, and trades arrive in bursts.
- A wallet extension or WalletConnect signs setup, deposits and, on Hyperliquid, the agent key. The keys that sign orders stay on the device.
- Two builds: mainnet reads only unless the build turns trading on, and testnet trades on the testnets.

## Capabilities and Constraints

- Order types: limit, market and scale, with time in force, reduce only, and take profit and stop loss where the venue supports them. The ticket checks price and size against each venue's tick and step.
- A send with no answer is an unknown outcome. The ticket says so, asks the venue for the order by client id, and keeps resend locked until it knows.
- A rejection shows the venue's own words. A failed read says what it could not read, never what was sent.
- Old data stays readable and says its age. Connection and data state are separate, and both show.
- Binance is read only. Orderly's Community Listed markets and markets that need more than 8 decimals stay out.
- Prices in the book, trades, ticket and venues table are exact. Floats exist only in display data such as chart coordinates and the 24h line.
- The public repo holds no research, competitor notes or decision logs.

## Brand Commitments

- The name is Tape, from the ticker tape. The symbol and the lockup are free to change.
- Voice: plain, short and literal. Copy names what happened and what the trader can do next, in the venue's words where the venue speaks.
- The trader asked for more life in the screen: the market should feel alive, and acting on it should feel fast and rewarding. They called the current look templated, generic, cramped and grey.
- The reward goes to what the trader did: their fill, a position opened or closed, a deposit credited. What the market does on its own gets a direction signal and nothing more. No confetti, streaks, badges, leaderboards, trade counters or screens tinted by PnL, the engagement practices the SEC listed in Release 34-92766 and Robinhood dropped in its 2024 settlement with Massachusetts.

## Evidence on Hand

- Live venue data on mainnet and testnet, and recorded frames in `packages/venues/src/__fixtures__/` and the e2e replay.
- Approved screens of the current look in `.claude/skills/tape-design/reference/`.
- No users, testimonials, volumes or benchmarks beyond the render numbers in the README. None may be invented.

## Product Principles

1. The trader reads before acting. Nothing on screen competes with a number while it is being read.
2. Every number is true or says why it is not: stale, reconnecting, failed, unknown.
3. Live signals inform. A movement on screen means something changed in the market or in the trader's account.
4. Acting is short. From a price on screen to an order sent takes the fewest steps the venue allows, and the outcome is never ambiguous.
5. The trader's money moves only on their deliberate action. Nothing nudges them to trade more.

## Accessibility & Inclusion

- WCAG 2.2 AA contrast for every text and control pair.
- Side never reads by color alone: a label, a mark or position carries it too.
- Every animation stops under `prefers-reduced-motion`. Nothing flashes more than three times a second.
- The book and the ticket work from the keyboard.
