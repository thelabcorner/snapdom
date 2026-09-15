#!/usr/bin/env node
// R7 protected Stage-1 parity oracle.
//
// Deliberately records NO timing. Each lane is exercised with two query-isolated imports of
// the exact candidate bundle and with option order physically reversed in a fresh page. This
// keeps correctness evidence usable while the host is too busy for decision-quality timing.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const arg = (name, fallback) => {
  const prefix = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const LANE = arg('lane', 'so1').toLowerCase()
const CONFIG = LANE === 'so1'
  ? {
      rel: arg('candidate', 'worktrees/snapdom-v3-r7-overlay-gutterfix/dist/snapdom.mjs'),
      historical: { burst: false, cache: 'disabled', embedFonts: false, __styleShareSnapshotOverlay: false },
      candidate: { burst: false, cache: 'disabled', embedFonts: false, __styleShareSnapshotOverlay: true },
      fixtures: [
        ['small-20', 20, 2, 'none'],
        ['twins-400', 400, 2, 'none'],
        ['mixed-400', 400, 20, 'none'],
        ['entropy-400', 400, 400, 'none'],
        ['entropy-1000', 1000, 1000, 'none'],
        ['structural-veto-400', 400, 2, 'veto'],
        ['flex-twins-400', 400, 2, 'flex'],
      ],
    }
  : LANE === 'fp1'
    ? {
        rel: arg('candidate', 'worktrees/snapdom-v3-r7-focus-partition/dist/snapdom.mjs'),
        historical: { burst: false, cache: 'disabled', embedFonts: false, __styleShareFocusPartition: false },
        candidate: { burst: false, cache: 'disabled', embedFonts: false, __styleShareFocusPartition: true },
        fixtures: [
          ['focus-20', 20, 1, 'focus'],
          ['focus-400', 400, 1, 'focus'],
          ['focus-1000', 1000, 1, 'focus'],
          ['focus-within-400', 400, 1, 'focus-within'],
          ['mixed-focus-400', 400, 20, 'focus'],
          ['focus-plus-hover-veto-400', 400, 1, 'focus-hover-veto'],
          ['no-focus-400', 400, 1, 'none'],
        ],
      }
    : null

if (!CONFIG) throw new Error(`unknown --lane=${LANE}; expected so1 or fp1`)

const moduleBytes = fs.readFileSync(path.join(ROOT, CONFIG.rel))
const sha256 = crypto.createHash('sha256').update(moduleBytes).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r5/results')
fs.mkdirSync(OUT, { recursive: true })

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
function buildSO1(nodes, cardinality, mode) {
  const st = document.createElement('style')
  let extra = ''
  if (mode === 'veto') extra = '.am-row:nth-child(3n){outline-offset:0px}'
  else if (mode === 'flex') extra = '.am-root{display:flex;flex-wrap:wrap}.am-row{flex:0 1 90px;min-width:auto}'
  st.textContent = '.am-root{width:900px;font:13px Arial,sans-serif}.am-row{display:block;padding:2px 4px;color:#334155}' + extra
  document.head.appendChild(st)
  const root = document.createElement('div'); root.className = 'am-root'
  for (let i=0;i<nodes;i++) {
    const el = document.createElement('div')
    el.className = 'am-row g' + (i % cardinality)
    el.textContent = 'row ' + i
    root.appendChild(el)
  }
  document.body.appendChild(root)
  return { root, cleanup(){ root.remove(); st.remove() } }
}

