import { mkdir, writeFile } from 'node:fs/promises'

const seconds = Number(process.argv[2] ?? 8)
const out = new URL('../src/venues/__fixtures__/', import.meta.url)
const dydxLines = 600

const venues = {
  binance: {
    url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@depth@100ms/btcusdt@trade/btcusdt@kline_1m',
    subscribe: [],
    rest: {
      depth: 'https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=1000',
      exchangeInfo: `https://data-api.binance.vision/api/v3/exchangeInfo?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT","SOLUSDT"]')}`,
      klines: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5',
    },
  },
  hyperliquid: {
    url: 'wss://api.hyperliquid.xyz/ws',
    subscribe: ['l2Book', 'trades'].map((type) => ({ method: 'subscribe', subscription: { type, coin: 'BTC' } }))
      .concat({ method: 'subscribe', subscription: { type: 'candle', coin: 'BTC', interval: '1m' } }),
    rest: {},
    post: {
      meta: { type: 'meta' },
      candleSnapshot: { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: Date.now() - 5 * 60_000, endTime: Date.now() } },
    },
  },
  dydx: {
    url: 'wss://indexer.dydx.trade/v4/ws',
    subscribe: [
      { type: 'subscribe', channel: 'v4_orderbook', id: 'BTC-USD' },
      { type: 'subscribe', channel: 'v4_trades', id: 'BTC-USD' },
      { type: 'subscribe', channel: 'v4_candles', id: 'BTC-USD/1MIN' },
    ],
    rest: {
      'markets-BTC': 'https://indexer.dydx.trade/v4/perpetualMarkets?ticker=BTC-USD',
      'markets-ETH': 'https://indexer.dydx.trade/v4/perpetualMarkets?ticker=ETH-USD',
      'markets-SOL': 'https://indexer.dydx.trade/v4/perpetualMarkets?ticker=SOL-USD',
      candles: 'https://indexer.dydx.trade/v4/candles/perpetualMarkets/BTC-USD?resolution=1MIN&limit=5',
    },
  },
}

// Binance documents that the depth snapshot must be taken after the first diff is buffered.
let firstDiff
const firstDiffSeen = new Promise((resolve) => (firstDiff = resolve))

function record(name, { url, subscribe }) {
  return new Promise((resolve) => {
    const frames = []
    const ws = new WebSocket(url)
    ws.onopen = () => subscribe.forEach((s) => ws.send(JSON.stringify(s)))
    ws.onmessage = (e) => {
      frames.push(String(e.data))
      if (name === 'binance' && String(e.data).includes('depthUpdate')) firstDiff()
    }
    ws.onerror = (e) => console.error(name, e.message)
    setTimeout(() => { ws.close(); resolve(frames) }, seconds * 1000)
  })
}

await mkdir(out, { recursive: true })
await Promise.all(Object.entries(venues).map(async ([name, v]) => {
  const [frames, ...rest] = await Promise.all([
    record(name, v),
    ...Object.entries(v.rest).map(async ([k, u]) => {
      if (k === 'depth') await firstDiffSeen
      return [k, await (await fetch(u)).json()]
    }),
    ...Object.entries(v.post ?? {}).map(async ([k, body]) => [k, await (await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()]),
  ])
  const kept = name === 'dydx' ? frames.slice(0, dydxLines) : frames
  await writeFile(new URL(`${name}.ws.jsonl`, out), kept.join('\n') + '\n')
  for (const [k, json] of rest) await writeFile(new URL(`${name}.${k}.json`, out), JSON.stringify(json))
  console.log(name, frames.length, 'frames', rest.map(([k]) => k).join(','))
}))
