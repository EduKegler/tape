---
name: Tape
description: Four perps venues on one graphite screen, with the trader's own actions in off-white.
colors:
  ground: "#121315"
  surface: "#1a1b1e"
  raised: "#232428"
  inset: "#141517"
  rule: "#26282c"
  edge: "#6e727a"
  level1: "#ecebe8"
  level2: "#b8babe"
  level3: "#8b8f96"
  ink: "#ecebe8"
  ink-contrast: "#121315"
  accent: "#efebe2"
  bid: "#2ebd85"
  ask: "#f75466"
  bid-wash: "rgb(46 189 133 / 0.1)"
  ask-wash: "rgb(247 84 102 / 0.1)"
  warn: "#e2a93b"
  err: "#ff8466"
typography:
  display:
    fontFamily: "Martian Mono Variable, ui-monospace, monospace"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1
    fontFeature: "\"tnum\", \"zero\""
    fontVariation: "\"wdth\" 75"
  figure:
    fontFamily: "Martian Mono Variable, ui-monospace, monospace"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "\"tnum\", \"zero\""
    fontVariation: "\"wdth\" 75"
  number:
    fontFamily: "Martian Mono Variable, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "\"tnum\", \"zero\""
    fontVariation: "\"wdth\" 75"
  number-sm:
    fontFamily: "Martian Mono Variable, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "\"tnum\", \"zero\""
    fontVariation: "\"wdth\" 75"
  title:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1
  body:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  body-strong:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  action:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  label:
    fontFamily: "Inter Variable, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "0.25rem"
  md: "0.375rem"
  lg: "0.5rem"
spacing:
  "0": "0"
  "0.5": "0.125rem"
  "1": "0.25rem"
  "1.5": "0.375rem"
  "2": "0.5rem"
  "2.5": "0.625rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "8": "2rem"
components:
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.level2}"
    rounded: "{rounded.lg}"
  panel-title:
    textColor: "{colors.level1}"
    typography: "{typography.title}"
    height: "2.25rem"
    padding: "0 0.75rem"
  venue-tab:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.level3}"
    height: "2.75rem"
    padding: "0 1rem"
  venue-tab-current:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.level1}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-contrast}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.75rem"
  button-primary-disabled:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.level2}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.level1}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.75rem"
  button-buy:
    backgroundColor: "{colors.bid}"
    textColor: "{colors.ink-contrast}"
    typography: "{typography.action}"
    rounded: "{rounded.md}"
    height: "2.75rem"
  button-sell:
    backgroundColor: "{colors.ask}"
    textColor: "{colors.ink-contrast}"
    typography: "{typography.action}"
    rounded: "{rounded.md}"
    height: "2.75rem"
  side-switch:
    backgroundColor: "{colors.inset}"
    rounded: "{rounded.lg}"
    padding: "0.25rem"
  side-switch-buy-selected:
    backgroundColor: "{colors.bid}"
    textColor: "{colors.ink-contrast}"
    typography: "{typography.action}"
    rounded: "{rounded.md}"
    height: "2rem"
  side-switch-idle:
    textColor: "{colors.level2}"
    typography: "{typography.action}"
    height: "2rem"
  input:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.level1}"
    typography: "{typography.number}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0 0.75rem"
  select:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.level1}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.5rem"
  table-row:
    textColor: "{colors.level2}"
    typography: "{typography.number-sm}"
    height: "1.875rem"
  table-row-dense:
    textColor: "{colors.level2}"
    height: "1.5rem"
  table-row-current:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.level1}"
  order-outcome:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.level1}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.625rem"
  dialog:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.level2}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "1rem"
  status-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.level3}"
    typography: "{typography.label}"
    height: "2rem"
---

# Design System: Tape

## Overview

**Creative North Star: "Graphite and the Trader's Light"**

The market sits on graphite. Four venues, a chart, a book, a tape and a ticket share one dark field of cards that stay quiet so the numbers can be read. Warm off-white is the light the trader brings: it marks the venue they chose, where their keyboard is, and their fill. The market only gets green, red and a small mark.

