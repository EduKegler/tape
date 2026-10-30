import { useEffect, useRef } from 'react'
import type { MarketKey } from '@tape/core/ids'
import { useFrameEffect } from '#/client/hooks'
import type { DepthFrame, DepthSide } from '#/core/topics'
import { Panel } from './Panel'

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

function draw(canvas: HTMLCanvasElement, f: DepthFrame): void {
  const dpr = window.devicePixelRatio || 1
  const { clientWidth: w, clientHeight: h } = canvas
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!f.bids.px.length || !f.asks.px.length || !f.mid) return
  const reach = Math.min(f.mid - (f.bids.px.at(-1) ?? f.mid), (f.asks.px.at(-1) ?? f.mid) - f.mid)
  const lo = f.mid - reach
  const hi = f.mid + reach
  const cumAt = (side: DepthSide, inside: (px: number) => boolean) => {
    let c = 0
    for (let i = 0; i < side.px.length && inside(side.px[i]!); i++) c = side.cum[i]!
    return c
  }
  const max =
    Math.max(
      cumAt(f.bids, (p) => p >= lo),
      cumAt(f.asks, (p) => p <= hi),
    ) || 1
  const x = (px: number) => ((px - lo) / (hi - lo)) * w
  const y = (cum: number) => h - 4 - (cum / max) * (h - 20)
  const area = (side: DepthSide, sign: 1 | -1, stroke: string, fill: string) => {
    ctx.beginPath()
    ctx.moveTo(x(f.mid), h)
    let prev = 0
    for (let i = 0; i < side.px.length; i++) {
      const px = side.px[i]!
      if (sign === -1 ? px < lo : px > hi) break
      ctx.lineTo(x(px), y(prev))
      prev = side.cum[i]!
      ctx.lineTo(x(px), y(prev))
    }
    ctx.lineTo(x(sign === -1 ? lo : hi), y(prev))
    ctx.lineTo(x(sign === -1 ? lo : hi), h)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.25
    ctx.stroke()
  }
  area(f.bids, -1, cssVar(canvas, '--bid'), cssVar(canvas, '--bid-wash'))
  area(f.asks, 1, cssVar(canvas, '--ask'), cssVar(canvas, '--ask-wash'))
  ctx.fillStyle = cssVar(canvas, '--level3')
  ctx.font = `11px ${cssVar(canvas, '--font-mono')}`
  ctx.textAlign = 'left'
  ctx.fillText(lo.toLocaleString('en-US', { maximumFractionDigits: 2 }), 6, h - 6)
  ctx.textAlign = 'right'
  ctx.fillText(hi.toLocaleString('en-US', { maximumFractionDigits: 2 }), w - 6, h - 6)
}

export function DepthChart({ market }: { market: MarketKey }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const last = useRef<DepthFrame | null>(null)
  const raf = useRef(0)
  useFrameEffect({ kind: 'depth', market }, (f) => {
    last.current = f
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => canvas.current && draw(canvas.current, f))
  })
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new ResizeObserver(() => last.current && draw(el, last.current))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <Panel title="Depth">
      <canvas ref={canvas} className="absolute inset-0 size-full" aria-label="Cumulative order book depth" role="img" />
    </Panel>
  )
}
