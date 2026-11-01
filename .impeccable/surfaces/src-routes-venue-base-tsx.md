---
version: 1
slug: "src-routes-venue-base-tsx"
primary_target: "src/routes/$venue.$base.tsx"
related_targets: []
---

# Trading screen

Scope: the trading route on desktop, 1440x900 first and 1280x800. Mode: Operate. History shares the world and follows it.

Audience and job: an active perps trader on more than one venue reads four books on one screen and acts on the venue with the better price. Task: pick the venue, build an order the venue accepts, send it, read the outcome. Proof: live books, exact decimals, the venue's own words. Constraint: the redesign PR changes the look only; every control, label, state and number format stays what the app renders today. Venue features from the research land later in the slots the target frame shows.

Chosen direction: quoted venue tabs with the Venues panel kept. Memorable moment: the trader's fill, and the venue that just took the best price, light for about a second.

Reference sketches: .impeccable/mocks/decision/abas-cotadas-pr-1440.html, abas-cotadas-pr-1280.html and abas-cotadas-ticket-estados.html.

Unresolved: the lockup; whether the submit button later carries the order summary; book rows at 1280x800, where 14 levels a side leave about 16px each; History and the target frame are not yet redrawn in this world.

## Direction contract

THESIS: choosing the venue is reading the comparison. Each venue tab carries the price it leads with, the best bid or best ask beside its mark, or its mid when it holds neither, so the trader picks where to trade while reading all four. It refuses the category default where a venue frontend shows only itself and the venue switch sits away from the price.

OWN-WORLD: graphite throughout: work panels, header and venue strip all #1A1B1E on #121315, the current venue tab raised to #232428. Warm off-white #EFEBE2 marks what is the trader's: current venue, keyboard focus as a separate 2px ring, their fill. Green and red say side only, amber says stale, errors take coral #FF8466 with a drawn icon. Field and checkbox edges reach 3:1. Words in Inter, every number in Martian Mono at 75 percent width with a slashed zero.

STORY: the trader reads the strip, sees who holds the best bid or ask, clicks that venue, and chart, book, trades and ticket follow. They build an order checked against the venue's tick and step, send it, and read the outcome in the venue's words. Their fill lights; the market only gets a direction mark.

FIRST VIEWPORT: graphite header 48px: lockup and Testnet chip, BTC ETH SOL, search, last price with its side mark, 24h, Volume, Funding 1h, Index, then History, network select and wallet. Graphite strip 36px across the full width: four equal tabs, name and chain left, best mark and the price it holds right, or the mid; the current tab raised with an off-white underline; a stale venue shows amber Reconnecting and its dimmed mid. Grid 644/256/214/286 under it: Chart over Depth, Order book with 14 levels a side around the mid row, Trades, Order ticket with the side-colored submit at its foot. Bottom row: Account across three columns, Venues table under the ticket. Status bar 26px.

FORM: quoted venue tabs, position 2 of 3 on my grounded list in the safer round, mixed with the kept Venues panel by Eduardo's pick. seed:ee2f39cecf7b11cb

SIGNATURE: on a fill, the ticket's outcome line and the position row take an off-white wash that holds near full for the first third and then settles to rest by 900ms. When a venue newly takes the best bid or ask, its tab lifts the same way, at most once per venue every 2 seconds. Under reduced motion the wash shows without movement for the same time and then clears.

MOTION GRAMMAR: only a change in the account or in who holds the best price animates. Exponential ease-out for control feedback at 120ms; the 900ms signature holds for its first 35 percent, then eases out. Book, trades and chart get no motion beyond their direction marks. Nothing loops, nothing flashes more than three times a second.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
