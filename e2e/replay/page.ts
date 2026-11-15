import { RECORDED_AT } from './clock'
import { restRecording } from './feed'
import { replayFetch } from './recordings'

const realFetch = globalThis.fetch.bind(globalThis)
const startedAt = performance.now()
Date.now = () => Math.round(RECORDED_AT + performance.now() - startedAt)
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input.toString()
  return restRecording(url, typeof init?.body === 'string' ? init.body : null)
    ? replayFetch(input, init)
    : realFetch(input, init)
}
