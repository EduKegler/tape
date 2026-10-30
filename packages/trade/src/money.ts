import { plainDecimal, wireDecimal } from '@tape/core/fixed'
import type { Brand } from '@tape/core/ids'

/** A signed exact decimal counted in 10^-18 units. Venue amounts carry fewer places, so sums of them stay exact. */
export type Amount = Brand<bigint, 'Amount'>

const PLACES = 18
const ONE = 10n ** BigInt(PLACES)

export const ZERO = 0n as Amount

/** Throws on text that is not a plain or exponent decimal, and on more than 18 places. */
export function amount(text: string): Amount {
  const plain = plainDecimal(text.trim())
  const negative = plain.startsWith('-')
  const [whole = '0', fraction = ''] = plain.replace(/^-/, '').split('.')
  if (fraction.length > PLACES) throw new RangeError(`${text} has more than ${PLACES} decimal places`)
  const units = BigInt(whole) * ONE + BigInt(fraction.padEnd(PLACES, '0'))
  return (negative ? -units : units) as Amount
}

function roundedQuotient(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const q = (n * 2n + d) / (d * 2n)
  return negative ? -q : q
}

export const add = (a: Amount, b: Amount) => (a + b) as Amount
export const subtract = (a: Amount, b: Amount) => (a - b) as Amount
export const negate = (a: Amount) => (0n - a) as Amount
export const abs = (a: Amount) => (a < 0n ? 0n - a : a) as Amount
export const multiply = (a: Amount, b: Amount) => roundedQuotient(a * b, ONE) as Amount
export const divide = (a: Amount, b: Amount) => roundedQuotient(a * ONE, b) as Amount
export const sum = (values: Iterable<Amount>) => {
  let total = ZERO
  for (const v of values) total = add(total, v)
  return total
}

/** Exactly `places` decimals, rounded half away from zero. */
export function format(value: Amount, places: number): string {
  const units = roundedQuotient(value, 10n ** BigInt(PLACES - places))
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(places + 1, '0')
  const whole = digits.slice(0, digits.length - places)
  const fraction = places > 0 ? `.${digits.slice(-places)}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}

/** The shortest exact decimal: no trailing zeros. */
export const plain = (value: Amount) => wireDecimal(value, PLACES)
