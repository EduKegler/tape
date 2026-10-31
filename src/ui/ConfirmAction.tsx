import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './primitives'

export function ConfirmAction({
  label,
  question,
  confirm = 'Confirm',
  keep = 'Cancel',
  disabled,
  onConfirm,
  children,
}: {
  label: string
  question: string
  confirm?: string
  keep?: string
  disabled?: boolean
  onConfirm: () => void
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const step = useRef<HTMLSpanElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const backToTrigger = useRef(false)

  useEffect(() => {
    if (open) {
      confirmButton.current?.focus()
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
      className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-level1"
    >
      <span>{question}</span>
      {children}
      <Button
        ref={confirmButton}
        look="primary"
        size="sm"
        onClick={() => {
          setOpen(false)
          onConfirm()
        }}
      >
        {confirm}
      </Button>
      <Button
        look="quiet"
        onClick={() => {
          backToTrigger.current = true
          setOpen(false)
        }}
      >
        {keep}
      </Button>
    </span>
  )
}
