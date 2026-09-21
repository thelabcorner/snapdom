#!/usr/bin/env node
// Same-CSSStyleDeclaration getPropertyValue duplication census. Deterministic counts only.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { PAGE_FIXTURE_SRC, FIXTURE_OPTIONS } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
  for (const fixture of ['cards400-safe', 'asset-heavy', 'entropy-400']) {
    const row = await page.evaluate(async ({ fixture, opts }) => {
      let el, style = null
      if (fixture === 'entropy-400') {
        style = document.createElement('style')
        style.textContent = '.dup-root{width:900px;font:13px Arial}.dup-row{display:block;padding:2px 4px}.dup-row[data-r]{outline-offset:0}'
        document.head.appendChild(style)
        el = document.createElement('div'); el.className = 'dup-root'
        for (let i = 0; i < 400; i++) { const n = document.createElement('div'); n.className = 'dup-row'; n.dataset.r = String(i); n.textContent = 'row ' + i; el.appendChild(n) }
        document.body.appendChild(el)
      } else el = window.__fx.build(fixture)

      const owner = CSSStyleDeclaration.prototype
      const desc = Object.getOwnPropertyDescriptor(owner, 'getPropertyValue')
      const original = owner.getPropertyValue
      const seen = new WeakMap()
      const dupByProp = new Map()
      let total = 0, duplicate = 0
      Object.defineProperty(owner, 'getPropertyValue', {
        ...desc,
        value(prop) {
          total++
          let props = seen.get(this)
          if (!props) seen.set(this, (props = new Set()))
          if (props.has(prop)) {
            duplicate++
            dupByProp.set(prop, (dupByProp.get(prop) || 0) + 1)
          } else props.add(prop)
          return original.apply(this, arguments)
        },
      })
      try {
        await window.__m.snapdom.toRaw(el, { ...opts, cache: 'disabled', embedFonts: false })
        return { total, duplicate, props: [...dupByProp].sort((a, b) => b[1] - a[1]).slice(0, 30) }
      } finally {
        Object.defineProperty(owner, 'getPropertyValue', desc)
        if (style) { el.remove(); style.remove() } else window.__fx.cleanup(el)
      }
    }, { fixture, opts: FIXTURE_OPTIONS })
    console.log(`\n${fixture} total=${row.total} duplicate=${row.duplicate} (${(100 * row.duplicate / row.total).toFixed(1)}%)`)
    for (const [prop, n] of row.props) console.log(String(n).padStart(6), prop)
  }
} finally {
  await browser.close()
  await new Promise(r => server.close(r))
}
