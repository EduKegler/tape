import type { Key, ReactNode } from 'react'

export interface Column<T> {
  header: string
  cell: (row: T) => ReactNode
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
}: {
  rows: readonly T[]
  rowKey: (row: T) => Key
  columns: readonly Column<T>[]
  empty?: string
} & RowAction<T>) {
  if (empty !== undefined && rows.length === 0) return <p className="p-3 text-sm text-level3">{empty}</p>
  return (
    <table className="num w-full text-sm">
      <thead>
        <tr className="h-6 text-xs text-level3">
          {columns.map((c, i) => (
            <th key={c.header} className={`font-normal ${i === 0 ? 'pl-3 text-left' : 'pr-3 text-right'}`}>
              {c.header}
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
              onClick={onRowClick && (() => onRowClick(row))}
              className={
                isCurrent
                  ? 'h-7.5 cursor-pointer border-t border-rule text-level2 hover:bg-level1/5 aria-current:text-level1'
                  : 'h-7.5 border-t border-rule text-level2'
              }
            >
              {columns.map((c, i) => (
                <td
                  key={c.header}
                  className={
                    i > 0
                      ? 'pr-3 text-right'
                      : current
                        ? 'pl-3 inset-shadow-current'
                        : isCurrent
                          ? 'pl-3'
                          : 'pl-3 text-level1'
                  }
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
