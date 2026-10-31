import type { ComponentProps } from 'react'

export function InlineInput({
  className = '',
  ...props
}: Omit<ComponentProps<'input'>, 'className' | 'type'> & { type?: 'text' | 'date'; className?: string }) {
  return (
    <input
      {...props}
      className={`num h-6 rounded-sm border border-edge bg-inset px-1 text-level1 outline-none focus:border-accent aria-invalid:border-warn ${className}`}
    />
  )
}
