#!/usr/bin/env node
/**
 * EXPERIMENTAL PROTOTYPE — DO NOT MERGE.
 *
 * This file exists to be measured, not adopted. Its schedule algebra is proved browser-free in
 * lane6-scratch/r9-calibration/algebra/selfnull-algebra.test.mjs, but it has never been executed
 * against a browser, and the first hosted A/A is its only admissible justification. Merge it only
 * if a hosted A/A shows it lowers the runner-level dispersion of the self-null. On the algebra
 * alone it is a wash: at equal page count and equal timed-call count it extracts the same number
 * of observation blocks as bench-r9-controlled.mjs, so its noise is the same. What it does remove
 * is a latent systematic that is already an order of magnitude under the measured noise floor, so
 * there is no evidence-backed case for it yet.
 *
 * What changes relative to bench-r9-controlled.mjs:
 *
 *   1. AB/BA moves INSIDE the acquisition block. bench-r9-controlled.mjs puts AB on one physical
 *      page and BA on another and relies on `crossoverEffect` to cancel between them. Here each
 *      block runs `batch/2` adjacent replicate-pairs on one page, each pair executing the two arms
 *      in opposite orders, so the position cost cancels to second order inside the block and the
 *      page identity never enters the estimate at all.
 *   2. The seeded coin that picks which order leads is independent of the block index. In
 *      bench-r9-controlled.mjs the batch-order parity is `(index + b) & 1` while the Latin
 *      rotation parity is `index % 6`, and since 6 is even those two parities are locked together
 *      on 16 of every 24 blocks. That is the one real defect in the shipped schedule.
 *   3. `batch` must be even. With an odd batch a block cannot be balanced, only alternated.
 *   4. --identity-canary loads BOTH slots from the SAME module URL. That makes the two arms one
 *      module record with identical physical identity, so a self-null is exactly zero by
 *      construction rather than by argument. It is the cleanest floor the rig can produce and it
 *      costs one flag.
 *   5. --reverse-layout-order negates the page-keyed term end to end. It is the cheapest possible
 *      probe of whether a systematic exists at all: if the aggregate flips sign, one does.
 *   6. Per-call rows are retained, not just batch means. Without them no decomposition of
 *      position cost, GC, or JIT tiering is possible from an artifact, which is the single biggest
 *      reason the first calibration could not diagnose itself.
 *
 * Deliberately NOT done: no post-hoc correction of measured values, no outlier deletion, no
 * trimming, no winsorising. The design change is in the schedule.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'
import {
  arg,
  numberArg,
  parseExtra,
  sha256File,
  assertHostedBrowser,
  stats,
  ciWithin,
  hostedProvenance,
  stableJson,
  sha256Text,
} from './protocol.mjs'

assertHostedBrowser()

const ROOT = process.cwd()
const MODE = arg('mode', 'option-pair')
const SUITE = arg('suite', 'standing')
const BASE_REL = arg('baseline', 'lane6-scratch/r9-calibration/bundle/candidate.mjs')
const CAND_REL = arg('candidate', 'lane6-scratch/r9-calibration/bundle/candidate.mjs')
const BASE_EXTRA = parseExtra(arg('base', ''))
const OPT_EXTRA = parseExtra(arg('opt', ''))
const ENGINE = String(arg('browser', 'chromium')).toLowerCase()
const N = Math.max(4, Math.floor(numberArg('n', 24)))
const BATCH = Math.max(2, Math.floor(numberArg('batch', 10)))
const PAGES = Math.max(1, Math.floor(numberArg('pages', 2)))
const WARM = Math.max(0, Math.floor(numberArg('warmup', 6)))
const BOOT = Math.max(1000, Math.floor(numberArg('bootstrap', 12000)))
const EPS = numberArg('epsilon', 0.02)
const CONTROL_BAND = numberArg('control-band', 0.20)
const NOOP_BAND = numberArg('noop-band', CONTROL_BAND)
const SEED = Math.floor(numberArg('seed', 0x9a31))
const REVERSE = /^(1|true|yes)$/i.test(arg('reverse-layout-order', 'false'))
const IDENTITY_CANARY = /^(1|true|yes)$/i.test(arg('identity-canary', 'false'))
const OUT_NAME = arg('out', 'r9-blocked.json')
const EXPECTED_PLAYWRIGHT = arg('playwright-version', '1.55.1')
const ONLY = new Set(String(arg('only', '')).split(',').map((x) => x.trim()).filter(Boolean))
const LABEL = arg('label', 'R9 blocked-layout prototype')

if (BATCH % 2) throw new Error('--batch must be even: an odd block can be alternated but not balanced')
if (MODE !== 'option-pair' && MODE !== 'bundle-diff') throw new Error(`unsupported --mode=${MODE}`)
if (SUITE !== 'standing') throw new Error('this prototype implements the standing suite only')

const basePath = path.resolve(ROOT, BASE_REL)
const candPath = path.resolve(ROOT, CAND_REL)
for (const p of [basePath, candPath]) if (!fs.existsSync(p)) throw new Error(`bundle missing: ${p}`)

const BASE = { ...FIXTURE_OPTIONS, ...BASE_EXTRA }
const OPT = { ...FIXTURE_OPTIONS, ...OPT_EXTRA }
const baseBytes = fs.readFileSync(basePath)
const candBytes = MODE === 'option-pair' ? baseBytes : fs.readFileSync(candPath)

const STANDING = [
  { name: 'light-20cards', noop: false },
  { name: 'cards400-safe', noop: false },
  { name: 'cards400-neutral-unsafe', noop: false },
  { name: 'cards400-non-neutral', noop: false },
]
const FIXTURES = STANDING.filter((fx) => !ONLY.size || ONLY.has(fx.name))
if (!FIXTURES.length) throw new Error('fixture selection is empty')
const fixtureSpecs = Object.fromEntries(FIXTURES.map((fx) => [fx.name, fx]))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script>
<script type="module">
const specs = ${JSON.stringify(fixtureSpecs)}
function lcg(seed) {
  let x = seed >>> 0
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 }
}
window.__bench = {
  async init(u1, u2, o1, o2) {
    this.mods = { slot1: await import(u1), slot2: await import(u2) }
    this.opts = { slot1: o1, slot2: o2 }
  },
  async one(slot, fixture) {
    const el = window.__fx.build(specs[fixture])
    try {
      const t0 = performance.now()
      const raw = await this.mods[slot].snapdom.toRaw(el, this.opts[slot])
      return { ms: performance.now() - t0, raw }
    } finally {
      window.__fx.cleanup(el)
    }
  },
  async warm(fixture, n) {
    for (let i = 0; i < n; i++) {
      for (const slot of (i & 1 ? ['slot2', 'slot1'] : ['slot1', 'slot2'])) await this.one(slot, fixture)
    }
  },
  async oracle(fixture) {
    const a = await this.one('slot1', fixture)
    const b = await this.one('slot2', fixture)
    return { parity: a.raw === b.raw, aBytes: a.raw.length, bBytes: b.raw.length }
  },
  // One acquisition block. Each replicate-pair executes the arms in opposite orders, so the
  // position cost of the pair cancels inside the pair rather than across pages. The lead order of
  // each pair is drawn from a seed that depends on the block index but is deliberately NOT
  // correlated with the block index parity, which is the defect in the shipped schedule.
  async block(fixture, index, batch, seed) {
    const random = lcg((seed + index * 104729) >>> 0)
    const calls = []
    let slot1 = 0
    let slot2 = 0
    for (let k = 0; k < batch / 2; k++) {
      const lead = random() < 0.5 ? 'slot1' : 'slot2'
      for (const seq of [[lead, lead === 'slot1' ? 'slot2' : 'slot1'],
                         [lead === 'slot1' ? 'slot2' : 'slot1', lead]]) {
        for (const slot of seq) {
          const ms = (await this.one(slot, fixture)).ms
          calls.push({ slot, lead: seq[0] === slot, ms })
          if (slot === 'slot1') slot1 += ms
          else slot2 += ms
        }
      }
    }
    const ord = Math.round((calls.length / batch) * 100) / 100
    return {
      slot1: slot1 / batch,
      slot2: slot2 / batch,
      logRatio: Math.log((slot2 / batch) / (slot1 / batch)),
      // Retained so an artifact can be decomposed after the fact rather than only re-aggregated.
      calls,
      order: { leadsSlot1First: calls.filter((c) => c.lead && c.slot === 'slot1').length, ord },
    }
  },
}
window.__ready = true
</script></body></html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  const arm = url.pathname.replace(/^\//, '').split('?')[0]
  if (arm === 'base.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(baseBytes)
    return
  }
  if (arm === 'cand.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(candBytes)
    return
  }
  res.writeHead(404)
  res.end('nf')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browserType = { chromium, firefox, webkit }[ENGINE]
if (!browserType) throw new Error(`unsupported --browser=${ENGINE}`)
const browser = await browserType.launch(ENGINE === 'chromium'
  ? { headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--disable-extensions'] }
  : { headless: true })
const actualBrowserName = browser.browserType().name()
const actualBrowserVersion = browser.version()
if (actualBrowserName !== ENGINE) throw new Error(`engine identity mismatch: ${actualBrowserName}`)

const LAYOUTS = ['effect', 'baseNull', 'optNull']
const armKinds = { effect: ['base.mjs', 'cand.mjs'], baseNull: ['base.mjs', 'base.mjs'], optNull: ['cand.mjs', 'cand.mjs'] }
const armOptions = { effect: [BASE, OPT], baseNull: [BASE, BASE], optNull: [OPT, OPT] }
const pagesOf = (layout) => Array.from({ length: PAGES }, (_, i) => ({ layout, page: i }))
let pageOrder = LAYOUTS.flatMap(pagesOf)
if (REVERSE) pageOrder = pageOrder.slice().reverse()

// Fixed-width, layout-independent URL tags. Two arms differ in their module bytes, never in the
// shape, length or spelling of the identity they are fetched under, so nothing about the request
// itself can be correlated with the arm.
const tag = (layout, page, slot) =>
  `${String(layout).padEnd(9, '-')}${String(page).padStart(2, '0')}${slot}`

async function openPage(spec) {
  const { layout, page } = spec
  const [k1, k2] = armKinds[layout]
  const p = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  p.on('pageerror', (error) => console.error(`[${layout}#${page}] PAGE ERROR`, error.message))
  try {
    await p.goto(origin)
    await p.waitForFunction(() => window.__ready === true && window.__fxReady === true)
    await p.evaluate(({ u1, u2, o1, o2 }) => window.__bench.init(u1, u2, o1, o2), {
      u1: IDENTITY_CANARY ? `/${k2}?${tag(layout, page, 1)}` : `/${k1}?${tag(layout, page, 1)}`,
      u2: `/${k2}?${tag(layout, page, 2)}`,
      o1: armOptions[layout][0],
      o2: armOptions[layout][1],
    })
    return p
  } catch (error) {
    await p.close()
    throw error
  }
}

async function runFixture(fx) {
  const out = Object.fromEntries(LAYOUTS.map((l) => [l, []]))
  const pages = []
  try {
    for (const spec of pageOrder) pages.push({ spec, handle: await openPage(spec) })
    for (const { spec, handle } of pages) {
      if (WARM) await handle.evaluate(({ f, w }) => window.__bench.warm(f, w), { f: fx.name, w: WARM })
    }
    for (let i = 0; i < N; i++) {
      // Same Latin rotation over layouts, so minute-scale drift stays common-mode.
      const shift = i % LAYOUTS.length
      for (const layout of LAYOUTS.slice(shift).concat(LAYOUTS.slice(0, shift))) {
        for (const entry of pages.filter((p) => p.spec.layout === layout)) {
          const row = await entry.handle.evaluate(
            ({ f, i, b, s }) => window.__bench.block(f, i, b, s),
            { f: fx.name, i, b: BATCH, s: SEED },
          )
          out[layout].push(row)
        }
      }
    }
    return out
  } finally {
    await Promise.all(pages.map((p) => p.handle.close().catch(() => {})))
  }
}

const layouts = Object.fromEntries(LAYOUTS.map((l) => [l, {}]))
try {
  for (const fx of FIXTURES) {
    const res = await runFixture(fx)
    for (const l of LAYOUTS) layouts[l][fx.name] = res[l]
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

function blockedEffect(blocks, seed, bootstrap) {
  const logPoint = blocks.reduce((a, b) => a + b, 0) / blocks.length
  const random = (() => { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 } })()
  const draws = new Array(bootstrap)
  for (let i = 0; i < bootstrap; i++) {
    let total = 0
    for (let j = 0; j < blocks.length; j++) total += blocks[(random() * blocks.length) | 0]
    draws[i] = total / blocks.length
  }
  draws.sort((a, b) => a - b)
  const pct = (x) => (Math.exp(x) - 1) * 100
  return { logPoint, pct: pct(logPoint), ci95: [pct(draws[Math.floor(draws.length * 0.025)]), pct(draws[Math.floor(draws.length * 0.975)])] }
}

const fixtures = {}
FIXTURES.forEach((meta, i) => {
  // Rows land in acquisition order, so block b occupies rows [b * PAGES, (b + 1) * PAGES).
  // Averaging a block's pages keeps the temporal pairing that turns minute-scale runner drift
  // into common-mode noise.
  const pairs = (layout) => {
    const rows = layouts[layout][meta.name]
    const out = []
    for (let b = 0; b < N; b++) {
      let total = 0
      for (let p = 0; p < PAGES; p++) total += rows[b * PAGES + p].logRatio
      out.push(total / PAGES)
    }
    return out
  }
  const effect = blockedEffect(pairs('effect'), SEED + i * 17 + 1, BOOT)
  const baseNull = blockedEffect(pairs('baseNull'), SEED + i * 17 + 3, BOOT)
  const optNull = blockedEffect(pairs('optNull'), SEED + i * 17 + 5, BOOT)
  const raw = layouts.effect[meta.name].flatMap((r) => r.calls)
  const maxPairLogSd = stats(raw.map((c) => Math.log(c.ms))).sd
  fixtures[meta.name] = {
    meta, effect, baseNull, optNull,
    baseNullEquivalent: ciWithin(baseNull.ci95, CONTROL_BAND),
    optNullEquivalent: ciWithin(optNull.ci95, CONTROL_BAND),
    equivalent: ciWithin(effect.ci95, NOOP_BAND),
    win: effect.ci95[1] < -(EPS * 100),
    regression: effect.ci95[0] > EPS * 100,
    maxPairLogSd,
  }
})

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
if (playwrightVersion !== EXPECTED_PLAYWRIGHT) throw new Error(`Playwright version mismatch: ${playwrightVersion}`)

const report = {
  schema: 'snapdom-r9-blocked-prototype-v1',
  experimental: true,
  mergeRecommendation: 'none until a hosted A/A shows reduced runner-level dispersion',
  provenance: hostedProvenance({
    protocol: {
      mode: MODE, suite: SUITE, n: N, batch: BATCH, pages: PAGES, warmup: WARM, bootstrap: BOOT,
      seed: SEED, reverseLayoutOrder: REVERSE, identityCanary: IDENTITY_CANARY,
      epsilon: EPS, controlBand: CONTROL_BAND, noopBand: NOOP_BAND,
      fixtureManifestSha256: sha256Text(stableJson(FIXTURES)),
    },
    browser: { requested: ENGINE, actualName: actualBrowserName, actualVersion: actualBrowserVersion, playwrightVersion },
    code: {
      harness: { path: 'lane6-scratch/r9-calibration/bench-r9-blocked.mjs', sha256: sha256File(path.resolve(process.argv[1])) },
      protocol: { path: 'lane6-scratch/r9/protocol.mjs', sha256: sha256File(path.resolve(ROOT, 'lane6-scratch/r9/protocol.mjs')) },
    },
  }),
  fixtures,
  layouts,
}
const outDir = path.join(ROOT, 'lane6-scratch/r9/results')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, OUT_NAME), JSON.stringify(report, null, 2))

console.log(`[prototype] ${LABEL} ${ENGINE} ${actualBrowserVersion} N=${N} batch=${BATCH} pages=${PAGES} reverse=${REVERSE} canary=${IDENTITY_CANARY}`)
for (const [name, fx] of Object.entries(fixtures)) {
  console.log(`${name.padEnd(30)} effect=${fx.effect.pct.toFixed(2)}% CI[${fx.effect.ci95.map((v) => v.toFixed(2)).join(', ')}] pairLogSD=${fx.maxPairLogSd.toFixed(3)}`)
}