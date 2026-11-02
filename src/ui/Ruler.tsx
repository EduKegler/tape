import { useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { RULER, clampX, halfWidth, inDomain, laneLabels, nearEdge, priceAt, spreadChips, toX } from './ruler-layout'
import type { Domain } from './ruler-layout'

type Grip = 'tp' | 'sl' | 'ink'

export interface RulerHandle {
  readonly key: string
  readonly price: number | null
  /** Where an unset handle waits, dashed, until it is dragged or clicked. */
  readonly ghost: number
  readonly short: string
  readonly label: string
  readonly grip: Grip
  readonly outcome: string | null
  readonly gain: boolean | null
  readonly bad: boolean
}

export interface RulerScene {
  readonly label: string
  readonly domain: Domain
  readonly format: (price: number) => string
  readonly snap: (price: number) => number
  readonly keyStep: number
  readonly now: number
  readonly entry: number | null
  readonly liquidation: number | null
  readonly exit?: { readonly price: number; readonly label: string } | null
  readonly zones: readonly { readonly from: number; readonly to: number; readonly gain: boolean }[]
  readonly dots: readonly { readonly price: number; readonly side: 'buy' | 'sell' }[]
  readonly legs: readonly { readonly price: number; readonly label: string }[]
  readonly handles: readonly RulerHandle[]
  readonly onMove: (key: string, price: number) => void
  readonly onRelease: (price: number) => void
  readonly onTrack: ((price: number) => string | null) | null
}

const TRACK = RULER.track
const LABEL_Y = 78
const LANE_HEIGHT = 14
const KEYS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }
const SHIFT_TIMES = 10

const GRIP_FILL = { tp: 'fill-bid', sl: 'fill-ask', ink: 'fill-ink' } as const

type Mark = { at: number; half: number; label: string; kind: 'entry' | 'now' | 'exit' | 'liq'; edge: boolean }

