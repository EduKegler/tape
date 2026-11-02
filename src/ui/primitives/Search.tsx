import { Autocomplete } from '@base-ui/react/autocomplete'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export interface SearchGroup<T> {
  readonly key: string
  readonly label: string | null
  readonly items: readonly T[]
}

export function Search<T>(props: {
  label: string
  value: string
  groups: readonly SearchGroup<T>[]
  empty: string
  itemKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  onChange: (query: string) => void
  onOpenChange: (open: boolean) => void
  onPick: (item: T) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return
      event.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', focus)
    return () => window.removeEventListener('keydown', focus)
  }, [])
  return (
    <Autocomplete.Root
      items={props.groups}
      filter={null}
      value={props.value}
      onValueChange={(query, details) => props.onChange(details.reason === 'item-press' ? '' : query)}
      onOpenChange={props.onOpenChange}
      itemToStringValue={props.itemKey}
      autoHighlight
      openOnInputClick
    >
      <span className="relative inline-flex">
        <Autocomplete.Input
          ref={input}
          aria-label={props.label}
          aria-keyshortcuts="/"
          placeholder={props.label}
          className="h-9 w-40 rounded-md border border-edge bg-inset pr-8 pl-3 text-sm text-level1 placeholder:text-level3 wide:w-58"
        />
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm border border-rule px-1.5 text-xs font-medium text-level3"
        >
          /
        </kbd>
      </span>
      <Autocomplete.Portal>
        <Autocomplete.Positioner className="z-dialog" sideOffset={4} align="start">
          <Autocomplete.Popup className="w-56 max-w-(--available-width) rounded-md border border-rule bg-raised text-base text-level1">
            <Autocomplete.Empty>
              <div className="p-2 text-level3">{props.empty}</div>
            </Autocomplete.Empty>
            <Autocomplete.List className="max-h-[min(24rem,var(--available-height))] overflow-y-auto overscroll-contain py-1 data-empty:p-0">
              {(group: SearchGroup<T>) => (
                <Autocomplete.Group key={group.key} items={group.items}>
                  {group.label !== null && (
                    <Autocomplete.GroupLabel className="px-2 pt-2 pb-1 text-xs text-level3">
                      {group.label}
                    </Autocomplete.GroupLabel>
                  )}
                  <Autocomplete.Collection>
                    {(item: T) => (
                      <Autocomplete.Item
                        key={props.itemKey(item)}
                        value={item}
                        onClick={() => props.onPick(item)}
                        className="cursor-pointer px-2 py-1 select-none data-highlighted:bg-level1/8"
                      >
                        {props.renderItem(item)}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  )
}
