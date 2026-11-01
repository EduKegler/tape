import type { ReactNode } from 'react'

const looks = {
  sm: 'h-6 rounded-md bg-raised pr-6 pl-2 text-sm font-medium',
  md: 'h-8 rounded-md border border-edge bg-surface pr-7 pl-3 text-sm',
  field: 'h-11 w-full rounded-md border border-edge bg-inset pr-8 pl-3 text-base',
}

export function Select({
  size,
  onChange,
  ...props
}: {
  size: keyof typeof looks
  value: string | number | undefined
  onChange: (value: string) => void
  children: ReactNode
  id?: string
  name?: string
  disabled?: boolean
}) {
  return (
    <span className={`relative inline-flex ${size === 'field' ? 'w-full' : ''}`}>
      <select
        {...props}
        onChange={(event) => onChange(event.target.value)}
        className={`appearance-none text-level1 disabled:opacity-40 ${looks[size]}`}
      />
      <svg
        aria-hidden
        viewBox="0 0 8 5"
        className={`pointer-events-none absolute top-1/2 size-2 -translate-y-1/2 fill-current text-level3 ${size === 'sm' ? 'right-2' : 'right-3'}`}
      >
        <path d="M0 0h8L4 5Z" />
      </svg>
    </span>
  )
}
