/** The record's own keys, typed as its key union. */
export const keysOf = <TKey extends string>(record: Readonly<Record<TKey, unknown>>): TKey[] =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TypeScript's lib types Object.keys as string[]
  Object.keys(record) as TKey[]

/** A record with one entry per key, in key order. */
export const fromKeys = <TKey extends PropertyKey, TValue>(
  keys: readonly TKey[],
  value: (key: TKey) => TValue,
): Record<TKey, TValue> => {
  const entries = keys.map((key) => [key, value(key)] as const)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TypeScript's lib types Object.fromEntries with a string index
  return Object.fromEntries(entries) as Record<TKey, TValue>
}
