import { Autocomplete } from '@base-ui/react/autocomplete'
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
      <Autocomplete.Input
        aria-label={props.label}
        placeholder={props.label}
        className="w-40 rounded-md border border-edge bg-inset px-2.5 py-1.5 text-base text-level1 placeholder:text-level3"
      />
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
