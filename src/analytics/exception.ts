import type { AppEvent } from './events'

export type ExceptionEvent = Extract<AppEvent, { event: '$exception' }>
type Source = ExceptionEvent['source']
type Frame = ExceptionEvent['frames'][number]

/** The chunk id format of the PostHog build plugin. */
export const CHUNK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_FRAMES = 20
const MAX_FILE = 300
const MAX_FN = 100
const MAX_TYPE = 100
const MAX_VALUE = 500
const MAX_PER_CONTEXT = 10

const V8 = /^\s*at (?:(.+?) \()?(\S+):(\d+):(\d+)\)?$/
const GECKO = /^([^@]*)@(\S+):(\d+):(\d+)$/

/** Libraries such as viem, and dYdX indexer URLs, put addresses and keys in error messages. */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/0x[0-9a-f]{40,}/gi, '0x…'],
  [/\b[0-9a-f]{40,}\b/gi, '…'],
  [/\bdydx1[02-9ac-hj-np-z]{38,}/g, 'dydx1…'],
]

interface Page {
  readonly origin: string
  /** The PostHog build plugin keys each chunk's id by a `new Error().stack` taken inside that chunk. */
  readonly chunkIds: Readonly<Record<string, string>>
}

const here = (): Page => ({
  origin: location.origin,
  chunkIds: (globalThis as { _posthogChunkIds?: Record<string, string> })._posthogChunkIds ?? {},
})

function scriptUrl(raw: string): string | null {
  if (!URL.canParse(raw)) return null
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const file = url.origin + url.pathname
  return file.length <= MAX_FILE ? file : null
}

/** Browser engines print the newest call first. */
function parseStack(stack: string): Frame[] {
  return stack.split('\n').flatMap((text) => {
    const match = V8.exec(text) ?? GECKO.exec(text)
    const file = match?.[2] ? scriptUrl(match[2]) : null
    const line = Number(match?.[3])
    const col = Number(match?.[4])
    if (!file || !Number.isSafeInteger(line) || !Number.isSafeInteger(col)) return []
    return [{ file, fn: (match?.[1] || '?').slice(0, MAX_FN), line, col }]
  })
}

function chunkOf(chunkIds: Page['chunkIds']): ReadonlyMap<string, string> {
  const byFile = new Map<string, string>()
  for (const [stack, id] of Object.entries(chunkIds)) {
    const top = parseStack(stack)[0]
    if (top && CHUNK_ID.test(id)) byFile.set(top.file, id)
  }
  return byFile
}

const scrub = (text: string) =>
  SECRETS.reduce((scrubbed, [pattern, mask]) => scrubbed.replace(pattern, mask), text).slice(0, MAX_VALUE)

/** Wallet extensions inject scripts that throw on every page, so an uncaught error with no frame of ours is dropped. */
export function toException(
  error: unknown,
  source: Source,
  handled: boolean,
  page: Page = here(),
): ExceptionEvent | null {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return null
  const chunks = chunkOf(page.chunkIds)
  const frames = parseStack(error.stack)
    .slice(0, MAX_FRAMES)
    .reverse()
    .map((frame) => {
      const chunk = chunks.get(frame.file)
      return chunk ? { ...frame, chunk } : frame
    })
  if (!frames.length) return null
  const ours = frames.some((frame) => new URL(frame.file).origin === page.origin)
  if (!ours && (source === 'window' || source === 'promise')) return null
  return {
    event: '$exception',
    type: (error.name || 'Error').slice(0, MAX_TYPE),
    value: scrub(error.message),
    handled,
    source,
    frames,
  }
}

export function createReporter(send: (event: ExceptionEvent) => void, page: () => Page = here) {
  const seen = new Set<string>()
  return (error: unknown, source: Source, handled: boolean) => {
    if (seen.size >= MAX_PER_CONTEXT) return
    const event = toException(error, source, handled, page())
    const top = event?.frames.at(-1)
    if (!event || !top) return
    const key = `${event.type}\n${event.value}\n${top.file}:${top.line}:${top.col}`
    if (seen.has(key)) return
    seen.add(key)
    send(event)
  }
}
