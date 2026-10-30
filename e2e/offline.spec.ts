import type { Network } from '@tape/core/ids'
import { CONTROL } from './replay/control'
import type { Probe, ProbeResult } from './replay/control'
import { expect, openMarket, test } from './fixtures'

const HYPERLIQUID: Record<Network, string> = { mainnet: 'api.hyperliquid.xyz', testnet: 'api.hyperliquid-testnet.xyz' }
const hyperliquid = (network: Network): Probe => ({
  http: `https://${HYPERLIQUID[network]}/exchange`,
  socket: `wss://${HYPERLIQUID[network]}/ws`,
})

test('the page cannot reach a venue', async ({ page, network, escaped, consoleErrors }) => {
  const venue = hyperliquid(network)
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const reached = await page.evaluate(async ({ http, socket }) => {
    const fetched = await fetch(http, { method: 'POST', body: '{}' }).then(
      () => true,
      () => false,
    )
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(socket)
      ws.onopen = () => {
        ws.close()
        resolve(true)
      }
      ws.onerror = () => resolve(false)
    })
    return { fetched, opened }
  }, venue)
  expect(reached).toEqual({ fetched: false, opened: false })
  expect(escaped.splice(0)).toEqual([`POST ${venue.http}`])
  const errors = consoleErrors.splice(0)
  expect(errors).toContainEqual(expect.stringContaining(venue.socket))
  expect(errors.filter((error) => !error.includes(HYPERLIQUID[network]))).toEqual([])
})

test('the hub worker cannot reach a venue', async ({ page, network }) => {
  await openMarket(page, '/hyperliquid/BTC?interval=1m')
  const reached = await page.evaluate(
    async ({ control, probe }) =>
      new Promise<ProbeResult>((resolve) => {
        const channel = new BroadcastChannel(control)
        channel.onmessage = (e: MessageEvent<{ reached?: ProbeResult }>) => {
          if (!e.data.reached) return
          channel.close()
          resolve(e.data.reached)
        }
        channel.postMessage({ probe })
      }),
    { control: CONTROL, probe: hyperliquid(network) },
  )
  expect(reached).toEqual({ fetched: false, opened: false })
})
