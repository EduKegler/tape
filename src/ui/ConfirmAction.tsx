import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Button } from './primitives'

export function ConfirmStep({
  question,
  confirm = 'Confirm',
  keep = 'Cancel',
  trigger,
  onConfirm,
  onCancel,
  children,
}: {
  question: string
  confirm?: string
  keep?: string
  trigger?: RefObject<HTMLElement | null>
  onConfirm: () => void
  onCancel: (refocus: boolean) => void
  children?: ReactNode
}) {
  const step = useRef<HTMLSpanElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const cancel = useRef(onCancel)
  useEffect(() => {
    cancel.current = onCancel
  })

  useEffect(() => {
    confirmButton.current?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (target && (step.current?.contains(target) || trigger?.current?.contains(target))) return
      cancel.current(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel.current(true)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [trigger])

  return (
    <span
      ref={step}
      role="group"
      aria-label={question}
      className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-level1"
    >
      <span>{question}</span>
      {children}
      <Button ref={confirmButton} look="primary" size="sm" onClick={onConfirm}>
        {confirm}
      </Button>
      <Button look="quiet" onClick={() => onCancel(true)}>
        {keep}
      </Button>
    </span>
  )
}

export function ConfirmAction({
  label,
  question,
  confirm,
  keep,
  disabled,
  onConfirm,
  children,
  look = 'secondary',
}: {
  label: string
  question: string
  confirm?: string
  keep?: string
  disabled?: boolean
  onConfirm: () => void
  children?: ReactNode
  look?: 'secondary' | 'outline'
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const backToTrigger = useRef(false)

  useEffect(() => {
    if (!open && backToTrigger.current) trigger.current?.focus()
    backToTrigger.current = false
  }, [open])

  if (!open)
    return (
      <Button ref={trigger} look={look} size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
    )
  return (
    <ConfirmStep
      question={question}
      confirm={confirm}
      keep={keep}
      onConfirm={() => {
        setOpen(false)
        onConfirm()
      }}
      onCancel={(refocus) => {
        backToTrigger.current = refocus
        setOpen(false)
      }}
    >
      {children}
    </ConfirmStep>
  )
}
