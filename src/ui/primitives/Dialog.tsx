import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ReactNode, RefObject } from 'react'

const widths = { narrow: 'w-72', wide: 'w-104' }

// Base UI unmounts the popup when it closes, so state that must survive a close lives in the caller.
export function Dialog({
  open,
  onClose,
  title,
  lockReason = null,
  initialFocus,
  width = 'wide',
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  lockReason?: string | null
  initialFocus?: RefObject<HTMLElement | null>
  width?: keyof typeof widths
  children: ReactNode
}) {
  return (
    <BaseDialog.Root
      open={open}
      disablePointerDismissal={lockReason !== null}
      onOpenChange={(next, details) => {
        if (next) return
        if (lockReason !== null && details.reason !== 'close-press') {
          details.cancel()
          return
        }
        onClose()
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-dialog bg-black/60 motion-safe:animate-fade-in" />
        <BaseDialog.Popup
          initialFocus={initialFocus && (() => initialFocus.current)}
          className={`fixed top-1/2 left-1/2 z-dialog flex max-h-[90vh] ${widths[width]} -translate-1/2 flex-col gap-3 overflow-auto rounded-sm border border-rule bg-raised p-4 text-sm motion-safe:animate-fade-in`}
        >
          <div className="flex items-center justify-between gap-3">
            <BaseDialog.Title className="text-base text-level1">{title}</BaseDialog.Title>
            <BaseDialog.Close aria-label="Close" className="text-level3 hover:text-level1">
              ×
            </BaseDialog.Close>
          </div>
          {lockReason !== null && (
            <p role="status" className="border-l-2 border-warn pl-2 text-level1">
              {lockReason}
            </p>
          )}
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
