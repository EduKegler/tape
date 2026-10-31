import { readFileSync } from 'node:fs'
import { hexToBytes } from 'viem'
import type { Hex } from 'viem'
import type { TradeVenueId } from './types'

/** One request Tape sent while recording, and the venue's answer. */
export interface RecordedExchange {
  readonly method: string
  readonly url: string
  /** The JSON body, without its signature. Null for a GET or a DELETE. */
  readonly request: unknown
  readonly status: number
  readonly response: unknown
}

/** What v4-client-js resolved or threw for one dYdX broadcast, with its byte arrays and bigints restored. */
export type RecordedBroadcast = { readonly method: 'placeOrder' | 'cancelOrder' } & (
  { readonly reply: unknown } | { readonly thrown: { readonly name: string; readonly message: string } }
)

export interface RecordedWrite {
  readonly exchanges: readonly RecordedExchange[]
  readonly chain: readonly RecordedBroadcast[]
}

interface Recording {
  readonly cases: Readonly<Record<string, Partial<RecordedWrite>>>
}

const revive = (_key: string, value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { bytes?: unknown; bigint?: unknown }
    if (typeof v.bytes === 'string' && Object.keys(v).length === 1) return hexToBytes(v.bytes as Hex)
    if (typeof v.bigint === 'string' && Object.keys(v).length === 1) return BigInt(v.bigint)
  }
  return value
}

const recordings = new Map<TradeVenueId, Recording>()

/** One case of the testnet writes `writes.record.test.ts` recorded. Throws on a case it did not record. */
export function recordedWrite(venue: TradeVenueId, name: string): RecordedWrite {
  let recording = recordings.get(venue)
  if (!recording) {
    const text = readFileSync(new URL(`./__fixtures__/writes.${venue}.json`, import.meta.url), 'utf8')
    recording = JSON.parse(text, revive) as Recording
    recordings.set(venue, recording)
  }
  const found = recording.cases[name]
  if (!found) throw new Error(`writes.${venue}.json has no case ${name}`)
  return { exchanges: found.exchanges ?? [], chain: found.chain ?? [] }
}
