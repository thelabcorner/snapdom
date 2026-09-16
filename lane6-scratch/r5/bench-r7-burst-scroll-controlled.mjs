#!/usr/bin/env node
// R7 decision-quality experiment: BRST1/2/3 semantic-scroll factorial on the integrated stack.
// Same bundle on all arms; only the scroll counterfactuals differ:
//   B1=__burstSemanticScrollTracking, B2=__wrapScrolledSemanticGate, B3=__burstCaptureScrollBaseline.
// 000 = historical geometry census everywhere; 111 = production stack default.
// Fresh-page slot crossover per pair + full-copy null; symmetric warmup; paired log
// ratios; seeded bootstrap; no outlier deletion. Raw samples retained.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const arg = (name, fallback) => {
  const prefix = `--${name}=`
  const hit = process.argv.find((value) => value.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
const CAND_REL = arg('candidate', 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs')
const N = Number(arg('n', 20))
const BATCH = Number(arg('batch', 3))
const WARM = Number(arg('warmup', 3))
const BOOT = Number(arg('bootstrap', 12000))
const EPS = Number(arg('epsilon', 0.02))
const ENGINE = arg('browser', 'chromium').toLowerCase()
const ONLY = arg('only', '')
const cand = fs.readFileSync(path.join(ROOT, CAND_REL))
const sha = crypto.createHash('sha256').update(cand).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r5/results')
fs.mkdirSync(OUT, { recursive: true })

const DEFAULT_FIXTURES = [
  'cards400-safe',
  'cards400-neutral-unsafe',
  'cards400-non-neutral',
]
const FIXTURES = ONLY
  ? ONLY.split(',').map((x) => x.trim()).filter(Boolean)
  : DEFAULT_FIXTURES

const arm = (b1, b2, b3) => ({
  ...FIXTURE_OPTIONS,
  __burstSemanticScrollTracking: b1,
  __wrapScrolledSemanticGate: b2,
  __burstCaptureScrollBaseline: b3,
})
const A000 = arm(false, false, false)
const A100 = arm(true, false, false)
const A010 = arm(false, true, false)
const A110 = arm(true, true, false)
const A111 = arm(true, true, true)

// [pairId, slot1Opts, slot2Opts, seed]: effect = slot2 vs slot1.
const PAIRS = [
  ['b1-main', A000, A100, 0xb101],
  ['b2-main', A000, A010, 0xb102],
  ['b2-cond', A100, A110, 0xb103],
  ['b3-cond', A110, A111, 0xb104],
  ['combined', A000, A111, 0xb105],
]

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">
window.__bench={
  async init(u1,u2,o1,o2){this.mods={slot1:await import(u1),slot2:await import(u2)};this.opts={slot1:o1,slot2:o2}},
  async one(slot,f){
    const el=window.__fx.build(f)
    try{const t0=performance.now();const raw=await this.mods[slot].snapdom.toRaw(el,this.opts[slot]);return{ms:performance.now()-t0,raw}}
    finally{window.__fx.cleanup(el)}
  },
  async warm(f,n){for(let i=0;i<n;i++)for(const slot of(i&1?['slot2','slot1']:['slot1','slot2']))await this.one(slot,f)},
  async parity(f){const a=await this.one('slot1',f),b=await this.one('slot2',f);return a.raw===b.raw},
  async pair(f,n,batch){
    const out=[]
    for(let i=0;i<n;i++){
      const row={}
      for(const slot of(i&1?['slot2','slot1']:['slot1','slot2'])){
        let total=0
        for(let b=0;b<batch;b++) total+=(await this.one(slot,f)).ms
        row[slot]=total/batch
      }
      out.push(row)
    }
    return out
  },
}
window.__ready=true
</script></body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  if (url.pathname.startsWith('/candidate')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(cand)
    return
  }
  res.writeHead(404)
  res.end('nf')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
function stats(xs) {
  const m = mean(xs)
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1))
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return {
    mean: m,
    median: sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    cov: m ? sd / m : 0,
  }
}
function rng(seed) {
  let x = seed >>> 0
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
}
const percent = (logRatio) => (Math.exp(logRatio) - 1) * 100
function crossoverEffect(forward, reverse, forwardRatio, reverseRatio, seed) {
  const a = forward.map(forwardRatio).map(Math.log)
  const b = reverse.map(reverseRatio).map(Math.log)
  const point = (mean(a) + mean(b)) / 2
  const random = rng(seed)
  const draws = []
  for (let i = 0; i < BOOT; i++) {
    let sa = 0, sb = 0
    for (let j = 0; j < a.length; j++) sa += a[(random() * a.length) | 0]
    for (let j = 0; j < b.length; j++) sb += b[(random() * b.length) | 0]
    draws.push(sa / a.length / 2 + sb / b.length / 2)
  }
  draws.sort((x, y) => x - y)
  return {
    pct: percent(point),
    ci95: [percent(draws[(BOOT * .025) | 0]), percent(draws[(BOOT * .975) | 0])],
  }
}

