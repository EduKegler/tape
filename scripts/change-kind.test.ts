import { describe, expect, it } from 'vitest'
import { changeKind } from './change-kind.ts'

describe('changeKind', () => {
  it('reads a change of markdown only as docs', () => {
    expect(changeKind(['README.md', 'packages/core/README.md'])).toBe('docs')
  })

  it('reads markdown with unit tests outside e2e and fixtures as tests', () => {
    expect(changeKind(['CLAUDE.md', 'packages/core/src/decimal.test.ts', 'src/ui/Ticket.test.tsx'])).toBe('tests')
    expect(changeKind(['packages/trade/src/history.test.ts'])).toBe('tests')
  })

  it('reads a test inside e2e as code', () => {
    expect(changeKind(['e2e/trading.test.ts'])).toBe('code')
    expect(changeKind(['README.md', 'e2e/replay/frames.test.ts'])).toBe('code')
  })

  it('reads a test inside a fixtures folder as code', () => {
    expect(changeKind(['packages/venues/src/__fixtures__/book.test.ts'])).toBe('code')
  })

  it('reads a recorded fixture as code', () => {
    expect(changeKind(['packages/venues/src/__fixtures__/hyperliquid-mainnet.json'])).toBe('code')
  })

  it('reads an empty change as code', () => {
    expect(changeKind([])).toBe('code')
  })

  it('reads one source file among docs and tests as code', () => {
    const skippable = ['CLAUDE.md', 'docs/a.md', 'packages/core/src/decimal.test.ts']
    for (const source of ['src/server.ts', 'packages/trade/src/order.ts', 'package.json', 'pnpm-lock.yaml']) {
      for (let at = 0; at <= skippable.length; at++) {
        expect(changeKind(skippable.toSpliced(at, 0, source))).toBe('code')
      }
    }
  })

  it('reads files that only look like tests or docs as code', () => {
    expect(changeKind(['src/test.ts'])).toBe('code')
    expect(changeKind(['src/decimal.test.js'])).toBe('code')
    expect(changeKind(['notes.md.ts'])).toBe('code')
    expect(changeKind(['README.mdx'])).toBe('code')
  })
})
