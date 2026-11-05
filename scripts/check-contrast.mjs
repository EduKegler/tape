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
  ['Button secondary', 'level1', 'raised', 'text'],
  ['Button quiet', 'level3', 'surface', 'text'],
  ['Button quiet, in the ticket', 'level3', 'ticket', 'text'],
  ['Button quiet, in a dialog', 'level3', 'raised', 'text'],
  ['Button quiet, hover', 'level1', 'surface', 'text'],
  ['Button toggle, selected', 'level1', 'surface', 'text'],
  ['Button toggle, selected mark', 'accent', 'surface', 'graphic'],
  ['Button toggle, selected mark in the ticket', 'accent', 'ticket', 'graphic'],
  ['Button buy side, selected', 'ink-contrast', 'bid', 'text'],
  ['Button sell side, selected', 'ink-contrast', 'ask', 'text'],
  ['Button side, not selected', 'level2', 'inset', 'text'],
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
  ['Input focus ring', 'accent', 'ticket', 'graphic'],
  ['Input error', 'level1', 'ticket', 'text'],
  ['Input error mark', 'err', 'ticket', 'graphic'],
  ['Input error edge', 'err', 'inset', 'graphic'],
  ['Select value', 'level1', 'inset', 'text'],
  ['Checkbox mark', 'ink-contrast', 'level1', 'graphic'],
  ['Select pill value', 'level1', 'raised', 'text'],
  ['Select mark, on a pill', 'level3', 'raised', 'graphic'],
  ['Select mark, in a field', 'level3', 'inset', 'graphic'],
  ['Select edge, on a panel', 'edge', 'surface', 'graphic'],
  ['Select edge, in the ticket', 'edge', 'ticket', 'graphic'],
  ['Select edge, in a dialog', 'edge', 'raised', 'graphic'],
  ['Link, on a panel', 'level1', 'surface', 'text'],
  ['Link, in the ticket', 'level1', 'ticket', 'text'],
  ['Link, in a dialog', 'level1', 'raised', 'text'],
  ['Search value', 'level1', 'inset', 'text'],
  ['Search placeholder', 'level3', 'inset', 'text'],
  ['Search edge, in the header', 'edge', 'surface', 'graphic'],
  ['Search shortcut hint', 'level3', 'inset', 'text'],
  ['Button outline', 'level2', 'surface', 'text'],
  ['Button outline, hover', 'level1', 'surface', 'text'],
  ['Button pill', 'level3', 'inset', 'text'],
  ['Button pill, selected', 'level1', 'raised', 'text'],
  ['Button chip, selected mark', 'accent', 'raised', 'graphic'],
  ['Button bid, fill against a popover', 'bid', 'raised', 'graphic'],
  ['Button ask, fill against a popover', 'ask', 'raised', 'graphic'],
  ['Unit field unit', 'level3', 'inset', 'text'],
  ['Ruler handle outcome, gain', 'bid', 'surface', 'text'],
  ['Ruler handle outcome, loss', 'ask', 'surface', 'text'],
  ['Ruler liquidation', 'err', 'raised', 'text'],
  ['Ruler order dot, buy', 'bid', 'raised', 'graphic'],
  ['Ruler order dot, sell', 'ask', 'raised', 'graphic'],
  ['Position panel PnL, gain', 'bid', 'raised', 'text'],
  ['Position panel PnL, loss', 'ask', 'raised', 'text'],
  ['Cancel all warning', 'warn', 'raised', 'text'],
  ['Connected dot, header and status bar', 'live', 'surface', 'graphic'],
  ['Hub offline dot, status bar', 'warn', 'surface', 'graphic'],
  ['Search item', 'level1', 'raised', 'text'],
  ['Search group label', 'level3', 'raised', 'text'],
  ['Table header', 'level3', 'surface', 'text'],
  ['Table cell', 'level2', 'surface', 'text'],
  ['Table current row', 'level1', 'raised', 'text'],
  ['Table current row, first cell', 'accent', 'raised', 'text'],
  ['Table current row, best bid', 'bid', 'raised', 'text'],
  ['Table current row, best ask', 'ask', 'raised', 'text'],
  ['Order outcome', 'level1', 'raised', 'text'],
  ['Trades newest row mark', 'level3', 'raised', 'graphic'],
  ['Panel title', 'level1', 'surface', 'text'],
  ['Panel state, empty', 'level3', 'surface', 'text'],
  ['Panel state, empty in the ticket', 'level3', 'ticket', 'text'],
  ['Panel state, stale', 'warn', 'surface', 'text'],
  ['Panel state, stale in the ticket', 'warn', 'ticket', 'text'],
  ['Panel state, error', 'err', 'surface', 'text'],
  ['Panel state, error in the ticket', 'err', 'ticket', 'text'],
  ['Error mark, in a dialog', 'err', 'raised', 'graphic'],
  ['Order result word, error', 'err', 'ticket', 'text'],
  ['Panel state, retry', 'level2', 'surface', 'text'],
  ['Panel state, retry in the ticket', 'level2', 'ticket', 'text'],
  ['Focus ring', 'accent', 'surface', 'graphic'],
  ['Focus ring, in the ticket', 'accent', 'ticket', 'graphic'],
  ['Focus ring, in a dialog', 'accent', 'raised', 'graphic'],
  ['Ticket body text', 'level2', 'ticket', 'text'],
  ['Dialog title', 'level1', 'raised', 'text'],
  ['Dialog body', 'level2', 'raised', 'text'],
  ['Dialog warning mark', 'warn', 'raised', 'graphic'],
  ['Connect panel label, caption and footer', 'level3', 'raised', 'text'],
  ['Connect panel wallet name', 'level1', 'option over raised', 'text'],
  ['Connect panel wallet name, hover', 'level1', 'option-hover over raised', 'text'],
  ['Connect panel Detected tag, hover', 'level2', 'option-hover over raised', 'text'],
  ['Connect panel link, no wallet', 'level1', 'option over raised', 'text'],
  ['Connect panel link, email wallet hint', 'level1', 'raised', 'text'],
  ['Disconnect panel address', 'level2', 'option over raised', 'text'],
  ['Button secondary on raised, hover', 'level1', 'option-hover over raised', 'text'],
  ['Connect panel feed, lit hole', 'accent', 'raised', 'graphic'],
  ['Testnet tag, read only tag', 'level1', 'level1/12 over surface', 'text'],
  ['Read only tag, hovered tab', 'level1', 'level1/12 over raised', 'text'],
  ['Read only ticket, title', 'level1', 'ticket', 'text'],
  ['Read only ticket, line', 'level2', 'ticket', 'text'],
  ['Read only ticket, link', 'level1', 'option over ticket', 'text'],
  ['Read only ticket, link hover', 'level1', 'option-hover over ticket', 'text'],
  ['Connect panel QR module', 'ink-contrast', 'accent', 'graphic'],
]

