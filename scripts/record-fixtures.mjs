import { mkdir, writeFile } from 'node:fs/promises'

const seconds = Number(process.argv[2] ?? 8)
const out = new URL('../packages/venues/src/__fixtures__/', import.meta.url)
const dydxLines = 600

const HOSTS = {
  mainnet: {
    binance: { rest: 'data-api.binance.vision', ws: 'data-stream.binance.vision' },
    hyperliquid: 'api.hyperliquid.xyz',
    dydx: 'indexer.dydx.trade',
    orderly: { rest: 'api.orderly.org', ws: 'ws-evm.orderly.org' },
  },
  testnet: {
    binance: { rest: 'testnet.binance.vision', ws: 'stream.testnet.binance.vision' },
    hyperliquid: 'api.hyperliquid-testnet.xyz',
    dydx: 'indexer.v4testnet.dydx.exchange',
    orderly: { rest: 'testnet-api.orderly.org', ws: 'testnet-ws-evm.orderly.org' },
  },
}
const network = process.env.NETWORK ?? 'mainnet'
const host = HOSTS[network]
if (!host) throw new Error(`NETWORK must be one of ${Object.keys(HOSTS).join(', ')}, not ${network}`)

const venues = {
  binance: {
    url: `wss://${host.binance.ws}/stream?streams=btcusdt@depth@100ms/btcusdt@trade/btcusdt@kline_1m`,
    subscribe: [],
    rest: {
      depth: `https://${host.binance.rest}/api/v3/depth?symbol=BTCUSDT&limit=1000`,
      exchangeInfo: `https://${host.binance.rest}/api/v3/exchangeInfo?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT","SOLUSDT"]')}`,
      klines: `https://${host.binance.rest}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5`,
      ticker: `https://${host.binance.rest}/api/v3/ticker/24hr?symbol=BTCUSDT`,
    },
  },
  hyperliquid: {
    url: `wss://${host.hyperliquid}/ws`,
    subscribe: ['l2Book', 'trades']
      .map((type) => ({ method: 'subscribe', subscription: { type, coin: 'BTC' } }))
      .concat({ method: 'subscribe', subscription: { type: 'candle', coin: 'BTC', interval: '1m' } }),
    rest: {},
    post: {
      meta: { type: 'meta' },
      metaAndAssetCtxs: { type: 'metaAndAssetCtxs' },
      candleSnapshot: {
        type: 'candleSnapshot',
        req: { coin: 'BTC', interval: '1m', startTime: Date.now() - 5 * 60_000, endTime: Date.now() },
      },
    },
  },
  dydx: {
    url: `wss://${host.dydx}/v4/ws`,
    subscribe: [
      { type: 'subscribe', channel: 'v4_orderbook', id: 'BTC-USD' },
      { type: 'subscribe', channel: 'v4_trades', id: 'BTC-USD' },
      { type: 'subscribe', channel: 'v4_candles', id: 'BTC-USD/1MIN' },
    ],
    rest: {
      'markets-BTC': `https://${host.dydx}/v4/perpetualMarkets?ticker=BTC-USD`,
      'markets-ETH': `https://${host.dydx}/v4/perpetualMarkets?ticker=ETH-USD`,
      'markets-SOL': `https://${host.dydx}/v4/perpetualMarkets?ticker=SOL-USD`,
      candles: `https://${host.dydx}/v4/candles/perpetualMarkets/BTC-USD?resolution=1MIN&limit=5`,
    },
  },
  orderly: {
    url: `wss://${host.orderly.ws}/ws/stream/OqdphuyCtYWxwzhxyLLjOWNdFP7sQt8RPWzmb5xY`,
    subscribe: ['orderbook', 'trade', 'kline_1m'].map((s) => ({
      id: s,
      topic: `PERP_BTC_USDC@${s}`,
      event: 'subscribe',
    })),
    rest: {
      'info-BTC': `https://${host.orderly.rest}/v1/public/info/PERP_BTC_USDC`,
      'info-ETH': `https://${host.orderly.rest}/v1/public/info/PERP_ETH_USDC`,
      'info-SOL': `https://${host.orderly.rest}/v1/public/info/PERP_SOL_USDC`,
      futures: `https://${host.orderly.rest}/v1/public/futures/PERP_BTC_USDC`,
      history: `https://${host.orderly.rest}/v1/tv/history?symbol=PERP_BTC_USDC&resolution=1&from=${Math.floor(Date.now() / 1000) - 300}&to=${Math.floor(Date.now() / 1000)}`,
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
    setTimeout(() => {
      ws.close()
      resolve(frames)
    }, seconds * 1000)
  })
}

async function reply(name, key, response) {
  if (!response.ok) throw new Error(`${name} ${key} answered ${response.status}: ${await response.text()}`)
  return [key, await response.json()]
}

await mkdir(out, { recursive: true })
const only = process.argv[3]
await Promise.all(
  Object.entries(venues)
    .filter(([name]) => !only || name === only)
    .map(async ([name, v]) => {
      const [frames, ...rest] = await Promise.all([
        record(name, v),
        ...Object.entries(v.rest).map(async ([k, u]) => {
          if (k === 'depth') await firstDiffSeen
          return reply(name, k, await fetch(u))
        }),
        ...Object.entries(v.post ?? {}).map(async ([k, body]) =>
          reply(
            name,
            k,
            await fetch(`https://${host.hyperliquid}/info`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
          ),
        ),
      ])
      const kept = name === 'dydx' ? frames.slice(0, dydxLines) : frames
      await writeFile(new URL(`${name}.ws.jsonl`, out), kept.join('\n') + '\n')
      for (const [k, json] of rest) await writeFile(new URL(`${name}.${k}.json`, out), JSON.stringify(json))
      console.log(name, frames.length, 'frames', rest.map(([k]) => k).join(','))
    }),
)
