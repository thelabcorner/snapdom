#!/usr/bin/env node
// R7 current-source asset-heavy getPropertyValue attribution. Deterministic call counts only.
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const entry = path.join(ROOT, 'src/index.js')
const built = await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser',
  write: false, minify: false, logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
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
const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  const rows = await page.evaluate(async ({ opts }) => {
    const proto = CSSStyleDeclaration.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'getPropertyValue')
    const original = proto.getPropertyValue
    const counts = new Map()
    Object.defineProperty(proto, 'getPropertyValue', {
      ...desc,
      value: function (prop) {
        const stack = new Error().stack || ''
        const lines = stack.split('\n').slice(2)
        let caller = 'other'
        for (const line of lines) {
          const m = line.match(/at\s+(?:async\s+)?([^\s(]+)/)
          if (!m) continue
          const name = m[1]
          if (name === 'CSSStyleDeclaration.value' || name === 'getPropertyValue') continue
          caller = name
          break
        }
        const key = `${caller}\u0000${String(prop)}`
        counts.set(key, (counts.get(key) || 0) + 1)
        return original.apply(this, arguments)
      },
    })
    const el = window.__fx.build('asset-heavy')
    try {
      const raw = await window.__m.snapdom.toRaw(el, { ...opts, cache: 'disabled', embedFonts: false })
      return { rawBytes: raw.length, rows: [...counts] }
    } finally {
      window.__fx.cleanup(el)
      Object.defineProperty(proto, 'getPropertyValue', desc)
    }
  }, { opts: FIXTURE_OPTIONS })

  const byCaller = new Map()
  for (const [key, count] of rows.rows) {
    const cut = key.indexOf('\u0000')
    const caller = key.slice(0, cut)
    const prop = key.slice(cut + 1)
    let rec = byCaller.get(caller)
    if (!rec) byCaller.set(caller, rec = { total: 0, props: new Map() })
    rec.total += count
    rec.props.set(prop, (rec.props.get(prop) || 0) + count)
  }
  console.log(`asset-heavy rawBytes=${rows.rawBytes}`)
  for (const [caller, rec] of [...byCaller].sort((a, b) => b[1].total - a[1].total).slice(0, 24)) {
    const props = [...rec.props].sort((a, b) => b[1] - a[1]).slice(0, 18)
      .map(([prop, count]) => `${prop}:${count}`).join(' ')
    console.log(`${String(rec.total).padStart(6)} ${caller}`)
    console.log(`       ${props}`)
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
