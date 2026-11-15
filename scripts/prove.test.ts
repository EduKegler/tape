import { describe, expect, it } from 'vitest'
import { exitCode, readRun, refusal, verdictOf } from './prove.ts'
import type { RunOutcome } from './prove.ts'

const TREE = '/tmp/tree'

const file = (name: string, status: string, tests: [string, string][], message?: string) => ({
  name: `${TREE}/${name}`,
  status,
  message,
  assertionResults: tests.map(([fullName, testStatus]) => ({ fullName, status: testStatus })),
})

describe('readRun', () => {
  it('reads a run with every test passing as passed', () => {
    const run = readRun(
      {
        testResults: [
          file('a.test.ts', 'passed', [
            ['adds', 'passed'],
            ['skips', 'pending'],
          ]),
        ],
      },
      TREE,
    )
    expect(run).toEqual({ outcome: 'passed', tests: 2, failedTests: [], loadProblems: [] })
  })

  it('reads a failed test as an assertion failure and names it relative to the tree', () => {
    const run = readRun(
      {
        testResults: [
          file(
            'a.test.ts',
            'failed',
            [
              ['adds', 'passed'],
              ['rounds', 'failed'],
            ],
            'expected 1 to be 2',
          ),
        ],
      },
      TREE,
    )
    expect(run.outcome).toBe('assertion-failed')
    expect(run.failedTests).toEqual(['a.test.ts > rounds'])
  })

  it('reads a failed file that ran no test as a load failure carrying its message', () => {
    const run = readRun({ testResults: [file('a.test.ts', 'failed', [], "Cannot find module './b.ts'")] }, TREE)
    expect(run.outcome).toBe('load-failed')
    expect(run.loadProblems).toEqual(["a.test.ts: Cannot find module './b.ts'"])
  })

  it('reads a failed file with no failed test as a load failure even when tests are listed', () => {
    const run = readRun({ testResults: [file('a.test.ts', 'failed', [['adds', 'skipped']], 'beforeAll threw')] }, TREE)
    expect(run.outcome).toBe('load-failed')
  })

  it('reads a run with no test file as a load failure', () => {
    expect(readRun({ testResults: [] }, TREE).outcome).toBe('load-failed')
  })

  it('reads a file with no test as a load failure', () => {
    expect(readRun({ testResults: [file('a.test.ts', 'passed', [])] }, TREE).outcome).toBe('load-failed')
  })

  it('lets a load failure in one file outrank an assertion failure in another', () => {
    const run = readRun(
      {
        testResults: [
          file('a.test.ts', 'failed', [['rounds', 'failed']]),
          file('b.test.ts', 'failed', [], 'SyntaxError'),
        ],
      },
      TREE,
    )
    expect(run.outcome).toBe('load-failed')
    expect(run.failedTests).toEqual(['a.test.ts > rounds'])
  })
})

describe('verdictOf', () => {
  it('proves a fix when a test fails on base and every test passes on head', () => {
    expect(verdictOf('assertion-failed', 'passed')).toBe('proved')
  })

  it('does not prove a fix when every test passes on base', () => {
    expect(verdictOf('passed', 'passed')).toBe('not proved')
  })

  it('could not run when the base does not load', () => {
    expect(verdictOf('load-failed', 'passed')).toBe('could not run')
  })

  it.each<RunOutcome>(['assertion-failed', 'load-failed'])('could not run when the head is %s', (head) => {
    for (const base of ['passed', 'assertion-failed', 'load-failed'] as const) {
      expect(verdictOf(base, head)).toBe('could not run')
    }
  })
})

describe('exitCode', () => {
  it('exits 0 for proved, 1 for not proved and 2 for could not run', () => {
    expect([exitCode('proved'), exitCode('not proved'), exitCode('could not run')]).toEqual([0, 1, 2])
  })
})

describe('refusal', () => {
  it('accepts Vitest files in the app, the packages and the scripts', () => {
    expect(
      refusal(['src/ui/Ticket.test.tsx', 'packages/core/src/book.test.ts', 'scripts/prove.test.ts']),
    ).toBeUndefined()
  })

  it('refuses a Playwright spec, naming it', () => {
    expect(refusal(['e2e/trading.testnet.spec.ts'])).toContain('e2e/trading.testnet.spec.ts')
    expect(refusal(['e2e/trading.testnet.spec.ts'])).toContain('Vitest files')
  })

  it('refuses a test file under e2e and a file that is not a test', () => {
    expect(refusal(['e2e/replay/frames.test.ts'])).toBeDefined()
    expect(refusal(['src/ui/Ticket.tsx'])).toBeDefined()
  })

  it('refuses when one of several files is not a Vitest file', () => {
    expect(refusal(['src/a.test.ts', 'src/b.spec.ts'])).toContain('src/b.spec.ts')
  })

  it('refuses an empty list', () => {
    expect(refusal([])).toBeDefined()
  })
})
