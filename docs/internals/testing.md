# Testing

How to write a test for Tape, and when to ask for one in review.

## What to test

- Test what can break: decimal math, book sync, venue parsing, signing, order building, history, a race the code guards against, and the logic a bug fix changed. Leave out tests for what the types already guarantee, trivial logic, copy text, mirrors of mock calls, callback wiring and static markup.
- Extend before you add. When an existing test or `it.each` table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer, the lowest one that fails on `main`. A test that repeats another layer's proof stays out, so a rule a package test proves gets no e2e spec too.
- In review, ask for a missing test only when it would catch a real regression, and name the fix for a test that breaks these rules: fold it into an existing case, move it down a layer, or delete it.

## Proof for a bug fix

The proof depends on the bug.

- A logic, data, state or protocol bug gets a test that fails on `main`, in the same commit as the fix. Put it in an existing case of the module's test file where one fits. `pnpm prove <test file>` shows a Vitest test failing on the base and passing on the fix.
- A purely visual bug, such as spacing, color, alignment or a layout shift, gets screenshots before and after in the PR and no test. Do not add an e2e spec for a visual nitpick, and do not ask for one in review when the screenshots show it.

## Layers

| What it proves | Layer | Expected value comes from |
| --- | --- | --- |
| Decimal math, ticks and steps, order building, book sync | Vitest in Node, examples and fast-check properties | A hand calculation, the venue's docs, or a plain model written in the test |
| Venue parsers and adapters | Vitest in Node over `packages/venues/src/__fixtures__/` | Frames recorded from the venue |
| Signing | Vitest in Node | A published vector, such as RFC 8032 in `orderly/sign.test.ts`, or viem's `hashTypedData` |
| History and PnL | Vitest in Node | The venue's own numbers, such as Hyperliquid's `closedPnl` |
| UI wiring and journeys | Playwright in `e2e/`, run by `pnpm e2e` on the production builds over [the recorded replay](overview.md#the-recorded-replay), with no network. Chromium runs on each PR, Firefox and WebKit run nightly | What the user reads on screen |
| Each venue still serves the book the testnet build reads | Playwright in `e2e/live.smoke.ts`, run only by the nightly, against the live venues | A live book on screen |
| Components, visual regression, Storybook | None | Rules live in packages and get Node tests |

A `*.testnet.spec.ts` or `*.mainnet.spec.ts` runs on that network's build, any other spec runs on mainnet, and a test whose result depends on the network takes the `@each-network` tag to run on both.

The `verify-tape` skill explores and reproduces bugs against live data. Regressions belong to `pnpm e2e`. A spec finds elements by role and accessible name, and a `data-testid` goes in only where neither is reliable. An e2e spec never raises a timeout: a test that needs a longer timeout to pass is wrong, so make the time controllable instead, as the replay build does for query retry delay.

## Expected values

The expected value never comes from a run of the code under test. Another model writing the test does not fix that, because it reads the same code and guesses the same value.

A property's generators stay inside its valid domain, and invalid input gets its own refusal test. Use `fast-check` with `fc.assert` inside a Vitest `it`. The `it` and `test` from `@fast-check/vitest` rerun every example test `numRuns` times.

## Before a venue ships

Before a venue ships, its tests prove these:

- The recorded replay yields a live, uncrossed book, a reconnect resyncs it, and a late snapshot is ignored.
- A 5xx, a timeout or an unreadable reply on a write is an unknown outcome, and the order is then found by client id.
- A missing order is told apart from a missing key, and cancelling a filled order is not an error.
- A cancel the venue says it already holds, such as dYdX's `already exists` codes 9 and 32, is a done cancel, not a refused one.
- A 5xx, a timeout or an unreadable reply on a read means the venue is unreachable, never a missing order or account.
- Trading stays off on mainnet unless the build turns mainnet trading on for that venue.
