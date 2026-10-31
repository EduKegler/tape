import { readFileSync } from 'node:fs'
import { hexToBytes } from 'viem'
import { z } from 'zod'
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

const Recording = z.object({
  cases: z.record(
    z.string(),
    z.object({
      exchanges: z
        .array(
          z.object({
            method: z.string(),
            url: z.string(),
            request: z.unknown(),
            status: z.number(),
            response: z.unknown(),
          }),
        )
        .optional(),
      chain: z
        .array(
          z.union([
            z.object({
              method: z.enum(['placeOrder', 'cancelOrder']),
              thrown: z.object({ name: z.string(), message: z.string() }),
            }),
            z.object({ method: z.enum(['placeOrder', 'cancelOrder']), reply: z.unknown() }),
          ]),
        )
        .optional(),
    }),
  ),
})
type Recording = z.infer<typeof Recording>

const revive = (_key: string, value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const tagged = value as { bytes?: unknown; bigint?: unknown }
    if (typeof tagged.bytes === 'string' && Object.keys(tagged).length === 1) return hexToBytes(tagged.bytes as Hex)
    if (typeof tagged.bigint === 'string' && Object.keys(tagged).length === 1) return BigInt(tagged.bigint)
  }
  return value
}

const recordings = new Map<TradeVenueId, Recording>()

/** One case of the testnet writes `writes.record.test.ts` recorded. Throws on a case it did not record. */
export function recordedWrite(venue: TradeVenueId, name: string): RecordedWrite {
  let recording = recordings.get(venue)
  if (!recording) {
    const text = readFileSync(new URL(`./__fixtures__/writes.${venue}.json`, import.meta.url), 'utf8')
    recording = Recording.parse(JSON.parse(text, revive))
    recordings.set(venue, recording)
  }
  const found = recording.cases[name]
  if (!found) throw new Error(`writes.${venue}.json has no case ${name}`)
  return { exchanges: found.exchanges ?? [], chain: found.chain ?? [] }
}
