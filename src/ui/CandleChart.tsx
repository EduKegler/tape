import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CandlestickSeries, HistogramSeries, TickMarkType, createChart } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import { INTERVALS, marketKey } from '@tape/core/ids'
import type { Base, Interval, VenueId } from '@tape/core/ids'
import { useFrameEffect } from '#/client/hooks'
import { formatChartTick, formatChartTime } from './format'
import { Panel, Segmented } from './Panel'
import { TopicStatus } from './PanelStatus'
import { candlesQuery, marketQuery } from './queries'

const chartTime = (seconds: number) => seconds as UTCTimestamp

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
  const decimals = useQuery(marketQuery(venue, base)).data?.scale.px

  useEffect(() => {
    const el = host.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: css('--level3'),
        fontFamily: css('--font-sans'),
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
      localization: { timeFormatter: (time: UTCTimestamp) => formatChartTime(time) },
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
    const plot = series.current
    if (!plot || !history.data) return
    plot.candles.setData(
      history.data.map((bar) => ({
        time: chartTime(bar.time),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    )
    plot.volume.setData(
      history.data.map((bar) => ({
        time: chartTime(bar.time),
        value: bar.volume,
        color: bar.close >= bar.open ? css('--bid-wash') : css('--ask-wash'),
      })),
    )
    plot.lastTime = history.data.at(-1)?.time ?? 0
    plot.chart.timeScale().scrollToRealTime()
  }, [history.data])

  useEffect(() => {
    if (decimals === undefined) return
    const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    series.current?.chart.applyOptions({
      localization: {
        priceFormatter: (price: number) => format.format(price),
        timeFormatter: (time: UTCTimestamp) => formatChartTime(time),
      },
    })
    series.current?.candles.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
    })
  }, [decimals])

  useFrameEffect({ kind: 'candle', market: marketKey(venue, base), interval }, (frame) => {
    const plot = series.current
    if (!plot?.lastTime) return
    for (const bar of frame.bars) {
      if (bar.time < plot.lastTime) continue
      plot.candles.update({
        time: chartTime(bar.time),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })
      plot.volume.update({
        time: chartTime(bar.time),
        value: bar.volume,
        color: bar.close >= bar.open ? css('--bid-wash') : css('--ask-wash'),
      })
      plot.lastTime = bar.time
    }
  })

  return (
    <Panel
      title="Chart"
      status={
        <TopicStatus
          topic={{ kind: 'candle', market: marketKey(venue, base), interval }}
          error={history.isError ? 'Could not load history.' : null}
          onRetry={() => void history.refetch()}
        />
      }
      aside={
        <Segmented
          label="Interval"
          value={interval}
          onChange={onInterval}
          options={INTERVALS.map((option) => ({ value: option, label: option }))}
        />
      }
    >
      <div ref={host} className="absolute inset-0" />
    </Panel>
  )
}
