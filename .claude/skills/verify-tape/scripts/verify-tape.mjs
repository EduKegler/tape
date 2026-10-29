#!/usr/bin/env node
// Verification harness for Tape. Builds the app, serves the build and starts headless Chrome, drives the
// real UI over CDP with playwright-core, and writes evidence under artifacts/<run-id>/.
// Usage: node .claude/skills/verify-tape/scripts/verify-tape.mjs <command> [flags]. Run with no
// command for the list.
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(SKILL, '../../..')
const STATE_DIR = join(SKILL, '.state')
const STATE = join(STATE_DIR, 'run.json')
const ARTIFACTS = join(SKILL, 'artifacts')
const OUTPUT = join(SKILL, '.cache/output')
const PORT = Number(process.env.VERIFY_TAPE_PORT ?? 4391)
const CDP_PORT = Number(process.env.VERIFY_TAPE_CDP_PORT ?? 9391)
const WALLET_PORT = Number(process.env.VERIFY_TAPE_WALLET_PORT ?? 4392)
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = `http://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const die = (msg, code = 1) => {
  console.error(`verify-tape: ${msg}`)
  process.exit(code)
}

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else pos.push(a)
  }
  return { pos, flags }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null)

function requireState() {
  const s = readState()
  if (!s) die('no run started by this harness. Run `up` first. This harness never drives an instance it did not start.')
  if (!alive(s.serverPid) || !alive(s.chromePid) || (s.walletPid && !alive(s.walletPid)))
    die('a process from this run is gone. Run `down`, then `up`.')
  return s
}

function portBusy(port) {
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => (sock.destroy(), res(true)))
    sock.once('error', () => res(false))
  })
}

function listenerPids(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function artifactPath(s, p) {
  const out = isAbsolute(p) ? p : join(ARTIFACTS, s.runId, p)
  mkdirSync(dirname(out), { recursive: true })
  return out
}

function record(s, entry) {
  const file = artifactPath(s, 'steps.jsonl')
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

// ---------- lifecycle ----------

async function up(flags) {
  const prior = readState()
  if (prior && (alive(prior.serverPid) || alive(prior.chromePid)))
    die(`a run is already up (run ${prior.runId}). Use it, or run \`down\` first.`)
  if (prior) rmSync(STATE_DIR, { recursive: true, force: true })
  if (await portBusy(PORT))
    die(
      `port ${PORT} is already in use by a process this harness did not start. Refusing to drive it. Set VERIFY_TAPE_PORT to a free port.`,
    )
  if (await portBusy(CDP_PORT)) die(`CDP port ${CDP_PORT} is in use. Set VERIFY_TAPE_CDP_PORT to a free port.`)
  if (await portBusy(WALLET_PORT))
    die(`wallet port ${WALLET_PORT} is in use. Set VERIFY_TAPE_WALLET_PORT to a free port.`)
  if (!existsSync(CHROME)) die(`Chrome not found at ${CHROME}. Set CHROME to a Chrome binary.`)

  const runId = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(join(ARTIFACTS, runId), { recursive: true })
  const buildLog = join(ARTIFACTS, runId, 'build.log')
  const serverLog = join(STATE_DIR, 'server.log')
  const sha = git(['rev-parse', '--short', 'HEAD'])
  const dirty = git(['status', '--porcelain', '--', 'src', 'packages']).split('\n').filter(Boolean).length
  if (flags['reuse-build'] && existsSync(join(OUTPUT, 'server/index.mjs'))) {
    console.log(`up: reusing the build in ${OUTPUT}. It may not match the working tree.`)
  } else {
    console.log(
      `up: building ${sha}${dirty ? ` plus ${dirty} uncommitted file(s) under src/ and packages/` : ''} into ${OUTPUT}`,
    )
    try {
      execFileSync(
        process.execPath,
        [
          join(REPO, 'node_modules/vite/bin/vite.js'),
          'build',
          '--config',
          join(SKILL, 'scripts/vite.verify.config.ts'),
        ],
        { cwd: REPO, stdio: ['ignore', openSync(buildLog, 'w'), openSync(buildLog, 'a')] },
      )
    } catch {
      console.error(readFileSync(buildLog, 'utf8').split('\n').slice(-30).join('\n'))
      rmSync(STATE_DIR, { recursive: true, force: true })
      die(`build failed. Log: ${buildLog}`)
    }
  }
  const fd = openSync(serverLog, 'a')
  const server = spawn(process.execPath, [join(OUTPUT, 'server/index.mjs')], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, NITRO_PORT: String(PORT), PORT: String(PORT), NITRO_HOST: '127.0.0.1', HOST: '127.0.0.1' },
  })
  server.unref()
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${join(STATE_DIR, 'chrome')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  )
  chrome.unref()
  const s = {
    runId,
    port: PORT,
    cdpPort: CDP_PORT,
    base: BASE,
    serverPid: server.pid,
    chromePid: chrome.pid,
    sha,
    dirtySrcFiles: dirty,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(STATE, JSON.stringify(s, null, 2))

  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline) {
    if (!alive(server.pid)) break
    try {
      const r = await fetch(`${BASE}/hyperliquid/BTC?interval=1m`, { signal: AbortSignal.timeout(30_000) })
      const body = await r.text()
      if (r.status === 200 && body.includes('BTC on Hyperliquid')) {
        ready = true
        break
      }
    } catch {}
    await sleep(1000)
  }
  if (!ready) {
    console.error(readFileSync(serverLog, 'utf8').split('\n').slice(-30).join('\n'))
    die(`server did not serve the market page within 60 s. Log: ${serverLog}. Run \`down\`.`)
  }
  let cdp = false
  for (let i = 0; i < 30 && !cdp; i++) {
    try {
      cdp = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok
    } catch {
      await sleep(500)
    }
  }
  if (!cdp) die('Chrome did not open its CDP port. Run `down`.')
  const walletLog = openSync(join(STATE_DIR, 'wallet.log'), 'a')
  const wallet = spawn(
    process.execPath,
    [
      join(SKILL, 'scripts/test-wallet.mjs'),
      String(CDP_PORT),
      String(WALLET_PORT),
      join(STATE_DIR, 'wallet-key.json'),
      join(ARTIFACTS, runId, 'wallet.jsonl'),
    ],
    { cwd: REPO, detached: true, stdio: ['ignore', walletLog, walletLog] },
  )
  wallet.unref()
  writeFileSync(STATE, JSON.stringify({ ...s, walletPid: wallet.pid, walletPort: WALLET_PORT }, null, 2))
  let address = null
  for (let i = 0; i < 40 && !address; i++) {
    await sleep(250)
    if (existsSync(join(STATE_DIR, 'wallet-key.json')) && (await portBusy(WALLET_PORT)))
      address = JSON.parse(readFileSync(join(STATE_DIR, 'wallet-key.json'), 'utf8')).address
  }
  if (!address) die('the test wallet did not start. Log: .state/wallet.log. Run `down`.')
  record(s, { cmd: 'up', base: BASE, sha: s.sha, wallet: address })
  console.log(
    `up: run ${runId}\n  app     ${BASE}\n  cdp     http://127.0.0.1:${CDP_PORT}\n  server  pid ${server.pid}, log ${serverLog}\n  chrome  pid ${chrome.pid}\n  wallet  ${address}, pid ${wallet.pid}, port ${WALLET_PORT}\n  evidence ${join(ARTIFACTS, runId)}`,
  )
}

