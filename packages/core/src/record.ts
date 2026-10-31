/** The record's own keys, typed as its key union. */
export const keysOf = <TKey extends string>(record: Readonly<Record<TKey, unknown>>): TKey[] =>
  Object.keys(record) as TKey[]

/** A record with one entry per key, in key order. */
export const fromKeys = <TKey extends PropertyKey, TValue>(
  keys: readonly TKey[],
  value: (key: TKey) => TValue,
): Record<TKey, TValue> => Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<TKey, TValue>