The screen is dense and built for hours of glances. The root type size is 13px, so every rem in the code is 13px: a 1rem gap is 13px and the 0.625rem gutter is 8.1px. Words are Inter. Numbers are Martian Mono pressed to 75% width with a slashed zero, so a column of prices lines up and reads as one block. Depth comes from three graphite steps, never from shadows.

Movement is rare and means something. One animation, the wash, plays when the trader's own order fills and when a venue newly takes the best bid or ask. Prices, sizes, book rows and trades never move.

**Key Characteristics:**
- Graphite cards (rounded 0.5rem) on a darker ground, with 8.1px gutters.
- Off-white accent only for what is the trader's: current choice, focus, fill.
- Every number in narrow Martian Mono, every word in Inter.
- Green and red for side and direction only. Amber for age. Coral with a drawn mark for failure.
- No shadows. Current things are raised one graphite step.
- One signature motion, the 900ms wash, and nothing else that draws the eye.

## Colors

Graphite neutrals carry everything; four signal hues each own one meaning, and the off-white accent belongs to the trader.

### Primary
- **Trader's Light** (accent): the underline on the current venue tab, market and segmented choice; the venue name in the current Venues row, semibold; the keyboard focus ring; the wash on the trader's fill. Text selection uses it at 20%.

### Secondary
- **Bid Green** (bid) and **Ask Red** (ask): side and direction. Book prices, trade marks, the last price by the side of the last trade, the 24h change, Buy and Sell buttons, the selected side, the best-price dot in the strip and the Venues table. Their 10% washes fill book depth bars, the depth chart and candle volume.

### Tertiary
- **Stale Amber** (warn): old data, its age, Reconnecting, Offline, price warnings under a field, the dialog lock note.
- **Failure Coral** (err): the drawn error mark, a field's error edge, the result word of a failed order, a panel's error line.

### Neutral
- **Ground** (ground): the page between cards, and the 1px cuts between venue tabs.
- **Graphite** (surface): cards, header, venue strip, status bar.
- **Raised Graphite** (raised): the current venue tab, the current Venues row, the order outcome block, dialogs, popovers, secondary buttons, tab hover.
- **Well** (inset): field and select fill, the side switch track.
- **Rule** (rule): 1px lines inside a card, under the panel title and between table rows.
- **Edge** (edge): field and select borders. Reaches 3:1 on every surface.
- **Level 1** (level1): values, titles, the current item, error messages.
- **Level 2** (level2): body text and table cells. The page default.
- **Level 3** (level3): labels, headers, chain names, hints, idle tabs.
- **Ink** (ink) and **Ink Contrast** (ink-contrast): the primary button and text on any filled side color.

### Named Rules
**The Trader's Light Rule.** The off-white accent marks only what the trader chose or did: the current choice, keyboard focus, their fill. The market never gets it.

**The Side Color Rule.** Green and red mean side or direction and nothing else. They live only in the files on `SIDE_FILES`; a warning takes amber and a failure takes coral.

**The Drawn Failure Rule.** A failure always carries the drawn coral mark (a 14px circle with a bar and a dot). In fields and notes the message beside it stays level1, so the mark carries the color and the words stay readable.

## Typography

**Body Font:** Inter Variable (with system-ui, sans-serif)
**Number Font:** Martian Mono Variable at font-stretch 75%, tabular and slashed zero (with ui-monospace)

**Character:** Inter names things and Martian Mono counts them. The narrow mono keeps long prices compact and makes every column align without help.

### Hierarchy
- **Display** (Martian Mono, 400, 22px, line-height 1): the last price in the header, with its side mark.
- **Figure** (Martian Mono, 400, 18px): equity in Account and notional in the ticket.
- **Number** (Martian Mono, 400, 13px or 12px): strip prices and field values at 13px; book, trades, tables and stats at 12px, and 11px in the dense Venues table.
- **Title** (Inter, 600, 13px, line-height 1): panel titles and venue names in the strip.
- **Action** (Inter, 600, 13px): Buy, Sell and the side switch.
- **Body** (Inter, 400 or 500, 12px, line-height 1.4): text, notes, labels next to values. 500 for the order outcome and primary buttons.
- **Label** (Inter, 400, 11px): table headers, chain names, stat labels, panel state lines, the status bar.