function killGroup(pid) {
  if (!pid || !alive(pid)) return false
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  return true
}

async function down() {
  const s = readState()
  if (!s) {
    console.log('down: nothing to stop. No run state.')
    return
  }
  const killed = [
    killGroup(s.walletPid) && `wallet ${s.walletPid}`,
    killGroup(s.chromePid) && `chrome ${s.chromePid}`,
    killGroup(s.serverPid) && `server ${s.serverPid}`,
  ].filter(Boolean)
  for (let i = 0; i < 20 && (alive(s.serverPid) || alive(s.chromePid) || (s.walletPid && alive(s.walletPid))); i++)
    await sleep(250)
  for (const pid of [s.serverPid, s.chromePid, s.walletPid])
    if (pid && alive(pid))
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
  const leftover = listenerPids(s.port)
  if (existsSync(join(ARTIFACTS, s.runId))) record(s, { cmd: 'down', killed })
  rmSync(STATE_DIR, { recursive: true, force: true })
  console.log(`down: stopped ${killed.join(', ') || 'nothing (already gone)'}. Removed ${STATE_DIR}.`)
  console.log(`  evidence kept at ${join(ARTIFACTS, s.runId)}`)
  if (leftover.length)
    console.log(
      `  warning: port ${s.port} still has listener(s) ${leftover.join(', ')}. Check they are not yours before killing.`,
    )
}

