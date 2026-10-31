import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://localhost:4317'
const root = fileURLToPath(new URL('..', import.meta.url))
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const font = (pkg, file) =>
  readFileSync(`${root}node_modules/@fontsource-variable/${pkg}/files/${file}`).toString('base64')

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? chrome })
const app = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
await app.goto(`${base}/hyperliquid/BTC?interval=1m`)
await app.waitForFunction(
  () =>
    [...document.querySelectorAll('section')]
      .find((s) => s.querySelector('h2')?.textContent === 'Order book')
      ?.innerText.includes('Spread') && /Sockets \d/.test(document.querySelector('footer')?.innerText ?? ''),
)
await app.waitForTimeout(6000)
const shot = await app.screenshot({ path: `${root}docs/screenshot.png` })

const card = await browser.newPage({ viewport: { width: 1280, height: 640 } })
await card.setContent(`<!doctype html><style>
@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font('inter', 'inter-latin-wght-normal.woff2')}) }
* { margin: 0; box-sizing: border-box }
body { width: 1280px; height: 640px; overflow: hidden; position: relative; font-family: Inter; color: #2f314c;
  background: linear-gradient(133deg, rgb(255 180 176 / .16), rgb(255 221 201 / .12) 22%, #fff 48%, rgb(189 238 254 / .14) 74%, rgb(191 185 255 / .2)) }
.copy { position: absolute; left: 80px; top: 158px; width: 440px }
.repo { font-size: 22px; color: #444659 } .repo b { color: #2f314c }
h1 { font-weight: 500; font-size: 84px; line-height: 1; margin: 34px 0 30px }
p { font-size: 25px; line-height: 1.5; color: #444659 }
a { display: block; margin-top: 30px; font-size: 22px; color: #2a44c2; text-decoration: none }
img { position: absolute; left: 578px; top: 72px; width: 820px; border-radius: 14px; border: 1px solid rgb(47 49 76 / .14);
  box-shadow: 0 30px 70px rgb(47 49 76 / .18) }
</style>
<div class="copy"><div class="repo"><b>EduKegler</b> / tape</div><h1>Tape</h1>
<p>Live order books from Binance, Hyperliquid and dYdX in one model. TanStack Start on Redact.</p>
<a>tape.kegler.dev</a></div>
<img src="data:image/png;base64,${shot.toString('base64')}">`)
await card.screenshot({ path: `${root}docs/social-preview.png` })
await browser.close()
console.log('wrote docs/screenshot.png and docs/social-preview.png')
