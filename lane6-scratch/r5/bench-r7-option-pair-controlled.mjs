#!/usr/bin/env node
// R7 generic decision-quality experiment: same-bundle option-only pair crossover.
// Exactly one mechanism differs between arms; everything else is held constant.
// Args:
//   --candidate=path/to/bundle.mjs (relative to repo root / bench workspace root)
//   --base='{"__someFlag":false}'   historical arm overrides
//   --opt='{"__someFlag":true}'     candidate arm overrides
//   --out=filename.json             artifact name under lane6-scratch/r5/results
//   --label=human-readable          log prefix
//   --browser/--n/--batch/--warmup/--bootstrap/--epsilon/--only as usual.
// Fresh-page slot crossover + full-copy null; symmetric warmup; paired log ratios;
// seeded bootstrap; no outlier deletion. Raw samples retained.

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
// Accepts JSON ('{"__flag":false}') or shell-safe shorthand ('__flag=false,__other=true').
function parseExtra(raw) {
  if (!raw) return {}
  if (raw.startsWith('{')) return JSON.parse(raw)
  const out = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) throw new Error(`bad flag pair ${pair}`)
    const key = pair.slice(0, eq)
    const val = pair.slice(eq + 1)
    out[key] = val === 'true' ? true : val === 'false' ? false : val === 'null' ? null : Number.isNaN(Number(val)) || val === '' ? val : Number(val)
  }
  return out
}
const BASE_EXTRA = parseExtra(arg('base', ''))
const OPT_EXTRA = parseExtra(arg('opt', ''))
const OUT_NAME = arg('out', 'r7-option-pair-controlled.json')
const LABEL = arg('label', 'R7 option pair')
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
const BASE = { ...FIXTURE_OPTIONS, ...BASE_EXTRA }
const OPT = { ...FIXTURE_OPTIONS, ...OPT_EXTRA }

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

let layouts
try {
  layouts = {
    cf: await layout('candidate-forward', BASE, OPT),
    cr: await layout('candidate-reverse', OPT, BASE),
    zf: await layout('null-forward', BASE, BASE),
    zr: await layout('null-reverse', BASE, BASE),
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const fixtures = {}
for (let i = 0; i < FIXTURES.length; i++) {
  const name = FIXTURES[i]
  const cf = layouts.cf[name], cr = layouts.cr[name], zf = layouts.zf[name], zr = layouts.zr[name]
  const candidate = crossoverEffect(cf.rows, cr.rows,
    (row) => row.slot2 / row.slot1,
    (row) => row.slot1 / row.slot2,
    0x7600 + i)
  const control = crossoverEffect(zf.rows, zr.rows,
    (row) => row.slot2 / row.slot1,
    (row) => row.slot1 / row.slot2,
    0xc600 + i)
  const maxCov = Math.max(cf.s1.cov, cf.s2.cov, cr.s1.cov, cr.s2.cov)
  const controlPass = control.ci95[0] <= 0 && control.ci95[1] >= 0
  const stabilityPass = maxCov < .15
  const win = candidate.ci95[1] < -(EPS * 100)
  const regression = candidate.ci95[0] > EPS * 100
  fixtures[name] = {
    parity: cf.parity && cr.parity,
    candidate,
    control,
    maxCov,
    controlPass,
    stabilityPass,
    win,
    regression,
    claimable: cf.parity && cr.parity && controlPass && stabilityPass && win,
  }
}

const report = {
  provenance: {
    generatedAt: new Date().toISOString(), candidate: CAND_REL, sha256: sha,
    browser: ENGINE, n: N, batch: BATCH, warmup: WARM, bootstrap: BOOT, epsilon: EPS,
    base: BASE_EXTRA, opt: OPT_EXTRA, label: LABEL,
  },
  method: 'same bundle option-only; fresh-page slot crossover; symmetric warmup; paired log ratios; full-copy/full-copy null; seeded bootstrap; no outlier deletion',
  fixtures,
  layouts,
}
const outPath = path.join(OUT, OUT_NAME)
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`${LABEL} ${sha.slice(0, 12)} ${ENGINE} N=${N} batch=${BATCH}`)
for (const [name, result] of Object.entries(fixtures)) {
  console.log(`${name.padEnd(27)} parity=${result.parity ? 'PASS' : 'FAIL'} effect ${result.candidate.pct.toFixed(1)}% CI[${result.candidate.ci95.map((v) => v.toFixed(1)).join(', ')}] null ${result.control.pct.toFixed(1)}% CI[${result.control.ci95.map((v) => v.toFixed(1)).join(', ')}] CoV=${(result.maxCov * 100).toFixed(1)}% claim=${result.claimable ? 'PASS' : result.regression ? 'REGRESSION' : 'INCONCLUSIVE'}`)
}
console.log(`artifact lane6-scratch/r5/results/${OUT_NAME}`)