Sizes come only from the closed scale 11, 12, 13, 18 and 22px. Weights stop at 600.

### Named Rules
**The Narrow Figures Rule.** The `num` class goes on the element that holds the number and nothing wider. Words stay Inter. A sentence that carries numbers, such as the order outcome, the order lookup and the liquidation note, stays Inter with tabular figures.

**The Canvas Exception.** Chart and depth axes are drawn on canvas, which cannot set font-stretch, so they use Inter at 11px.

## Layout

The trading screen fills the viewport from 1024px up. A header (about 48px) and the venue strip (36px, inset by the gutter) sit on top. Under them a grid holds the panels: the chart column takes the rest of the width beside the book (20rem), trades (17rem) and the ticket (22rem). Rows are the chart (flexible), Depth (9rem) and Account (up to 13rem). The ticket spans the top two rows; the Venues table sits under it beside Account. A 26px status bar closes the screen.

Every gap and padding is a step of `SPACING_STEPS`. Gutters between cards and around the grid are 0.625rem (8.1px). Panel titles are 2.25rem tall with 0.75rem side padding. Table rows are 1.875rem, and 1.5rem when dense.

Below 1024px the panels stack in one column with fixed heights. Below 640px the venue strip stacks its four tabs. The header lays out on one line from 1280px and wraps below.

History uses the same cards and gutters under its own header, with Accounts in a narrow column beside Totals and Fills and funding.

## Elevation & Depth

Tape is flat. Depth is three graphite steps: ground under graphite cards, raised graphite for what is current or on top, and a darker well for fields. There are no drop shadows, blurs or glows; the shadow scales are reset to nothing in the theme. The one inset shadow is the 2px off-white underline that marks a current tab or choice.

### Shadow Vocabulary
- **Selected underline** (`box-shadow: inset 0 -2px var(--accent)`): the current venue tab, the current market (BTC, ETH, SOL), and the checked option of a segmented control.

### Named Rules
**The Raised Means Current Rule.** A raised fill says this is the current one or it sits above the page: the current venue tab, the current Venues row, the order outcome, a dialog. Do not raise a thing for emphasis alone.

## Shapes

Three radii from the closed scale. Cards, the venue strip and the side switch track take the large radius (0.5rem, 6.5px). Buttons, fields, selects, search, popovers and the outcome block take the medium radius (0.375rem, 4.9px). Small inline fields and the Testnet chip take the small radius (0.25rem, 3.25px). Full rounding is refused by lint.

Inside a card, structure is drawn with 1px rule lines, never with nested boxes. Between venue tabs the cut is a 1px line in the ground color, so the strip reads as four tabs cut from one piece.

## Components

### Buttons
Compact and literal. Heights follow three sizes: 1.5rem, 2rem and 2.5rem.
- **Shape:** medium radius (0.375rem).
- **Primary:** off-white ink fill with graphite text, weight 500. Disabled turns raised graphite with a rule ring and level2 text.
- **Secondary:** raised graphite with level1 text; hover lifts it with level1 at 12%.
- **Buy / Sell:** the submit at the ticket's foot, 2.75rem tall, filled bid or ask, graphite text, 600.
- **Quiet and link:** level3 text that turns level1 on hover; a link is level1 and underlined.
- **Focus:** the global 2px off-white ring at a 2px offset.

### Side switch
- **Track:** the well fill with the large radius and 0.25rem padding.
- **Selected:** the chosen side fills bid or ask with graphite text. The other side is level2 text on the track and turns level1 on hover.

### Segmented and tabs
- Text-only options in level3. The checked one turns level1 and carries the selected underline. Used for intervals, order type, account tabs and History filters.

### Cards / Containers
- **Corner Style:** large radius (0.5rem).
- **Background:** graphite.
- **Shadow Strategy:** none, see Elevation & Depth.
- **Border:** none outside. A rule line under the 2.25rem title row.
- **Title row:** title in level1 semibold, the panel state line beside it, controls on the right.

