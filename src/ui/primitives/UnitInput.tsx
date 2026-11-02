import type { ComponentProps } from 'react'

/** A compact number field with its unit inside, named by `label` for screen readers only. */
export function UnitInput({
  label,
  unit,
  className = '',
  ...props
}: Omit<ComponentProps<'input'>, 'className' | 'type' | 'size'> & { label: string; unit: string; className?: string }) {
  return (
    <label
      className={`flex h-8 min-w-0 items-center gap-1 rounded-md border border-edge bg-inset px-2.5 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent has-aria-invalid:border-err ${className}`}
    >
      <span className="sr-only">{label}</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        {...props}
        className="num min-w-0 flex-1 bg-transparent text-right text-base font-medium text-level1 outline-none! placeholder:text-level3"
      />
      <span aria-hidden className="shrink-0 text-xs text-level3">
        {unit}
      </span>
    </label>
  )
}
