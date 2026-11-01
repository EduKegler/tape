import { useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react'
import { Button } from './primitives'

const rowsIn = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[data-row]:not([aria-hidden="true"])')]

const STEPS: Record<string, (at: number, last: number) => number> = {
  ArrowDown: (at, last) => Math.min(at + 1, last),
  ArrowUp: (at) => Math.max(at - 1, 0),
  Home: () => 0,
  End: (_, last) => last,
}

export function useRowKeys() {
  const [inside, setInside] = useState(false)
  const last = useRef<HTMLElement | null>(null)
  return {
    tabIndex: inside ? -1 : 0,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) {
        last.current = event.target
        setInside(true)
        return
      }
      const rows = rowsIn(event.currentTarget)
      const back = last.current && rows.includes(last.current) ? last.current : rows[0]
      back?.focus()
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setInside(false)
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = STEPS[event.key]
      if (!step) return
      const rows = rowsIn(event.currentTarget)
      const to =
        rows[
          step(
            rows.findIndex((row) => row === document.activeElement),
            rows.length - 1,
          )
        ]
      if (!to) return
      event.preventDefault()
      to.focus()
      to.scrollIntoView({ block: 'nearest' })
    },
  }
}

export function Panel({
  title,
  status,
  aside,
  children,
  className = '',
  tone = 'surface',
}: {
  title: string
  status?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  tone?: 'surface' | 'ticket'
}) {
  return (
    <section
      className={`flex h-full min-h-0 flex-col overflow-hidden rounded-lg ${tone === 'ticket' ? 'bg-ticket' : 'bg-surface'} ${className}`}
    >
      <header className="flex h-10.5 shrink-0 items-center justify-between gap-2 border-b border-rule px-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2 className="text-base/none font-semibold whitespace-nowrap text-level1">{title}</h2>
          {status}
        </div>
        {aside !== undefined && <div className="shrink-0 whitespace-nowrap">{aside}</div>}
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
      {options.map((option) => (
        <Button
          key={option.value}
          look="toggle"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
