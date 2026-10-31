import type { ReactNode } from 'react'

const sizes = {
  sm: 'h-6 px-1 text-sm',
  md: 'h-8 px-2 text-sm',
  field: 'h-9 px-2 text-base',
}

export function Select({
  size,
  onChange,
  ...props
}: {
  size: keyof typeof sizes
  value: string | number | undefined
  onChange: (value: string) => void
  children: ReactNode
  id?: string
  name?: string
  disabled?: boolean
}) {
  return (
    <select
      {...props}
      onChange={(e) => onChange(e.target.value)}
      className={`num rounded-sm border border-edge bg-inset text-level1 disabled:opacity-40 ${sizes[size]}`}
    />
  )
}
