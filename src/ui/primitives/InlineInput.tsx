import type { ComponentProps } from 'react'

const sizes = {
  sm: 'h-6 rounded-sm px-1',
  md: 'h-9 rounded-md px-3 text-sm',
  lg: 'h-10.5 rounded-md px-3 text-sm',
}

export function InlineInput({
  className = '',
  size = 'sm',
  ...props
}: Omit<ComponentProps<'input'>, 'className' | 'type' | 'size'> & {
  type?: 'text' | 'date'
  className?: string
  size?: keyof typeof sizes
}) {
  return (
    <input
      {...props}
      className={`num border border-edge bg-inset text-level1 placeholder:text-level3 aria-invalid:border-err ${sizes[size]} ${className}`}
    />
  )
}
