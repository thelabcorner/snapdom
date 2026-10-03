#!/usr/bin/env node
/**
 * F4 — hosted wall-clock falsifier for the per-root identity partition.
 *
 * Same protocol machinery as the R9 controlled harness (lane6-scratch/r9/protocol.mjs, reused
 * unmodified): fresh-page AB/BA crossover, micro-interleaved arms, Latin-rotated observation
 * blocks across six physical layouts, a baseline-state A/A control and a candidate-state B/B
 * control, index-block bootstrap of symmetric paired log ratios, raw samples retained, no
 * outlier deletion. R9's own driver is NOT edited: its hash is pinned by the completed R9
 * calibration, so this lane carries its own copy of the driver and its own policy.
 *
 * Three things are different from R9, and all three matter:
 *
 *  - mode is option-pair on ONE bundle. Both arms are the released build and the only difference
 *    is the internal counterfactual option, so any measured difference is attributable to that
 *    option alone.
 *  - the fixtures are the shadow-card family (__tests__/helpers/shadowCards.js, served to the
 *    page as a module) instead of the light-DOM standing suite.
 *  - byte parity between the arms is a DIAGNOSTIC, not a gate. The opt arm is the ceiling
 *    spike: it hands shadow content a per-root identity without scanning that root's own sheets,
 *    so on a root whose sheet splits twins it is expected to diverge. That divergence is a
 *    finding about what a sound partition must add, not a harness failure. A fixture whose two
 *    arms agree byte-for-byte is reported as spikeByteSafe.
 *
 * Browser launch is refused outside GitHub Actions.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium, firefox, webkit } from 'playwright'
import {
  arg, numberArg, parseExtra, sha256File, stats, crossoverEffect, ciWithin,
  hostedProvenance, stableJson, sha256Text,
} from '../r9/protocol.mjs'

if (process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error(
    'F4 wall measurement is GitHub-Actions-only. ' +
    'Local browser execution is intentionally blocked by protocol.'
  )
}

const ROOT = process.cwd()
const LANE = path.resolve(ROOT, 'lane6-scratch/r10-shadow')
const FIXTURES_MJS = path.resolve(ROOT, '__tests__/helpers/shadowCards.js')
const PROTOCOL_MJS = path.resolve(ROOT, 'lane6-scratch/r9/protocol.mjs')
const POLICY_PATH = path.join(LANE, 'F4_POLICY.json')
const BUNDLE_REL = arg('bundle', 'lane6-scratch/r10-shadow/bundle/candidate.mjs')
const POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
const ENGINE = String(arg('browser', 'chromium')).toLowerCase()
const REPLICATE = Number(arg('replicate', '0'))
const N = Math.max(4, Math.floor(numberArg('n', POLICY.sampling.n)))
const BATCH = Math.max(1, Math.floor(numberArg('batch', POLICY.sampling.batch)))
const WARM = Math.max(0, Math.floor(numberArg('warmup', POLICY.sampling.warmup)))
const BOOT = Math.max(1000, Math.floor(numberArg('bootstrap', POLICY.sampling.bootstrap)))
const SEED = Math.floor(numberArg('seed', POLICY.sampling.baseSeed))
const LABEL = arg('label', 'F4 wall falsifier')
const OUT_NAME = arg('out', 'f4-' + ENGINE + '-r' + REPLICATE + '.json')
const ENGINE_OFFSET = { chromium: 0, firefox: 1000003, webkit: 2000003 }

if (!['chromium', 'firefox', 'webkit'].includes(ENGINE)) throw new Error('invalid browser ' + ENGINE)
if (!Number.isInteger(REPLICATE) || REPLICATE < 0 || REPLICATE >= POLICY.replicates[ENGINE]) {
  throw new Error('replicate outside policy for ' + ENGINE)
}

const bundlePath = path.resolve(ROOT, BUNDLE_REL)
if (!fs.existsSync(bundlePath)) throw new Error('bundle missing: ' + bundlePath)
if (!fs.existsSync(FIXTURES_MJS)) throw new Error('shadow fixture module missing')
const bundleBytes = fs.readFileSync(bundlePath)
const bundleSha = sha256File(bundlePath)
const fixtureBytes = fs.readFileSync(FIXTURES_MJS)
const fixtureSha = sha256File(FIXTURES_MJS)
const protocolSha = sha256File(PROTOCOL_MJS)
const policySha = sha256File(POLICY_PATH)

const BASE_OPTIONS = {
  scale: 1, dpr: 1, embedFonts: false, cache: 'disabled', burst: false,
  ...parseExtra(arg('base', '__styleShareShadowRootTwins=false')),
}
const OPT_OPTIONS = {
  scale: 1, dpr: 1, embedFonts: false, cache: 'disabled', burst: false,
  ...parseExtra(arg('opt', '__styleShareShadowRootTwins=true')),
}

const FIXTURES = POLICY.fixtures
const moduleSource = [
  "import { SHADOW_FIXTURES, fixtureByName } from '/shadowCards.js'",
  'const NAMES = ' + JSON.stringify(FIXTURES),
  'window.__bench = {',
  '  async init(u1, u2, o1, o2) {',
  '    this.mods = { slot1: await import(u1), slot2: await import(u2) }',
  '    this.opts = { slot1: o1, slot2: o2 }',
  '    this.known = new Set(SHADOW_FIXTURES.map((fx) => fx.name))',
  '    for (const name of NAMES) {',
  '      if (!this.known.has(name)) throw new Error("policy names an unknown fixture: " + name)',
  '    }',
  '  },',
  '  async one(slot, name) {',
  '    const { root, dispose } = fixtureByName(name).build()',
  '    try {',
  '      const t0 = performance.now()',
  '      const raw = await this.mods[slot].snapdom.toRaw(root, this.opts[slot])',
  '      return { ms: performance.now() - t0, raw }',
  '    } finally {',
  '      dispose()',
  '    }',
  '  },',
  '  async warm(name, n) {',
  '    for (let i = 0; i < n; i++) {',
  "      const order = i & 1 ? ['slot2', 'slot1'] : ['slot1', 'slot2']",
  '      for (const slot of order) await this.one(slot, name)',
  '    }',
  '  },',
  '  async oracle(name) {',
  "    const a = await this.one('slot1', name)",
  "    const b = await this.one('slot2', name)",
  '    return { parity: a.raw === b.raw, aBytes: a.raw.length, bBytes: b.raw.length }',
  '  },',
  '  async sample(name, index, batch) {',
  '    let slot1 = 0',
  '    let slot2 = 0',
  '    for (let b = 0; b < batch; b++) {',
  "      const order = (index + b) & 1 ? ['slot2', 'slot1'] : ['slot1', 'slot2']",
  '      for (const slot of order) {',
  '        const ms = (await this.one(slot, name)).ms',
  "        if (slot === 'slot1') slot1 += ms",
  '        else slot2 += ms',
  '      }',
  '    }',
  '    return { slot1: slot1 / batch, slot2: slot2 / batch }',
  '  },',
  '}',
  'window.__ready = true',
].join('\n')

const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<script type="module">',
  moduleSource,
  '</script></body></html>',
].join('\n')

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/shadowCards.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(fixtureBytes)
    return
  }
  if (url.pathname.startsWith('/baseline.mjs') || url.pathname.startsWith('/candidate.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(bundleBytes)
    return
  }
  res.writeHead(404)
  res.end('nf')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port

const browserType = { chromium, firefox, webkit }[ENGINE]
const browser = await browserType.launch(ENGINE === 'chromium'
  ? {
    headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--disable-extensions'],
  }
  : { headless: true })
const actualName = browser.browserType().name()
const actualVersion = browser.version()
if (actualName !== ENGINE) {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
  throw new Error('engine identity mismatch: requested ' + ENGINE + ', launched ' + actualName)
}

async function openLayout(name, leftOptions, rightOptions) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => console.error('[' + name + '] PAGE ERROR', error.message))
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.__ready === true)
    await page.evaluate(({ o1, o2 }) => window.__bench.init('/baseline.mjs', '/candidate.mjs', o1, o2), {
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
  effectForward: [BASE_OPTIONS, OPT_OPTIONS],
  effectReverse: [OPT_OPTIONS, BASE_OPTIONS],
  baseNullForward: [BASE_OPTIONS, BASE_OPTIONS],
  baseNullReverse: [BASE_OPTIONS, BASE_OPTIONS],
  optNullForward: [OPT_OPTIONS, OPT_OPTIONS],
  optNullReverse: [OPT_OPTIONS, OPT_OPTIONS],
}
const LAYOUT_ORDER = Object.keys(LAYOUT_SPECS)

async function runFixture(name) {
  const pages = {}
  const result = {}
  try {
    for (const layout of LAYOUT_ORDER) {
      pages[layout] = await openLayout(layout, ...LAYOUT_SPECS[layout])
      result[layout] = { rows: [] }
    }
    for (const layout of LAYOUT_ORDER) {
      if (WARM) {
        await pages[layout].evaluate(({ n, warm }) => window.__bench.warm(n, warm), { n: name, warm: WARM })
      }
      result[layout].oracle = await pages[layout].evaluate((n) => window.__bench.oracle(n), name)
    }
    for (let i = 0; i < N; i++) {
      const shift = i % LAYOUT_ORDER.length
      const order = LAYOUT_ORDER.slice(shift).concat(LAYOUT_ORDER.slice(0, shift))
      for (const layout of order) {
        const row = await pages[layout].evaluate(
          ({ n, index, batch }) => window.__bench.sample(n, index, batch),
          { n: name, index: i, batch: BATCH },
        )
        result[layout].rows.push(row)
      }
    }
    for (const layout of LAYOUT_ORDER) {
      const rows = result[layout].rows
      result[layout].slot1 = stats(rows.map((row) => row.slot1))
      result[layout].slot2 = stats(rows.map((row) => row.slot2))
      result[layout].pairLog = stats(rows.map((row) => Math.log(row.slot2 / row.slot1)))
    }
    return result
  } finally {
    await Promise.all(Object.values(pages).map((page) => page.close().catch(() => {})))
  }
}

const layouts = Object.fromEntries(LAYOUT_ORDER.map((layout) => [layout, {}]))
try {
  for (const name of FIXTURES) {
    const fixtureResult = await runFixture(name)
    for (const layout of LAYOUT_ORDER) layouts[layout][name] = fixtureResult[layout]
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const gates = POLICY.gates
const fixtures = {}
for (let i = 0; i < FIXTURES.length; i++) {
  const name = FIXTURES[i]
  const ef = layouts.effectForward[name]
  const er = layouts.effectReverse[name]
  const bf = layouts.baseNullForward[name]
  const br = layouts.baseNullReverse[name]
  const of = layouts.optNullForward[name]
  const or = layouts.optNullReverse[name]
  const effect = crossoverEffect(ef.rows, er.rows, SEED + i * 17 + 1, BOOT)
  const baseNull = crossoverEffect(bf.rows, br.rows, SEED + i * 17 + 3, BOOT)
  const optNull = crossoverEffect(of.rows, or.rows, SEED + i * 17 + 5, BOOT)
  const maxPairLogSd = Math.max(ef.pairLog.sd, er.pairLog.sd, bf.pairLog.sd,
    br.pairLog.sd, of.pairLog.sd, or.pairLog.sd)
  const rawMaxCov = Math.max(ef.slot1.cov, ef.slot2.cov, er.slot1.cov, er.slot2.cov,
    bf.slot1.cov, bf.slot2.cov, br.slot1.cov, br.slot2.cov,
    of.slot1.cov, of.slot2.cov, or.slot1.cov, or.slot2.cov)
  fixtures[name] = {
    meta: {
      name,
      noop: POLICY.noopFixtures.includes(name),
      splitting: POLICY.splittingFixtures.includes(name),
    },
    effect,
    baseNull,
    optNull,
    controlsPass: ciWithin(baseNull.ci95, gates.controlBand) && ciWithin(optNull.ci95, gates.controlBand),
    stabilityPass: maxPairLogSd <= gates.maxPairLogSd,
    noOpEquivalent: !POLICY.noopFixtures.includes(name) || ciWithin(effect.ci95, gates.equivalenceBand),
    spikeByteSafe: ef.oracle.parity && er.oracle.parity,
    reachesMinEffect: effect.ci95[1] >= gates.minEffectPct,
    clearsMinEffect: effect.ci95[0] >= gates.minEffectPct,
    regresses: effect.ci95[0] > gates.minEffectPct,
    maxPairLogSd,
    rawMaxCov,
  }
}

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
if (playwrightVersion !== POLICY.playwrightVersion) {
  throw new Error('Playwright version mismatch: expected ' + POLICY.playwrightVersion + ', loaded ' + playwrightVersion)
}

const report = {
  schema: 'snapdom-r10-f4-wall-v1',
  provenance: hostedProvenance({
    protocol: {
      lane: 'F4',
      label: LABEL,
      mode: 'option-pair',
      n: N,
      batch: BATCH,
      warmup: WARM,
      bootstrap: BOOT,
      seed: SEED,
      engineOffset: ENGINE_OFFSET[ENGINE],
      replicate: REPLICATE,
      fixtureNames: FIXTURES,
      fixtureManifestSha256: sha256Text(stableJson(FIXTURES)),
      gates,
    },
    browser: { requested: ENGINE, actualName, actualVersion, playwrightVersion },
    code: {
      harness: {
        path: 'lane6-scratch/r10-shadow/bench-f4.mjs',
        sha256: sha256File(path.resolve(process.argv[1])),
      },
      protocol: { path: 'lane6-scratch/r9/protocol.mjs', sha256: protocolSha },
      fixtureSource: { path: '__tests__/helpers/shadowCards.js', sha256: fixtureSha },
      policy: { path: 'lane6-scratch/r10-shadow/F4_POLICY.json', sha256: policySha },
    },
    bundle: { path: BUNDLE_REL, sha256: bundleSha, bytes: bundleBytes.length },
  }),
  method: 'hosted-only fresh-page AB/BA crossover; micro-interleaved arms; Latin-rotated observation blocks across six physical layouts; baseline-state A/A and candidate-state B/B nulls; index-block bootstrap of symmetric paired log ratios; raw samples retained; no outlier deletion; arm byte parity reported as a diagnostic of the ceiling spike, not as a gate',
  global: {
    controlsPass: Object.values(fixtures).every((fx) => fx.controlsPass),
    stabilityPass: Object.values(fixtures).every((fx) => fx.stabilityPass),
    noOpPass: POLICY.noopFixtures.every((name) => fixtures[name].noOpEquivalent),
    anySpikeByteSafe: Object.values(fixtures).some((fx) => fx.spikeByteSafe),
  },
  fixtures,
  layouts,
}

const outDir = path.join(LANE, 'results')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, OUT_NAME)
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

console.log(LABEL + ' ' + ENGINE + ' ' + actualVersion + ' r' + REPLICATE + ' N=' + N + ' batch=' + BATCH
  + ' bundle=' + bundleSha.slice(0, 12))
console.log('base=' + JSON.stringify(BASE_OPTIONS))
console.log('opt=' + JSON.stringify(OPT_OPTIONS))
for (const [name, fx] of Object.entries(fixtures)) {
  console.log(
    name.padEnd(26)
    + ' effect=' + fx.effect.pct.toFixed(2) + '% CI[' + fx.effect.ci95.map((v) => v.toFixed(2)).join(', ') + ']'
    + ' base-null=[' + fx.baseNull.ci95.map((v) => v.toFixed(2)).join(', ') + ']'
    + ' opt-null=[' + fx.optNull.ci95.map((v) => v.toFixed(2)).join(', ') + ']'
    + ' pairLogSD=' + fx.maxPairLogSd.toFixed(3)
    + ' byteSafe=' + (fx.spikeByteSafe ? 'yes' : 'NO')
    + ' clears>=' + gates.minEffectPct + '%:' + (fx.clearsMinEffect ? 'yes' : 'no')
    + ' reaches:' + (fx.reachesMinEffect ? 'yes' : 'no')
  )
}
console.log('artifact ' + path.relative(ROOT, outPath).replaceAll('\\', '/'))