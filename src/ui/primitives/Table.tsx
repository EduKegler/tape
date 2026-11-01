import type { Key, ReactNode } from 'react'
import { NoData } from './NoData'

export interface Column<T> {
  header: string
  cell: (row: T) => ReactNode
  words?: true
}

type RowAction<T> =
  { isCurrent: (row: T) => boolean; onRowClick: (row: T) => void } | { isCurrent?: never; onRowClick?: never }

export function Table<T>({
  rows,
  rowKey,
  columns,
  empty,
  isCurrent,
  onRowClick,
  rowClass,
  dense = false,
}: {
  rows: readonly T[]
  rowKey: (row: T) => Key
  columns: readonly Column<T>[]
  empty?: string
  rowClass?: (row: T) => string
  dense?: boolean
} & RowAction<T>) {
  if (empty !== undefined && rows.length === 0) return <NoData>{empty}</NoData>
  return (
    <table className={`w-full ${dense ? 'text-xs' : 'text-sm'}`}>
      <thead>
        <tr className="h-6 text-xs text-level3">
          {columns.map((column, index) => (
            <th key={column.header} className={`font-normal ${index === 0 ? 'pl-3 text-left' : 'pr-3 text-right'}`}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const current = isCurrent?.(row)
          return (
            <tr
              key={rowKey(row)}
              aria-current={current}
              data-row={onRowClick ? true : undefined}
              tabIndex={onRowClick ? -1 : undefined}
              onClick={onRowClick && (() => onRowClick(row))}
              onKeyDown={onRowClick && ((event) => event.key === 'Enter' && onRowClick(row))}
              className={`${
                isCurrent
                  ? `${dense ? 'h-6' : 'h-7.5'} cursor-pointer border-t border-rule text-level2 hover:bg-level1/5 aria-current:bg-raised aria-current:text-level1`
                  : `${dense ? 'h-6' : 'h-7.5'} border-t border-rule text-level2`
              } ${rowClass?.(row) ?? ''}`}
            >
              {columns.map((column, index) => (
                <td
                  key={column.header}
                  className={
                    index > 0
                      ? column.words
                        ? 'pr-3 text-right'
                        : 'num pr-3 text-right'
                      : current
                        ? 'pl-3 font-semibold text-accent'
                        : isCurrent
                          ? 'pl-3'
                          : 'pl-3 text-level1'
                  }
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