async function doctor() {
  const s = readState()
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })
  if (!s) {
    check('run state', false, `no ${STATE}. Run \`up\`.`)
  } else {
    check('run state', true, `run ${s.runId}, started ${s.startedAt} at ${s.sha}`)
    check('server process', alive(s.serverPid), `pid ${s.serverPid}`)
    check('chrome process', alive(s.chromePid), `pid ${s.chromePid}`)
    check(
      'test wallet process',
      Boolean(s.walletPid) && alive(s.walletPid),
      `pid ${s.walletPid ?? 'none'}, port ${s.walletPort ?? 'none'}`,
    )
    const owners = listenerPids(s.port)
    check(
      `port ${s.port} owned by this run`,
      owners.length > 0 && owners.every((p) => p === s.serverPid),
      `listeners ${owners.join(',') || 'none'}`,
    )
    try {
      const r = await fetch(`${s.base}/`, { signal: AbortSignal.timeout(30_000) })
      const body = await r.text()
      const title = body.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''
      check(
        'app serves /',
        r.ok && /\/hyperliquid\/BTC\?interval=1m(&net=mainnet)?$/.test(r.url) && title.includes('Tape'),
        `${r.status} ${r.url} title "${title}"`,
      )
    } catch (e) {
      check('app serves /', false, String(e))
    }
    try {
      const v = await (await fetch(`http://127.0.0.1:${s.cdpPort}/json/version`)).json()
      const tabs = await (await fetch(`http://127.0.0.1:${s.cdpPort}/json/list`)).json()
      check('chrome cdp', true, `${v.Browser}, ${tabs.filter((t) => t.type === 'page').length} page(s)`)
    } catch (e) {
      check('chrome cdp', false, String(e))
    }
    const head = git(['rev-parse', '--short', 'HEAD'])
    const dirty = git(['status', '--porcelain', '--', 'src', 'packages']).split('\n').filter(Boolean).length
    check(
      'build',
      true,
      `HEAD ${head}${head !== s.sha ? ` but the build is from ${s.sha}. Run down and up to rebuild` : ''}, ${dirty} uncommitted file(s) under src/ and packages/ now, ${s.dirtySrcFiles} at build time`,
    )
  }
  const venues = [
    ['binance', () => fetch('https://data-api.binance.vision/api/v3/ping', { signal: AbortSignal.timeout(5000) })],
    [
      'hyperliquid',
      () =>
        fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"type":"meta"}',
          signal: AbortSignal.timeout(5000),
        }),
    ],
    ['dydx', () => fetch('https://indexer.dydx.trade/v4/height', { signal: AbortSignal.timeout(5000) })],
  ]
  for (const [name, probe] of venues) {
    try {
      const r = await probe()
      check(`venue ${name} reachable`, r.ok, `HTTP ${r.status}`)
    } catch (e) {
      check(`venue ${name} reachable`, false, e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code ?? e))
    }
  }
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  const core = checks.filter((c) => !c.name.startsWith('venue'))
  if (core.some((c) => !c.ok)) process.exit(1)
  if (checks.some((c) => !c.ok)) process.exit(2)
}

// ---------- browser ----------

