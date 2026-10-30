import { describe, expect, it } from 'vitest'
import { AppEvent } from './events'
import { createReporter, toException } from './exception'
import type { ExceptionEvent } from './exception'

const SITE = 'https://tape.kegler.dev'
const BUNDLE = `${SITE}/assets/index-DvMkFl2s.js`
const CHUNK = '437b5dd7-1ce0-52dc-9602-3c07b1b25a59'

const V8_STACK = [
  'TypeError: level without price',
  `    at e (${BUNDLE}:1:1020)`,
  `    at ${BUNDLE}?v=3:1:1120`,
  '    at Array.map (<anonymous>)',
  `    at t (${BUNDLE}#x:1:1113)`,
  `    at globalThis.etTest (${BUNDLE}:1:1148)`,
  '    at file:///private/tmp/et-scripts/stack.mjs:5:14',
].join('\n')
const PAGE = {
  origin: SITE,
  chunkIds: {
    [`Error\n    at ${BUNDLE}:1:169\n    at ${BUNDLE}:1:307\n    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)`]:
      CHUNK,
  },
}

const JSC_STACK = [
  `parseLevel@${SITE}/assets/t.js:1:56`,
  `@${SITE}/assets/t.js:2:70`,
  'map@[native code]',
  `applyBookDelta@${SITE}/assets/t.js:2:52`,
  `global code@${SITE}/assets/t.js:3:21`,
].join('\n')

const GECKO_STACK = [
  `parseLevel@${SITE}/assets/t.js:1:56`,
  `applyBookDelta/<@${SITE}/assets/t.js:2:70`,
  `applyBookDelta@${SITE}/assets/t.js:2:52`,
].join('\n')

function thrown(message: string, stack: string, name = 'TypeError'): Error {
  const error = new Error(message)
  error.name = name
  error.stack = stack
  return error
}

describe('toException', () => {
  it('turns a V8 stack into frames oldest first with chunk ids, scripts only', () => {
    const event = toException(thrown('level without price', V8_STACK), 'window', false, PAGE)
    expect(event).toEqual({
      event: '$exception',
      type: 'TypeError',
      value: 'level without price',
      handled: false,
      source: 'window',
      frames: [
        { file: BUNDLE, fn: 'globalThis.etTest', line: 1, col: 1148, chunk: CHUNK },
        { file: BUNDLE, fn: 't', line: 1, col: 1113, chunk: CHUNK },
        { file: BUNDLE, fn: '?', line: 1, col: 1120, chunk: CHUNK },
        { file: BUNDLE, fn: 'e', line: 1, col: 1020, chunk: CHUNK },
      ],
    })
    expect(AppEvent.safeParse(event).success).toBe(true)
  })

  it.each([
    ['JavaScriptCore', JSC_STACK, ['global code', 'applyBookDelta', '?', 'parseLevel']],
    ['Firefox', GECKO_STACK, ['applyBookDelta', 'applyBookDelta/<', 'parseLevel']],
  ])('reads a %s stack', (_, stack, fns) => {
    const event = toException(thrown('x', stack), 'promise', false, { origin: SITE, chunkIds: {} })
    expect(event?.frames.map((f) => f.fn)).toEqual(fns)
    expect(event?.frames.at(-1)).toEqual({ file: `${SITE}/assets/t.js`, fn: 'parseLevel', line: 1, col: 56 })
  })

  it('drops an uncaught error thrown only by a wallet extension', () => {
    const extension = [
      'Error: Cannot redefine property: ethereum',
      '    at Object.defineProperty (<anonymous>)',
      '    at chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js:1:16521',
      '    at https://cdn.wallet.example/inject.js:2:10',
    ].join('\n')
    const page = { origin: SITE, chunkIds: {} }
    expect(toException(thrown('Cannot redefine property: ethereum', extension), 'window', false, page)).toBeNull()
    expect(toException(thrown('Cannot redefine property: ethereum', extension), 'promise', false, page)).toBeNull()
    expect(toException(thrown('x', extension), 'trade', true, page)?.frames).toHaveLength(1)
  })

  it('drops a value that carries no stack', () => {
    expect(toException('rejected', 'promise', false, PAGE)).toBeNull()
    expect(toException({ code: 4001, message: 'User rejected' }, 'trade', true, PAGE)).toBeNull()
  })

  it('keeps addresses and keys out of the message', () => {
    const address = '0x8ba1f109551bD432803012645Ac136ddd64DBA72'
    const message = `call reverted from ${address} key ${'ab'.repeat(32)} at /v4/addresses/dydx1qy352euf40x77qfrg4ncn27daufrg4ncnasxfa`
    const event = toException(thrown(message, V8_STACK), 'trade', true, PAGE)
    expect(event?.value).toBe('call reverted from 0x… key … at /v4/addresses/dydx1…')
  })

  it('keeps every field inside what the server accepts', () => {
    const long = [
      `Error: ${'m'.repeat(2000)}`,
      ...Array.from({ length: 60 }, (_, i) => `    at ${'f'.repeat(300)} (${SITE}/assets/a${i}.js:${i}:${i})`),
      `    at x (${SITE}/${'p'.repeat(400)}.js:1:1)`,
    ].join('\n')
    const event = toException(thrown('m'.repeat(2000), long, 'E'.repeat(300)), 'router', true, PAGE)
    expect(event?.frames).toHaveLength(20)
    expect(event?.frames.at(-1)?.file).toBe(`${SITE}/assets/a0.js`)
    expect(AppEvent.safeParse(event).success).toBe(true)
  })
})

describe('createReporter', () => {
  const page = () => PAGE

  it('sends the same error once', () => {
    const sent: ExceptionEvent[] = []
    const report = createReporter((e) => sent.push(e), page)
    report(thrown('a', V8_STACK), 'window', false)
    report(thrown('a', V8_STACK), 'promise', false)
    report(thrown('b', V8_STACK), 'window', false)
    expect(sent.map((e) => e.value)).toEqual(['a', 'b'])
  })

  it('stops after ten errors', () => {
    const sent: ExceptionEvent[] = []
    const report = createReporter((e) => sent.push(e), page)
    for (let i = 0; i < 25; i++) report(thrown(`error ${i}`, V8_STACK), 'window', false)
    expect(sent).toHaveLength(10)
  })

  it('does not spend the cap on errors it drops', () => {
    const sent: ExceptionEvent[] = []
    const report = createReporter((e) => sent.push(e), page)
    for (let i = 0; i < 25; i++) report(`no stack ${i}`, 'promise', false)
    report(thrown('a', V8_STACK), 'window', false)
    expect(sent).toHaveLength(1)
  })
})
