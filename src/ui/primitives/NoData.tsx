import type { ReactNode } from 'react'

export function NoData({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`p-3 text-sm text-level3 ${className}`}>{children}</div>
}
