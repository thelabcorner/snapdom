#!/usr/bin/env node
/**
 * R9 hosted-runner controlled A/B harness.
 *
 * Hard protocol:
 *   - browser launch is refused outside GitHub Actions;
 *   - effect uses fresh-page AB/BA crossover;
 *   - BOTH baseline-state and candidate-state A/A controls are measured;
 *   - known no-op fixtures must prove equivalence, not merely "CI includes zero";
 *   - exact raw parity is mandatory;
 *   - raw observations are retained; no outlier deletion.
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
  crossoverEffect,
  ciWithin,
  hostedProvenance,
  stableJson,
  sha256Text,
} from './protocol.mjs'

assertHostedBrowser()

const ROOT = process.cwd()
const MODE = arg('mode', 'bundle-diff')
const SUITE = arg('suite', 'standing')
const BASE_REL = arg('baseline', 'lane6-scratch/r9/bundles/baseline.mjs')
const CAND_REL = arg('candidate', 'lane6-scratch/r9/bundles/candidate.mjs')
const BASE_EXTRA = parseExtra(arg('base', ''))
const OPT_EXTRA = parseExtra(arg('opt', ''))
const ENGINE = String(arg('browser', 'chromium')).toLowerCase()
const N = Math.max(4, Math.floor(numberArg('n', 16)))
const BATCH = Math.max(1, Math.floor(numberArg('batch', 2)))
const WARM = Math.max(0, Math.floor(numberArg('warmup', 2)))
const BOOT = Math.max(1000, Math.floor(numberArg('bootstrap', 12000)))
const EPS = numberArg('epsilon', 0.02)
const CONTROL_BAND = numberArg('control-band', 0.03)
const NOOP_BAND = numberArg('noop-band', CONTROL_BAND)
const MAX_PAIR_LOG_SD = numberArg('max-pair-log-sd', 0.20)
const SEED = Math.floor(numberArg('seed', 0x9a31))
const ONLY = new Set(String(arg('only', '')).split(',').map((x) => x.trim()).filter(Boolean))
const LABEL = arg('label', 'R9 controlled A/B')
const OUT_NAME = arg('out', 'r9-controlled.json')
const EXPECT = arg('expect', 'improvement')
const EXPECTED_PLAYWRIGHT = arg('playwright-version', '1.55.1')

if (!['bundle-diff', 'option-pair'].includes(MODE)) throw new Error(`unsupported --mode=${MODE}`)
if (!['standing', 'focus', 'pseudo'].includes(SUITE)) throw new Error(`unsupported --suite=${SUITE}`)
if (!['improvement', 'equivalence', 'explore'].includes(EXPECT)) throw new Error(`unsupported --expect=${EXPECT}`)

const basePath = path.resolve(ROOT, BASE_REL)
const candPath = path.resolve(ROOT, CAND_REL)
if (!fs.existsSync(candPath)) throw new Error(`candidate bundle missing: ${candPath}`)
if (MODE === 'bundle-diff' && !fs.existsSync(basePath)) throw new Error(`baseline bundle missing: ${basePath}`)

const candidateBytes = fs.readFileSync(candPath)
const baselineBytes = MODE === 'option-pair' ? candidateBytes : fs.readFileSync(basePath)
const candidateSha = sha256File(candPath)
const baselineSha = MODE === 'option-pair' ? candidateSha : sha256File(basePath)

const COMMON = { burst: false, cache: 'disabled', embedFonts: false }
const BASE = SUITE === 'standing'
  ? { ...FIXTURE_OPTIONS, ...BASE_EXTRA }
  : { ...COMMON, ...BASE_EXTRA }
const OPT = SUITE === 'standing'
  ? { ...FIXTURE_OPTIONS, ...OPT_EXTRA }
  : { ...COMMON, ...OPT_EXTRA }

const STANDING = [
  { name: 'light-20cards', noop: false },
  { name: 'cards400-safe', noop: false },
  { name: 'cards400-neutral-unsafe', noop: false },
  { name: 'cards400-non-neutral', noop: false },
]

const FOCUS = [
  { name: 'focus-20', nodes: 20, cardinality: 1, mode: 'focus', noop: false },
  { name: 'focus-400', nodes: 400, cardinality: 1, mode: 'focus', noop: false },
  { name: 'focus-1000', nodes: 1000, cardinality: 1, mode: 'focus', noop: false },
  { name: 'focus-within-400', nodes: 400, cardinality: 1, mode: 'focus-within', noop: false },
  { name: 'mixed-focus-400', nodes: 400, cardinality: 20, mode: 'focus', noop: false },
  { name: 'focus-plus-hover-veto-400', nodes: 400, cardinality: 1, mode: 'focus-hover-veto', noop: true },
  { name: 'no-focus-400', nodes: 400, cardinality: 1, mode: 'none', noop: true },
]

const PSEUDO = [
  { name: 'pseudo-20', nodes: 20, cardinality: 1, mode: 'both', noop: false },
  { name: 'pseudo-400', nodes: 400, cardinality: 1, mode: 'both', noop: false },
  { name: 'pseudo-mixed-400', nodes: 400, cardinality: 20, mode: 'both', noop: false },
  { name: 'pseudo-pairs-400', nodes: 400, cardinality: 200, mode: 'both', noop: false },
  { name: 'pseudo-pairs-unique-style-400', nodes: 400, cardinality: 200, mode: 'pairUnique', noop: false },
  { name: 'pseudo-triples-unique-style-360', nodes: 360, cardinality: 120, mode: 'tripleUnique', noop: false },
  { name: 'pseudo-quads-unique-style-400', nodes: 400, cardinality: 100, mode: 'quadUnique', noop: false },
  { name: 'pseudo-fives-unique-style-400', nodes: 400, cardinality: 80, mode: 'fiveUnique', noop: false },
  { name: 'pseudo-sixes-unique-style-420', nodes: 420, cardinality: 70, mode: 'sixUnique', noop: false },
  { name: 'pseudo-entropy-400', nodes: 400, cardinality: 400, mode: 'both', noop: false },
  { name: 'pseudo-before-only-400', nodes: 400, cardinality: 1, mode: 'before', noop: false },
  { name: 'pseudo-flex-400', nodes: 400, cardinality: 1, mode: 'flex', noop: false },
  { name: 'pseudo-percent-400', nodes: 400, cardinality: 2, mode: 'percent', noop: false },
  { name: 'pseudo-state-veto-400', nodes: 400, cardinality: 1, mode: 'stateVeto', noop: true },
  { name: 'no-pseudo-400', nodes: 400, cardinality: 1, mode: 'none', noop: true },
]

const ALL_FIXTURES = SUITE === 'standing' ? STANDING : SUITE === 'focus' ? FOCUS : PSEUDO
const FIXTURES = ALL_FIXTURES.filter((fx) => !ONLY.size || ONLY.has(fx.name))
if (!FIXTURES.length) throw new Error('fixture selection is empty')

const FOCUS_SRC = String.raw`
window.__fx = (() => {
  function build(spec) {
    const { nodes, cardinality, mode } = spec
    const st = document.createElement('style')
    const common = '.fp-root{width:900px;font:13px Arial,sans-serif}.fp-card{display:block;width:120px;height:14px;outline:none;background:rgb(0,0,255)}'
    if (mode === 'focus') st.textContent = common + '.fp-card:focus{background:rgb(255,0,0)}'
    else if (mode === 'focus-within') st.textContent = common + '.fp-group{display:block;width:130px;height:16px;background:rgb(0,0,255)}.fp-probe{outline:none}.fp-group:focus-within{background:rgb(255,0,0)}'
    else if (mode === 'focus-hover-veto') st.textContent = common + '.fp-card:focus:not(:hover),.fp-card:not(:hover){background:rgb(10,20,30)}'
    else st.textContent = common
    document.head.appendChild(st)
    const root = document.createElement('div')
    root.className = 'fp-root'
    if (mode === 'focus-within') {
      for (let i = 0; i < nodes; i++) {
        const g = document.createElement('div')
        g.className = 'fp-group g' + (i % cardinality)
        const p = document.createElement('span')
        p.className = 'fp-probe'
        p.tabIndex = 0
        g.appendChild(p)
        root.appendChild(g)
      }
    } else {
      for (let i = 0; i < nodes; i++) {
        const e = document.createElement('span')
        e.className = 'fp-card g' + (i % cardinality)
        e.tabIndex = 0
        root.appendChild(e)
      }
    }
    document.body.appendChild(root)
    if (mode === 'focus-within') root.querySelectorAll('.fp-probe')[nodes >> 1]?.focus()
    else if (mode === 'focus' || mode === 'focus-hover-veto') root.children[nodes >> 1]?.focus()
    return root
  }
  return {
    build,
    cleanup(el) {
      try { document.activeElement?.blur?.() } catch {}
      try { el.remove() } catch {}
      document.querySelectorAll('style').forEach((s) => s.remove())
    },
  }
})()
window.__fxReady = true
`

const PSEUDO_SRC = String.raw`
window.__fx = (() => {
  function color(i, salt = 0) {
    return 'rgb(' + ((i * 47 + salt) % 256) + ',' + ((i * 83 + salt * 3) % 256) + ',' + ((i * 131 + salt * 7) % 256) + ')'
  }
  function build(spec) {
    const { nodes, cardinality, mode } = spec
    const st = document.createElement('style')
    let css = '.r9p-root{width:900px;font:13px Arial,sans-serif}.r9p-row{display:block;box-sizing:border-box;min-height:18px}'
    if (mode !== 'none') {
      css += '.r9p-row::before{content:"#";display:inline-block;width:12px;color:#64748b}'
      if (mode !== 'before') css += '.r9p-row::after{content:"!";display:inline-block;width:8px;color:#94a3b8}'
    }
    if (mode === 'flex') css += '.r9p-row{display:flex;align-items:center}'
    if (mode === 'percent') css += '.r9p-row{width:var(--w)}.r9p-row::before{width:50%}'
    if (mode === 'stateVeto') css += '.r9p-row:not(:hover)::before{outline-offset:0px}'
    if (['pairUnique','tripleUnique','quadUnique','fiveUnique','sixUnique'].includes(mode)) {
      for (let i = 0; i < cardinality; i++) {
        css += '.r9p-row.g' + i + '::before{color:' + color(i, 11) + '}.r9p-row.g' + i + '::after{color:' + color(i, 29) + '}'
      }
    }
    st.textContent = css
    document.head.appendChild(st)
    const root = document.createElement('div')
    root.className = 'r9p-root'
    for (let i = 0; i < nodes; i++) {
      const e = document.createElement('div')
      e.className = 'r9p-row g' + (i % cardinality)
      if (mode === 'percent') e.style.setProperty('--w', (i & 1 ? '420px' : '180px'))
      e.textContent = 'row ' + i
      root.appendChild(e)
    }
    document.body.appendChild(root)
    return root
  }
  return {
    build,
    cleanup(el) {
      try { el.remove() } catch {}
      document.querySelectorAll('style').forEach((s) => s.remove())
    },
  }
})()
window.__fxReady = true
`

const fixtureSource = SUITE === 'standing' ? PAGE_FIXTURE_SRC : SUITE === 'focus' ? FOCUS_SRC : PSEUDO_SRC
const fixtureSpecs = Object.fromEntries(FIXTURES.map((fx) => [fx.name, fx]))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>${fixtureSource.replaceAll('</script>', '<\\/script>')}</script>
<script type="module">
const specs = ${JSON.stringify(fixtureSpecs)}
window.__bench = {
  async init(u1, u2, o1, o2) {
    this.mods = { slot1: await import(u1), slot2: await import(u2) }
    this.opts = { slot1: o1, slot2: o2 }
  },
  async one(slot, fixture) {
    const spec = specs[fixture]
    const el = window.__fx.build(${SUITE === 'standing' ? 'fixture' : 'spec'})
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
      const order = i & 1 ? ['slot2', 'slot1'] : ['slot1', 'slot2']
      for (const slot of order) await this.one(slot, fixture)
    }
  },
  async oracle(fixture) {
    const a = await this.one('slot1', fixture)
    const b = await this.one('slot2', fixture)
    return { parity: a.raw === b.raw, aBytes: a.raw.length, bBytes: b.raw.length }
  },
  async sample(fixture, index, batch) {
    let slot1 = 0
    let slot2 = 0
    for (let b = 0; b < batch; b++) {
      // Micro-interleave the arms. The old scheduler ran A,A,A then B,B,B, which let
      // sub-second runner/JIT/GC drift masquerade as an arm effect. With an even batch each
      // arm goes first exactly batch/2 times; odd batches rotate the extra first position.
      const order = (index + b) & 1 ? ['slot2', 'slot1'] : ['slot1', 'slot2']
      for (const slot of order) {
        const ms = (await this.one(slot, fixture)).ms
        if (slot === 'slot1') slot1 += ms
        else slot2 += ms
      }
    }
    return { slot1: slot1 / batch, slot2: slot2 / batch }
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
  if (url.pathname.startsWith('/baseline.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(baselineBytes)
    return
  }
  if (url.pathname.startsWith('/candidate.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(candidateBytes)
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
if (actualBrowserName !== ENGINE) {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
  throw new Error(`engine identity mismatch: requested ${ENGINE}, launched ${actualBrowserName}`)
}

const moduleFor = MODE === 'option-pair'
  ? { base: 'candidate', opt: 'candidate' }
  : { base: 'baseline', opt: 'candidate' }

async function openLayout(name, leftKind, rightKind, leftOptions, rightOptions, fixtureName) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => console.error(`[${name}] PAGE ERROR`, error.message))
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
    await page.evaluate(({ u1, u2, o1, o2 }) => window.__bench.init(u1, u2, o1, o2), {
      u1: `/${leftKind}.mjs?${fixtureName}-${name}-1`,
      u2: `/${rightKind}.mjs?${fixtureName}-${name}-2`,
      o1: leftOptions,
      o2: rightOptions,
    })
    return page
  } catch (error) {
    await page.close()
    throw error
  }
}

const LAYOUT_SPECS = {
  effectForward: [moduleFor.base, moduleFor.opt, BASE, OPT],
  effectReverse: [moduleFor.opt, moduleFor.base, OPT, BASE],
  baseNullForward: [moduleFor.base, moduleFor.base, BASE, BASE],
  baseNullReverse: [moduleFor.base, moduleFor.base, BASE, BASE],
  optNullForward: [moduleFor.opt, moduleFor.opt, OPT, OPT],
  optNullReverse: [moduleFor.opt, moduleFor.opt, OPT, OPT],
}
const LAYOUT_ORDER = Object.keys(LAYOUT_SPECS)

async function runFixture(fx) {
  const pages = {}
  const result = {}
  try {
    // Six independent physical pages preserve the fresh-page crossover, while keeping all
    // layouts alive together lets us acquire one observation block across AB/BA/AA/BB before
    // moving to the next block. This converts minute-scale runner drift into common-mode noise.
    for (const name of LAYOUT_ORDER) {
      pages[name] = await openLayout(name, ...LAYOUT_SPECS[name], fx.name)
      result[name] = { rows: [] }
    }

    // Symmetric warmup and byte oracle on every physical layout before timed acquisition.
    for (const name of LAYOUT_ORDER) {
      const page = pages[name]
      if (WARM) {
        await page.evaluate(({ fixture, warm }) => window.__bench.warm(fixture, warm), {
          fixture: fx.name,
          warm: WARM,
        })
      }
      result[name].oracle = await page.evaluate((fixture) => window.__bench.oracle(fixture), fx.name)
    }

    for (let i = 0; i < N; i++) {
      // Latin rotation: across every six observation blocks, each physical layout occupies
      // every temporal position exactly once. No arm/control owns "early" or "late" runner time.
      const shift = i % LAYOUT_ORDER.length
      const order = LAYOUT_ORDER.slice(shift).concat(LAYOUT_ORDER.slice(0, shift))
      for (const name of order) {
        const row = await pages[name].evaluate(
          ({ fixture, index, batch }) => window.__bench.sample(fixture, index, batch),
          { fixture: fx.name, index: i, batch: BATCH },
        )
        result[name].rows.push(row)
      }
    }

    for (const name of LAYOUT_ORDER) {
      const rows = result[name].rows
      result[name].slot1 = stats(rows.map((row) => row.slot1))
      result[name].slot2 = stats(rows.map((row) => row.slot2))
      result[name].pairLog = stats(rows.map((row) => Math.log(row.slot2 / row.slot1)))
    }
    return result
  } finally {
    await Promise.all(Object.values(pages).map((page) => page.close().catch(() => {})))
  }
}

const layouts = Object.fromEntries(LAYOUT_ORDER.map((name) => [name, {}]))
try {
  for (const fx of FIXTURES) {
    const fixtureResult = await runFixture(fx)
    for (const name of LAYOUT_ORDER) layouts[name][fx.name] = fixtureResult[name]
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const fixtures = {}
for (let i = 0; i < FIXTURES.length; i++) {
  const meta = FIXTURES[i]
  const name = meta.name
  const ef = layouts.effectForward[name]
  const er = layouts.effectReverse[name]
  const bf = layouts.baseNullForward[name]
  const br = layouts.baseNullReverse[name]
  const of = layouts.optNullForward[name]
  const or = layouts.optNullReverse[name]

  const candidate = crossoverEffect(ef.rows, er.rows, SEED + i * 17 + 1, BOOT)
  const baseNull = crossoverEffect(bf.rows, br.rows, SEED + i * 17 + 3, BOOT)
  const optNull = crossoverEffect(of.rows, or.rows, SEED + i * 17 + 5, BOOT)

  const rawMaxCov = Math.max(
    ef.slot1.cov, ef.slot2.cov, er.slot1.cov, er.slot2.cov,
    bf.slot1.cov, bf.slot2.cov, br.slot1.cov, br.slot2.cov,
    of.slot1.cov, of.slot2.cov, or.slot1.cov, or.slot2.cov,
  )
  const maxPairLogSd = Math.max(
    ef.pairLog.sd, er.pairLog.sd, bf.pairLog.sd,
    br.pairLog.sd, of.pairLog.sd, or.pairLog.sd,
  )

  const parity = ef.oracle.parity && er.oracle.parity
  const baseNullEquivalent = ciWithin(baseNull.ci95, CONTROL_BAND)
  const optNullEquivalent = ciWithin(optNull.ci95, CONTROL_BAND)
  const controlsPass = baseNullEquivalent && optNullEquivalent
  const stabilityPass = maxPairLogSd <= MAX_PAIR_LOG_SD
  const noOpEquivalent = !meta.noop || ciWithin(candidate.ci95, NOOP_BAND)
  const candidateWin = candidate.ci95[1] < -(EPS * 100)
  const candidateRegression = candidate.ci95[0] > EPS * 100
  const candidateEquivalent = ciWithin(candidate.ci95, NOOP_BAND)

  fixtures[name] = {
    meta,
    parity,
    candidate,
    baseNull,
    optNull,
    baseNullEquivalent,
    optNullEquivalent,
    controlsPass,
    stabilityPass,
    noOpEquivalent,
    candidateWin,
    candidateRegression,
    candidateEquivalent,
    claimable: parity && controlsPass && stabilityPass && noOpEquivalent && candidateWin,
    rawMaxCov,
    maxPairLogSd,
  }
}

const noOpFixtures = FIXTURES.filter((fx) => fx.noop).map((fx) => fx.name)
const global = {
  parityPass: Object.values(fixtures).every((fx) => fx.parity),
  controlsPass: Object.values(fixtures).every((fx) => fx.controlsPass),
  stabilityPass: Object.values(fixtures).every((fx) => fx.stabilityPass),
  noOpPass: noOpFixtures.every((name) => fixtures[name].noOpEquivalent),
}

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
if (playwrightVersion !== EXPECTED_PLAYWRIGHT) {
  throw new Error(`Playwright version mismatch: expected ${EXPECTED_PLAYWRIGHT}, loaded ${playwrightVersion}`)
}
const harnessPath = path.resolve(process.argv[1])
const protocolPath = path.resolve(ROOT, 'lane6-scratch/r9/protocol.mjs')
const fixtureSourcePath = path.resolve(ROOT, 'lane6-scratch/atlas/profiler/fixtures.mjs')
const report = {
  schema: 'snapdom-r9-hosted-bench-v1',
  provenance: hostedProvenance({
    protocol: {
      mode: MODE,
      suite: SUITE,
      label: LABEL,
      expectation: EXPECT,
      n: N,
      batch: BATCH,
      warmup: WARM,
      bootstrap: BOOT,
      epsilon: EPS,
      controlBand: CONTROL_BAND,
      noopBand: NOOP_BAND,
      maxPairLogSd: MAX_PAIR_LOG_SD,
      seed: SEED,
      fixtureNames: FIXTURES.map((fx) => fx.name),
      fixtureManifestSha256: sha256Text(stableJson(FIXTURES)),
    },
    browser: {
      requested: ENGINE,
      actualName: actualBrowserName,
      actualVersion: actualBrowserVersion,
      playwrightVersion,
    },
    code: {
      harness: {
        path: path.relative(ROOT, harnessPath).replaceAll('\\\\', '/'),
        sha256: sha256File(harnessPath),
      },
      protocol: {
        path: path.relative(ROOT, protocolPath).replaceAll('\\\\', '/'),
        sha256: sha256File(protocolPath),
      },
      fixtureSource: {
        path: 'lane6-scratch/atlas/profiler/fixtures.mjs',
        sha256: sha256File(fixtureSourcePath),
      },
      manifestSha256: process.env.SNAPDOM_BENCH_MANIFEST_SHA256 || null,
    },
    git: {
      candidateSha: process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null,
      baselineSha: process.env.SNAPDOM_BASELINE_GIT_SHA || null,
    },
    bundles: {
      baseline: { path: BASE_REL, sha256: baselineSha },
      candidate: { path: CAND_REL, sha256: candidateSha },
    },
    options: { base: BASE_EXTRA, opt: OPT_EXTRA },
  }),
  method: 'hosted-only fresh-page AB/BA crossover; micro-interleaved arms; Latin-rotated AB/BA/AA/BB observation blocks; baseline-state A/A + candidate-state B/B nulls; exact raw parity; equivalence-bounded controls; index-block bootstrap of symmetric paired log ratios; raw samples retained; no outlier deletion',
  global,
  fixtures,
  layouts,
}

const outDir = path.join(ROOT, 'lane6-scratch/r9/results')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, OUT_NAME)
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

console.log(`${LABEL} mode=${MODE} suite=${SUITE} ${ENGINE} ${actualBrowserVersion} N=${N} batch=${BATCH}`)
console.log(`baseline=${baselineSha.slice(0, 12)} candidate=${candidateSha.slice(0, 12)} controls=±${(CONTROL_BAND * 100).toFixed(1)}% noop=±${(NOOP_BAND * 100).toFixed(1)}%`)
for (const [name, fx] of Object.entries(fixtures)) {
  const verdict = fx.claimable ? 'WIN' : fx.candidateRegression ? 'REGRESSION' : fx.candidateEquivalent ? 'EQUIVALENT' : 'INCONCLUSIVE'
  console.log(
    `${name.padEnd(34)} parity=${fx.parity ? 'PASS' : 'FAIL'} effect=${fx.candidate.pct.toFixed(2)}% CI[${fx.candidate.ci95.map((v) => v.toFixed(2)).join(', ')}] ` +
    `base-null=[${fx.baseNull.ci95.map((v) => v.toFixed(2)).join(', ')}] opt-null=[${fx.optNull.ci95.map((v) => v.toFixed(2)).join(', ')}] ` +
    `rawCoV=${(fx.rawMaxCov * 100).toFixed(1)}% pairLogSD=${fx.maxPairLogSd.toFixed(3)} ${verdict}`
  )
}
console.log(`artifact ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`)
