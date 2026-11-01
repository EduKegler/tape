---
name: tape-design
description: Tape's visual system. Use before changing how any Tape screen looks or reads, such as a color, size or spacing, a button, field or table, a loading, stale, empty or error state, a dialog, motion, or a screenshot review.
---

# Tape design

Tape's look lives in code, and this skill points at it instead of repeating it:

- `src/styles.css` holds the tokens. `:root` has the colors, and `@theme` closes every Tailwind scale to Tape's steps.
- `src/ui/primitives/` holds `Button`, `Checkbox`, `Dialog`, `InlineInput`, `Input`, `NoData`, `Search`, `Select`, `Table` and `TextLink`. Base UI enters only through them.
- `src/ui/Panel.tsx` frames every panel. `src/ui/panel-state.ts` and `src/ui/PanelStatus.tsx` say what state a panel is in.
- `scripts/check-contrast.mjs` lists every color pair the primitives and the panel state draw.
- `DESIGN.md` describes the system in prose, with `.impeccable/design.json` beside it.

These files win over any other skill, such as `interface-design` or `frontend-design`, and over a library's defaults. When another source suggests a value or a pattern, use the token or primitive that already carries that meaning. A new token or look enters only for a meaning the system lacks, in the same change as its contrast pair.

## Build with the system

- **Graphite, one off-white.** The page is `ground`. Header, venue strip, panels and status bar are `surface` cards with an 8 px gutter (`gap-2.5` and `p-2.5`, since 1rem is 13 px). `raised` lifts one thing inside a card: the current venue tab, the current table row, the order outcome, a secondary button, a dialog. A field sits on `inset` inside an `edge` border.
- **Off-white belongs to the trader.** `accent` marks the current venue, the selected item, focus as a 2 px ring with a 2 px offset, and the trader's own fill. It never decorates.
- **Color carries meaning.** `bid` and `ask` mean side, and nothing else. `err` (coral) with `ErrorMark` means something failed: a refused order, a rule error on a field, a failed read. `warn` (amber) means old data, a price warning or a venue reconnecting. Text sits on three levels: `level1` for values and the selected item, `level2` for body, `level3` for labels.
- **Numbers are Martian Mono.** `num` sets them at 75 % width, tabular, with a slashed zero. Put it on the number element, never on a container, so words stay in Inter. Align numbers right in columns and keep the same decimals down a column. A sentence that carries numbers, such as an order outcome, stays in Inter with `tabular-nums`. Canvas text in the chart stays in Inter, because canvas cannot set `font-stretch`.
- **Corners.** Cards take `rounded-lg`, controls and blocks inside them `rounded-md`. No shadows, except three 2 px inset lines: `inset-shadow-selected` under the current venue tab and the checked option, `inset-shadow-current` at the left of the current Venues row, and `inset-shadow-newest` in `level3` at the left of the newest trade.
- **Controls come from primitives.** `Button` takes a `look`, and only `primary` and `secondary` take a `size`. A pressed side fills with its color and `ink-contrast` text. `className` on a primitive carries layout: width, alignment, padding. `Input` is a field with its label and message, and `InlineInput` a bare field in a bar or a filter row. A field's error goes through `Input`'s `error`.
- **Side reads without color.** A label like `Buy / Long`, a mark like `▲`, `▼` or `●` with its words, or position, as in the book.
- **The venue strip quotes each venue.** Four equal tabs under the header: venue on the left with its chain under it, followed by `● best bid` or `● best ask` when the venue holds one, and `Mid` over the mid price on the right. A venue that went quiet says `Reconnecting` in `warn` in place of `Mid`. Bid, ask and basis stay in the Venues panel.
- **The submit names the order.** It reads `Buy / Long BTC` or `Sell / Short BTC`, and for a limit or market order with a valid size a second line states size, price and venue. The second line is hidden from the accessible name and read as its description.

## Panel state

Data and connection are two axes. Data is live, stale, empty or error. Connection is connected, reconnecting or down. `panelState` turns both into one text, and `src/ui/panel-state.test.ts` holds every text a trader can read.

A panel fed by a hub topic passes `<TopicStatus topic={…} />` to `Panel`'s `status` slot, beside the title. Pass `ageLimit` where an old frame misleads, as in the book, the depth and the ticket's price hint. Pass `error` and `onRetry` for a failed read.

The title bar is one line, 34 px high, in every state, so panels side by side keep their bodies aligned. A state text that does not fit beside the title stacks under it inside the same height, and its Retry is a link, never a boxed button. The aside never wraps. The chart puts its intervals and OHLC in the title's place with `lead`, and the ticket and Account pass `bare` and fold the title into their first row. Both keep the title as a hidden heading, because e2e finds a panel by it.

- Old data stays readable, with its age beside the title.
- A failed read says what failed and offers Retry. Its wording is about reading, never about sending, and it never sits beside an empty-result text. Outside a hub panel it goes through `ReadNote`, which takes its reason from `readFailure`.
- Before the first frame the panel says `Loading…` and shows no placeholder number. With the socket down it names the venue it waits for.
- A legitimately empty result is plain `level3` text in place of the data, drawn by `NoData`.
- The panel state speaks through `aria-live="polite"` with no role, because the ticket's order outcome owns `role="status"` and `role="alert"`.

## Orders and confirmation

