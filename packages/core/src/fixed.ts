import type { Brand } from './ids'

/**
 * Fixed-point decimals as safe integers. A Px counts 10^-scale.px quote units,
 * a Qty counts 10^-scale.qty base units. The scale belongs to the market, so
 * two values from one market add, compare and group with integer math, which
 * doubles do exactly below 2^53. Px * Qty can pass 2^53, so notional is bigint.
 */
export type Px = Brand<number, 'Px'>
export type Qty = Brand<number, 'Qty'>

export type Decimals = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export interface Scale {
  readonly px: Decimals
  readonly qty: Decimals
}

export class DecimalError extends Error {
  constructor(
    readonly input: string,
    readonly reason: 'syntax' | 'precision' | 'unsafe',
  ) {
    super(`bad decimal ${input}: ${reason}`)
  }
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/

function parseUnits(input: string, decimals: Decimals): number {
  const match = DECIMAL.exec(input)
  if (!match) throw new DecimalError(input, 'syntax')
  const whole = match[1] as string
  const fraction = match[2] ?? ''
  if (/[1-9]/.test(fraction.slice(decimals))) throw new DecimalError(input, 'precision')
  const units = Number(whole + fraction.slice(0, decimals).padEnd(decimals, '0'))
  if (!Number.isSafeInteger(units)) throw new DecimalError(input, 'unsafe')
  return units
}

export function parsePx(input: string, scale: Scale): Px {
  return parseUnits(input, scale.px) as Px
}

export function parseQty(input: string, scale: Scale): Qty {
  return parseUnits(input, scale.qty) as Qty
}

/** Decimal places a venue increment string implies: "0.01000000" is 2, "1" is 0. */
export function decimalsOf(increment: string): Decimals {
  const fraction = increment.split('.')[1]?.replace(/0+$/, '') ?? ''
  return Math.min(fraction.length, 8) as Decimals
}

const grouping = new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 })

function formatUnits(units: bigint, scaleDecimals: number, decimals: number): string {
  const negative = units < 0n
  let abs = negative ? -units : units
  if (decimals < scaleDecimals) abs /= 10n ** BigInt(scaleDecimals - decimals)
  else abs *= 10n ** BigInt(decimals - scaleDecimals)
  const digits = abs.toString().padStart(decimals + 1, '0')
  const whole = grouping.format(BigInt(digits.slice(0, digits.length - decimals)))
  const fraction = decimals > 0 ? `.${digits.slice(-decimals)}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}

/** Exact. Fewer decimals than the scale truncates toward zero. */
export function formatPx(px: Px, scale: Scale, decimals: number = scale.px): string {
  return formatUnits(BigInt(px), scale.px, decimals)
}

export function formatQty(qty: Qty, scale: Scale, decimals: number = scale.qty): string {
  return formatUnits(BigInt(qty), scale.qty, decimals)
}

/** The shortest exact decimal for a venue's wire: no grouping, no trailing zeros. */
export function wireDecimal(units: Px | Qty | bigint, decimals: number): string {
  const abs = BigInt(units) < 0n ? -BigInt(units) : BigInt(units)
  const digits = abs.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${BigInt(units) < 0n ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** A JSON number's source text as a plain decimal: "1e-7" is "0.0000001", "-2.5E+3" is "-2500". */
export function plainDecimal(source: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source)
  if (!match) throw new DecimalError(source, 'syntax')
  const [, sign, whole, fraction = '', exp = '0'] = match as unknown as [string, string, string, string | undefined, string | undefined]
  const digits = `${whole}${fraction}`
  const point = whole.length + Number(exp)
  const padded = point <= 0 ? `${'0'.repeat(1 - point)}${digits}` : digits.padEnd(point, '0')
  const at = Math.max(point, 1)
  const int = padded.slice(0, at).replace(/^0+(?=\d)/, '')
  const frac = padded.slice(at).replace(/0+$/, '')
  return `${sign}${int}${frac ? `.${frac}` : ''}`
}

/** Px * Qty at scale px + qty. */
export function notional(px: Px, qty: Qty): bigint {
  return BigInt(px) * BigInt(qty)
}

export function formatNotional(value: bigint, scale: Scale, decimals = 2): string {
  return formatUnits(value, scale.px + scale.qty, decimals)
}

export function rescalePx(px: Px, from: Decimals, to: Decimals): Px {
  const units = px * 10 ** (to - from)
  if (!Number.isSafeInteger(units)) throw new DecimalError(String(px), 'unsafe')
  return units as Px
}

/** (ask - bid) / mid in basis points, exact to 2 dp. */
export function spreadBps(bid: Px, ask: Px): string {
  const hundredths = (BigInt(ask - bid) * 2n * 1_000_000n) / BigInt(bid + ask)
  return formatUnits(hundredths, 2, 2)
}

export function formatMid(bid: Px, ask: Px, scale: Scale): string {
  const sum = BigInt(bid + ask)
  return sum % 2n === 0n ? formatUnits(sum / 2n, scale.px, scale.px) : formatUnits(sum * 5n, scale.px + 1, scale.px + 1)
}

/** The one exit from the integer domain, for chart coordinates and bar ratios. */
export function toDisplayFloat(units: Px | Qty, decimals: Decimals): number {
  return units / 10 ** decimals
}
