# Tape verification map

This folder is the maintained source for verifying what a Tape user sees and does. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Run `up` from `SKILL.md`. The app is the production build at `http://127.0.0.1:4391`, served by this run.
- Run `doctor` and require exit 0. Exit 2 names an unreachable venue. Prove on another venue and report it.
- The network is up. Every panel reads live public venue data. There is no fixture mode in the browser.
- One tab is open, on `/hyperliquid/BTC?interval=1m` unless the recipe says otherwise.
- Never drive an instance this run did not start. Port 3000 belongs to the user.

## Driving conventions

- Start every recipe from the baseline. Close extra tabs before the next recipe, because all tabs share one hub.
- `vt` means `node .claude/skills/verify-tape/scripts/verify-tape.mjs`.
- Scope by panel title (`--panel "Order book"`) or header nav (`--nav Market`), then use ARIA role and name. Use `--css` only where a feature file says the UI has no better handle.
- Wait for the data state the step needs. The book is ready when `section div[data-status]` has `live`.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Nothing in Tape persists. A reload restores the defaults, except what the URL carries (`interval`, `group`).

## Proof and skip reporting

- Capture the user action and the resulting state. Save an ARIA snapshot of the panel before and after, plus a screenshot.
- Every command lands in `artifacts/<run-id>/steps.jsonl`. Name that folder in the report.
- Prices move between commands. Assert what holds across frames, not one exact number.
- Record the feature file and sub-feature ids with the evidence paths.
- Report a step blocked by a venue outage or a missing wallet extension as skipped, with the reason. Do not report a skipped entry point as verified through another one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short ids with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-tape` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Order book](./order-book.md) covers the live book, price grouping, the spread line and clicking a level into the ticket.
- [Order ticket](./order-ticket.md) covers side, limit and market, tick and step validation, touch price hints and the preview.
- [Market navigation](./market-navigation.md) covers the root redirect, the market and venue navs, the Venues table, chart intervals and unknown routes.
- [Hub and status bar](./hub-status.md) covers the shared hub counters, a second tab, tab close and the dedicated worker fallback.
- [Live panels](./live-panels.md) covers the header ticker, the trade feed, the depth chart and the candle chart.
