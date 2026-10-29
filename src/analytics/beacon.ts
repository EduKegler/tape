import type { Batch } from './events'

export const MAX_BODY = 32_000
export const MAX_EVENTS = 50

export function pack(session: string, events: Batch['events']): string[] {
  const empty = JSON.stringify({ session, events: [] } satisfies Batch).length
  const bodies: string[] = []
  let part: Batch['events'] = []
  let size = empty
  for (const entry of events) {
    const added = JSON.stringify(entry).length + 1
    if (part.length && (part.length === MAX_EVENTS || size + added > MAX_BODY)) {
      bodies.push(JSON.stringify({ session, events: part } satisfies Batch))
      part = []
      size = empty
    }
    part.push(entry)
    size += added
  }
  if (part.length) bodies.push(JSON.stringify({ session, events: part } satisfies Batch))
  return bodies
}
