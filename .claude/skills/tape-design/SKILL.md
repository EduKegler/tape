---
name: tape-design
description: Tape's visual system. Use before changing how any Tape screen looks or reads, such as a color, size or spacing, a button, field or table, a loading, stale, empty or error state, a dialog, motion, or a screenshot review.
---

# Tape design

Tape's look lives in code, and this skill points at it instead of repeating it:

- `src/styles.css` holds the tokens. `:root` has the colors, and `@theme` closes every Tailwind scale to Tape's steps.
- `src/ui/primitives/` holds `Button`, `Checkbox`, `Dialog`, `InlineInput`, `Input`, `Search` and `Table`. Base UI enters only through them.
- `src/ui/Panel.tsx` frames every panel. `src/ui/panel-state.ts` and `src/ui/PanelStatus.tsx` say what state a panel is in.
- `scripts/check-contrast.mjs` lists every color pair the primitives and the panel state draw.

These files win over any other skill, such as `interface-design` or `frontend-design`, and over a library's defaults. When another source suggests a value or a pattern, use the token or primitive that already carries that meaning. A new token or look enters only for a meaning the system lacks, in the same change as its contrast pair.

## Build with the system

- **Color carries meaning.** `bid` and `ask` mean side, and nothing else. `warn` means old data, a price warning or a failed read. `accent` marks focus and the selected item: market, venue, interval, order type, account tab and the current row. Text sits on three levels: `level1` for values and the selected item, `level2` for body, `level3` for labels.
- **One surface, split by `rule` lines.** The order ticket has its own tone, `ticket`. A dialog sits on `raised`. A field sits on `inset` inside an `edge` border.
- **Numbers are tabular.** Give them `num`, align them right in columns, and keep the same decimals down a column.
- **Controls come from primitives.** `Button` takes a `look`, and only `primary` and `secondary` take a `size`. `className` on a primitive carries layout: width, alignment, padding. `Input` is a field with its label and message, and `InlineInput` a bare field in a bar or a filter row. A field's error goes through `Input`'s `error`.
- **Side reads without color.** A label like `Buy / Long`, a mark like `▲` and `▼`, or position, as in the book.

## Panel state

Data and connection are two axes. Data is live, stale, empty or error. Connection is connected, reconnecting or down. `panelState` turns both into one text, and `src/ui/panel-state.test.ts` holds every text a trader can read.

A panel fed by a hub topic passes `<TopicStatus topic={…} />` to `Panel`'s `status` slot, beside the title. Pass `ageLimit` where an old frame misleads, as in the book, the depth and the ticket's price hint. Pass `error` and `onRetry` for a failed read.

- Old data stays readable, with its age beside the title.
- A failed read says what failed and offers Retry. Its wording is about reading, never about sending, and it never sits beside an empty-result text.
- Before the first frame the panel says `Loading…` and shows no placeholder number. With the socket down it names the venue it waits for.
- A legitimately empty result is plain `level3` text in place of the data.
- The panel state speaks through `aria-live="polite"` with no role, because the ticket's order outcome owns `role="status"` and `role="alert"`.

## Orders and confirmation

- The submit button and the last order outcome stay in view at 1280×800, with the ticket in its longest state. The fields scroll and the footer holds still.
- A price warning is its own level, apart from an error, and never blocks.
- While sending, the button says `Sending…` and the form locks.
- After an unknown outcome, resend stays locked until the venue answers or the trader resends on purpose.
- A plain order goes out with no dialog. Closing a position, cancelling all orders and forgetting the trading key confirm in two steps on the same row.

## Motion

A dialog and the panel state fade in with `animate-fade-in`. An order outcome appears at once. Prices, sizes, book rows, new trades, the ticket total and balances hold still. Every animation sits behind `motion-safe:`, so `prefers-reduced-motion` turns it off.

## Guardrails

The lint in `eslint.config.js` refuses these, and the fix is always the token or primitive, never a change to the rule:

- arbitrary values and properties, such as `text-[13px]`, `z-[60]` or `[transition:…]`;
- `rounded-full`, shadows, and any class outside the closed scales;
- a raw `<button>` or `<table>`, or a Base UI import, outside `src/ui/primitives`;
- a dialog overlay, such as `<dialog>`, `role="dialog"`, `aria-modal` or `z-dialog`, outside `src/ui/primitives`;
- a `bid` or `ask` color outside `SIDE_FILES`, the files that show a side. A new file that shows a side joins the list, and anything else takes `warn` or `accent`;
- an animation without `motion-safe:`.

Review catches the rest. A screen that shows one of these goes back:

- a warm light background, a gradient, glass, blur, a texture or a decorative grid;
- an italic or second font inside a title, a serif, a monospace label, or letter-spaced capitals above a panel;
- numbered labels such as 01, 02, 03, or a decorative icon beside each title;
- identical cards with the same radius and shadow, or a colored pill on every state;
- weight above 600, or 600 outside a key number;
- color carrying a meaning alone;
- a number that moves while the trader reads it.

## Evidence

1. Run `pnpm verify`. It runs the lint and `scripts/check-contrast.mjs`. Add any new color pair to that script's `PAIRS` first.
2. Capture with the `verify-tape` skill on the replay build: `parity.mjs capture` on `main` and on the change, then `parity.mjs diff`, summarized by property. Take screenshots at 1440×900 and 1280×800 with live, stale and error data, plus `/history` and the Deposit dialog.
3. Compare each screenshot with the matching one in `reference/`. A difference the change did not intend goes back.
4. Run `pnpm e2e`. An assertion changed on purpose goes in the review with its diff.
5. For a change on the trading screen, run `perf-probe.mjs` against the baseline and report main-thread work.

## Reference

Screens approved for the visual direction. Layout in them may be ahead of the code. Tokens, primitives, state and motion are what they settle.

- `reference/trading-live.png`: the whole screen live at 1440×900. One surface, the ticket's own tone, violet only on the selected item.
- `reference/trading-stale.png`: one venue went quiet. Each panel keeps its data and says `No updates` with the age beside its title.
- `reference/trading-offline.png`: the hub has no socket. Every panel says `Offline` with its age, and the status bar says prices are frozen.
- `reference/trading-error.png`: reads failed. Chart, ticker and ticket say what failed, each with Retry, and the panels that still read keep working.
- `reference/trading-1280.png`: the ticket's longest state at 1280×800, with take profit and stop loss open and an unknown outcome beside the button.
- `reference/ticket-warning.png`: a limit price far from the market gets a `warn` line under the field, and the button stays live.
- `reference/history-error.png`: `/history` when a venue did not answer. Read wording, Retry per venue, and no totals beside the failure.
- `reference/deposit-summary.png`: the Deposit dialog on `raised`. The summary is the confirmation, and the one button names the amount and the source chain.

Screens from the code, on the replay build. The market panels and the header look like this today.

- `reference/market-live.png`: the market panels live at 1440×900. Lockup in the header, last price at 22 px with the side arrow, book mid at 22 px, `▲` and `▼` on trades, `●` on the best venue bid and ask.
- `reference/market-1280.png`: the same at 1280×800, with all 28 book levels in view.
- `reference/market-stale.png`: Hyperliquid went quiet. Each panel keeps its data and says `Reconnecting` with the age.
- `reference/market-offline.png`: no socket left. Every panel says `Offline` with its age.
- `reference/market-error.png`: the candle history and the 24h stats failed. Each says what failed, with Retry.
- `reference/market-focus.png`: the book holds keyboard focus. One Tab stop, and the arrows move the focus ring between levels.
