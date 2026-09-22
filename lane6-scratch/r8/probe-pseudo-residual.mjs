#!/usr/bin/env node
// Deterministic current-stack pseudo residual census. This is structural evidence only:
// precise-coverage call counts and browser-native operation counts, never wall-time claims.
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const built = await build({
  entryPoints: [path.join(ROOT, 'src/index.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  minify: false,
  logLevel: 'silent',
})
const moduleBytes = built.outputFiles[0].contents
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url === '/m.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(moduleBytes)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })

async function run(mode) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.__ready === true)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true, allowTriggeredUpdates: false })
    const native = await page.evaluate(async (mode) => {
      const stats = { gcs: 0, gpv: 0, matches: 0, rect: 0, createSpan: 0 }
      const oldGcs = window.getComputedStyle
      const oldGpv = CSSStyleDeclaration.prototype.getPropertyValue
      const oldMatches = Element.prototype.matches
      const oldRect = Element.prototype.getBoundingClientRect
      const oldCreate = Document.prototype.createElement
      window.getComputedStyle = function (...args) { stats.gcs++; return oldGcs.apply(this, args) }
      CSSStyleDeclaration.prototype.getPropertyValue = function (...args) { stats.gpv++; return oldGpv.apply(this, args) }
      Element.prototype.matches = function (...args) { stats.matches++; return oldMatches.apply(this, args) }
      Element.prototype.getBoundingClientRect = function (...args) { stats.rect++; return oldRect.apply(this, args) }
      Document.prototype.createElement = function (name, ...rest) {
        if (String(name).toLowerCase() === 'span') stats.createSpan++
        return oldCreate.call(this, name, ...rest)
      }
      const style = oldCreate.call(document, 'style')
      style.textContent = '.root{width:900px;font:13px Arial}.row{display:block;color:#334155}.row::before{content:"#";display:inline;width:12px;height:8px;color:#64748b}.row::after{content:"!";display:inline;width:8px;height:6px;color:#94a3b8}'
      if (mode === 'entropy') style.textContent += '.row[data-id]{outline-offset:0px}'
      if (mode === 'pairs' || mode === 'triples') {
        const card = mode === 'pairs' ? 200 : 120
        for (let i = 0; i < card; i++) {
          const r = (i * 47) & 255, g = (i * 83) & 255, b = (i * 131) & 255
          style.textContent += `.row.g${i}::before{color:rgb(${r},${g},${b})}`
        }
      }
      document.head.appendChild(style)
      const root = oldCreate.call(document, 'div'); root.className = 'root'
      const n = mode === 'triples' ? 360 : 400
      const card = mode === 'pairs' ? 200 : mode === 'triples' ? 120 : 1
      for (let i = 0; i < n; i++) {
        const e = oldCreate.call(document, 'div')
        e.className = (mode === 'pairs' || mode === 'triples') ? `row g${i % card}` : 'row'
        if (mode === 'entropy') e.setAttribute('data-id', String(i))
        e.textContent = `row ${i}`
        root.appendChild(e)
      }
      document.body.appendChild(root)
      try {
        await window.__m.snapdom.toRaw(root, { burst: false, cache: 'disabled', embedFonts: false })
        return stats
      } finally {
        window.getComputedStyle = oldGcs
        CSSStyleDeclaration.prototype.getPropertyValue = oldGpv
        Element.prototype.matches = oldMatches
        Element.prototype.getBoundingClientRect = oldRect
        Document.prototype.createElement = oldCreate
        root.remove(); style.remove()
      }
    }, mode)
    const { result } = await cdp.send('Profiler.takePreciseCoverage')
    await cdp.send('Profiler.stopPreciseCoverage')
    await cdp.send('Profiler.disable')
    const funcs = []
    for (const script of result.filter((x) => x.url.includes('/m.mjs'))) {
      for (const fn of script.functions) {
        // In precise detailed coverage, ranges[0] is the function's outer range. Nested ranges
        // are block/loop coverage and can execute many times per call; max(range.count) therefore
        // grossly overstates call counts for functions such as getStyleKey().
        const calls = fn.ranges[0]?.count || 0
        if (calls) funcs.push({ name: fn.functionName, calls })
      }
    }
    const wanted = /getStyleKey|pseudoSnapshotFor|shareLists|snapshotComputedStyle|pseudoGateMatches|resolvePseudoContent|inlinePseudoElements|getDefaultStyleForTag|styleSignature/
    return { mode, native, functions: funcs.filter((x) => wanted.test(x.name)).sort((a, b) => b.calls - a.calls) }
  } finally {
    await page.close()
  }
}

try {
  for (const mode of ['repeated', 'pairs', 'triples', 'entropy']) {
    console.log(JSON.stringify(await run(mode)))
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
