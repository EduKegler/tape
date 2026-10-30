#!/usr/bin/env node
// Performance probe for Tape. Drives a verify-tape run that was started with `up --replay`, keeps the
// recorded book moving, and measures frame time, long tasks, the time from a key press in the ticket's price
// field to the next paint, and main thread and GPU work. Writes one JSON per run and a summary, and compares
// the summary to a baseline when given one.
// Usage: node .claude/skills/verify-tape/scripts/perf-probe.mjs [flags]. Run with --help for the list.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, totalmem } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CONTROL } from '../../../../e2e/replay/control.ts'
import { replayRoutes } from './replay-routes.mjs'

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(SKILL, '../../..')
const STATE = join(SKILL, '.state/run.json')
const ARTIFACTS = join(SKILL, 'artifacts')

const PROBE = {
  path: '/dydx/BTC?interval=1m',
  seconds: 60,
  primeLoads: 2,
  warmupSeconds: 5,
  pressEveryMs: 330,
  typed: '80520',
  calibrationLoop: 25_000,
  calibrateEveryMs: 250,
}
const MIN_BOOK_COMMITS_PER_SECOND = 5
const MIN_KEYS_MEASURED = 0.9

// Main thread time on Apple silicon moves with the core macOS schedules the renderer on, so CPU work is also
// reported in runs of a fixed loop timed on the same thread during the same window.
const METRICS = {
  frameP95: 'frame time p95, ms',
  frameP99: 'frame time p99, ms',
  droppedPct: 'frames dropped against the display rate, %',
  longTasks: 'long tasks',
  blockingMs: 'total blocking time of long tasks, ms',
  keyP50: 'key to paint p50, ms',
  keyP95: 'key to paint p95, ms',
  keyWorkP50: 'main thread work per key, from keydown to the end of the next paint, p50, calibration loops',
  keyWorkP95: 'main thread work per key, p95, calibration loops',
  mainThreadWork: 'main thread busy time, calibration loops per second',
  gpuWork: 'GPU process CPU time, calibration loops per second',
  layoutsPerSecond: 'layouts per second',
  styleRecalcsPerSecond: 'style recalculations per second',
  frameP50: 'frame time p50, ms',
  keyMax: 'key to paint max, ms',
  mainThreadMsPerSecond: 'main thread busy time, ms per second',
  scriptMsPerSecond: 'script, ms per second',
  styleLayoutMsPerSecond: 'style and layout, ms per second',
  gpuMsPerSecond: 'GPU process CPU time, ms per second',
  calibrationMs: 'mean time of one calibration loop, ms',
  domNodes: 'DOM nodes at the end',
  bookCommitsPerSecond: 'book commits per second',
}

const HELP = `perf-probe [flags]

Needs a verify-tape run started with \`up --replay\`. Loads the market ${PROBE.primeLoads} times to warm Chrome's code
cache. Then each run opens ${PROBE.path} in a new tab, waits for the book, loops the recording, warms up
${PROBE.warmupSeconds} s, and measures for ${PROBE.seconds} s while it types ${PROBE.typed} into the ticket's price field and
deletes it again, one key every ${PROBE.pressEveryMs} ms.

  --runs N                  runs back to back, each in a fresh tab and hub. Default 1
  --seconds S               length of the measured window. Default ${PROBE.seconds}. A baseline only compares runs of its length
  --out DIR                 where run-N.json and summary.json go. Default artifacts/<run-id>/perf-<time>/
  --baseline FILE           compare the median of the runs with the limits in FILE, from 3 runs. Exit 1 over a limit
  --label TEXT              free text stored in the summary, such as the branch being measured`

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    flags[key] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
if (flags.help) {
  console.log(HELP)
  process.exit(0)
}
if (flags.seconds) PROBE.seconds = Number(flags.seconds)
if (!existsSync(STATE)) {
  console.error('perf-probe: no verify-tape run. Start one with `up --replay`.')
  process.exit(1)
}
const run = JSON.parse(readFileSync(STATE, 'utf8'))
if (!run.replay) {
  console.error(
    'perf-probe: the run serves live venues. Live data changes between runs. Run `down`, then `up --replay`.',
  )
  process.exit(1)
}

const ascending = (values) => [...values].sort((a, b) => a - b)
const nearestRank = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : 0)
const median = (values) => nearestRank(ascending(values), 50)
const round = (n, digits = 1) => Number(n.toFixed(digits))