const browserType = { chromium, firefox, webkit }[ENGINE]
if (!browserType) throw new Error(`unsupported --browser=${ENGINE}`)
const browser = await browserType.launch(ENGINE === 'chromium'
  ? { headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--disable-extensions'] }
  : { headless: true })
async function layout(name, o1, o2) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => console.error(`[${name}] PAGE ERROR`, error.message))
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
    await page.evaluate(({ name, o1, o2 }) => window.__bench.init(
      `/candidate.mjs?${name}-1`, `/candidate.mjs?${name}-2`, o1, o2,
    ), { name, o1, o2 })
    const result = {}
    for (const fixture of FIXTURES) {
      await page.evaluate(({ fixture, warm }) => window.__bench.warm(fixture, warm), { fixture, warm: WARM })
      const parity = await page.evaluate((fixture) => window.__bench.parity(fixture), fixture)
      const rows = await page.evaluate(({ fixture, n, batch }) => window.__bench.pair(fixture, n, batch), {
        fixture, n: N, batch: BATCH,
      })
      result[fixture] = {
        parity,
        rows,
        s1: stats(rows.map((row) => row.slot1)),
        s2: stats(rows.map((row) => row.slot2)),
      }
    }
    return result
  } finally {
    await page.close()
  }
}

const layouts = {}
try {
  for (const [pairId, o1, o2] of PAIRS) {
    layouts[`${pairId}-forward`] = await layout(`${pairId}-forward`, o1, o2)
    layouts[`${pairId}-reverse`] = await layout(`${pairId}-reverse`, o2, o1)
  }
  layouts['null-forward'] = await layout('null-forward', A000, A000)
  layouts['null-reverse'] = await layout('null-reverse', A000, A000)
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const fixtures = {}
for (let i = 0; i < FIXTURES.length; i++) {
  const name = FIXTURES[i]
  const nullEffect = crossoverEffect(
    layouts['null-forward'][name].rows, layouts['null-reverse'][name].rows,
    (row) => row.slot2 / row.slot1, (row) => row.slot1 / row.slot2, 0xc600 + i,
  )
  const controlPass = nullEffect.ci95[0] <= 0 && nullEffect.ci95[1] >= 0
  const pairs = {}
  for (const [pairId, , , seed] of PAIRS) {
    const fwd = layouts[`${pairId}-forward`][name]
    const rev = layouts[`${pairId}-reverse`][name]
    const candidate = crossoverEffect(fwd.rows, rev.rows,
      (row) => row.slot2 / row.slot1, (row) => row.slot1 / row.slot2, seed + i)
    const maxCov = Math.max(fwd.s1.cov, fwd.s2.cov, rev.s1.cov, rev.s2.cov)
    const stabilityPass = maxCov < .15
    const win = candidate.ci95[1] < -(EPS * 100)
    const regression = candidate.ci95[0] > EPS * 100
    pairs[pairId] = {
      parity: fwd.parity && rev.parity,
      candidate,
      maxCov,
      controlPass,
      stabilityPass,
      win,
      regression,
      claimable: fwd.parity && rev.parity && controlPass && stabilityPass && win,
    }
  }
  const allParity = Object.values(pairs).every((p) => p.parity)
  fixtures[name] = { parity: allParity, null: nullEffect, controlPass, pairs }
}

const report = {
  provenance: {
    generatedAt: new Date().toISOString(), candidate: CAND_REL, sha256: sha,
    browser: ENGINE, n: N, batch: BATCH, warmup: WARM, bootstrap: BOOT, epsilon: EPS,
  },
  method: 'same bundle BRST 2x3 option-only; fresh-page slot crossover per pair; symmetric warmup; paired log ratios; full-copy/full-copy null; seeded bootstrap; no outlier deletion',
  fixtures,
  layouts,
}
const outPath = path.join(OUT, 'r7-burst-scroll-controlled.json')
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`R7 burst-scroll factorial controlled ${sha.slice(0, 12)} ${ENGINE} N=${N} batch=${BATCH}`)
for (const [name, result] of Object.entries(fixtures)) {
  console.log(`${name} parity=${result.parity ? 'PASS' : 'FAIL'} null ${result.null.pct.toFixed(1)}% CI[${result.null.ci95.map((v) => v.toFixed(1)).join(', ')}]`)
  for (const [pairId, p] of Object.entries(result.pairs)) {
    console.log(`  ${pairId.padEnd(10)} effect ${p.candidate.pct.toFixed(1)}% CI[${p.candidate.ci95.map((v) => v.toFixed(1)).join(', ')}] CoV=${(p.maxCov * 100).toFixed(1)}% claim=${p.claimable ? 'PASS' : p.regression ? 'REGRESSION' : 'INCONCLUSIVE'}`)
  }
}
console.log('artifact lane6-scratch/r5/results/r7-burst-scroll-controlled.json')
