import { useEffect, useRef } from 'react'
import { useFrameEffect } from '#/client/hooks'
import type { MarketKey } from '@tape/core/ids'
import type { DepthFrame } from '#/core/topics'
import { Panel } from './Panel'

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

/** Cumulative depth as two stepped areas around the mid, redrawn on a canvas with no React render. */
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
  const bidN = f.bids.length / 2
  const askN = f.asks.length / 2
  if (!bidN || !askN || !f.mid) return
  const reach = Math.min(f.mid - (f.bids[(bidN - 1) * 2] ?? f.mid), (f.asks[(askN - 1) * 2] ?? f.mid) - f.mid)
  const lo = f.mid - reach
  const hi = f.mid + reach
  const cumAt = (side: Float64Array, n: number, inside: (px: number) => boolean) => {
    let c = 0
    for (let i = 0; i < n && inside(side[i * 2]!); i++) c = side[i * 2 + 1]!
    return c
  }
  const max =
    Math.max(
      cumAt(f.bids, bidN, (p) => p >= lo),
      cumAt(f.asks, askN, (p) => p <= hi),
    ) || 1
  const x = (px: number) => ((px - lo) / (hi - lo)) * w
  const y = (cum: number) => h - 4 - (cum / max) * (h - 20)
  const area = (side: Float64Array, n: number, sign: 1 | -1, stroke: string, fill: string) => {
    ctx.beginPath()
    ctx.moveTo(x(f.mid), h)
    let prev = 0
    for (let i = 0; i < n; i++) {
      const px = side[i * 2]!
      if (sign === -1 ? px < lo : px > hi) break
      ctx.lineTo(x(px), y(prev))
      prev = side[i * 2 + 1]!
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
  area(f.bids, bidN, -1, cssVar(canvas, '--bid'), cssVar(canvas, '--bid-wash'))
  area(f.asks, askN, 1, cssVar(canvas, '--ask'), cssVar(canvas, '--ask-wash'))
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
