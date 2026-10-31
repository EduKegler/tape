import { plainDecimal } from './fixed'

/**
 * JSON.parse that keeps every number as its source text. Orderly sends prices as JSON numbers,
 * and the text is exact where a double is not. Engines without reviver source text get the double
 * as a plain decimal, since String writes 0.0000001 as 1e-7.
 */
export function parseExactJson(raw: string): unknown {
  return JSON.parse(raw, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? (context?.source ?? plainDecimal(String(value))) : value,
  )
}

/** A JSON object, or any other non-null object, whose fields can be read one by one. Arrays are not records. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
