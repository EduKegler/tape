#!/usr/bin/env node
// Computed-style parity for Tape. Reads the computed style and box of every rendered element in a
// replay run of verify-tape, keyed by panel, ARIA role and accessible name, and diffs two captures.
// Usage: node .claude/skills/verify-tape/scripts/parity.mjs <capture|diff> [flags]. Run with no
// command for the list.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { RECORDED_AT } from '../../../../e2e/replay/clock.ts'
import { CONTROL } from '../../../../e2e/replay/control.ts'
import { replayRoutes } from './replay-routes.mjs'

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE = join(SKILL, '.state/run.json')
const ARTIFACTS = join(SKILL, 'artifacts')

const MARKET_READY = { panel: 'Order book', text: /^Spread .* bps$/ }
const VIEWS = [
  ...['hyperliquid', 'binance', 'dydx', 'orderly'].map((venue) => ({
    name: `${venue}-1440`,
    path: `/${venue}/BTC?interval=1m`,
    viewport: { width: 1440, height: 900 },
    ready: MARKET_READY,
  })),
  {
    name: 'hyperliquid-1280',
    path: '/hyperliquid/BTC?interval=1m',
    viewport: { width: 1280, height: 800 },
    ready: MARKET_READY,
  },
  {
    name: 'hyperliquid-market-order',
    path: '/hyperliquid/BTC?interval=1m',
    viewport: { width: 1440, height: 900 },
    ready: MARKET_READY,
    act: (page) => panel(page, 'Order ticket').getByRole('radio', { name: 'Market', exact: true }).click(),
  },
  { name: 'history-1440', path: '/history', viewport: { width: 1440, height: 900 } },
]
const BOX_DERIVED = new Set(['width', 'height', 'inline-size', 'block-size', 'transform-origin', 'perspective-origin'])
const LANDMARKS = new Set(['banner', 'navigation', 'contentinfo', 'dialog', 'alertdialog'])
const UNNAMED_ROLES = new Set(['generic', 'none', 'presentation', 'StaticText', 'InlineTextBox', 'LineBreak'])
const PLAYBACK_TIMEOUT_MS = 30_000
const SETTLE_EVERY_MS = 500
const SETTLED_READS = 4
const SETTLE_TIMEOUT_MS = 30_000

const die = (msg, code = 1) => {
  console.error(`parity: ${msg}`)
  process.exit(code)
}

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true
      else {
        flags[a.slice(2)] = next
        i++
      }
    } else pos.push(a)
  }
  return { pos, flags }
}

const panel = (page, title) =>
  page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })

// ---------- capture ----------

function readTree(snapshot, ax) {
  const doc = snapshot.documents[0]
  const str = (i) => (i >= 0 ? snapshot.strings[i] : '')
  const { nodes, layout } = doc
  const count = nodes.parentIndex.length
  const children = Array.from({ length: count }, () => [])
  for (let i = 0; i < count; i++) if (nodes.parentIndex[i] >= 0) children[nodes.parentIndex[i]].push(i)
  const pseudo = new Map(nodes.pseudoType.index.map((node, k) => [node, str(nodes.pseudoType.value[k])]))
  const axByBackend = new Map(ax.nodes.filter((n) => n.backendDOMNodeId).map((n) => [n.backendDOMNodeId, n]))
  const tag = (i) => str(nodes.nodeName[i]).toLowerCase()
  const attr = (i, name) => {
    const list = nodes.attributes[i] ?? []
    for (let k = 0; k < list.length; k += 2) if (str(list[k]) === name) return str(list[k + 1])
    return null
  }
  const text = (i) => (nodes.nodeType[i] === 3 ? str(nodes.nodeValue[i]) : children[i].map(text).join(''))
  const findTag = (i, name) => {
    if (tag(i) === name) return i
    for (const c of children[i]) {
      const hit = findTag(c, name)
      if (hit !== null) return hit
    }
    return null
  }
  const role = (i) => {
    const node = axByBackend.get(nodes.backendNodeId[i])
    if (!node || node.ignored) return { role: '', name: '' }
    return { role: String(node.role?.value ?? ''), name: String(node.name?.value ?? '').trim() }
  }
  const panelName = (i) => {
    if (tag(i) === 'section') {
      const label = attr(i, 'aria-label')
      if (label) return label
      const h2 = findTag(i, 'h2')
      if (h2 !== null) return text(h2).trim()
    }
    const r = role(i)
    if (LANDMARKS.has(r.role)) return r.name ? `${r.role} "${r.name}"` : r.role
    return null
  }
  return { count, nodes, layout, str, children, pseudo, tag, role, panelName }
}

