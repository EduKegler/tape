---
version: 1
slug: "src-routes-venue-base-tsx"
primary_target: "src/routes/$venue.$base.tsx"
related_targets: []
---

# Trading screen

Scope: the trading route on desktop, 1440x900 first and 1280x800. Mode: Operate. History shares the world and follows it.

Audience and job: an active perps trader on more than one venue reads four books on one screen and acts on the venue with the better price. Task: pick the venue, build an order the venue accepts, send it, read the outcome. Proof: live books, exact decimals, the venue's own words. Constraint: the redesign PRs change the look only; every control, state and behavior stays what the app does today. The one label that changed is the submit, which names the side as Buy / Long or Sell / Short, as the frame shows. Venue features from the research land later in the slots the target frame shows.

Chosen direction: quoted venue tabs with the Venues panel kept. Memorable moment: the trader's fill, and the venue that just took the best price, light for about a second.

Reference sketches: .impeccable/mocks/decision/venues-a-faixa-enxuta.html at 1440, which merges the PR frame with the lean strip, abas-cotadas-pr-1280.html at 1280, and abas-cotadas-ticket-estados.html for the ticket states.

Unresolved: book rows at 1280x800, where 14 levels a side leave about 14px each; the outcome chip, the Filled chip on position rows and a / search shortcut, which wait for behavior work; History is not yet redrawn in this world.

## Direction contract

THESIS: choosing the venue is reading the comparison. Each venue tab carries its mid, and under its chain the mark of the best bid or best ask it holds, so the trader picks where to trade while reading all four. It refuses the category default where a venue frontend shows only itself and the venue switch sits away from the price.

OWN-WORLD: graphite throughout: work panels, header and venue strip all #1A1B1E on #121315, the current venue tab raised to #232428. Warm off-white #EFEBE2 marks what is the trader's: current venue, keyboard focus as a separate 2px ring, their fill. Green and red say side only, amber says stale, errors take coral #FF8466 with a drawn icon. Field and checkbox edges reach 3:1. Words in Inter, every number in Martian Mono at 75 percent width with a slashed zero.

STORY: the trader reads the strip, sees who holds the best bid or ask, clicks that venue, and chart, book, trades and ticket follow. They build an order checked against the venue's tick and step, send it, and read the outcome in the venue's words. Their fill lights; the market only gets a direction mark.

FIRST VIEWPORT: graphite header 48px: lockup and Testnet chip, BTC ETH SOL, search, last price with its side mark, 24h, Volume, Funding 1h, Index, then History, network select and wallet. Graphite strip 48px across the full width: four equal tabs, name left with the chain under it and the best bid or ask mark after the chain, Mid over the mid price right; the current tab raised with an off-white underline; a stale venue shows amber Reconnecting in place of Mid, over its mid in level3. Grid under it: the chart takes the rest beside the book (19rem), trades (16.25rem) and the ticket (22rem), about 656/247/211/286 at 1440: Chart with its intervals and OHLC as the title row over Depth (13rem), Order book opening on the last price with 14 levels a side, Trades, Order ticket with the order types as its first row and a submit that names the order at its foot. Bottom row: Account with tabs, figures and actions in one row across three columns, Venues table under the ticket. Status bar 26px with capital labels.

FORM: quoted venue tabs, position 2 of 3 on my grounded list in the safer round, mixed with the kept Venues panel by Eduardo's pick. seed:ee2f39cecf7b11cb

SIGNATURE: on a fill, the ticket's outcome line and the position row take an off-white wash that holds near full for the first third and then settles to rest by 900ms. When a venue newly takes the best bid or ask, its tab lifts the same way, at most once per venue every 2 seconds. Under reduced motion the wash shows without movement for the same time and then clears.

MOTION GRAMMAR: only a change in the account or in who holds the best price animates. Exponential ease-out for control feedback at 120ms; the 900ms signature holds for its first 35 percent, then eases out. Book, trades and chart get no motion beyond their direction marks. Nothing loops, nothing flashes more than three times a second.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
