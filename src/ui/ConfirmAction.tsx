import { useEffect, useRef, useState } from 'react'
import { Button } from './primitives'

export function ConfirmAction({
  label,
  question,
  disabled,
  onConfirm,
}: {
  label: string
  question: string
  disabled?: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  const step = useRef<HTMLSpanElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const backToTrigger = useRef(false)

  useEffect(() => {
    if (open) {
      confirm.current?.focus()
      const outside = (e: PointerEvent) => {
        if (!step.current?.contains(e.target as Node)) setOpen(false)
      }
      const escape = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return
        backToTrigger.current = true
        setOpen(false)
      }
      document.addEventListener('pointerdown', outside)
      document.addEventListener('keydown', escape)
      return () => {
        document.removeEventListener('pointerdown', outside)
        document.removeEventListener('keydown', escape)
      }
    }
    if (backToTrigger.current) trigger.current?.focus()
    backToTrigger.current = false
  }, [open])

  if (!open)
    return (
      <Button ref={trigger} look="quiet" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
    )
  return (
    <span
      ref={step}
      role="group"
      aria-label={question}
      className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-level1"
    >
      <span>{question}</span>
      <Button
        ref={confirm}
        look="primary"
        size="sm"
        onClick={() => {
          setOpen(false)
          onConfirm()
        }}
      >
        Confirm
      </Button>
      <Button
        look="quiet"
        onClick={() => {
          backToTrigger.current = true
          setOpen(false)
        }}
      >
        Cancel
      </Button>
    </span>
  )
}
