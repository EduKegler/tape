import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CandlestickSeries, HistogramSeries, TickMarkType, createChart } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import { INTERVALS, marketKey } from '@tape/core/ids'
import type { Base, Interval, VenueId } from '@tape/core/ids'
import { useFrameEffect } from '#/client/hooks'
import { VENUES } from '#/site'
import { formatChartTick, formatChartTime } from './format'
import { Panel, Segmented } from './Panel'
import { TopicStatus } from './PanelStatus'
import { candlesQuery, marketQuery } from './queries'

type Bar = { readonly open: number; readonly high: number; readonly low: number; readonly close: number }

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- lightweight-charts brands UTCTimestamp and has no constructor for it
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
  const spec = useQuery(marketQuery(venue, base)).data
  const decimals = spec?.scale.px
  const [latest, setLatest] = useState<Bar | null>(null)

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
      grid: { vertLines: { visible: false }, horzLines: { color: css('--rule') } },
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
      lastValueVisible: false,
      priceLineVisible: false,
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
    setLatest(history.data.at(-1) ?? null)
    plot.chart.timeScale().scrollToRealTime()
  }, [history.data])

  useEffect(() => {
    if (decimals === undefined) return
    const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals })
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
      setLatest(bar)
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
      lead={
        <div className="flex items-center gap-5 self-stretch">
          <Segmented
            tabs="roomy"
            label="Interval"
            value={interval}
            onChange={onInterval}
            options={INTERVALS.map((option) => ({ value: option, label: option }))}
          />
          {latest && decimals !== undefined && <Ohlc bar={latest} decimals={decimals} />}
        </div>
      }
      aside={
        spec && (
          <span className="text-sm text-level3 @max-2xl:hidden">{`${base}-${spec.quote} · ${VENUES[venue].label}`}</span>
        )
      }
      className="@container"
    >
      <div ref={host} className="absolute inset-0" />
    </Panel>
  )
}

function Ohlc({ bar, decimals }: { bar: Bar; decimals: number }) {
  const format = (price: number) => price.toLocaleString('en-US', { maximumFractionDigits: decimals })
  return (
    <dl aria-label="Latest candle" className="flex gap-3 text-sm">
      {(
        [
          ['O', 'Open', bar.open],
          ['H', 'High', bar.high],
          ['L', 'Low', bar.low],
          ['C', 'Close', bar.close],
        ] as const
      ).map(([mark, name, price]) => (
        <div key={mark} className="flex gap-1">
          <dt className="text-level3">
            <abbr title={name} className="no-underline">
              {mark}
            </abbr>
          </dt>
          <dd className="num text-level1">{format(price)}</dd>
        </div>
      ))}
    </dl>
  )
}
