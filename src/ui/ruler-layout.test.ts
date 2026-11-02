import { describe, expect, it } from 'vitest'
import { domainOf, laneLabels, nearEdge, priceAt, spreadChips, toX } from './ruler-layout'

describe('ruler domain', () => {
  it('pads the prices by 16% of their span on each side', () => {
    const [low, high] = domainOf(100, [90, 110], null)
    expect(low).toBeCloseTo(86.8)
    expect(high).toBeCloseTo(113.2)
  })

  it('is at least 1% of now wide', () => {
    const [low, high] = domainOf(100, [], null)
    expect(low).toBeCloseTo(99.84)
    expect(high).toBeCloseTo(100.16)
  })

  it('takes in a liquidation within half the span of an edge, and leaves a far one out', () => {
    const [low, high] = domainOf(100, [90, 110], 84)
    expect(low).toBeCloseTo(82.72)
    expect(high).toBeCloseTo(113.2)
    const [farLow] = domainOf(100, [90, 110], 70)
    expect(farLow).toBeCloseTo(86.8)
  })
})

describe('ruler positions', () => {
  it('maps prices onto the track between its 8 unit insets', () => {
    expect(toX([0, 100], 0)).toBe(8)
    expect(toX([0, 100], 50)).toBe(170)
    expect(toX([0, 100], 100)).toBe(332)
  })

  it('reads a price back from a fraction of the drawn width, held to the track', () => {
    expect(priceAt([0, 100], 0.5)).toBeCloseTo(50)
    expect(priceAt([0, 100], 0)).toBe(0)
    expect(priceAt([0, 100], 1)).toBe(100)
  })

  it('calls the outer 6% of the span an edge', () => {
    expect(nearEdge([0, 100], 5)).toBe(true)
    expect(nearEdge([0, 100], 50)).toBe(false)
    expect(nearEdge([0, 100], 95)).toBe(true)
  })
})

describe('ruler labels', () => {
  it('drops a label that would touch the one before it to the second lane', () => {
    const placed = laneLabels([
      { at: 200, half: 20 },
      { at: 110, half: 20 },
      { at: 100, half: 20 },
    ])
    expect(placed.map(({ center, lane }) => [center, lane])).toEqual([
      [100, 0],
      [110, 1],
      [200, 0],
    ])
  })

  it('marks a second-lane label whose leader would run through a first-lane label', () => {
    // 100 takes lane 0 and spans 80 to 120; 110 and 125 both fall to lane 1, and only 110 sits under that span.
    const placed = laneLabels([
      { at: 100, half: 20 },
      { at: 110, half: 20 },
      { at: 125, half: 5 },
    ])
    expect(placed.map(({ at, lane, crossed }) => [at, lane, crossed])).toEqual([
      [100, 0, false],
      [110, 1, true],
      [125, 1, false],
    ])
  })

  it('keeps a label at the edge inside the ruler', () => {
    expect(laneLabels([{ at: 5, half: 20 }])[0]!.center).toBe(20)
  })
})

describe('ruler chips', () => {
  it('pushes two close chips a chip and a gap apart, in the order given', () => {
    expect(spreadChips([100, 120])).toEqual([68, 152])
    expect(spreadChips([120, 100])).toEqual([152, 68])
  })

  it('keeps a chip inside the ruler', () => {
    expect(spreadChips([335])).toEqual([301])
  })
})
