#!/usr/bin/env node
// R7-SO1 retained-memory probe. No timing claims.
//
// Each arm runs in a fresh Chromium page with the exact candidate bundle. We force GC before
// building the source tree, capture while keeping that tree live (therefore keeping the
// snapshotCache WeakMap keys live), force GC again, and compare Runtime.getHeapUsage deltas.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const REL = 'worktrees/snapdom-v3-r7-overlay-gutterfix/dist/snapdom.mjs'
const N = Number((process.argv.find((x) => x.startsWith('--n=')) || '--n=10').slice(4))
const NODES = Number((process.argv.find((x) => x.startsWith('--nodes=')) || '--nodes=400').slice(8))
const MODE = (process.argv.find((x) => x.startsWith('--mode=')) || '--mode=twins').slice(7)
if (!['twins', 'entropy'].includes(MODE)) throw new Error(`unknown --mode=${MODE}`)
const bytes = fs.readFileSync(path.join(ROOT, REL))
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase()
const PAGE = '<!doctype html><html><body><script type="module">window.__mod=await import("/candidate.mjs");window.__ready=true</script></body></html>'

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/candidate.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(bytes); return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
// Avoid Chromium's blocked-port list (a random Windows port once landed on 1720/H.323).
await new Promise((resolve) => server.listen(43991, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc','--no-first-run','--disable-extensions'] })
const context = await browser.newContext({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })

async function one(overlay, token) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  try {
    await page.goto(`${origin}/?${token}`)
    await page.waitForFunction(() => window.__ready === true)
    await cdp.send('HeapProfiler.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    const before = await cdp.send('Runtime.getHeapUsage')
    const capture = await page.evaluate(async ({ overlay, nodes, mode }) => {
      const style = document.createElement('style')
      style.textContent = '.root{width:900px;font:13px Arial,sans-serif}.row{display:block;padding:2px 4px;color:#334155}' +
        (mode === 'entropy' ? '.row[data-identity]{outline-offset:0px}' : '')
      document.head.appendChild(style)
      const root = document.createElement('div'); root.className = 'root'
      for (let i=0;i<nodes;i++) {
        const el = document.createElement('div'); el.className = 'row g' + (i & 1); el.textContent = 'row ' + i
        if (mode === 'entropy') el.setAttribute('data-identity', String(i))
        root.appendChild(el)
      }
      document.body.appendChild(root)
      // Intentionally retain root/style on window: snapshotCache is a WeakMap keyed by these
      // live source elements, so this measures the cross-capture retained representation.
      window.__retained = { root, style }
      const raw = await window.__mod.snapdom.toRaw(root, {
        burst: false, cache: 'disabled', embedFonts: false,
        __styleShareSnapshotOverlay: overlay,
      })
      return { rawBytes: raw.length, elements: root.querySelectorAll('*').length + 1 }
    }, { overlay, nodes: NODES, mode: MODE })
    await cdp.send('HeapProfiler.collectGarbage')
    const after = await cdp.send('Runtime.getHeapUsage')
    return {
      overlay, rawBytes: capture.rawBytes, elements: capture.elements,
      usedBefore: before.usedSize, usedAfter: after.usedSize,
      retainedDelta: after.usedSize - before.usedSize,
    }
  } finally { await cdp.detach().catch(() => {}); await page.close() }
}

const rows = []
try {
  for (let i=0;i<N;i++) {
    const order = i & 1 ? [true, false] : [false, true]
    for (let j=0;j<order.length;j++) rows.push(await one(order[j], `${i}-${j}`))
  }
} finally {
  await context.close(); await browser.close(); await new Promise((resolve) => server.close(resolve))
}

const stats = (xs) => {
  const sorted = [...xs].sort((a,b) => a-b)
  const mean = xs.reduce((a,b) => a+b,0) / xs.length
  const mid = sorted.length >> 1
  const median = sorted.length & 1 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2
  return { n: xs.length, mean, median, min: sorted[0], max: sorted.at(-1) }
}
const hist = rows.filter((x) => !x.overlay)
const overlay = rows.filter((x) => x.overlay)
const report = {
  generatedAt: new Date().toISOString(), candidate: { path: REL, sha256, bytes: bytes.length }, nodes: NODES, mode: MODE,
  method: 'fresh page per arm; headless Chromium DPR1; source tree retained; forced GC before/after; Runtime.getHeapUsage; no timing',
  historical: stats(hist.map((x) => x.retainedDelta)),
  overlay: stats(overlay.map((x) => x.retainedDelta)),
  medianDeltaBytes: stats(overlay.map((x) => x.retainedDelta)).median - stats(hist.map((x) => x.retainedDelta)).median,
  rawParity: new Set(rows.map((x) => x.rawBytes)).size === 1,
  rows,
}
const out = path.join(ROOT, `lane6-scratch/r5/results/r7-overlay-retained-heap-${MODE}-${NODES}.json`)
fs.writeFileSync(out, JSON.stringify(report, null, 2))
console.log(`R7 SO1 retained heap ${sha256.slice(0,12)} mode=${MODE} nodes=${NODES} n=${N}/arm rawParity=${report.rawParity}`)
console.log(`historical retained median ${(report.historical.median/1024).toFixed(1)} KiB [${(report.historical.min/1024).toFixed(1)}, ${(report.historical.max/1024).toFixed(1)}]`)
console.log(`overlay    retained median ${(report.overlay.median/1024).toFixed(1)} KiB [${(report.overlay.min/1024).toFixed(1)}, ${(report.overlay.max/1024).toFixed(1)}]`)
console.log(`median delta ${(report.medianDeltaBytes/1024).toFixed(1)} KiB`)
console.log(`artifact ${path.relative(ROOT, out).replaceAll('\\','/')}`)
