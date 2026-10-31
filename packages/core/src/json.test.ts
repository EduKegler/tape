import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExactJson } from './json'

describe('parseExactJson', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a number as a plain decimal in an engine without reviver source text', () => {
    const parse = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) =>
      parse(text, reviver && ((key, value: unknown) => reviver.call(undefined, key, value) as unknown)),
    )
    // Orderly's PERP_1000PEPE_USDC ticks, as packages/venues/src/__fixtures__/orderly.info.json records them.
    expect(parseExactJson('{"quote_tick":0.0000001,"base_tick":100}')).toEqual({
      quote_tick: '0.0000001',
      base_tick: '100',
    })
  })
})
