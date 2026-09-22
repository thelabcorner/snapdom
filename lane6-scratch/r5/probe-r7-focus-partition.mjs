#!/usr/bin/env node
// R7-FP1 deterministic mechanism probe.
//
// Compares focus-state selector partitioning against the SAME bundle with
// `__styleShareFocusPartition:false`. This is intentionally counter/oracle evidence only:
// prototype instrumentation perturbs the hot path, so the timings are not reported or used.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const rel = process.argv.find((x) => x.startsWith('--candidate='))?.slice(12) ||
  'worktrees/snapdom-v3-r7-focus-partition/dist/snapdom.mjs'
const mod = fs.readFileSync(path.join(ROOT, rel))
const sha = crypto.createHash('sha256').update(mod).digest('hex').toUpperCase()

const FIXTURES = [
  ['focus-20', 20, 1, 'focus'],
  ['focus-400', 400, 1, 'focus'],
  ['focus-1000', 1000, 1, 'focus'],
  ['focus-within-400', 400, 1, 'focus-within'],
  ['mixed-focus-400', 400, 20, 'focus'],
  ['structural-400', 400, 1, 'structural'],
  ['focus-plus-hover-veto-400', 400, 1, 'focus-hover-veto'],
  ['no-focus-400', 400, 1, 'none'],
]

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
const snap = await import('/candidate.mjs')

function build(nodes, cardinality, mode) {
  const st = document.createElement('style')
  const common = '.fp-root{width:900px;font:13px Arial,sans-serif}.fp-card{display:block;width:120px;height:14px;outline:none;background:rgb(0,0,255)}'
  if (mode === 'focus') st.textContent = common + '.fp-card:focus{background:rgb(255,0,0)}'
  else if (mode === 'focus-within') st.textContent = common + '.fp-group{display:block;width:130px;height:16px;background:rgb(0,0,255)}.fp-probe{outline:none}.fp-group:focus-within{background:rgb(255,0,0)}'
  else if (mode === 'structural') st.textContent = common + '.fp-card:nth-child(3n){background:rgb(0,128,0)}'
  else if (mode === 'focus-hover-veto') st.textContent = common + '.fp-card:focus:not(:hover),.fp-card:not(:hover){background:rgb(10,20,30)}'
  else st.textContent = common
  document.head.appendChild(st)

  const root = document.createElement('div')
  root.className = 'fp-root'
  if (mode === 'focus-within') {
    for (let i = 0; i < nodes; i++) {
      const group = document.createElement('div')
      group.className = 'fp-group g' + (i % cardinality)
      const probe = document.createElement('span')
      probe.className = 'fp-probe'
      probe.tabIndex = 0
      group.appendChild(probe)
      root.appendChild(group)
    }
  } else {
    for (let i = 0; i < nodes; i++) {
      const card = document.createElement('span')
      card.className = 'fp-card g' + (i % cardinality)
      card.tabIndex = 0
      root.appendChild(card)
    }
  }
  document.body.appendChild(root)

  if (mode === 'focus-within') root.querySelectorAll('.fp-probe')[Math.min(nodes - 1, nodes >> 1)]?.focus()
  else if (mode === 'focus' || mode === 'focus-hover-veto') root.children[Math.min(nodes - 1, nodes >> 1)]?.focus()

  return { root, cleanup() { try { document.activeElement?.blur?.() } catch {} root.remove(); st.remove() } }
}

async function one(nodes, cardinality, mode, focusPartition) {
  const x = build(nodes, cardinality, mode)
  const sp = CSSStyleDeclaration.prototype
  const ep = Element.prototype
  const og = sp.getPropertyValue
  const om = ep.matches
  let reads = 0, matches = 0
  sp.getPropertyValue = function(...args) { reads++; return og.apply(this, args) }
  ep.matches = function(...args) { matches++; return om.apply(this, args) }
  try {
    const raw = await snap.snapdom.toRaw(x.root, {
      burst: false,
      cache: 'disabled',
      embedFonts: false,
      __styleShareFocusPartition: focusPartition,
    })
    return { reads, matches, raw }
  } finally {
    sp.getPropertyValue = og
    ep.matches = om
    x.cleanup()
  }
}

window.__probe = { one }
window.__ready = true
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  if (u.pathname === '/candidate.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(mod)
    return
  }
  res.writeHead(404); res.end('nf')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
const rows = []
try {
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  for (const [name, nodes, cardinality, mode] of FIXTURES) {
    const historical = await page.evaluate((a) => window.__probe.one(a.nodes, a.cardinality, a.mode, false), { nodes, cardinality, mode })
    const partitioned = await page.evaluate((a) => window.__probe.one(a.nodes, a.cardinality, a.mode, true), { nodes, cardinality, mode })
    rows.push({
      name, nodes, cardinality, mode,
      historical: { reads: historical.reads, matches: historical.matches, bytes: historical.raw.length },
      partitioned: { reads: partitioned.reads, matches: partitioned.matches, bytes: partitioned.raw.length },
      rawParity: historical.raw === partitioned.raw,
    })
  }
} finally {
  await page.close()
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const out = { generatedAt: new Date().toISOString(), candidate: { path: rel, sha256: sha }, rows }
const outPath = path.join(ROOT, 'lane6-scratch/r5/results/r7-focus-partition-probe.json')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(out, null, 2))

console.log(`R7 focus partition mechanism probe ${sha.slice(0, 12)}`)
for (const x of rows) {
  const r = x.historical.reads ? (1 - x.partitioned.reads / x.historical.reads) * 100 : 0
  const m = x.historical.matches ? (1 - x.partitioned.matches / x.historical.matches) * 100 : 0
  console.log(`${x.name.padEnd(29)} gPV ${String(x.historical.reads).padStart(7)} -> ${String(x.partitioned.reads).padStart(7)} (${r.toFixed(1)}%)  matches ${String(x.historical.matches).padStart(6)} -> ${String(x.partitioned.matches).padStart(6)} (${m.toFixed(1)}%)  raw=${x.rawParity ? 'EQ' : 'DIFF'}`)
}
console.log('artifact lane6-scratch/r5/results/r7-focus-partition-probe.json')

