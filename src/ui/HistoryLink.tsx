import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useSelector } from '@tanstack/react-store'
import { createStore } from '@tanstack/store'
import type { HistorySearch } from './History'

export const lastHistorySearch = createStore<HistorySearch | null>(null)

export function HistoryLink({ className, children }: { className: string; children: ReactNode }) {
  const search = useSelector(lastHistorySearch, (state) => state)
  return (
    <Link to="/history" search={search ?? {}} className={className}>
      {children}
    </Link>
  )
}