function keyElements(tree) {
  const { count, nodes, children, pseudo, tag, role, panelName } = tree
  const keys = new Array(count).fill(null)
  const seen = new Map()
  const walk = (i, panelKey, anchorKey, path) => {
    if (pseudo.has(i)) {
      keys[i] = `${keys[nodes.parentIndex[i]]}::${pseudo.get(i)}`
      return
    }
    if (nodes.nodeType[i] !== 1) return
    let key
    const named = panelName(i)
    const r = role(i)
    if (named !== null) {
      panelKey = dedupe(seen, '', named)
      anchorKey = panelKey
      path = ''
      key = panelKey
    } else if (r.name && r.role && !UNNAMED_ROLES.has(r.role)) {
      anchorKey = `${panelKey} › ${dedupe(seen, panelKey, `${r.role} "${r.name}"`)}`
      path = ''
      key = anchorKey
    } else key = path ? `${anchorKey} › ${path}` : anchorKey
    keys[i] = key
    const sameTag = new Map()
    for (const c of children[i]) {
      if (nodes.nodeType[c] !== 1 || pseudo.has(c)) continue
      const t = tag(c)
      const n = (sameTag.get(t) ?? 0) + 1
      sameTag.set(t, n)
      walk(c, panelKey, anchorKey, `${path ? `${path}/` : ''}${t}[${n}]`)
    }
    for (const c of children[i]) if (pseudo.has(c)) walk(c, panelKey, anchorKey, path)
  }
  for (const root of children[0]) walk(root, 'page', 'page', '')
  return keys
}

function dedupe(seen, scope, label) {
  const id = `${scope}\u0000${label}`
  const n = (seen.get(id) ?? 0) + 1
  seen.set(id, n)
  return n === 1 ? label : `${label} (${n})`
}

const playback = (page) =>
  page.evaluate(
    (control) =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel(control)
        channel.onmessage = (e) => {
          if (!e.data.playback) return
          channel.close()
          resolve(e.data.playback)
        }
        channel.postMessage({ playback: true })
      }),
    CONTROL,
  )

async function played(page, view) {
  const deadline = Date.now() + PLAYBACK_TIMEOUT_MS
  for (;;) {
    const { sockets, playing } = await playback(page)
    if (sockets > 0 && playing === 0) return
    if (Date.now() > deadline)
      die(`${view.name}: the replay still plays ${playing} of ${sockets} socket(s) after ${PLAYBACK_TIMEOUT_MS} ms`)
    await page.waitForTimeout(SETTLE_EVERY_MS)
  }
}

async function readView(cdp, properties) {
  const [snapshot, ax] = await Promise.all([
    cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: properties }),
    cdp.send('Accessibility.getFullAXTree'),
  ])
  const tree = readTree(snapshot, ax)
  const keys = keyElements(tree)
  const { layout, str } = tree
  const elements = {}
  const read = new Set()
  for (let l = 0; l < layout.nodeIndex.length; l++) {
    const i = layout.nodeIndex[l]
    const key = keys[i]
    if (key === null || read.has(i)) continue
    read.add(i)
    const style = {}
    layout.styles[l].forEach((v, p) => (style[properties[p]] = str(v)))
    const box = (layout.bounds[l] ?? []).map((v) => Math.round(v * 100) / 100)
    if (elements[key]) die(`two rendered elements share the key ${key}`)
    elements[key] = { style, box }
  }
  return elements
}