const VENUE_PAIRS = [
  ['Venue tab, selected name and values', 'level1', 'venue-tab', 'text'],
  ['Venue tab, selected labels', 'level2', 'venue-tab', 'text'],
  ['Venue tab, selected and reconnecting', 'warn', 'venue-tab', 'text'],
  ['Venue tab, selected best bid mark', 'bid', 'venue-tab', 'graphic'],
  ['Venue tab, selected best ask mark', 'ask', 'venue-tab', 'graphic'],
  ['Venue tab, selected logo', 'venue', 'venue-tab', 'graphic'],
  ['Venue tab, selected read only tag', 'level1', 'level1/12 over venue-tab', 'text'],
  ['Chart legend logo', 'venue', 'surface', 'graphic'],
]

// WebAIM's published ratio for #767676 on white, so a wrong formula fails before it measures anything.
const KNOWN = [['#767676', '#ffffff', 4.54]]

function tokens(declarationBlock) {
  const declarations = declarationBlock.split(';').map((d) => d.trim())
  return new Map(
    declarations
      .filter((d) => d.startsWith('--'))
      .map((d) => [d.slice(2, d.indexOf(':')), d.slice(d.indexOf(':') + 1).trim()]),
  )
}

function block(css, selector) {
  const found = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1]
  if (!found) throw new Error(`no ${selector} block in src/styles.css`)
  return tokens(found)
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
const rootPalette = block(css, ':root')
const venueShared = block(css, '\\[data-venue\\]')
const venueIds = [...css.matchAll(/\[data-venue='(\w+)'\]/g)].map((match) => match[1])
if (venueIds.length === 0) throw new Error('no venue blocks in src/styles.css')

function venuePalette(venueId) {
  const palette = new Map([...rootPalette, ...venueShared, ...block(css, `\\[data-venue='${venueId}'\\]`)])
  const ground = rgba(palette.get('ground'))
  for (const card of ['surface', 'ticket']) {
    const [red, green, blue] = over(rgba(palette.get(card)), ground)
    palette.set(card, `rgb(${red} ${green} ${blue})`)
  }
  return palette
}

let failed = 0
let measuredPairs = 0
function measure(pairs, palette, scope) {
  const color = (name) => {
    const [token, percent] = name.split('/')
    const value = palette.get(token)
    if (!value) throw new Error(`--${token} is not in the ${scope} palette`)
    const [red, green, blue, alpha] = rgba(value)
    return [red, green, blue, percent ? Number(percent) / 100 : alpha]
  }
  for (const [use, fg, background, kind] of pairs) {
    const [bottom, ...above] = background.split(' over ').toReversed()
    const bg = above.reduce((below, name) => over(color(name), below), color(bottom))
    const measured = ratio(over(color(fg), bg), bg)
    const ok = measured >= NEED[kind]
    measuredPairs++
    if (!ok) failed++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'}  ${measured.toFixed(2).padStart(5)}  ${kind.padEnd(7)} ${NEED[kind]}  ${scope}  ${fg} on ${background}  ${use}`,
    )
  }
}

measure(PAIRS, rootPalette, 'root')
for (const venueId of venueIds) measure([...PAIRS, ...VENUE_PAIRS], venuePalette(venueId), venueId)

if (failed > 0) {
  console.log(`${failed} of ${measuredPairs} pairs under the WCAG minimum`)
  process.exitCode = 1
}
