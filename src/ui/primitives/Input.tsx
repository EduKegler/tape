import { Input as BaseInput } from '@base-ui/react/input'
import { useId } from 'react'
import type { ReactNode, Ref } from 'react'
import { ErrorMark } from '../ErrorMark'

export function Input({
  inputRef,
  ...props
}: {
  label: string
  name: string
  value: string
  error: string | undefined
  warning?: string | null
  messageLine?: boolean
  hint: ReactNode
  unit?: string
  onChange: (v: string) => void
  onBlur?: () => void
  disabled?: boolean
  inputRef?: Ref<HTMLInputElement>
}) {
  const id = useId()
  const message = props.error ? `${id}-error` : props.warning ? `${id}-warning` : undefined
  const fit = props.messageLine ? 'truncate' : ''
  // The hint can be a button, so it sits beside the label and not inside it.
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex justify-between text-xs text-level3">
        <label htmlFor={id}>{props.label}</label>
        {props.hint}
      </div>
      <div className="relative">
        <BaseInput
          ref={inputRef}
          id={id}
          name={props.name}
          inputMode="decimal"
          autoComplete="off"
          value={props.value}
          onValueChange={(value) => props.onChange(value.trim())}
          onBlur={props.onBlur}
          disabled={props.disabled}
          aria-invalid={Boolean(props.error)}
          aria-describedby={message}
          className={`num h-11 w-full rounded-md border border-edge bg-inset pl-3 text-base font-medium text-level1 aria-invalid:border-err ${props.unit ? 'pr-8' : 'pr-3'}`}
        />
        {props.unit && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-level3"
          >
            {props.unit}
          </span>
        )}
      </div>
      <div
        aria-live={props.warning === undefined ? undefined : 'polite'}
        className={props.messageLine ? 'h-4.5 leading-4.5' : 'contents'}
      >
        {props.error ? (
          <span className="flex gap-1.5">
            <ErrorMark />
            <span id={message} title={props.error} className={`min-w-0 text-level1 ${fit}`}>
              {props.error}
            </span>
          </span>
        ) : props.warning ? (
          <span id={message} title={props.warning} className={`block text-warn ${fit}`}>
            {props.warning}
          </span>
        ) : null}
      </div>
    </div>
  )
}
