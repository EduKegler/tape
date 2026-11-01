import type { VenueId } from '@tape/core/ids'
import type { CompareRow } from '#/core/topics'

const LIFT_GAP_MS = 2000

type Held = { readonly bid: boolean; readonly ask: boolean }

export interface LiftState {
  readonly held: ReadonlyMap<VenueId, Held> | null
  readonly lastLift: ReadonlyMap<VenueId, number>
}

export const NO_LIFTS: LiftState = { held: null, lastLift: new Map() }

export function takeLifts(
  state: LiftState,
  rows: readonly CompareRow[],
  now: number,
): { state: LiftState; lifted: VenueId[] } {
  const live = rows.filter((row) => row.status === 'live')
  const held = new Map(live.map((row) => [row.venue, { bid: row.bestBid, ask: row.bestAsk }]))
  if (!state.held) return { state: { ...state, held }, lifted: [] }
  const before = state.held
  const lastLift = new Map(state.lastLift)
  const lifted = live
    .filter((row) => {
      const was = before.get(row.venue)
      if (!was) return false
      const took = (row.bestBid && !was.bid) || (row.bestAsk && !was.ask)
      return took && now - (lastLift.get(row.venue) ?? -Infinity) >= LIFT_GAP_MS
    })
    .map((row) => row.venue)
  for (const venue of lifted) lastLift.set(venue, now)
  return { state: { held, lastLift }, lifted }
}
