import type { ReactNode } from 'react'

export function Panel({
  title,
  aside,
  children,
  className = '',
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`flex h-full min-h-0 flex-col border border-rule bg-panel ${className}`}>
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-rule px-3">
        <h2 className="font-display text-[15px] text-level1">{title}</h2>
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
    <div role="radiogroup" aria-label={label} className="flex rounded-full border border-rule p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${o.value === value ? 'bg-level1/12 text-level1' : 'text-level3 hover:text-level2'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
