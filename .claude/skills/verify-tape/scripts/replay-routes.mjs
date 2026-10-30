// Serves the REST calls of a page on a replay run from the recordings, as `pnpm e2e` does.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { restRecording } from '../../../../e2e/replay/feed.ts'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/venues/src/__fixtures__')

export async function replayRoutes(context) {
  const escaped = []
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.hostname === '127.0.0.1') return route.continue()
    const name = restRecording(request.url(), request.postData())
    if (name && existsSync(join(FIXTURES, name)))
      return route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: readFileSync(join(FIXTURES, name), 'utf8'),
      })
    escaped.push(`${request.method()} ${url.origin}${url.pathname}`)
    return route.abort('blockedbyclient')
  })
  return escaped
}
