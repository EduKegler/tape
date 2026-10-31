import type { ReactNode } from 'react'

export function TextLink({ href, newTab = false, children }: { href: string; newTab?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noreferrer' : undefined}
      className="text-level1 underline underline-offset-2"
    >
      {children}
    </a>
  )
}
