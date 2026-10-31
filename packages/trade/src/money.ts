import { plainDecimal, wireDecimal } from '@tape/core/fixed'
import type { Brand } from '@tape/core/ids'
import { toDecimal } from './types'
import type { Decimal } from './types'

/** A signed exact decimal counted in 10^-18 units. Venue amounts carry fewer places, so sums of them stay exact. */
export type Amount = Brand<bigint, 'Amount'>

const PLACES = 18
const ONE = 10n ** BigInt(PLACES)

const fromUnits = (count: bigint) => count as Amount

export const ZERO = fromUnits(0n)

/** Throws on text that is not a plain or exponent decimal, and on more than 18 places. */
export function amount(text: string): Amount {
  const plain = plainDecimal(text.trim())
  const negative = plain.startsWith('-')
  const [whole = '0', fraction = ''] = plain.replace(/^-/, '').split('.')
  if (fraction.length > PLACES) throw new RangeError(`${text} has more than ${PLACES} decimal places`)
  const count = BigInt(whole) * ONE + BigInt(fraction.padEnd(PLACES, '0'))
  return fromUnits(negative ? -count : count)
}

function roundedQuotient(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n
  const absNumerator = numerator < 0n ? -numerator : numerator
  const absDenominator = denominator < 0n ? -denominator : denominator
  const quotient = (absNumerator * 2n + absDenominator) / (absDenominator * 2n)
  return negative ? -quotient : quotient
}

export const add = (left: Amount, right: Amount) => fromUnits(left + right)
export const subtract = (left: Amount, right: Amount) => fromUnits(left - right)
export const negate = (value: Amount) => fromUnits(0n - value)
export const abs = (value: Amount) => fromUnits(value < 0n ? 0n - value : value)
export const multiply = (left: Amount, right: Amount) => fromUnits(roundedQuotient(left * right, ONE))
export const divide = (left: Amount, right: Amount) => fromUnits(roundedQuotient(left * ONE, right))
export const sum = (values: Iterable<Amount>) => {
  let total = ZERO
  for (const value of values) total = add(total, value)
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
export const plain = (value: Amount): Decimal => toDecimal(wireDecimal(value, PLACES))
