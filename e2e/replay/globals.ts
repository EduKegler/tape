import { VENUE_IDS } from '@tape/core/ids'
import { venues } from '@tape/venues/index'
import { NETWORK } from '#/site'
import { RECORDED_AT } from './clock'
import { CONTROL } from './control'
import type { Playback, Probe, ProbeResult } from './control'
import { createFeed, restRecording } from './feed'
import type { Feed } from './feed'

const recordings = import.meta.glob<string>('../../packages/venues/src/__fixtures__/*', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const recording = (name: string) => recordings[`../../packages/venues/src/__fixtures__/${name}`] ?? null

const urls = venues(NETWORK)
const open = new Set<Feed>()
const realFetch = globalThis.fetch.bind(globalThis)
const RealWebSocket = globalThis.WebSocket

class ReplayWebSocket {
  static readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  private readonly feed: Feed

  constructor(url: string) {
    const venue = VENUE_IDS.find((id) => urls[id].url === url)
    if (!venue) throw new Error(`no recording for ${url}`)
    const frames = (recording(`${venue}.ws.jsonl`) ?? '').trim().split('\n')
    this.feed = createFeed(frames, {
      send: (data) => this.onmessage?.({ data }),
      close: () => this.closed(),
    })
    open.add(this.feed)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }

  send(data: string) {
    this.feed.receive(data)
  }

  close() {
    this.feed.stop()
    this.closed()
  }

  private closed() {
    if (this.readyState === 3) return
    this.readyState = 3
    open.delete(this.feed)
    setTimeout(() => this.onclose?.(), 0)
  }
}

const replayFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString()
  const name = restRecording(url, typeof init?.body === 'string' ? init.body : null)
  const body = name ? recording(name) : null
  if (!body) throw new TypeError(`no recording for ${url}`)
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

async function reaches({ http, socket }: Probe): Promise<ProbeResult> {
  const fetched = await realFetch(http, { method: 'POST', body: '{}' }).then(
    () => true,
    () => false,
  )
  const opened = await new Promise<boolean>((resolve) => {
    const ws = new RealWebSocket(socket)
    ws.onopen = () => {
      ws.close()
      resolve(true)
    }
    ws.onerror = () => resolve(false)
  })
  return { fetched, opened }
}

const startedAt = performance.now()
Date.now = () => Math.round(RECORDED_AT + performance.now() - startedAt)
Object.assign(globalThis, { WebSocket: ReplayWebSocket, fetch: replayFetch })

const control = new BroadcastChannel(CONTROL)
control.onmessage = async (e: MessageEvent<{ probe?: Probe; playback?: true }>) => {
  if (e.data.probe) control.postMessage({ reached: await reaches(e.data.probe) })
  if (e.data.playback) {
    const playback: Playback = { sockets: open.size, playing: [...open].filter((feed) => !feed.played()).length }
    control.postMessage({ playback })
  }
}
