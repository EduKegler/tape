import { restRecording } from './feed'

const recordings = import.meta.glob<string>('../../packages/venues/src/__fixtures__/*', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export const recording = (name: string) => recordings[`../../packages/venues/src/__fixtures__/${name}`] ?? null

export const replayFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString()
  const name = restRecording(url, typeof init?.body === 'string' ? init.body : null)
  const body = name ? recording(name) : null
  if (!body) throw new TypeError(`no recording for ${url}`)
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}