export function Ruler(scene: RulerScene) {
  const svg = useRef<SVGSVGElement>(null)
  const { domain, format } = scene
  const fraction = (clientX: number) => {
    const box = svg.current?.getBoundingClientRect()
    return box ? (clientX - box.left) / box.width : 0
  }
  const priceUnder = (clientX: number) => scene.snap(priceAt(domain, fraction(clientX)))

  const drag = (key: string, event: PointerEvent) => {
    event.preventDefault()
    let latest: number | null = null
    const move = (moved: { clientX: number }) => {
      latest = priceUnder(moved.clientX)
      scene.onMove(key, latest)
    }
    const stop = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', stop)
      removeEventListener('pointercancel', stop)
      if (latest !== null && nearEdge(domain, latest)) scene.onRelease(latest)
      svg.current?.querySelector<SVGGElement>(`[data-handle="${key}"]`)?.focus()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', stop)
    addEventListener('pointercancel', stop)
    move(event)
  }

  const marks: Mark[] = []
  const mark = (price: number, label: string, kind: Mark['kind']) =>
    marks.push({ at: clampX(toX(domain, price)), half: halfWidth(label), label, kind, edge: false })
  if (scene.entry !== null) mark(scene.entry, `Entry ${format(scene.entry)}`, 'entry')
  mark(scene.now, `Now ${format(scene.now)}`, 'now')
  if (scene.exit) mark(scene.exit.price, scene.exit.label, 'exit')
  if (scene.liquidation !== null) {
    if (inDomain(domain, scene.liquidation)) mark(scene.liquidation, `Liq. ${format(scene.liquidation)}`, 'liq')
    else {
      const below = scene.liquidation < domain[0]
      const label = below ? `← Liq. ${format(scene.liquidation)}` : `Liq. ${format(scene.liquidation)} →`
      const half = halfWidth(label)
      const at = below ? RULER.inset + half : RULER.width - RULER.inset - half
      marks.push({ at, half, label, kind: 'liq', edge: true })
    }
  }

  const handles = scene.handles.map((handle) => ({ ...handle, at: clampX(toX(domain, handle.price ?? handle.ghost)) }))
  const chips = spreadChips(handles.map((handle) => handle.at))

  return (
    <div className="px-2.5 pt-2">
      <svg
        ref={svg}
        role="group"
        aria-label={scene.label}
        viewBox={`0 0 ${RULER.width} ${RULER.height}`}
        className="block w-full touch-none text-xs select-none"
      >
        <rect
          x={0}
          y={TRACK - 14}
          width={RULER.width}
          height={28}
          className={`fill-transparent ${scene.onTrack ? 'cursor-pointer' : ''}`}
          onPointerDown={(event) => {
            const key = scene.onTrack?.(scene.snap(priceAt(domain, fraction(event.clientX))))
            if (key) drag(key, event)
          }}
        />
        <rect
          x={RULER.inset}
          y={TRACK - 3}
          width={RULER.width - RULER.inset * 2}
          height={6}
          rx={3}
          className="pointer-events-none fill-inset stroke-edge"
        />
        {scene.zones.map((zone) => {
          const from = clampX(toX(domain, zone.from))
          const to = clampX(toX(domain, zone.to))
          return (
            <rect
              key={`${zone.from}-${zone.to}`}
              x={Math.min(from, to)}
              y={TRACK - 3}
              width={Math.abs(to - from)}
              height={6}
              className={`pointer-events-none ${zone.gain ? 'fill-bid/55' : 'fill-ask/55'}`}
            />
          )
        })}
        {laneLabels(marks).map((placed) => {
          const textY = LABEL_Y + placed.lane * LANE_HEIGHT
          const now = placed.kind === 'now'
          const tone = placed.kind === 'liq' ? 'fill-err' : now ? 'fill-level1 font-medium' : 'fill-level3'
          return (
            <g key={placed.label} className="pointer-events-none">
              {!placed.edge && (
                <line
                  x1={placed.at}
                  x2={placed.at}
                  y1={now ? TRACK - 9 : TRACK + 4}
                  y2={placed.crossed ? LABEL_Y - 11 : textY - 9}
                  stroke-width={now ? 1.5 : 1}
                  className={now ? 'stroke-level1' : placed.kind === 'liq' ? 'stroke-err' : 'stroke-level3'}
                />
              )}
              <text x={placed.center} y={textY} text-anchor="middle" className={`num ${tone}`}>
                {placed.label}
              </text>
            </g>
          )
        })}
        {scene.dots
          .filter((dot) => inDomain(domain, dot.price))
          .map((dot) => (
            <rect
              key={`${dot.side}-${dot.price}`}
              x={toX(domain, dot.price) - 3}
              y={TRACK - 3}
              width={6}
              height={6}
              rx={1}
              className={`pointer-events-none fill-raised ${dot.side === 'buy' ? 'stroke-bid' : 'stroke-ask'}`}
            />
          ))}
        {scene.legs
          .filter((leg) => inDomain(domain, leg.price))
          .map((leg) => {
            const at = toX(domain, leg.price)
            return (
              <g key={leg.label} className="pointer-events-none">
                <rect x={at - 1.5} y={TRACK - 9} width={3} height={18} className="fill-level2" />
                <text x={at} y={TRACK - 13} text-anchor="middle" className="num fill-level3">
                  {leg.label}
                </text>
              </g>
            )
          })}
        {handles.map((handle, index) => {
          const ghost = handle.price === null
          const chip = chips[index]!
          const [low, high] = domain
          return (
            <g
              key={handle.key}
              data-handle={handle.key}
              tabIndex={0}
              role="slider"
              aria-label={handle.label}
              aria-orientation="horizontal"
              aria-valuemin={scene.snap(low)}
              aria-valuemax={scene.snap(high)}
              aria-valuenow={handle.price ?? undefined}
              aria-valuetext={
                ghost ? 'not set' : `${format(handle.price!)}${handle.outcome ? `, ${handle.outcome}` : ''}`
              }
              aria-invalid={handle.bad || undefined}
              className="group cursor-grab outline-none! active:cursor-grabbing"
              onPointerDown={(event) => drag(handle.key, event)}
              onKeyDown={(event: KeyboardEvent) => {
                const direction = KEYS[event.key]
                const from = handle.price ?? handle.ghost
                if (direction) {
                  event.preventDefault()
                  scene.onMove(
                    handle.key,
                    scene.snap(from + direction * scene.keyStep * (event.shiftKey ? SHIFT_TIMES : 1)),
                  )
                } else if (ghost && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  scene.onMove(handle.key, scene.snap(handle.ghost))
                }
              }}
            >
              <line x1={chip} x2={handle.at} y1={26} y2={TRACK - 12} className="stroke-edge" />
              <rect
                x={chip - RULER.chip / 2}
                y={0.5}
                width={RULER.chip}
                height={26}
                rx={4}
                className={ghost ? 'fill-none stroke-level3 [stroke-dasharray:3_2]' : 'fill-surface stroke-rule'}
              />
              <text
                x={chip}
                y={11.5}
                text-anchor="middle"
                className={`num ${ghost ? 'fill-level2' : 'fill-level1 font-medium'}`}
              >
                {ghost ? `+ ${handle.short}` : `${handle.short} ${format(handle.price!)}`}
              </text>
              <text
                x={chip}
                y={22.5}
                text-anchor="middle"
                className={`num ${ghost ? 'fill-level2' : handle.gain === null ? 'fill-level3' : handle.gain ? 'fill-bid' : 'fill-ask'}`}
              >
                {ghost ? 'drag or click' : (handle.outcome ?? '')}
              </text>
              <rect
                x={handle.at - 9}
                y={TRACK - 15}
                width={18}
                height={30}
                rx={4}
                className="fill-none stroke-transparent stroke-2 group-focus-visible:stroke-accent"
              />
              <rect
                x={handle.at - 6}
                y={TRACK - 12}
                width={12}
                height={24}
                rx={3}
                className={
                  ghost ? 'fill-raised stroke-level3 [stroke-dasharray:3_2]' : `${GRIP_FILL[handle.grip]} stroke-raised`
                }
              />
              {!ghost && (
                <path
                  d={`M${handle.at - 2} ${TRACK - 5}v10M${handle.at + 2} ${TRACK - 5}v10`}
                  className="stroke-ink-contrast"
                />
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