function buildFP1(nodes, cardinality, mode) {
  const st = document.createElement('style')
  const common = '.fp-root{width:900px;font:13px Arial,sans-serif}.fp-card{display:block;width:120px;height:14px;outline:none;background:rgb(0,0,255)}'
  if (mode === 'focus') st.textContent = common + '.fp-card:focus{background:rgb(255,0,0)}'
  else if (mode === 'focus-within') st.textContent = common + '.fp-group{display:block;width:130px;height:16px;background:rgb(0,0,255)}.fp-probe{outline:none}.fp-group:focus-within{background:rgb(255,0,0)}'
  else if (mode === 'focus-hover-veto') st.textContent = common + '.fp-card:focus:not(:hover),.fp-card:not(:hover){background:rgb(10,20,30)}'
  else st.textContent = common
  document.head.appendChild(st)
  const root = document.createElement('div'); root.className = 'fp-root'
  if (mode === 'focus-within') {
    for (let i=0;i<nodes;i++) {
      const group = document.createElement('div'); group.className = 'fp-group g' + (i % cardinality)
      const probe = document.createElement('span'); probe.className = 'fp-probe'; probe.tabIndex = 0
      group.appendChild(probe); root.appendChild(group)
    }
  } else {
    for (let i=0;i<nodes;i++) {
      const el = document.createElement('span'); el.className = 'fp-card g' + (i % cardinality); el.tabIndex = 0
      root.appendChild(el)
    }
  }
  document.body.appendChild(root)
  if (mode === 'focus-within') root.querySelectorAll('.fp-probe')[nodes >> 1]?.focus()
  else if (mode === 'focus' || mode === 'focus-hover-veto') root.children[nodes >> 1]?.focus()
  return { root, cleanup(){ try { document.activeElement?.blur?.() } catch {} root.remove(); st.remove() } }
}

window.__parity = {
  async init(url1, url2, options1, options2) {
    this.mods = { slot1: await import(url1), slot2: await import(url2) }
    this.options = { slot1: options1, slot2: options2 }
  },
  async one(lane, slot, nodes, cardinality, mode) {
    const fixture = lane === 'so1' ? buildSO1(nodes, cardinality, mode) : buildFP1(nodes, cardinality, mode)
    try { return await this.mods[slot].snapdom.toRaw(fixture.root, this.options[slot]) }
    finally { fixture.cleanup() }
  },
  async compare(lane, nodes, cardinality, mode) {
    const first = await this.one(lane, 'slot1', nodes, cardinality, mode)
    const second = await this.one(lane, 'slot2', nodes, cardinality, mode)
    return { equal: first === second, firstBytes: first.length, secondBytes: second.length }
  },
}
window.__ready = true
</script></body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/candidate.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(moduleBytes)
    return
  }
  res.writeHead(404); res.end('nf')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--disable-extensions'] })
async function layout(name, firstOptions, secondOptions) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.__ready === true)
    await page.evaluate(({ u1, u2, firstOptions, secondOptions }) => window.__parity.init(u1, u2, firstOptions, secondOptions), {
      u1: `/candidate.mjs?${name}-1`, u2: `/candidate.mjs?${name}-2`, firstOptions, secondOptions,
    })
    const out = {}
    for (const [fixture, nodes, cardinality, mode] of CONFIG.fixtures) {
      out[fixture] = await page.evaluate(({ lane, nodes, cardinality, mode }) => window.__parity.compare(lane, nodes, cardinality, mode), {
        lane: LANE, nodes, cardinality, mode,
      })
    }
    return out
  } finally { await page.close() }
}

let layouts
try {
  layouts = {
    forward: await layout('forward', CONFIG.historical, CONFIG.candidate),
    reverse: await layout('reverse', CONFIG.candidate, CONFIG.historical),
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const fixtures = {}
for (const [name] of CONFIG.fixtures) {
  fixtures[name] = {
    parity: layouts.forward[name].equal && layouts.reverse[name].equal,
    forward: layouts.forward[name], reverse: layouts.reverse[name],
  }
}
const report = {
  generatedAt: new Date().toISOString(), lane: LANE,
  candidate: { path: CONFIG.rel, sha256, bytes: moduleBytes.length },
  method: 'parity only; exact candidate bundle; two query-isolated module instances; fresh headless page per ordering; deviceScaleFactor=1; cache disabled; forward/reverse option ordering; no timing',
  fixtures,
  overall: { parityPass: Object.values(fixtures).every((x) => x.parity) },
}
const outPath = path.join(OUT, `r7-${LANE}-protected-parity.json`)
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`R7 ${LANE} protected parity ${sha256.slice(0,12)}`)
for (const [name, value] of Object.entries(fixtures)) console.log(`${name.padEnd(30)} parity=${value.parity ? 'PASS' : 'FAIL'}`)
console.log(`OVERALL ${report.overall.parityPass ? 'PASS' : 'FAIL'}`)
console.log(`artifact ${path.relative(ROOT, outPath).replaceAll('\\','/')}`)
if (!report.overall.parityPass) process.exitCode = 1
