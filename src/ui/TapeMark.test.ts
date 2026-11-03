import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MARK } from './TapeMark'

describe('favicon', () => {
  it('draws the Tape mark', () => {
    const favicon = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8')
    expect(favicon).toContain(`d="${MARK}"`)
  })
})
