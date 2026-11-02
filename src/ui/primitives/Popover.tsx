import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { useLayoutEffect, useState } from 'react'
import type { ReactNode, Ref } from 'react'

type Place = { readonly top: number; readonly right: number }

const GAP_PX = 6

const SIZES = {
  md: { width: 'w-md', body: 'p-5', head: 'mb-5', title: 'text-lg' },
  sm: { width: 'w-80', body: 'p-4', head: 'mb-3', title: 'text-base' },
} as const

function placeUnder(anchor: HTMLElement): Place {
  const bottom = (anchor.closest('header') ?? anchor).getBoundingClientRect().bottom
  return { top: bottom + GAP_PX, right: document.documentElement.clientWidth - anchor.getBoundingClientRect().right }
}

export function Popover({
  open,
  onClose,
  anchor,
  title,
  size = 'md',
  initialFocus,
  finalFocus,
  layerRef,
  backdropRef,
  bodyRef,
  children,
}: {
  open: boolean
  onClose: () => void
  anchor: HTMLElement | null
  title: string
  size?: keyof typeof SIZES
  initialFocus?: () => HTMLElement | null
  finalFocus?: () => HTMLElement | null
  layerRef?: Ref<HTMLDivElement>
  backdropRef?: Ref<HTMLDivElement>
  bodyRef?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  const [place, setPlace] = useState<Place | null>(null)
  const look = SIZES[size]
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const measure = () => setPlace(placeUnder(anchor))
    measure()
    addEventListener('resize', measure)
    return () => removeEventListener('resize', measure)
  }, [open, anchor])
  return (
    <BaseDialog.Root
      open={open && place !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop ref={backdropRef} className="fixed inset-0 z-dialog bg-black/40" />
        <BaseDialog.Popup
          initialFocus={initialFocus && (() => initialFocus() ?? true)}
          finalFocus={finalFocus && (() => finalFocus() ?? true)}
          style={place ?? undefined}
          className={`fixed z-dialog ${look.width} text-sm outline-none`}
        >
          <div
            ref={layerRef}
            aria-hidden
            className="absolute inset-0 origin-top-left rounded-md border border-rule bg-raised"
          />
          <div ref={bodyRef} className={`relative ${look.body}`}>
            <div data-stagger className={`${look.head} flex items-center justify-between gap-3`}>
              <BaseDialog.Title className={`${look.title} font-semibold text-level1`}>{title}</BaseDialog.Title>
              <BaseDialog.Close
                aria-label="Close"
                className="-m-1.5 grid size-8 place-items-center rounded-md text-level3 hover:bg-level1/8 hover:text-level1 motion-safe:transition-colors"
              >
                <svg aria-hidden viewBox="0 0 14 14" className="size-3.5">
                  <path d="m4 4 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              </BaseDialog.Close>
            </div>
            {children}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
