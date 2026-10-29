const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

export const formatCompact = (n: number) => compact.format(n)

export function formatPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
