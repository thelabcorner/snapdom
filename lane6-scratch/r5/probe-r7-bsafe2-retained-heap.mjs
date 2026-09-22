#!/usr/bin/env node
// R7-BSAFE2 retained-memory probe. No timing claims.
// Fresh page per arm, source tree retained, forced GC before/after first memo establishment.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const REL = 'dist/snapdom.mjs'
const N = Number((process.argv.find((x) => x.startsWith('--n=')) || '--n=9').slice(4))
const CARDS = Number((process.argv.find((x) => x.startsWith('--cards=')) || '--cards=400').slice(8))
const bytes = fs.readFileSync(path.join(ROOT, REL))
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase()
const PAGE = '<!doctype html><html><body><script type="module">window.__mod=await import("/candidate.mjs");window.__ready=true</script></body></html>'

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/candidate.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(bytes)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({
  headless: true,
  args: ['--js-flags=--expose-gc', '--no-first-run', '--disable-extensions'],
})
const context = await browser.newContext({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })

async function one(retain, token) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  try {
    await page.goto(`${origin}/?${token}`)
    await page.waitForFunction(() => window.__ready === true)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    const before = await cdp.send('Runtime.getHeapUsage')
    const result = await page.evaluate(async ({ retain, cards }) => {
      const style = document.createElement('style')
      style.textContent = '.root{width:900px;font:13px Arial}.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:5px}.card{min-width:0;padding:5px}.value{font-weight:700}'
      document.head.appendChild(style)
      const root = document.createElement('div')
      root.className = 'root'
      const grid = document.createElement('div')
      grid.className = 'grid'
      root.appendChild(grid)
      for (let i = 0; i < cards; i++) {
        const card = document.createElement('div')
        card.className = 'card'
        const label = document.createElement('span')
        label.textContent = `metric ${i}: `
        const value = document.createElement('span')
        value.className = 'value'
        value.textContent = String(1000 + i)
        card.append(label, value)
        grid.appendChild(card)
      }
      document.body.appendChild(root)
      window.__retained = { root, style }
      const options = {
        embedFonts: false,
        cache: 'disabled',
        __burstRetainedSafetyFastPath: true,
        __burstRetainedShadowProbe: retain,
      }
      const first = await window.__mod.snapdom(root, options)
      const second = await window.__mod.snapdom(root, options)
      window.__retained.memo = second
      return {
        sameMemo: first === second || first.url === second.url,
        elements: root.querySelectorAll('*').length + 1,
        urlBytes: second.url.length,
      }
    }, { retain, cards: CARDS })
    await cdp.send('HeapProfiler.collectGarbage')
    const after = await cdp.send('Runtime.getHeapUsage')
    return {
      retain,
      ...result,
      usedBefore: before.usedSize,
      usedAfter: after.usedSize,
      retainedDelta: after.usedSize - before.usedSize,
    }
  } finally {
    await cdp.detach().catch(() => {})
    await page.close()
  }
}

const rows = []
try {
  for (let i = 0; i < N; i++) {
    const order = i & 1 ? [true, false] : [false, true]
    for (let j = 0; j < order.length; j++) rows.push(await one(order[j], `${CARDS}-${i}-${j}`))
  }
} finally {
  await context.close()
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const mid = sorted.length >> 1
  const median = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { n: xs.length, mean, median, min: sorted[0], max: sorted.at(-1) }
}
const historical = rows.filter((x) => !x.retain)
const retained = rows.filter((x) => x.retain)
const hs = stats(historical.map((x) => x.retainedDelta))
const rs = stats(retained.map((x) => x.retainedDelta))
const report = {
  generatedAt: new Date().toISOString(),
  candidate: { path: REL, sha256, bytes: bytes.length },
  cards: CARDS,
  elements: rows[0]?.elements,
  method: 'fresh page/arm; first memo + clean hit; source/result retained; forced GC; Runtime.getHeapUsage; no timing',
  historical: hs,
  retained: rs,
  medianDeltaBytes: rs.median - hs.median,
  memoIdentity: rows.every((x) => x.sameMemo),
  rows,
}
const out = path.join(ROOT, `lane6-scratch/r5/results/r7-bsafe2-retained-heap-${CARDS}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(report, null, 2))
console.log(`R7 BSAFE2 retained heap ${sha256.slice(0, 12)} cards=${CARDS} elements=${report.elements} n=${N}/arm memo=${report.memoIdentity}`)
console.log(`historical median ${(hs.median / 1024).toFixed(1)} KiB [${(hs.min / 1024).toFixed(1)}, ${(hs.max / 1024).toFixed(1)}]`)
console.log(`BSAFE2     median ${(rs.median / 1024).toFixed(1)} KiB [${(rs.min / 1024).toFixed(1)}, ${(rs.max / 1024).toFixed(1)}]`)
console.log(`median delta ${(report.medianDeltaBytes / 1024).toFixed(1)} KiB`)
console.log(`artifact ${path.relative(ROOT, out).replaceAll('\\', '/')}`)
