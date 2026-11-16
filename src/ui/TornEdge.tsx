import { useId } from 'react'

export function TornEdge() {
  const id = useId()
  return (
    <svg aria-hidden="true" className="absolute inset-x-0 -top-1.5 h-1.5 w-full">
      <defs>
        <pattern id={id} width="10" height="6" patternUnits="userSpaceOnUse">
          <rect width="10" height="6" className="fill-surface" />
          <circle cx="5" cy="0" r="3.5" className="fill-inset" />
        </pattern>
      </defs>
      <rect width="100%" height="6" fill={`url(#${id})`} />
    </svg>
  )
}