async function targetId(page) {
  const cdp = await page.context().newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  await cdp.detach().catch(() => {})
  return targetInfo.targetId.slice(0, 8)
}

// Pages are addressed by a short CDP target id, never by list position: the order Chrome
// reports pages in changes after a tab closes. The current page is kept in run.json.
async function withPage(s, flags, fn) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`)
  try {
    const ctx = browser.contexts()[0]
    const ids = new Map()
    for (const p of ctx.pages()) ids.set(p, await targetId(p))
    const byId = (id) => [...ids].find(([, v]) => v.startsWith(String(id)))?.[0]
    let page
    if (flags.new) {
      page = await ctx.newPage()
      ids.set(page, await targetId(page))
    } else if (flags.page !== undefined) page = byId(flags.page)
    else page = (s.current && byId(s.current)) || ctx.pages()[0]
    if (!page) throw new Error(`no page ${flags.page ?? s.current ?? ''}. Run \`pages\`.`)
    const id = ids.get(page)
    if (s.current !== id) writeFileSync(STATE, JSON.stringify({ ...s, current: id }, null, 2))
    page.setDefaultTimeout(Number(flags.timeout ?? 15000))
    return await fn(page, ctx, id, ids)
  } finally {
    await browser.close().catch(() => {})
  }
}

function scope(page, flags) {
  if (flags.panel)
    return page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 2, name: flags.panel, exact: true }) })
  if (flags.nav) return page.getByRole('navigation', { name: flags.nav, exact: true })
  if (flags.within) return page.locator(flags.within)
  return page
}

function target(page, flags) {
  const root = scope(page, flags)
  if (flags.css) return root.locator(flags.css).first()
  if (flags.role) {
    const name = flags.name === undefined ? undefined : flags.regex ? new RegExp(flags.name) : flags.name
    const loc = root.getByRole(flags.role, { name, exact: Boolean(flags.exact) })
    return flags.nth !== undefined ? loc.nth(Number(flags.nth)) : loc
  }
  if (flags.text) return root.getByText(flags.text, { exact: Boolean(flags.exact) })
  if (flags.label) return root.getByLabel(flags.label, { exact: Boolean(flags.exact) })
  return root === page ? page.locator('body') : root
}

function describe(flags) {
  return ['panel', 'nav', 'within', 'role', 'name', 'css', 'text', 'label', 'nth']
    .filter((k) => flags[k] !== undefined)
    .map((k) => `${k}=${flags[k]}`)
    .join(' ')
}

