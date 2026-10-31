import { Input as BaseInput } from '@base-ui/react/input'
import { useId } from 'react'
import type { ReactNode } from 'react'

export function Input(props: {
  label: string
  name: string
  value: string
  error: string | undefined
  hint: ReactNode
  onChange: (v: string) => void
  onBlur: () => void
}) {
  const id = useId()
  // The hint can be a button, so it sits beside the label and not inside it.
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex justify-between text-level3">
        <label htmlFor={id}>{props.label}</label>
        {props.hint}
      </div>
      <BaseInput
        id={id}
        name={props.name}
        inputMode="decimal"
        autoComplete="off"
        value={props.value}
        onValueChange={(v) => props.onChange(v.trim())}
        onBlur={props.onBlur}
        aria-invalid={Boolean(props.error)}
        aria-describedby={props.error ? `${id}-error` : undefined}
        className="num h-9 rounded-sm border border-edge bg-inset px-2 text-base text-level1 outline-none focus:border-accent aria-invalid:border-warn"
      />
      {props.error && (
        <span id={`${id}-error`} className="border-l-2 border-warn pl-2 text-level1">
          {props.error}
        </span>
      )}
    </div>
  )
}
