import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CandlestickSeries, HistogramSeries, TickMarkType, createChart } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import { useFrameEffect } from '#/client/hooks'
import { INTERVALS, marketKey } from '@tape/core/ids'
import type { Base, Interval, VenueId } from '@tape/core/ids'
import { formatChartTick, formatChartTime } from './format'
import { Panel, Segmented } from './Panel'
import { candlesQuery, specsQuery } from './queries'

const MARKS = {
  [TickMarkType.Year]: 'year',
  [TickMarkType.Month]: 'month',
  [TickMarkType.DayOfMonth]: 'day',
  [TickMarkType.Time]: 'time',
  [TickMarkType.TimeWithSeconds]: 'seconds',
} as const

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

interface Series {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  volume: ISeriesApi<'Histogram'>
  lastTime: number
}

/** History comes from REST through Query. The live bar comes from the hub and goes straight into the series. */
export function CandleChart({
  venue,
  base,
  interval,
  onInterval,
}: {
  venue: VenueId
  base: Base
  interval: Interval
  onInterval: (i: Interval) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const series = useRef<Series | null>(null)
  const history = useQuery(candlesQuery(venue, base, interval))
  const decimals = useQuery({ ...specsQuery(venue), select: (specs) => specs.get(base)?.scale.px }).data

  useEffect(() => {
    const el = host.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: css('--level3'),
        fontFamily: css('--font-mono'),
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: css('--rule') }, horzLines: { color: css('--rule') } },
      rightPriceScale: { borderColor: css('--rule') },
      timeScale: {
        borderColor: css('--rule'),
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: UTCTimestamp, mark: TickMarkType) => formatChartTick(time, MARKS[mark]),
      },
      localization: { timeFormatter: (t: UTCTimestamp) => formatChartTime(t) },
      crosshair: { vertLine: { color: css('--level3') }, horzLine: { color: css('--level3') } },
    })
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: css('--bid'),
      downColor: css('--ask'),
      borderVisible: false,
      wickUpColor: css('--bid'),
      wickDownColor: css('--ask'),
    })
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      color: css('--rule'),
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    series.current = { chart, candles, volume, lastTime: 0 }
    return () => {
      series.current = null
      chart.remove()
    }
  }, [])

  useEffect(() => {
    const s = series.current
    if (!s || !history.data) return
    s.candles.setData(
      history.data.map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    )
    s.volume.setData(
      history.data.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? css('--bid-wash') : css('--ask-wash'),
      })),
    )
    s.lastTime = history.data.at(-1)?.time ?? 0
    s.chart.timeScale().scrollToRealTime()
  }, [history.data])

  useEffect(() => {
    if (decimals === undefined) return
    const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    series.current?.chart.applyOptions({
      localization: {
        priceFormatter: (p: number) => format.format(p),
        timeFormatter: (t: UTCTimestamp) => formatChartTime(t),
      },
    })
    series.current?.candles.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
    })
  }, [decimals])

  useFrameEffect({ kind: 'candle', market: marketKey(venue, base), interval }, (f) => {
    const s = series.current
    if (!s?.lastTime) return
    for (const bar of f.bars) {
      if (bar.time < s.lastTime) continue
      s.candles.update({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })
      s.volume.update({
        time: bar.time as UTCTimestamp,
        value: bar.volume,
        color: bar.close >= bar.open ? css('--bid-wash') : css('--ask-wash'),
      })
      s.lastTime = bar.time
    }
  })

  return (
    <Panel
      title="Chart"
      aside={
        <Segmented
          label="Interval"
          value={interval}
          onChange={onInterval}
          options={INTERVALS.map((i) => ({ value: i, label: i }))}
        />
      }
    >
      <div ref={host} className="absolute inset-0" />
      {history.isError && <p className="absolute inset-x-0 top-1/2 text-center text-level3">Could not load history.</p>}
    </Panel>
  )
}