async function browserCmd(cmd, pos, flags) {
  const s = requireState()
  await withPage(s, flags, async (page, ctx, index, ids) => {
    let result
    switch (cmd) {
      case 'open': {
        const path = pos[0] ?? '/'
        await page.goto(path.startsWith('http') ? path : `${s.base}${path}`, { waitUntil: 'domcontentloaded' })
        result = { page: index, url: page.url(), title: await page.title() }
        break
      }
      case 'click':
        await target(page, flags).click()
        result = { page: index, clicked: describe(flags), url: page.url() }
        break
      case 'fill':
        await target(page, flags).fill(String(flags.value ?? ''))
        if (flags.blur) await target(page, flags).blur()
        result = { page: index, filled: describe(flags), value: flags.value }
        break
      case 'select':
        await target(page, flags).selectOption(String(flags.value))
        result = { page: index, selected: describe(flags), value: flags.value, url: page.url() }
        break
      case 'press':
        await page.keyboard.press(String(flags.key))
        result = { page: index, key: flags.key }
        break
      case 'wait': {
        const start = Date.now()
        if (flags.js) await page.waitForFunction(flags.js, null, { timeout: Number(flags.timeout ?? 30000) })
        else if (flags.url) await page.waitForURL(new RegExp(flags.url), { timeout: Number(flags.timeout ?? 30000) })
        else
          await target(page, flags)
            .first()
            .waitFor({ state: flags.state ?? 'visible', timeout: Number(flags.timeout ?? 30000) })
        result = { page: index, waited: flags.js ?? flags.url ?? describe(flags), ms: Date.now() - start }
        break
      }
      case 'text': {
        const loc = target(page, flags)
        result = {
          page: index,
          of: describe(flags) || 'page',
          text: flags.all ? await loc.allInnerTexts() : await loc.first().innerText(),
        }
        break
      }
      case 'attr':
        result = {
          page: index,
          of: describe(flags),
          attr: flags.attr,
          value: await target(page, flags).first().getAttribute(String(flags.attr)),
        }
        break
      case 'eval':
        result = { page: index, value: await page.evaluate(pos.join(' ')) }
        break
      case 'aria': {
        const snap = await target(page, flags).first().ariaSnapshot()
        if (flags.path) {
          const out = artifactPath(s, flags.path)
          writeFileSync(out, `# ${page.url()}\n# ${describe(flags) || 'page'}\n${snap}\n`)
          result = { page: index, wrote: out }
        } else result = { page: index, aria: snap }
        break
      }
      case 'shot': {
        const out = artifactPath(s, flags.path ?? `shot-${Date.now()}.png`)
        if (flags.panel || flags.css || flags.role) await target(page, flags).first().screenshot({ path: out })
        else await page.screenshot({ path: out, fullPage: Boolean(flags.full) })
        result = { page: index, wrote: out }
        break
      }
      case 'pages':
        result = {
          current: index,
          pages: await Promise.all(
            [...ids].map(async ([p, id]) => ({ id, url: p.url(), title: await p.title().catch(() => '') })),
          ),
        }
        break
      case 'close':
        await page.close()
        writeFileSync(STATE, JSON.stringify({ ...readState(), current: undefined }, null, 2))
        result = { closed: index }
        break
    }
    record(s, { cmd, args: pos, flags, result })
    console.log(JSON.stringify(result, null, 2))
  })
}

const HELP = `verify-tape <command> [flags]

Lifecycle
  up [--reuse-build]         build into .cache/output, serve it on 127.0.0.1:${PORT}, start headless Chrome (CDP ${CDP_PORT})
  doctor                     read-only health check. Exit 1: instance broken. Exit 2: a venue is unreachable.
  down                       stop both processes this run started. Evidence stays.

Browser (acts on the current page. --new opens a tab and makes it current. --page <id> switches)
  open <path> [--new]        load ${BASE}<path>, --new opens a second tab
  click  <locator>           wait --js <expr> | --url <re> | <locator> [--state hidden]
  fill   <locator> --value V [--blur]
  select <locator> --value V
  press  --key K             text <locator> [--all]    attr <locator> --attr A
  eval   <js expression>     aria [<locator>] [--path rel]   shot [<locator>] [--path rel] [--full]
  pages                      list tabs with their ids     close [--page <id>]

Locator flags
  --panel "Order book"       scope to the panel whose h2 has this exact text
  --nav Market|Venue         scope to a header nav
  --role R [--name N] [--exact] [--regex] [--nth i]
  --text T | --label L | --css S
  --timeout ms

Relative --path values go to ${ARTIFACTS}/<run-id>/. Every command appends to steps.jsonl there.`

const { pos, flags } = parseArgs(process.argv.slice(2))
const cmd = pos.shift()
try {
  if (cmd === 'up') await up(flags)
  else if (cmd === 'down') await down()
  else if (cmd === 'doctor') await doctor()
  else if (
    [
      'open',
      'click',
      'fill',
      'select',
      'press',
      'wait',
      'text',
      'attr',
      'eval',
      'aria',
      'shot',
      'pages',
      'close',
    ].includes(cmd)
  )
    await browserCmd(cmd, pos, flags)
  else {
    console.log(HELP)
    if (cmd && cmd !== 'help') process.exit(1)
  }
} catch (e) {
  const s = readState()
  if (s && cmd !== 'up')
    try {
      record(s, { cmd, args: pos, flags, error: String(e.message ?? e) })
    } catch {}
  die(
    String(e.message ?? e)
      .split('\n')
      .slice(0, 6)
      .join('\n'),
  )
}
