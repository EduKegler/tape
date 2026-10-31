import type { RawLevel } from './types'

export const isText = (value: unknown): value is string => typeof value === 'string'

export const isNumber = (value: unknown): value is number => Number.isFinite(value)

export const isPairs = (value: unknown): value is RawLevel[] =>
  Array.isArray(value) && value.every((level: unknown) => Array.isArray(level) && isText(level[0]) && isText(level[1]))
