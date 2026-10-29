/**
 * JSON.parse that keeps every number as its source text. Orderly sends prices as JSON numbers,
 * and the text is exact where a double is not. Browsers without reviver source fall back to String.
 */
export function parseExactJson<T>(raw: string): T {
  return JSON.parse(raw, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? (context?.source ?? String(value)) : value,
  ) as T
}
