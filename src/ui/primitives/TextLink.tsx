import type { ReactNode } from 'react'

export const LINK_LOOK = 'text-level1 underline decoration-level3 underline-offset-4'

export function TextLink({ href, newTab = false, children }: { href: string; newTab?: boolean; children: ReactNode }) {
  return (
    <a href={href} target={newTab ? '_blank' : undefined} rel={newTab ? 'noreferrer' : undefined} className={LINK_LOOK}>
      {children}
    </a>
  )
}
