const REST_RECORDING: readonly [RegExp, string][] = [
  [/\/api\/v3\/exchangeInfo\?(?:permissions|symbol)=/, 'binance.markets.json'],
  [/\/api\/v3\/exchangeInfo/, 'binance.exchangeInfo.json'],
  [/\/api\/v3\/depth/, 'binance.depth.json'],
  [/\/api\/v3\/klines/, 'binance.klines.json'],
  [/\/api\/v3\/ticker\/24hr/, 'binance.ticker.json'],
  [/\/v4\/candles\//, 'dydx.candles.json'],
  [/\/v4\/perpetualMarkets$/, 'dydx.markets.json'],
  [/perpetualMarkets\?ticker=BTC-USD/, 'dydx.markets-BTC.json'],
  [/perpetualMarkets\?ticker=ETH-USD/, 'dydx.markets-ETH.json'],
  [/perpetualMarkets\?ticker=SOL-USD/, 'dydx.markets-SOL.json'],
  [/perpetualMarkets\?ticker=/, 'dydx.markets.json'],
  [/\/v1\/public\/info$/, 'orderly.info.json'],
  [/\/v1\/public\/info\/PERP_BTC_USDC/, 'orderly.info-BTC.json'],
  [/\/v1\/public\/info\/PERP_ETH_USDC/, 'orderly.info-ETH.json'],
  [/\/v1\/public\/info\/PERP_SOL_USDC/, 'orderly.info-SOL.json'],
  [/\/v1\/public\/info\/PERP_/, 'orderly.info-missing.json'],
  [/\/v1\/public\/futures/, 'orderly.futures.json'],
  [/\/v1\/tv\/history/, 'orderly.history.json'],
]

export function restRecording(url: string, body: string | null): string | null {
  if (/hyperliquid[^/]*\/info$/.test(url) && body)
    return `hyperliquid.${(JSON.parse(body) as { type: string }).type}.json`
  return REST_RECORDING.find(([re]) => re.test(url))?.[1] ?? null
}

interface FeedSink {
  send: (frame: string) => void
  close: () => void
}

export interface Feed {
  receive: (data: string) => void
  played: () => boolean
  drop: () => void
  stop: () => void
}

const START_DELAY_MS = 250
const FRAME_EVERY_MS = 5
const IDLE_EVERY_MS = 2000

export function createFeed(frames: readonly string[], sink: FeedSink, loops: () => boolean): Feed {
  let started = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let next = 0
  const pump = () => {
    if (next === frames.length && loops()) next = 0
    if (next < frames.length) {
      sink.send(frames[next++]!)
      timer = setTimeout(pump, FRAME_EVERY_MS)
    } else {
      sink.send('{}')
      timer = setTimeout(pump, IDLE_EVERY_MS)
    }
  }
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    receive(data) {
      if (started || !/"subscribe"|"SUBSCRIBE"/.test(data)) return
      started = true
      timer = setTimeout(pump, START_DELAY_MS)
    },
    played: () => next >= frames.length,
    drop() {
      stop()
      sink.close()
    },
    stop,
  }
}
