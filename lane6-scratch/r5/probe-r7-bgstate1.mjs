#!/usr/bin/env node
// R7-BGSTATE1 same-build causal probe. Deterministic CSSOM call counts only; no wall claims.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(mod)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const engine = process.env.BROWSER || 'chromium'
const launcher = { chromium, firefox, webkit }[engine]
if (!launcher) throw new Error(`unknown BROWSER=${engine}`)
const browser = await launcher.launch({ headless: true })

const fixtures = ['light-20cards', 'cards400-safe', 'cards400-non-neutral', 'asset-heavy', 'entropy-400']
const bgProp = /^(?:background(?:-|$)|mask(?:-|$)|-webkit-mask(?:-|$)|border-image(?:-|$))/i

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  for (const fixture of fixtures) {
    const rows = []
    for (const gate of [false, true]) {
      rows.push(await page.evaluate(async ({ fixture, gate, opts, bgSource }) => {
        const bgRe = new RegExp(bgSource, 'i')
        let el, st = null
        if (fixture === 'entropy-400') {
          st = document.createElement('style')
          st.textContent = '.rr-root{width:900px;font:13px Arial}.rr-row{display:block;padding:2px 4px}.rr-row[data-r]{outline-offset:0}'
          document.head.appendChild(st)
          el = document.createElement('div')
          el.className = 'rr-root'
          for (let i = 0; i < 400; i++) {
            const row = document.createElement('div')
            row.className = 'rr-row'
            row.dataset.r = String(i)
            row.textContent = `row ${i}`
            el.appendChild(row)
          }
          document.body.appendChild(el)
        } else {
          el = window.__fx.build(fixture)
        }
        const proto = CSSStyleDeclaration.prototype
        const original = proto.getPropertyValue
        let gpv = 0, bgReads = 0
        proto.getPropertyValue = function (prop) {
          gpv++
          if (bgRe.test(String(prop))) bgReads++
          return original.apply(this, arguments)
        }
        try {
          const raw = await window.__m.snapdom.toRaw(el, {
            ...opts,
            cache: 'disabled',
            embedFonts: false,
            __backgroundStateProbeGate: gate,
          })
          return { raw, gpv, bgReads }
        } finally {
          proto.getPropertyValue = original
          if (st) { el.remove(); st.remove() } else window.__fx.cleanup(el)
        }
      }, { fixture, gate, opts: FIXTURE_OPTIONS, bgSource: bgProp.source }))
    }
    console.log(`${fixture.padEnd(24)} gPV ${rows[0].gpv}->${rows[1].gpv} ` +
      `saved=${rows[0].gpv - rows[1].gpv} bg ${rows[0].bgReads}->${rows[1].bgReads} ` +
      `raw=${rows[0].raw === rows[1].raw ? 'EQ' : 'DIFF'}`)
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
