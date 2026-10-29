const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

export const formatCompact = (n: number) => compact.format(n)

export function formatPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

const tickFormats: Record<'year' | 'month' | 'day' | 'time' | 'seconds', Intl.DateTimeFormatOptions> = {
  year: { year: 'numeric' },
  month: { month: 'short' },
  day: { day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', hour12: false },
  seconds: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
}

/**
 * Chart time in the reader's zone, like the trade feed. Lightweight-charts shows UTC by default and
 * picks day, month and year marks at UTC midnight, so those read as a time unless it is local midnight too.
 */
export function formatChartTick(seconds: number, mark: keyof typeof tickFormats): string {
  const d = new Date(seconds * 1000)
  const calendar = mark === 'year' || mark === 'month' || mark === 'day'
  return d.toLocaleString('en-GB', tickFormats[calendar && (d.getHours() || d.getMinutes()) ? 'time' : mark])
}

export function formatChartTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
