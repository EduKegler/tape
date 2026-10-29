import { parseExactJson } from '@tape/core/json'
import { TradeFailure } from './types'
import type { TradeError, TradeVenueId } from './types'

export type Classify = (status: number, body: unknown, text: string) => TradeError | null

/**
 * Every venue request goes through here. A fetch that throws before a response means either
 * nothing left (a read) or the outcome is unknown (a signed action), and only the caller knows
 * which, so it says with `signed`. A body that parses goes to the venue's classifier first.
 */
export async function send<T>(venue: TradeVenueId, fetch: typeof globalThis.fetch, url: string, init: RequestInit & { signed: boolean }, classify: Classify): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new TradeFailure(venue, init.signed ? { kind: 'unknown-outcome', detail } : { kind: 'unreachable', detail })
  }
  let text: string
  try {
    text = await response.text()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new TradeFailure(venue, init.signed ? { kind: 'unknown-outcome', detail } : { kind: 'unreachable', detail })
  }
  // A signed request the server failed on may still have been applied, whatever its body says.
  if (init.signed && response.status >= 500) throw new TradeFailure(venue, { kind: 'unknown-outcome', detail: `${response.status} ${text}` })
  let body: unknown = null
  try {
    body = parseExactJson(text)
  } catch {
    body = null
  }
  const error = classify(response.status, body, text) ?? httpError(response.status, text, init.signed)
  if (error) throw new TradeFailure(venue, error)
  return body as T
}

function httpError(status: number, text: string, signed: boolean): TradeError | null {
  if (status === 429) return { kind: 'rate-limited', detail: text || 'Too many requests' }
  if (status >= 500) return signed ? { kind: 'unknown-outcome', detail: `${status} ${text}` } : { kind: 'unreachable', detail: `${status} ${text}` }
  if (status >= 400) return { kind: 'rejected', detail: `${status} ${text}` }
  return null
}

export const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
