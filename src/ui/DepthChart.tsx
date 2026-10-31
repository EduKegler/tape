import { useEffect, useRef } from 'react'
import type { MarketKey } from '@tape/core/ids'
import { useFrameEffect } from '#/client/hooks'
import type { DepthFrame, DepthSide } from '#/core/topics'
import { Panel } from './Panel'
import { TopicStatus } from './PanelStatus'

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

function draw(canvas: HTMLCanvasElement, frame: DepthFrame): void {
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
  if (!frame.bids.px.length || !frame.asks.px.length || !frame.mid) return
  const reach = Math.min(
    frame.mid - (frame.bids.px.at(-1) ?? frame.mid),
    (frame.asks.px.at(-1) ?? frame.mid) - frame.mid,
  )
  const lo = frame.mid - reach
  const hi = frame.mid + reach
  const cumAt = (side: DepthSide, inside: (px: number) => boolean) => {
    let cumulative = 0
    for (let level = 0; level < side.px.length && inside(side.px[level]!); level++) cumulative = side.cum[level]!
    return cumulative
  }
  const max =
    Math.max(
      cumAt(frame.bids, (price) => price >= lo),
      cumAt(frame.asks, (price) => price <= hi),
    ) || 1
  const priceX = (px: number) => ((px - lo) / (hi - lo)) * width
  const depthY = (cum: number) => height - 4 - (cum / max) * (height - 20)
  const area = (side: DepthSide, sign: 1 | -1, stroke: string, fill: string) => {
    ctx.beginPath()
    ctx.moveTo(priceX(frame.mid), height)
    let prev = 0
    for (let level = 0; level < side.px.length; level++) {
      const px = side.px[level]!
      if (sign === -1 ? px < lo : px > hi) break
      ctx.lineTo(priceX(px), depthY(prev))
      prev = side.cum[level]!
      ctx.lineTo(priceX(px), depthY(prev))
    }
    ctx.lineTo(priceX(sign === -1 ? lo : hi), depthY(prev))
    ctx.lineTo(priceX(sign === -1 ? lo : hi), height)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.25
    ctx.stroke()
  }
  area(frame.bids, -1, cssVar(canvas, '--bid'), cssVar(canvas, '--bid-wash'))
  area(frame.asks, 1, cssVar(canvas, '--ask'), cssVar(canvas, '--ask-wash'))
  ctx.fillStyle = cssVar(canvas, '--level3')
  ctx.font = `11px ${cssVar(canvas, '--font-sans')}`
  ctx.textAlign = 'left'
  ctx.fillText(lo.toLocaleString('en-US', { maximumFractionDigits: 2 }), 6, height - 6)
  ctx.textAlign = 'right'
  ctx.fillText(hi.toLocaleString('en-US', { maximumFractionDigits: 2 }), width - 6, height - 6)
}

export function DepthChart({ market }: { market: MarketKey }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const last = useRef<DepthFrame | null>(null)
  const raf = useRef(0)
  useFrameEffect({ kind: 'depth', market }, (frame) => {
    last.current = frame
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => canvas.current && draw(canvas.current, frame))
  })
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new ResizeObserver(() => last.current && draw(el, last.current))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <Panel title="Depth" status={<TopicStatus topic={{ kind: 'depth', market }} ageLimit />}>
      <canvas ref={canvas} className="absolute inset-0 size-full" aria-label="Cumulative order book depth" role="img" />
    </Panel>
  )
}