function install({ control, calibrationLoop, calibrateEveryMs }) {
  const probe = { frames: [], longTasks: [], keys: [], bookCommits: [], calibration: [], running: true }
  globalThis.__tapePerfProbe = probe
  probe.calibrator = setInterval(() => {
    const at = performance.now()
    let x = 1
    for (let i = 0; i < calibrationLoop; i++) x = (x * 48271) % 2147483647
    probe.sink = x
    probe.calibration.push({ at, ms: performance.now() - at })
  }, calibrateEveryMs)
  const frame = (t) => {
    if (!probe.running) return
    probe.frames.push(t)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  probe.longTaskObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) probe.longTasks.push({ start: e.startTime, duration: e.duration })
  })
  probe.longTaskObserver.observe({ type: 'longtask' })
  const book = [...document.querySelectorAll('section')].find(
    (s) => s.querySelector('h2')?.textContent === 'Order book',
  )
  probe.bookObserver = new MutationObserver(() => probe.bookCommits.push(performance.now()))
  probe.bookObserver.observe(book, { subtree: true, childList: true, characterData: true, attributes: true })
  probe.onKeyDown = (e) => {
    if (e.target.matches?.('input')) probe.key = { pressed: e.timeStamp, handled: performance.now() }
  }
  // In Chrome, a message posted from a requestAnimationFrame callback runs after that frame's style, layout and
  // paint.
  probe.onInput = () => {
    const key = probe.key
    if (!key) return
    probe.key = null
    key.committed = performance.now()
    requestAnimationFrame(() => {
      key.frame = performance.now()
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        key.painted = performance.now()
        probe.keys.push(key)
      }
      channel.port2.postMessage(null)
    })
  }
  addEventListener('keydown', probe.onKeyDown, true)
  addEventListener('input', probe.onInput)
  new BroadcastChannel(control).postMessage({ loop: true })
  return { start: performance.now(), visible: document.visibilityState }
}

function collect() {
  const probe = globalThis.__tapePerfProbe
  probe.running = false
  clearInterval(probe.calibrator)
  probe.longTaskObserver.disconnect()
  probe.bookObserver.disconnect()
  removeEventListener('keydown', probe.onKeyDown, true)
  removeEventListener('input', probe.onInput)
  const { frames, longTasks, keys, bookCommits, calibration } = probe
  return { frames, longTasks, keys, bookCommits, calibration, end: performance.now() }
}

function measure(raw, start, end, before, after, gpuMsPerSecond) {
  const within = (t) => t >= start && t <= end
  const calibrations = raw.calibration.filter((c) => within(c.at)).map((c) => c.ms)
  const loop = calibrations.reduce((n, ms) => n + ms, 0) / calibrations.length
  const perSecond = (name) => (1000 * (after[name] - before[name])) / (after.Timestamp - before.Timestamp)
  const frames = raw.frames.filter(within)
  const deltas = frames.slice(1).map((t, i) => t - frames[i])
  const frameTimes = ascending(deltas)
  const interval = nearestRank(frameTimes, 50)
  const dropped = deltas.reduce((n, d) => n + Math.max(0, Math.round(d / interval) - 1), 0)
  const longTasks = raw.longTasks.filter((t) => within(t.start))
  const keys = raw.keys.filter((k) => within(k.pressed))
  const toPaint = ascending(keys.map((k) => k.painted - k.pressed))
  const work = ascending(keys.map((k) => (k.committed - k.handled + k.painted - k.frame) / loop))
  return {
    metrics: {
      frameP95: round(nearestRank(frameTimes, 95)),
      frameP99: round(nearestRank(frameTimes, 99)),
      droppedPct: round((100 * dropped) / (deltas.length + dropped), 2),
      longTasks: longTasks.length,
      blockingMs: round(longTasks.reduce((n, t) => n + Math.max(0, t.duration - 50), 0)),
      keyP50: round(nearestRank(toPaint, 50)),
      keyP95: round(nearestRank(toPaint, 95)),
      keyWorkP50: round(nearestRank(work, 50)),
      keyWorkP95: round(nearestRank(work, 95)),
      mainThreadWork: round(perSecond('TaskDuration') / loop),
      gpuWork: round(gpuMsPerSecond / loop),
      layoutsPerSecond: round(perSecond('LayoutCount') / 1000, 2),
      styleRecalcsPerSecond: round(perSecond('RecalcStyleCount') / 1000, 2),
      frameP50: round(interval),
      keyMax: round(toPaint.at(-1) ?? 0),
      mainThreadMsPerSecond: round(perSecond('TaskDuration')),
      scriptMsPerSecond: round(perSecond('ScriptDuration')),
      styleLayoutMsPerSecond: round(perSecond('RecalcStyleDuration') + perSecond('LayoutDuration')),
      gpuMsPerSecond: round(gpuMsPerSecond),
      calibrationMs: round(loop, 3),
      domNodes: after.Nodes,
      bookCommitsPerSecond: round(raw.bookCommits.filter(within).length / ((end - start) / 1000)),
    },
    samples: {
      frameDeltas: deltas.map((d) => round(d)),
      keyToPaint: keys.map((k) => round(k.painted - k.pressed)),
      keyWork: keys.map((k) => round((k.committed - k.handled + k.painted - k.frame) / loop, 2)),
      calibrationMs: calibrations.map((ms) => round(ms, 2)),
      longTasks: longTasks.map((t) => round(t.duration)),
    },
  }
}