- The submit button and the last order outcome stay in view at 1280×800, with the ticket in its longest state. The fields scroll and the footer holds still.
- A price warning is its own level, apart from an error, and never blocks.
- While sending, the button says `Sending…` and the form locks.
- After an unknown outcome, resend stays locked until the venue answers or the trader resends on purpose.
- A plain order goes out with no dialog. Closing a position, cancelling all orders and forgetting the trading key confirm in two steps. Close puts its step on a full-width row under the position, so the columns hold; the others swap their button for the step in place.

## Motion

The wash is Tape's one signature. An off-white tint starts at 20 %, holds near 15 % for the first third and clears by 900 ms on `cubic-bezier(0.33, 1, 0.68, 1)`. It plays on:

- the trader's own fill: the order outcome and the position row the fill changed;
- a venue tab that newly takes the best bid or ask, at most once every 2 s per venue, never on the first frame and never for a venue that just came live.

`src/ui/wash.ts` and `src/ui/lead.ts` decide when. The `wash` utility in `src/styles.css` draws it, and it is the one animation outside `motion-safe:`: under `prefers-reduced-motion` it shows a still 12 % tint and clears at once, because a fill must still be seen. Draw it as an overlay under the content, never over the text.

A dialog and the panel state fade in with `animate-fade-in`. Prices, sizes, book rows, new trades, the ticket total and balances hold still. Every other animation sits behind `motion-safe:`.

## Guardrails

The lint in `eslint.config.js` refuses these, and the fix is always the token or primitive, never a change to the rule:

- arbitrary values and properties, such as `text-[13px]`, `z-[60]` or `[transition:…]`;
- `rounded-full`, shadows, and any class outside the closed scales;
- a padding, margin or gap off the steps in `SPACING_STEPS` of `eslint.config.js`. Sizes such as `w-` and `h-` stay free;
- a raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<table>`, or a Base UI import, outside `src/ui/primitives`;
- an `underline` outside `src/ui/primitives`. A link is `TextLink`, or `Button` with look `link`;
- a dialog overlay, such as `<dialog>`, `role="dialog"`, `aria-modal` or `z-dialog`, outside `src/ui/primitives`;
- a `bid` or `ask` color outside `SIDE_FILES`, the files that show a side. A new file that shows a side joins the list, and anything else takes `warn`, `err` or `accent`;
- an animation without `motion-safe:`. The `wash` utility is the exception and carries its own reduced-motion still.

Review catches the rest. A screen that shows one of these goes back:

- a warm light background, a blue or tinted shell, a gradient, glass, blur, a texture or a decorative grid;
- an italic or third font, a serif, words in Martian Mono, or letter-spaced capitals above a panel;
- numbered labels such as 01, 02, 03, or a decorative icon beside each title;
- a shadow on a card, a side stripe on a row or a note, or a colored pill on every state;
- weight above 600, or 600 outside a key number;
- off-white on anything the trader does not own, or color carrying a meaning alone;
- a number that moves while the trader reads it, or a wash on anything but a fill or a lift.

## Evidence

1. Run `pnpm verify`. It runs the lint and `scripts/check-contrast.mjs`. Add any new color pair to that script's `PAIRS` first.
2. Capture with the `verify-tape` skill on the replay build: `parity.mjs capture` on `main` and on the change, then `parity.mjs diff`, summarized by property. Take screenshots at 1440×900 and 1280×800 with live, stale and error data, plus `/history` and the Deposit dialog.
3. Compare each screenshot with the matching one in `reference/`. A difference the change did not intend goes back.
4. Run `pnpm e2e`. An assertion changed on purpose goes in the review with its diff.
5. For a change on the trading screen, run `perf-probe.mjs` against the baseline and report main-thread work.
6. The screens the operator approves enter `reference/` in the same PR, each with a line under Reference that says what it settles. A screen the PR makes wrong is retaken or leaves.

## Reference

Screens of the graphite redesign, taken from the code. Each settles tokens, primitives, state and motion.

- `reference/trading-live.png`: the whole screen live at 1440×900, matched to the quoted-tabs frame. The strip quotes each mid with the best-price mark under the chain, the chart heads with intervals and OHLC, the book opens on the last price, the ticket folds its title into the order types, 14 book levels a side.
- `reference/trading-1280.png`: the same at 1280×800. The chart drops its source label, and the ticket, Account and Venues still fit.
- `reference/fill-ticket.png`: a real Hyperliquid testnet market fill. The outcome sits on `raised` right above the submit, which names the order on two lines.
- `reference/fill-position.png`: the same fill as a position in Account: tabs, equity, actions and Deposit on one row, figures grouped, size with its unit.
- `reference/lift.png`: a venue tab during a live best-price lift on mainnet, with its chain and mark raised to `level1` on the tint.
- `reference/field-error.png`: a rule error on Size in `err` with `ErrorMark`, the off-white focus ring on Price, and units inside the fields.
- `reference/history.png`: `/history` in the graphite world. History itself is not redesigned yet.
- `reference/close-confirm.png`: closing a position. Close stays in its cell, and the step with size, expected price and its own slippage takes a full-width row under the position.
- `reference/deposit.png`: the Deposit dialog on `raised`. The terms read in Inter with tabular figures, and the address in Martian Mono.

Not retaken yet: stale, offline and failed reads, the unknown and refused order outcomes. Their rules above still hold, and each enters here once a screen of it is approved.
