import { parseExactJson } from '@tape/core/json'
import { TradeFailure } from './types'
import type { TradeError, TradeVenueId } from './types'

export type Classify = (status: number, body: unknown, text: string) => TradeError | null

const REPLY_TIMEOUT_MS = 10_000

export async function send<T>(
  venue: TradeVenueId,
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit & { mutates: boolean },
  classify: Classify,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REPLY_TIMEOUT_MS) })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new TradeFailure(venue, init.mutates ? { kind: 'unknown-outcome', detail } : { kind: 'unreachable', detail })
  }
  let text: string
  try {
    text = await response.text()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new TradeFailure(venue, init.mutates ? { kind: 'unknown-outcome', detail } : { kind: 'unreachable', detail })
  }
  if (init.mutates && response.status >= 500)
    throw new TradeFailure(venue, { kind: 'unknown-outcome', detail: `${response.status} ${text}` })
  let body: unknown
  try {
    body = parseExactJson(text)
  } catch {
    body = null
  }
  const error = classify(response.status, body, text) ?? httpError(response.status, text, init.mutates)
  if (error) throw new TradeFailure(venue, error)
  return body as T
}

function httpError(status: number, text: string, mutates: boolean): TradeError | null {
  if (status === 429) return { kind: 'rate-limited', detail: text || 'Too many requests' }
  if (status >= 500)
    return mutates
      ? { kind: 'unknown-outcome', detail: `${status} ${text}` }
      : { kind: 'unreachable', detail: `${status} ${text}` }
  if (status >= 400) return { kind: 'rejected', detail: `${status} ${text}` }
  return null
}

export const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
