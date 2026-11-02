import { Popover as BasePopover } from '@base-ui/react/popover'
import type { ReactElement, ReactNode } from 'react'

const EDGE_PX = 8

/**
 * A panel that opens above the control that opened it, with a caret on that control, and stays
 * inside the viewport. The page stays live around it: a click outside or Escape closes it and
 * focus goes back to the control.
 */
export function Anchored({
  open,
  onOpenChange,
  trigger,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactElement
  children: ReactNode
}) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          side="top"
          sideOffset={EDGE_PX}
          collisionPadding={EDGE_PX}
          collisionAvoidance={{ side: 'shift', align: 'shift' }}
          className="z-dialog"
        >
          <BasePopover.Popup className="w-md origin-(--transform-origin) rounded-md border border-rule bg-raised text-sm outline-none motion-safe:transition-[opacity,scale] motion-safe:duration-fast motion-safe:ease-out motion-safe:data-ending-style:scale-98 motion-safe:data-ending-style:opacity-0 motion-safe:data-starting-style:scale-96 motion-safe:data-starting-style:opacity-0">
            <BasePopover.Arrow className="data-[side=top]:-bottom-1.5">
              <svg aria-hidden viewBox="0 0 12 6" className="block h-1.5 w-3">
                <path d="M0 0 6 6 12 0" className="fill-raised stroke-rule" />
              </svg>
            </BasePopover.Arrow>
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}

/** The title row of an Anchored panel, with the button that closes it. */
export function AnchoredHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 pt-2.5">
      <BasePopover.Title className="min-w-0 truncate text-base font-semibold text-level1">{children}</BasePopover.Title>
      <BasePopover.Close
        aria-label="Close panel"
        className="-mr-1 grid size-5 shrink-0 place-items-center rounded-sm text-level3 hover:bg-level1/8 hover:text-level1"
      >
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5">
          <path d="M1 1l8 8M9 1 1 9" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </BasePopover.Close>
    </div>
  )
}
