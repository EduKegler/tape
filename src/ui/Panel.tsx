import type { ReactNode } from 'react'
import { Button } from './primitives'

export function Panel({
  title,
  status,
  aside,
  children,
  className = '',
}: {
  title: string
  status?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`flex h-full min-h-0 flex-col border border-rule bg-surface ${className}`}>
      <header className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-rule px-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2 className="text-base whitespace-nowrap text-level1">{title}</h2>
          {status}
        </div>
        {aside}
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-3">
      {options.map((o) => (
        <Button
          key={o.value}
          look="toggle"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}
