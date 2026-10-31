import { plainDecimal } from './fixed'

/**
 * JSON.parse that keeps every number as its source text. Orderly sends prices as JSON numbers,
 * and the text is exact where a double is not. Engines without reviver source text get the double
 * as a plain decimal, since String writes 0.0000001 as 1e-7.
 */
export function parseExactJson<T>(raw: string): T {
  return JSON.parse(raw, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? (context?.source ?? plainDecimal(String(value))) : value,
  ) as T
}