### Inputs / Fields
- **Style:** well fill, 1px edge border, medium radius, 2.25rem tall in the ticket, value in Martian Mono 13px level1. The label sits above in level3 with a hint or a button on the right.
- **Focus:** the global off-white ring outside the border.
- **Error:** coral border, then the drawn mark and the message in level1 below. A price warning shows in amber with no mark.
- **Selects and search:** the same well, edge and radius.

### Panel state
- One 11px line beside the panel title. Empty is level3 (Loading…, Waiting for the venue). Stale is amber with its age (Reconnecting · 4 s old). Error is coral with the drawn mark and a Retry link. It fades in at 120ms when it changes.

### Venue strip (signature)
- Four equal tabs on one graphite card under the header, 2.75rem tall.
- Left: the venue name in title type, level1, and its chain in 11px level3.
- Right: when the venue holds the best bid or ask, a small dot in the side color, "best bid" or "best ask" in 11px level2, and the price in Martian Mono 13px. When it holds neither, "mid" in level3 and the mid price.
- A venue that lost its feed shows Reconnecting in amber and its mid in level3. An unlisted market shows Not shown in level3.
- The current tab is raised with the selected underline. Hover raises any tab.
- When a venue newly takes the best bid or ask, its tab plays the wash, at most once per venue every 2s, never on the first frame or when the venue just came live. While it washes, the chain and the best or mid label turn level1 so they stay readable on the tint.

### Venues table
- Dense table (11px, 1.5rem rows) of venue, bid, ask and basis in bps. The best bid and best ask carry the side color and the dot. The current venue's row is raised with its name semibold in the accent. Rows are keyboard reachable and switch the venue.

### Order outcome
- A raised block with the medium radius under the ticket summary, 12px Inter 500 in level1 with tabular figures. On a fill it plays the wash. A failed send shows the drawn mark, the result word in coral and the venue's words.

### The wash (signature motion)
- A background tint of the accent: 20% at the start, 15% at 35%, clear at 900ms, eased with `cubic-bezier(0.33, 1, 0.68, 1)`.
- It plays on the trader's fill (the outcome block and the changed position row) and on a venue tab that takes the best price. Nothing else uses it.
- Under reduced motion it holds a still 12% tint for 900ms and then clears. This is the only motion not gated by `motion-safe:`, because it carries information and does not move.
- The only other animation is a 120ms fade-in for dialogs and panel state, behind `motion-safe:`.

### Dialog
- Raised graphite, rule border, small radius, 1rem padding, a 60% black backdrop. Title in 13px level1. A lock reason shows as a level1 note with an amber left rule.

### Navigation
- The header is graphite: the lockup and the Testnet chip, the market links (level3, level1 with the selected underline when current), market search, the ticker, then History and the wallet on the right.

## Do's and Don'ts

### Do:
- **Do** put `num` on every element that holds a number, and only on that element.
- **Do** keep sentences that carry numbers in Inter with tabular figures.
- **Do** mark the current thing by raising it one graphite step, plus the 2px accent underline on tabs.
- **Do** pair every failure with the drawn coral mark, and keep the message in level1 beside it.
- **Do** show old data in amber with its age, and keep it readable.
- **Do** give side a word or a mark besides its color.
- **Do** take color, type size, weight, radius, z-index, duration and animation from the tokens in `src/styles.css`, and spacing from `SPACING_STEPS`.
- **Do** keep the global focus ring: 2px off-white at a 2px offset.

### Don't:
- **Don't** use the accent for market data or for emphasis. It is the trader's.
- **Don't** use green or red for a warning, an error or decoration.
- **Don't** animate prices, sizes, book rows, trades or charts. A change in the market gets a direction mark only.
- **Don't** add a second animation or play the wash for anything but the trader's fill or a venue taking the best price.
- **Don't** add drop shadows, glows or blur. Depth is the graphite steps.
- **Don't** use full rounding or radii outside sm, md and lg.
- **Don't** set words in Martian Mono, or numbers in Inter outside sentences and canvas.
- **Don't** tint the screen by PnL or add confetti, streaks, badges or trade counters.
