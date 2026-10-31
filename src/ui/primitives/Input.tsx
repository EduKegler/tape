import { Input as BaseInput } from '@base-ui/react/input'
import { useId } from 'react'
import type { ReactNode, Ref } from 'react'

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
      <div className="flex justify-between text-level3">
        <label htmlFor={id}>{props.label}</label>
        {props.hint}
      </div>
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
        className="num h-9 rounded-sm border border-edge bg-inset px-2 text-base text-level1 outline-none focus:border-accent aria-invalid:border-warn"
      />
      <div
        aria-live={props.warning === undefined ? undefined : 'polite'}
        className={props.messageLine ? 'h-4.5 leading-4.5' : 'contents'}
      >
        {props.error ? (
          <span id={message} title={props.error} className={`block border-l-2 border-warn pl-2 text-level1 ${fit}`}>
            {props.error}
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
