import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ReactNode, Ref, RefObject } from 'react'

const widths = { narrow: 'w-72', wide: 'w-104', split: 'w-200', slip: 'w-96', ledger: 'w-204', receipt: 'w-108' }

// Base UI unmounts the popup when it closes, so state that must survive a close lives in the caller.
export function Dialog({
  open,
  onClose,
  title,
  titleHidden = false,
  lockReason = null,
  locked = lockReason !== null,
  initialFocus,
  finalFocus,
  width = 'wide',
  well,
  popupRef,
  backdropRef,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  titleHidden?: boolean
  lockReason?: string | null
  locked?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  finalFocus?: () => HTMLElement | null
  width?: keyof typeof widths
  well?: ReactNode
  popupRef?: Ref<HTMLDivElement>
  backdropRef?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  const beside = width === 'ledger'
  const head = titleHidden ? (
    <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>
  ) : (
    <div className="flex items-center justify-between gap-3">
      <BaseDialog.Title className="text-base text-level1">{title}</BaseDialog.Title>
      <BaseDialog.Close aria-label="Close" className="text-level3 hover:text-level1">
        ×
      </BaseDialog.Close>
    </div>
  )
  const note = lockReason !== null && (
    <p role="status" className="border-l-2 border-warn pl-2 text-level1">
      {lockReason}
    </p>
  )
  return (
    <BaseDialog.Root
      open={open}
      disablePointerDismissal={locked}
      onOpenChange={(next, details) => {
        if (next) return
        if (locked && details.reason !== 'close-press') {
          details.cancel()
          return
        }
        onClose()
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          ref={backdropRef}
          className="fixed inset-0 z-dialog bg-black/60 motion-safe:animate-fade-in"
        />
        <BaseDialog.Popup
          ref={popupRef}
          initialFocus={initialFocus && (() => initialFocus.current)}
          finalFocus={finalFocus && (() => finalFocus() ?? true)}
          className={`fixed top-1/2 left-1/2 z-dialog max-h-[90vh] ${widths[width]} -translate-1/2 overflow-auto rounded-sm border border-rule bg-raised text-sm motion-safe:animate-fade-in ${
            well === undefined
              ? 'flex flex-col gap-3 p-4'
              : beside
                ? 'grid grid-cols-[minmax(0,1fr)_25rem]'
                : 'flex flex-col'
          }`}
        >
          {well === undefined ? (
            <>
              {head}
              {note}
              {children}
            </>
          ) : (
            <>
              <div className={`flex min-w-0 flex-col gap-4 p-5 ${beside ? 'min-h-120' : 'order-2 pt-4'}`}>
                {head}
                {note}
                {children}
              </div>
              <div
                className={`flex flex-col justify-end overflow-hidden bg-inset px-5 pt-8 ${beside ? 'border-l border-rule' : ''}`}
              >
                {well}
              </div>
            </>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