const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now())))
const gpuSeconds = async (cdp) => {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
  return processInfo.filter((p) => p.type === 'GPU').reduce((n, p) => n + p.cpuTime, 0)
}
const mainThread = async (cdp) =>
  Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))

const panel = (page, title) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

async function openMarket(page) {
  await page.bringToFront()
  await page.goto(`${run.base}${PROBE.path}`, { waitUntil: 'domcontentloaded' })
  await panel(page, 'Order book')
    .getByText(/^Spread .* bps$/)
    .waitFor({ timeout: 30_000 })
}

// V8 in Chrome caches a script's compiled code from its second load on, so the first runs in a fresh Chrome
// would compile more than the rest.
async function prime(browser) {
  for (let i = 0; i < PROBE.primeLoads; i++) {
    const page = await browser.contexts()[0].newPage()
    try {
      await openMarket(page)
    } finally {
      await page.close().catch(() => {})
    }
  }
}

async function probeOnce(browser, n) {
  const context = browser.contexts()[0]
  const system = await browser.newBrowserCDPSession()
  const page = await context.newPage()
  try {
    await openMarket(page)
    const price = panel(page, 'Order ticket').getByRole('textbox', { name: /^Price/ })
    await price.fill('')
    const { start: installedAt, visible } = await page.evaluate(install, { control: CONTROL, ...PROBE })
    if (visible !== 'visible') throw new Error(`the probe tab is ${visible}, so Chrome throttles its frames`)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    await sleepUntil(Date.now() + PROBE.warmupSeconds * 1000)
    const load = loadavg()[0]
    const gpuBefore = { seconds: await gpuSeconds(system), at: performance.now() }
    const before = await mainThread(cdp)
    const start = await page.evaluate(() => performance.now())
    const keys = [...PROBE.typed, ...Array.from(PROBE.typed, () => 'Backspace')]
    const begun = Date.now()
    let pressed = 0
    while (Date.now() - begun < PROBE.seconds * 1000) {
      await page.keyboard.press(keys[pressed % keys.length])
      pressed++
      await sleepUntil(begun + pressed * PROBE.pressEveryMs)
    }
    const after = await mainThread(cdp)
    const gpu = (1000 * ((await gpuSeconds(system)) - gpuBefore.seconds)) / ((performance.now() - gpuBefore.at) / 1000)
    const raw = await page.evaluate(collect)
    const result = measure(raw, start, raw.end, before, after, gpu)
    const commits = result.metrics.bookCommitsPerSecond
    if (commits < MIN_BOOK_COMMITS_PER_SECOND)
      throw new Error(`run ${n}: the book committed ${commits} times a second, under ${MIN_BOOK_COMMITS_PER_SECOND}`)
    if (result.samples.keyToPaint.length < pressed * MIN_KEYS_MEASURED)
      throw new Error(`run ${n}: measured ${result.samples.keyToPaint.length} of ${pressed} key presses`)
    return {
      run: n,
      loadAverage: { before: round(load, 2), after: round(loadavg()[0], 2) },
      warmupFrom: round(installedAt),
      from: round(start),
      to: round(raw.end),
      pressed,
      ...result,
    }
  } finally {
    await page.close().catch(() => {})
  }
}