async function captureView(browser, base, view) {
  const context = await browser.newContext({
    viewport: view.viewport,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
  })
  try {
    const escaped = await replayRoutes(context)
    const page = await context.newPage()
    await page.clock.install({ time: RECORDED_AT })
    await page.goto(`${base}${view.path}`)
    if (view.ready) {
      await panel(page, view.ready.panel).getByText(view.ready.text).waitFor({ timeout: 30_000 })
      await played(page, view)
    }
    if (view.act) {
      await view.act(page)
      await page.mouse.move(-1, -1)
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const properties = (
      await page.evaluate(() => [...getComputedStyle(document.documentElement)].filter((p) => !p.startsWith('--')))
    ).filter((p) => !BOX_DERIVED.has(p))
    const cdp = await context.newCDPSession(page)
    const read = () => readView(cdp, properties)
    const deadline = Date.now() + SETTLE_TIMEOUT_MS
    let elements = await read()
    for (let same = 1; same < SETTLED_READS;) {
      await page.waitForTimeout(SETTLE_EVERY_MS)
      const again = await read()
      const changed = diffElements(elements, again)
      same = changed.size === 0 ? same + 1 : 1
      if (changed.size > 0 && Date.now() > deadline)
        die(`${view.name} still changes after ${SETTLE_TIMEOUT_MS} ms:\n${report(changed, 20)}`)
      elements = again
    }
    if (escaped.length) die(`${view.name}: requests left for the network:\n${escaped.join('\n')}`)
    return { url: page.url(), viewport: view.viewport, elements }
  } finally {
    await context.close()
  }
}

async function capture(flags) {
  if (!existsSync(STATE)) die('no verify-tape run. Run `verify-tape.mjs up --replay` first.')
  const s = JSON.parse(readFileSync(STATE, 'utf8'))
  if (!s.replay)
    die(`run ${s.runId} serves live data, so two captures never match. Run \`down\`, then \`up --replay\`.`)
  const only = flags.view ? String(flags.view).split(',') : null
  const views = VIEWS.filter((v) => !only || only.includes(v.name))
  if (views.length === 0) die(`no view named ${flags.view}. Views: ${VIEWS.map((v) => v.name).join(', ')}`)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`)
  const out = {
    sha: s.sha,
    dirtySrcFiles: s.dirtySrcFiles,
    network: s.network,
    browser: browser.version(),
    runId: s.runId,
    views: {},
  }
  try {
    for (const view of views) {
      const started = Date.now()
      out.views[view.name] = await captureView(browser, s.base, view)
      console.log(
        `capture: ${view.name} ${Object.keys(out.views[view.name].elements).length} elements in ${Date.now() - started} ms`,
      )
    }
  } finally {
    await browser.close().catch(() => {})
  }
  const file = flags.out ? resolve(String(flags.out)) : join(ARTIFACTS, s.runId, 'parity.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(pack(out)))
  console.log(`capture: wrote ${file}`)
}

function pack(capture) {
  const ids = new Map()
  const styles = []
  const views = {}
  for (const [name, view] of Object.entries(capture.views)) {
    const elements = {}
    for (const [key, { style, box }] of Object.entries(view.elements)) {
      const full = JSON.stringify(style)
      if (!ids.has(full)) {
        ids.set(full, styles.length)
        styles.push(
          styles.length === 0
            ? style
            : Object.fromEntries(Object.entries(style).filter(([prop, value]) => styles[0][prop] !== value)),
        )
      }
      elements[key] = { style: ids.get(full), box }
    }
    views[name] = { ...view, elements }
  }
  return { ...capture, views, styles }
}

function unpack(file) {
  const capture = JSON.parse(readFileSync(file, 'utf8'))
  const [root] = capture.styles
  const styles = capture.styles.map((delta) => ({ ...root, ...delta }))
  for (const view of Object.values(capture.views))
    for (const element of Object.values(view.elements)) element.style = styles[element.style]
  return capture
}

// ---------- diff ----------

function diffElements(a, b) {
  const changed = new Map()
  const note = (key, line) => changed.set(key, [...(changed.get(key) ?? []), line])
  for (const key of Object.keys(a)) {
    if (!(key in b)) {
      note(key, 'removed')
      continue
    }
    const props = new Map()
    for (const [prop, from] of Object.entries(a[key].style)) {
      const to = b[key].style[prop]
      if (to !== from) props.set(`${from} → ${to}`, [...(props.get(`${from} → ${to}`) ?? []), prop])
    }
    for (const [change, names] of props) note(key, `${names.join(', ')}: ${change}`)
    if (a[key].box.join() !== b[key].box.join()) note(key, `box: ${a[key].box.join(' ')} → ${b[key].box.join(' ')}`)
  }
  for (const key of Object.keys(b)) if (!(key in a)) note(key, 'added')
  return changed
}

const report = (changed, limit = Infinity) =>
  [...changed]
    .slice(0, limit)
    .flatMap(([key, lines]) => [`  ${key}`, ...lines.map((line) => `    ${line}`)])
    .join('\n')

function diff(pos) {
  if (pos.length !== 2) die('diff takes two capture files.')
  const [a, b] = pos.map(unpack)
  if (a.browser !== b.browser) console.log(`diff: captured on ${a.browser} and ${b.browser}. Expect noise.`)
  const views = new Set([...Object.keys(a.views), ...Object.keys(b.views)])
  let elements = 0
  let changedElements = 0
  let changedViews = 0
  for (const name of views) {
    if (!a.views[name] || !b.views[name]) {
      console.log(`${name}: only in ${a.views[name] ? pos[0] : pos[1]}`)
      changedViews++
      continue
    }
    const changed = diffElements(a.views[name].elements, b.views[name].elements)
    elements += Object.keys(a.views[name].elements).length
    if (changed.size === 0) continue
    changedViews++
    changedElements += changed.size
    console.log(`${name}: ${changed.size} element(s) changed\n${report(changed)}`)
  }
  if (changedViews) {
    console.log(
      `diff: ${changedElements} element(s) changed in ${changedViews} of ${views.size} views between ${a.sha} and ${b.sha}${b.dirtySrcFiles ? ' plus uncommitted files' : ''}`,
    )
    process.exit(1)
  }
  console.log(`diff: no change in ${elements} elements across ${views.size} views`)
}

const HELP = `parity <command> [flags]

  capture [--out <file>] [--view <name,...>]
                    read every rendered element of each view in the current replay run (verify-tape up --replay)
                    and write <file>, by default artifacts/<run-id>/parity.json
  diff <a> <b>      list every element added, removed or changed between two captures. Exit 1 on any change.

Views: ${VIEWS.map((v) => v.name).join(', ')}`

const { pos, flags } = parseArgs(process.argv.slice(2))
const cmd = pos.shift()
if (cmd === 'capture') await capture(flags)
else if (cmd === 'diff') diff(pos)
else {
  console.log(HELP)
  if (cmd && cmd !== 'help') process.exit(1)
}
