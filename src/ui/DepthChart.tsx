import { useEffect, useRef, useState } from 'react'
import type { Base, MarketKey } from '@tape/core/ids'
import { useFrameEffect } from '#/client/hooks'
import type { DepthFrame, DepthSide } from '#/core/topics'
import { Panel } from './Panel'
import { TopicStatus } from './PanelStatus'

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

const amount = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

function reachOf(frame: DepthFrame): number | null {
  if (!frame.bids.px.length || !frame.asks.px.length || !frame.mid) return null
  return Math.min(frame.mid - (frame.bids.px.at(-1) ?? frame.mid), (frame.asks.px.at(-1) ?? frame.mid) - frame.mid)
}

function draw(canvas: HTMLCanvasElement, frame: DepthFrame, base: Base): void {
  const dpr = window.devicePixelRatio || 1
  const { clientWidth: width, clientHeight: height } = canvas
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const reach = reachOf(frame)
  if (reach === null) return
  const lo = frame.mid - reach
  const hi = frame.mid + reach
  const cumAt = (side: DepthSide, inside: (px: number) => boolean) => {
    let cumulative = 0
    for (let level = 0; level < side.px.length && inside(side.px[level]!); level++) cumulative = side.cum[level]!
    return cumulative
  }
  const bidTotal = cumAt(frame.bids, (price) => price >= lo)
  const askTotal = cumAt(frame.asks, (price) => price <= hi)
  const max = Math.max(bidTotal, askTotal) || 1
  const priceX = (px: number) => ((px - lo) / (hi - lo)) * width
  const floor = height - 18
  const depthY = (cum: number) => floor - (cum / max) * (floor - 30)
  const area = (side: DepthSide, sign: 1 | -1, stroke: string, fill: string) => {
    ctx.beginPath()
    ctx.moveTo(priceX(frame.mid), floor)
    let prev = 0
    for (let level = 0; level < side.px.length; level++) {
      const px = side.px[level]!
      if (sign === -1 ? px < lo : px > hi) break
      ctx.lineTo(priceX(px), depthY(prev))
      prev = side.cum[level]!
      ctx.lineTo(priceX(px), depthY(prev))
    }
    ctx.lineTo(priceX(sign === -1 ? lo : hi), depthY(prev))
    ctx.lineTo(priceX(sign === -1 ? lo : hi), floor)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.25
    ctx.stroke()
  }
  area(frame.bids, -1, cssVar(canvas, '--bid'), cssVar(canvas, '--bid-wash'))
  area(frame.asks, 1, cssVar(canvas, '--ask'), cssVar(canvas, '--ask-wash'))
  const midX = Math.round(priceX(frame.mid)) + 0.5
  ctx.strokeStyle = cssVar(canvas, '--edge')
  ctx.lineWidth = 1
  ctx.setLineDash([2, 3])
  ctx.beginPath()
  ctx.moveTo(midX, 16)
  ctx.lineTo(midX, floor)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = cssVar(canvas, '--level3')
  ctx.font = `11px ${cssVar(canvas, '--font-sans')}`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillText(amount(lo), 6, height - 5)
  ctx.fillText(`Bids ${amount(bidTotal)} ${base}`, 6, 14)
  ctx.textAlign = 'center'
  ctx.fillText(amount(frame.mid), midX, height - 5)
  ctx.textAlign = 'right'
  ctx.fillText(amount(hi), width - 6, height - 5)
  ctx.fillText(`Asks ${amount(askTotal)} ${base}`, width - 6, 14)
}

export function DepthChart({ market, base }: { market: MarketKey; base: Base }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const last = useRef<DepthFrame | null>(null)
  const raf = useRef(0)
  const [reach, setReach] = useState<string | null>(null)
  useFrameEffect({ kind: 'depth', market }, (frame) => {
    last.current = frame
    const span = reachOf(frame)
    setReach(span === null ? null : amount(span))
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => canvas.current && draw(canvas.current, frame, base))
  })
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new ResizeObserver(() => last.current && draw(el, last.current, base))
    observer.observe(el)
    return () => observer.disconnect()
  }, [base])
  return (
    <Panel
      title="Depth"
      status={<TopicStatus topic={{ kind: 'depth', market }} ageLimit />}
      aside={reach && <span className="text-sm text-level3">±{reach} from mid</span>}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full" aria-label="Cumulative order book depth" role="img" />
    </Panel>
  )
}