function summarize(runs) {
  return Object.fromEntries(
    Object.keys(METRICS).map((name) => {
      const values = runs.map((r) => r.metrics[name])
      return [name, { median: median(values), min: Math.min(...values), max: Math.max(...values), values }]
    }),
  )
}

function compare(summary, baseline) {
  const rows = Object.entries(baseline.metrics)
    .filter(([, b]) => b.limit !== undefined)
    .map(([name, b]) => ({ name, baseline: b.median, limit: b.limit, now: summary[name]?.median }))
  for (const r of rows) r.over = r.now === undefined || r.now > r.limit
  return rows
}

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
const runs = Number(flags.runs ?? 1)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
const out = flags.out
  ? isAbsolute(flags.out)
    ? flags.out
    : resolve(process.cwd(), flags.out)
  : join(ARTIFACTS, run.runId, `perf-${stamp}`)
mkdirSync(out, { recursive: true })

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${run.cdpPort}`)
const results = []
try {
  const others = browser
    .contexts()[0]
    .pages()
    .filter((p) => p.url().startsWith(run.base))
  if (others.length)
    throw new Error(`close the other Tape tabs first. They share the hub and render too: ${others.map((p) => p.url())}`)
  const escaped = await replayRoutes(browser.contexts()[0])
  await prime(browser)
  for (let n = 1; n <= runs; n++) {
    const result = await probeOnce(browser, n)
    writeFileSync(join(out, `run-${n}.json`), `${JSON.stringify(result)}\n`)
    results.push(result)
    console.log(
      `run ${n}/${runs}: ${Object.entries(result.metrics)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    )
  }
  if (escaped.length) throw new Error(`requests left for the network:\n${[...new Set(escaped)].join('\n')}`)
} finally {
  await browser.close().catch(() => {})
}

const chromeVersion = (await (await fetch(`http://127.0.0.1:${run.cdpPort}/json/version`)).json()).Browser
const summary = {
  at: new Date().toISOString(),
  label: flags.label ?? null,
  sha: run.sha,
  head: git(['rev-parse', '--short', 'HEAD']),
  dirtySrcFiles: run.dirtySrcFiles,
  network: run.network,
  probe: PROBE,
  machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) },
  chrome: chromeVersion,
  units: METRICS,
  runs: results.length,
  metrics: summarize(results),
}
if (flags.baseline) {
  const baseline = JSON.parse(readFileSync(resolve(process.cwd(), flags.baseline), 'utf8'))
  summary.comparison = { baseline: flags.baseline, rows: compare(summary.metrics, baseline) }
  for (const key of ['path', 'seconds', 'pressEveryMs', 'typed', 'calibrationLoop', 'calibrateEveryMs'])
    if (baseline.probe?.[key] !== PROBE[key])
      console.warn(`warning: the baseline used ${key} ${baseline.probe?.[key]}, this probe uses ${PROBE[key]}`)
  if (baseline.chrome !== chromeVersion) console.warn(`warning: the baseline ran on ${baseline.chrome}`)
  const loop = summary.metrics.calibrationMs.median
  const seen = baseline.metrics.calibrationMs
  if (seen && (loop < seen.min || loop > seen.max))
    console.warn(
      `warning: the calibration loop took ${loop} ms, outside the baseline's ${seen.min} to ${seen.max} ms. The core ran at a speed the baseline never saw, so the metrics in ms can move without a change.`,
    )
  if (baseline.machine?.cpu !== summary.machine.cpu)
    console.warn(`warning: the baseline ran on ${baseline.machine?.cpu}`)
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
appendFileSync(
  join(ARTIFACTS, run.runId, 'steps.jsonl'),
  `${JSON.stringify({ at: summary.at, cmd: 'perf-probe', flags, out, over: summary.comparison?.rows.filter((r) => r.over).map((r) => r.name) ?? null })}\n`,
)
console.log(`summary: ${join(out, 'summary.json')}`)
for (const [name, m] of Object.entries(summary.metrics))
  console.log(`  ${name.padEnd(22)} median ${m.median}  min ${m.min}  max ${m.max}`)
if (summary.comparison) {
  for (const r of summary.comparison.rows)
    console.log(
      `  ${r.over ? 'OVER' : 'ok  '} ${r.name.padEnd(22)} ${r.now} against limit ${r.limit} (baseline ${r.baseline})`,
    )
  if (summary.comparison.rows.some((r) => r.over)) process.exit(1)
}
