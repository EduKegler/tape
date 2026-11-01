import { readFileSync } from 'node:fs'

// WCAG 2.2 contrast: 1.4.3 asks 4.5:1 of text and 3:1 of large text, 1.4.11 asks 3:1 of the graphics a control
// needs to be seen and used. Large text is 24px, or 18.66px at weight 700, and Tape's weights stop at 600.
const NEED = { text: 4.5, large: 3, graphic: 3 }

const PAIRS = [
  ['Page text', 'level2', 'surface', 'text'],
  ['Page text, between panels', 'level3', 'ground', 'text'],
  ['Button primary', 'ink-contrast', 'ink', 'text'],
  ['Button primary, disabled', 'level2', 'raised', 'text'],
  ['Button buy', 'ink-contrast', 'bid', 'text'],
  ['Button sell', 'ink-contrast', 'ask', 'text'],
  ['Button buy, fill against the ticket', 'bid', 'ticket', 'graphic'],
  ['Button sell, fill against the ticket', 'ask', 'ticket', 'graphic'],
  ['Button secondary', 'level2', 'surface', 'text'],
  ['Button quiet', 'level3', 'surface', 'text'],
  ['Button quiet, in the ticket', 'level3', 'ticket', 'text'],
  ['Button quiet, in a dialog', 'level3', 'raised', 'text'],
  ['Button quiet, hover', 'level1', 'surface', 'text'],
  ['Button toggle, selected', 'level1', 'surface', 'text'],
  ['Button toggle, selected mark', 'accent', 'surface', 'graphic'],
  ['Button toggle, selected mark in the ticket', 'accent', 'ticket', 'graphic'],
  ['Button buy side, selected', 'bid', 'bid-wash over ticket', 'text'],
  ['Button sell side, selected', 'ask', 'ask-wash over ticket', 'text'],
  ['Book row, bid price over its depth', 'bid', 'bid-wash over surface', 'text'],
  ['Book row, ask price over its depth', 'ask', 'ask-wash over surface', 'text'],
  ['Book row, size over its depth', 'level1', 'ask-wash over surface', 'text'],
  ['Book row, total over bid depth', 'level3', 'bid-wash over surface', 'text'],
  ['Book row, total over ask depth', 'level3', 'ask-wash over surface', 'text'],
  ['Input value', 'level1', 'inset', 'text'],
  ['Input label', 'level3', 'ticket', 'text'],
  ['Input label, in a dialog', 'level3', 'raised', 'text'],
  ['Input edge, inside', 'edge', 'inset', 'graphic'],
  ['Input edge, in the ticket', 'edge', 'ticket', 'graphic'],
  ['Input edge, in a dialog', 'edge', 'raised', 'graphic'],
  ['Input focus edge', 'accent', 'inset', 'graphic'],
  ['Input error', 'level1', 'ticket', 'text'],
  ['Input error mark', 'warn', 'ticket', 'graphic'],
  ['Input error edge', 'warn', 'inset', 'graphic'],
  ['Select value', 'level1', 'inset', 'text'],
  ['Select edge, on a panel', 'edge', 'surface', 'graphic'],
  ['Select edge, in the ticket', 'edge', 'ticket', 'graphic'],
  ['Select edge, in a dialog', 'edge', 'raised', 'graphic'],
  ['Link, on a panel', 'level1', 'surface', 'text'],
  ['Link, in the ticket', 'level1', 'ticket', 'text'],
  ['Link, in a dialog', 'level1', 'raised', 'text'],
  ['Search value', 'level1', 'inset', 'text'],
  ['Search placeholder', 'level3', 'inset', 'text'],
  ['Search edge, in the header', 'edge', 'surface', 'graphic'],
  ['Search item', 'level1', 'raised', 'text'],
  ['Search group label', 'level3', 'raised', 'text'],
  ['Table header', 'level3', 'surface', 'text'],
  ['Table cell', 'level2', 'surface', 'text'],
  ['Table current row', 'level1', 'surface', 'text'],
  ['Table current row mark', 'accent', 'surface', 'graphic'],
  ['Order outcome', 'level1', 'raised', 'text'],
  ['Panel title', 'level1', 'surface', 'text'],
  ['Panel state, empty', 'level3', 'surface', 'text'],
  ['Panel state, empty in the ticket', 'level3', 'ticket', 'text'],
  ['Panel state, stale or error', 'warn', 'surface', 'text'],
  ['Panel state, stale or error in the ticket', 'warn', 'ticket', 'text'],
  ['Panel state, retry', 'level2', 'surface', 'text'],
  ['Panel state, retry in the ticket', 'level2', 'ticket', 'text'],
  ['Focus ring', 'accent', 'surface', 'graphic'],
  ['Focus ring, in the ticket', 'accent', 'ticket', 'graphic'],
  ['Focus ring, in a dialog', 'accent', 'raised', 'graphic'],
  ['Ticket body text', 'level2', 'ticket', 'text'],
  ['Dialog title', 'level1', 'raised', 'text'],
  ['Dialog body', 'level2', 'raised', 'text'],
  ['Dialog warning mark', 'warn', 'raised', 'graphic'],
]

// WebAIM's published ratio for #767676 on white, so a wrong formula fails before it measures anything.
const KNOWN = [['#767676', '#ffffff', 4.54]]

function tokens(css) {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1]
  if (!root) throw new Error('no :root block in src/styles.css')
  const declarations = root.split(';').map((d) => d.trim())
  return new Map(
    declarations
      .filter((d) => d.startsWith('--'))
      .map((d) => [d.slice(2, d.indexOf(':')), d.slice(d.indexOf(':') + 1).trim()]),
  )
}

function rgba(value) {
  const hex = /^#([\da-f]{6})$/i.exec(value)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1)
  if (value.startsWith('rgb(') && value.endsWith(')')) {
    const [channels, alpha = '1'] = value.slice(4, -1).split('/')
    return channels.trim().split(/\s+/).map(Number).concat(Number(alpha))
  }
  throw new Error(`cannot read the color ${value}`)
}

const over = (top, below) => [0, 1, 2].map((i) => top[i] * top[3] + below[i] * (1 - top[3])).concat(1)

function luminance([r, g, b]) {
  const channel = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

for (const [fg, bg, published] of KNOWN) {
  const measured = ratio(rgba(fg), rgba(bg))
  if (Math.abs(measured - published) > 0.005) throw new Error(`${fg} on ${bg} measures ${measured}, not ${published}`)
}

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const palette = tokens(css)
const color = (name) => {
  const value = palette.get(name)
  if (!value) throw new Error(`--${name} is not in :root`)
  return rgba(value)
}

let failed = 0
for (const [use, fg, background, kind] of PAIRS) {
  const [bottom, ...above] = background.split(' over ').toReversed()
  const bg = above.reduce((below, name) => over(color(name), below), color(bottom))
  const measured = ratio(over(color(fg), bg), bg)
  const ok = measured >= NEED[kind]
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${measured.toFixed(2).padStart(5)}  ${kind.padEnd(7)} ${NEED[kind]}  ${fg} on ${background}  ${use}`,
  )
}
if (failed > 0) {
  console.log(`${failed} of ${PAIRS.length} pairs under the WCAG minimum`)
  process.exitCode = 1
}
