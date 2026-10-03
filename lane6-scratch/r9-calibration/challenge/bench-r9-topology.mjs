#!/usr/bin/env node
/**
 * R9 hosted TOPOLOGY CHALLENGE harness.
 *
 * EXPERIMENTAL. This file produces evidence about the measuring instrument. It is not a benchmark
 * of snapDOM, it cannot produce a performance claim, and it merges nothing.
 *
 * It runs six preregistered lanes, SEQUENTIALLY, inside one hosted Chromium runner, on three focus
 * fixtures, and emits raw per-call rows for every timed call. The reason for the verbosity is the
 * ledger's section 5: `bench-r9-controlled.mjs` discards per-call rows and returns only batch
 * means, which is why the first calibration could not tell a page-differential systematic from
 * sampling noise. Everything the corrected 8-runner run left unrecoverable is recoverable here.
 *
 * THE SIX LANES
 *
 *   current6          the shipped six-page rig, exact existing semantics
 *   blocked6          blocked-within-page AB/BA on 3 layouts x 2 pages
 *   identityCanary    both slots on ONE module URL / one physical module record
 *   current6Reversed  the shipped rig with the ONE canonical layout list fully reversed
 *   treatmentCurrent  positive control + its own null, crossover topology, two predeclared doses
 *   treatmentBlocked  the same two doses, blocked topology
 *
 * EQUAL COST IS ENFORCED, NOT ASSUMED
 *
 * Every lane's declared budget comes from `algebra/call-budget.mjs`, and after acquisition the
 * harness counts the timed calls that actually executed and REFUSES to write a report unless they
 * match, per lane and on every preregistered compared pair. A topology that quietly spends more
 * work fails the run rather than winning it.
 *
 * ONE CANONICAL ORDER
 *
 * `laneLayoutOrder(lane)` returns the single list that feeds page creation, warm order and the
 * Latin rotation base together. `current6Reversed` is that list reversed; there is no second list
 * and no per-knob ordering override anywhere in this file.
 *
 * POSITIVE CONTROL
 *
 * A fixed-iteration xorshift stream runs inside the timed region, AFTER the identical toRaw call
 * has returned, on the candidate arm only. It is keyed to the arm, not to a position, so no
 * position-balancing schedule can cancel it by construction. Two work counts a fixed 4x apart are
 * preregistered; neither is a calibrated millisecond figure. `captureMs` is recorded separately on
 * every call, which is what proves the injection did not perturb snapDOM's own work.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../../atlas/profiler/fixtures.mjs'
import {
  arg,
  numberArg,
  sha256File,
  assertHostedBrowser,
  stats,
  crossoverEffect,
  hostedProvenance,
  stableJson,
  sha256Text,
} from '../../r9/protocol.mjs'
import {
  LANES,
  LANE_NAMES,
  DOSES,
  armsForLane,
  budgetPairReport,
  injectedArmsFor,
  laneBudget,
  laneExecutionOrder,
  laneLayoutOrder,
  lanePages,
  totalTimedCalls,
} from './algebra/call-budget.mjs'

// The hosted-only refusal must be the FIRST thing that can fail. A static `import 'playwright'` is
// hoisted above every statement, so a local invocation would report a module-resolution error
// instead of the protocol refusal, and "I could not find Playwright" is a much weaker answer than
// "this benchmark is GitHub-Actions-only on purpose". The import is therefore dynamic, immediately
// after the guard.
assertHostedBrowser()
const { chromium } = await import('playwright')

const ROOT = process.cwd()
const CHAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge')
const POLICY_PATH = path.join(CHAL, 'POLICY.json')
const OUT_DIR = path.resolve(ROOT, 'lane6-scratch/r9/results')

const REPLICATE = Math.floor(numberArg('replicate', 0))
const PROFILE_NAME = arg('profile', 'primary')
const BROWSER = String(arg('browser', POLICY_BROWSER())).toLowerCase()
const BOOT = Math.max(1000, Math.floor(numberArg('bootstrap', 12000)))
const BASE_SEED = Math.floor(numberArg('seed', POLICY_BASE_SEED()))
const EXPECTED_PLAYWRIGHT = arg('playwright-version', '1.55.1')
const LABEL = arg('label', 'R9 hosted topology challenge')
const BUNDLE_REL = arg('bundle', 'lane6-scratch/r9-calibration/bundle/candidate.mjs')
const OUT_NAME = arg('out', `topology-${BROWSER}-r${REPLICATE}.json`)

function readPolicy() {
  if (!fs.existsSync(POLICY_PATH)) throw new Error(`challenge policy missing: ${POLICY_PATH}`)
  return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
}
function POLICY_BROWSER() { return readPolicy().browser }
function POLICY_BASE_SEED() { return readPolicy().baseSeed }

const POLICY = readPolicy()
const SEED = (BASE_SEED + REPLICATE * 104729) >>> 0

if (POLICY.schema !== 'snapdom-r9-hosted-topology-challenge-v1') throw new Error('policy schema mismatch')
if (BROWSER !== POLICY.browser) throw new Error(`this challenge is ${POLICY.browser}-only, got ${BROWSER}`)
const PROFILE = POLICY.sampling[PROFILE_NAME]
if (!PROFILE) throw new Error(`unknown sampling profile: ${PROFILE_NAME} (have ${Object.keys(POLICY.sampling).join(', ')})`)
if (!POLICY.lanes.every((l) => LANES[l])) throw new Error('policy declares a lane the algebra does not define')
if (!POLICY.lanes.every((l) => LANE_NAMES.includes(l))) throw new Error('policy is missing a preregistered lane')

const BUNDLE_ABS = path.resolve(ROOT, BUNDLE_REL)
if (!fs.existsSync(BUNDLE_ABS)) throw new Error(`compiled bundle missing: ${BUNDLE_ABS}`)
const BUNDLE_BYTES = fs.readFileSync(BUNDLE_ABS)

// Every lane in this challenge is a self-null: the same compiled bundle and the same options on
// both arms. A non-zero result is measurement bias, never a snapDOM effect. The arms are LABELLED
// base/opt so that the positive control has an arm identity to attach to, but the bytes and the
// options they resolve to are identical.
const BASE = { ...FIXTURE_OPTIONS }
const OPT = { ...FIXTURE_OPTIONS }
const optionsForArm = (arm) => (arm === 'opt' ? OPT : BASE)

const FIXTURES = POLICY.fixtures.map((name) => ({ name }))
const DOSE_ITERATIONS = Object.fromEntries(POLICY.positiveControl.doses.map((d) => [d.name, d.iterations]))
const DOSE_OF_LAYOUT = (layout) => {
  const lower = layout.toLowerCase()
  return DOSES.find((d) => lower.includes(d)) ?? null
}

const CALL_COLUMNS = Object.freeze([
  'block', 'page', 'slot', 'position', 'seq', 'injected', 'ms', 'captureMs', 'injectMs',
])

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script>
<script type="module">
const CALL_COLUMNS = ${JSON.stringify(CALL_COLUMNS)}
window.__columns = CALL_COLUMNS
const r3 = (x) => Math.round(x * 1000) / 1000
window.__bench = {
  async init(cfg) {
    this.mode = cfg.mode
    this.inject = cfg.inject
    this.iterations = cfg.iterations
    this.state = cfg.state >>> 0 || 2463534242
    this.mods = { slot1: await import(cfg.u1), slot2: await import(cfg.u2) }
    this.opts = { slot1: cfg.o1, slot2: cfg.o2 }
    this.calls = []
  },
  // Deterministic synthetic work. Fixed iteration count, fixed seed, result published to a page
  // global so the engine cannot elide it. Keyed to the ARM, never to a position.
  injectWork() {
    let x = this.state
    let acc = 0
    for (let i = 0; i < this.iterations; i++) {
      x ^= x << 13; x >>>= 0
      x ^= x >>> 17
      x ^= x << 5; x >>>= 0
      acc += x
      if (acc >= 4294967296) acc -= 4294967296
    }
    this.state = x
    window.__injectSink = acc
    return acc
  },
  async one(slot, fixture, block, page, position, timed) {
    const armed = this.inject[slot]
    const el = window.__fx.build(fixture)
    try {
      const t0 = performance.now()
      const raw = await this.mods[slot === 0 ? 'slot1' : 'slot2'].snapdom.toRaw(el, this.opts[slot])
      const t1 = performance.now()
      if (armed) this.injectWork()
      const t2 = performance.now()
      if (timed) {
        this.calls.push([block, page, slot, position, this.calls.length, armed ? 1 : 0,
          r3(t2 - t0), r3(t1 - t0), r3(t2 - t1)])
      }
      return { ms: t2 - t0, raw }
    } finally {
      window.__fx.cleanup(el)
    }
  },
  async warm(fixture, n) {
    for (let i = 0; i < n; i++) {
      const order = i & 1 ? [1, 0] : [0, 1]
      for (const slot of order) await this.one(slot, fixture, -1, -1, order[0] === slot ? 0 : 1, false)
    }
  },
  async oracle(fixture) {
    const a = await this.one(0, fixture, -1, -1, 0, false)
    const b = await this.one(1, fixture, -1, -1, 1, false)
    return { parity: a.raw === b.raw, aBytes: a.raw.length, bBytes: b.raw.length }
  },
  // One observation block on one physical page. Both schedules spend exactly 2*batch timed calls.
  async block(fixture, index, batch, page, roundPos, seed) {
    const start = this.calls.length
    if (this.mode === 'current') {
      for (let b = 0; b < batch; b++) {
        const order = (index + b) & 1 ? [1, 0] : [0, 1]
        for (const slot of order) await this.one(slot, fixture, index, page, order[0] === slot ? 0 : 1, true)
      }
    } else {
      let st = (seed + index * 104729 + page * 7919) >>> 0
      const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296 }
      for (let k = 0; k < batch / 2; k++) {
        const lead = rnd() < 0.5 ? 0 : 1
        for (const order of [[lead, 1 - lead], [1 - lead, lead]]) {
          for (const slot of order) await this.one(slot, fixture, index, page, order[0] === slot ? 0 : 1, true)
        }
      }
    }
    const rows = this.calls.slice(start)
    let s0 = 0, n0 = 0, s1 = 0, n1 = 0, cap = 0, injSum = 0, injN = 0, ctlMax = 0
    for (const row of rows) {
      if (row[2] === 0) { s0 += row[6]; n0++ } else { s1 += row[6]; n1++ }
      cap += row[7]
      if (row[5]) { injSum += row[8]; injN++ } else if (row[8] > ctlMax) ctlMax = row[8]
    }
    let heap = null
    try { heap = performance.memory ? performance.memory.usedJSHeapSize : null } catch {}
    return {
      nCalls: rows.length,
      slot1: r3(s0 / n0),
      slot2: r3(s1 / n1),
      logRatio: Math.log((s1 / n1) / (s0 / n0)),
      heapUsedJsHeapSize: heap,
      meanCaptureMs: r3(cap / rows.length),
      injectedCalls: injN,
      meanInjectMs: injN ? r3(injSum / injN) : 0,
      maxControlInjectMs: r3(ctlMax),
    }
  },
  calls: [],
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
  if (url.pathname === '/cand.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(BUNDLE_BYTES)
    return
  }
  res.writeHead(404)
  res.end('nf')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--disable-extensions'],
})
const actualBrowserName = browser.browserType().name()
const actualBrowserVersion = browser.version()
if (actualBrowserName !== BROWSER) throw new Error(`engine identity mismatch: ${actualBrowserName}`)

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
if (playwrightVersion !== EXPECTED_PLAYWRIGHT) throw new Error(`Playwright version mismatch: ${playwrightVersion}`)

// Fixed-width, layout-independent URL tags. Two arms never differ in the SHAPE, LENGTH or SPELLING
// of the identity they are fetched under, so nothing about the request itself can be correlated with
// the arm. In the canary both slots resolve to the byte-identical string, which is what makes them
// one module record rather than two records of identical bytes.
const laneTag = (lane) => lane.padEnd(18, '-')
const moduleUrl = (lane, creationIndex, pageSlot, slot) => {
  if (LANES[lane].identityCanary) return `${origin}/cand.mjs?tc${laneTag(lane)}${String(pageSlot).padStart(2, '0')}`
  return `${origin}/cand.mjs?tc${laneTag(lane)}${String(creationIndex).padStart(2, '0')}${String(pageSlot).padStart(2, '0')}${slot}`
}

async function openPage(lane, fixture, entry) {
  const spec = LANES[lane]
  const layout = entry.layout
  const arms = armsForLane(lane, layout)
  const inject = injectedArmsFor(layout)
  const dose = DOSE_OF_LAYOUT(layout)
  const iterations = inject.some(Boolean) ? DOSE_ITERATIONS[dose] : 0
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => console.error(`[${lane}/${layout}#${entry.pageSlot}] PAGE ERROR`, error.message))
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
    await page.evaluate((cfg) => window.__bench.init(cfg), {
      mode: spec.topology,
      u1: moduleUrl(lane, entry.creationIndex, entry.pageSlot, 1),
      u2: moduleUrl(lane, entry.creationIndex, entry.pageSlot, 2),
      o1: optionsForArm(arms[0]),
      o2: optionsForArm(arms[1]),
      inject,
      iterations,
      state: (SEED ^ (entry.creationIndex * 2654435761)) >>> 0,
    })
    return page
  } catch (error) {
    await page.close()
    throw error
  }
}

function groupPageRows(pageRows) {
  const byLayout = new Map()
  for (const row of pageRows) {
    if (!byLayout.has(row.layout)) byLayout.set(row.layout, [])
    byLayout.get(row.layout).push(row)
  }
  return byLayout
}

function blockedBlockSeries(pageRows, layout, blocks) {
  const rows = pageRows.filter((r) => r.layout === layout)
  const series = Array.from({ length: blocks }, () => [])
  for (const row of rows) series[row.block].push(row.logRatio)
  return series.map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length)
}

function blockedCell(series, seed) {
  const logPoint = series.reduce((a, b) => a + b, 0) / series.length
  let state = seed >>> 0
  const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296 }
  const draws = new Array(BOOT)
  for (let i = 0; i < BOOT; i++) {
    let total = 0
    for (let j = 0; j < series.length; j++) total += series[(rnd() * series.length) | 0]
    draws[i] = total / series.length
  }
  draws.sort((a, b) => a - b)
  const pct = (x) => (Math.exp(x) - 1) * 100
  return {
    logPoint,
    pct: pct(logPoint),
    ci95: [pct(draws[Math.floor(BOOT * 0.025)]), pct(draws[Math.floor(BOOT * 0.975)])],
    logRatios: { blocks: series.slice() },
  }
}

const cap = (s) => s[0].toUpperCase() + s.slice(1)

function evaluateCells(lane, pageRows, fixtureIndex) {
  const spec = LANES[lane]
  const blocks = PROFILE.blocks[lane]
  const byLayout = groupPageRows(pageRows)
  const rowsOf = (layout) => byLayout.get(layout).map((r) => ({ slot1: r.slot1, slot2: r.slot2 }))
  const seed = (k) => (SEED + fixtureIndex * 17 + k) >>> 0
  if (spec.role === 'canary') {
    return {
      role: spec.role,
      treatmentSensitive: false,
      cells: { canary: crossoverEffect(rowsOf('effectForward'), rowsOf('effectReverse'), seed(1), BOOT) },
    }
  }
  if (spec.role === 'null-triplet') {
    if (spec.topology === 'current') {
      return {
        role: spec.role,
        treatmentSensitive: true,
        cells: {
          candidate: crossoverEffect(rowsOf('effectForward'), rowsOf('effectReverse'), seed(1), BOOT),
          baseNull: crossoverEffect(rowsOf('baseNullForward'), rowsOf('baseNullReverse'), seed(3), BOOT),
          optNull: crossoverEffect(rowsOf('optNullForward'), rowsOf('optNullReverse'), seed(5), BOOT),
        },
      }
    }
    return {
      role: spec.role,
      treatmentSensitive: true,
      cells: {
        effect: blockedCell(blockedBlockSeries(pageRows, 'effect', blocks), seed(1)),
        baseNull: blockedCell(blockedBlockSeries(pageRows, 'baseNull', blocks), seed(3)),
        optNull: blockedCell(blockedBlockSeries(pageRows, 'optNull', blocks), seed(5)),
      },
    }
  }
  const doses = {}
  DOSES.forEach((dose, i) => {
    const D = cap(dose)
    const treatment = spec.topology === 'current'
      ? crossoverEffect(rowsOf(`treatment${D}Forward`), rowsOf(`treatment${D}Reverse`), seed(11 + i * 2), BOOT)
      : blockedCell(blockedBlockSeries(pageRows, `treatment${D}`, blocks), seed(11 + i * 2))
    const treatmentNull = spec.topology === 'current'
      ? crossoverEffect(rowsOf(`treatmentNull${D}Forward`), rowsOf(`treatmentNull${D}Reverse`), seed(13 + i * 2), BOOT)
      : blockedCell(blockedBlockSeries(pageRows, `treatmentNull${D}`, blocks), seed(13 + i * 2))
    doses[dose] = {
      iterations: DOSE_ITERATIONS[dose],
      treatment,
      treatmentNull,
      recovery: {
        logPoint: treatment.logPoint - treatmentNull.logPoint,
        pct: (Math.exp(treatment.logPoint - treatmentNull.logPoint) - 1) * 100,
      },
    }
  })
  return { role: spec.role, treatmentSensitive: true, doses }
}

/**
 * Per-call rows -> the diagnostics the ledger's section 6 says are missing or wrong today.
 *
 * `positionPremiumLog` is the position-conditional cost the corrected run could not recover, and it
 * is the direct size estimate of the section 4 term. `injectedArmMsMean` /
 * `controlArmInjectMsMax` prove the positive control landed on one arm and only one arm.
 * `captureMsArmDeltaMs` proves the injection did not perturb snapDOM's own work.
 */
function callDiagnostics(callRows, columns) {
  const ix = Object.fromEntries(columns.map((c, i) => [c, i]))
  const arms = { injected: [], control: [] }
  const byPosition = [[], []]
  const byArm = [[], []]
  for (const row of callRows) {
    const injected = row[ix.injected] === 1
    const pos = row[ix.position]
    const slot = row[ix.slot]
    byPosition[pos].push(Math.log(row[ix.ms]))
    byArm[slot].push(row[ix.captureMs])
    if (injected) arms.injected.push(row[ix.injectMs])
    else arms.control.push(row[ix.injectMs])
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const firstMean = byPosition[0].length ? mean(byPosition[0]) : 0
  const secondMean = byPosition[1].length ? mean(byPosition[1]) : 0
  return {
    timedCalls: callRows.length,
    positionPremiumLog: firstMean - secondMean,
    positionPremiumPct: (Math.exp(firstMean - secondMean) - 1) * 100,
    positionLogSd: byPosition.map((xs) => (xs.length > 1 ? Math.sqrt(
      xs.reduce((a, b) => a + (b - mean(xs)) ** 2, 0) / (xs.length - 1)) : 0)),
    captureMsArmMean: byArm.map(mean),
    captureMsArmDeltaMs: mean(byArm[1]) - mean(byArm[0]),
    injectedArmMsMean: mean(arms.injected),
    injectedCalls: arms.injected.length,
    controlArmInjectMsMax: arms.control.length ? Math.max(...arms.control) : 0,
  }
}

async function runLane(lane, fixture, fixtureIndex) {
  const spec = LANES[lane]
  const declared = laneBudget(lane, PROFILE)
  // THE one canonical list. Page creation, warm order and the rotation base all read from it.
  const order = laneLayoutOrder(lane)
  const entries = []
  for (const layout of order) {
    for (let pageSlot = 0; pageSlot < spec.pagesPerLayout; pageSlot++) {
      entries.push({ layout, pageSlot, layoutIndex: order.indexOf(layout), creationIndex: entries.length })
    }
  }
  const t0 = Date.now()
  try {
    for (const entry of entries) {
      entry.handle = await openPage(lane, fixture, entry)
      entry.moduleUrls = [moduleUrl(lane, entry.creationIndex, entry.pageSlot, 1),
        moduleUrl(lane, entry.creationIndex, entry.pageSlot, 2)]
      entry.physicalIdentityShared = entry.moduleUrls[0] === entry.moduleUrls[1]
    }
    const createdAtMs = Date.now() - t0
    // Warm and oracle in the SAME canonical order, so warmIndex is a function of the one list.
    for (const entry of entries) {
      entry.warmIndex = entries.indexOf(entry)
      if (PROFILE.warmup) {
        await entry.handle.evaluate(({ f, w }) => window.__bench.warm(f, w), { f: fixture, w: PROFILE.warmup })
      }
      entry.warmedAtMs = Date.now() - t0
      entry.oracle = await entry.handle.evaluate((f) => window.__bench.oracle(f), fixture)
      entry.warmToFirstSampleGapMs = null
    }

    const pageRows = []
    const sampledOnce = new Set()
    const acquireStart = Date.now()
    for (let i = 0; i < declared.blocks; i++) {
      const shift = i % order.length
      const rotated = order.slice(shift).concat(order.slice(0, shift))
      const schedule = []
      for (const layout of rotated) {
        for (const entry of entries) if (entry.layout === layout) schedule.push(entry)
      }
      for (let oi = 0; oi < schedule.length; oi++) {
        const entry = schedule[oi]
        const res = await entry.handle.evaluate(
          ({ f, i: index, b, p, pos, seed }) => window.__bench.block(f, index, b, p, pos, seed),
          { f: fixture, i, b: declared.batch, p: entry.creationIndex, pos: oi, seed: SEED },
        )
        if (!sampledOnce.has(entry.creationIndex)) {
          sampledOnce.add(entry.creationIndex)
          entry.warmToFirstSampleGapMs = Date.now() - entry.warmedAtMs
        }
        pageRows.push({
          layout: entry.layout,
          page: entry.creationIndex,
          pageSlot: entry.pageSlot,
          block: i,
          roundPos: oi,
          ...res,
        })
      }
    }
    const acquireMs = Date.now() - acquireStart

    const calls = []
    for (const entry of entries) {
      const rows = await entry.handle.evaluate(() => window.__bench.calls)
      for (const row of rows) calls.push([row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8]])
    }
    const diagnostics = callDiagnostics(calls, CALL_COLUMNS)
    if (diagnostics.timedCalls !== declared.timedCalls) {
      throw new Error(
        `${lane}/${fixture}: executed ${diagnostics.timedCalls} timed calls, budget declares ${declared.timedCalls}`,
      )
    }
    const maxAbsBlockLogRatio = Math.max(...pageRows.map((r) => Math.abs(r.logRatio)))
    const meanCapture = stats(pageRows.map((r) => r.meanCaptureMs))
    return {
      lane,
      topology: spec.topology,
      role: spec.role,
      treatmentSensitive: spec.treatmentSensitive,
      reversed: spec.reversed,
      identityCanary: spec.identityCanary,
      canonicalOrder: order,
      declared,
      executedTimedCalls: diagnostics.timedCalls,
      pages: entries.map((e) => ({
        layout: e.layout,
        page: e.creationIndex,
        pageSlot: e.pageSlot,
        creationIndex: e.creationIndex,
        warmIndex: e.warmIndex,
        moduleUrls: e.moduleUrls,
        physicalIdentityShared: e.physicalIdentityShared,
        oracle: e.oracle,
        warmedAtMs: e.warmedAtMs,
        warmToFirstSampleGapMs: e.warmToFirstSampleGapMs,
      })),
      pageRows,
      calls: { columns: CALL_COLUMNS, rows: calls },
      diagnostics,
      maxAbsBlockLogRatio,
      meanCaptureMs: meanCapture,
      wallClockMs: Date.now() - t0,
      createdMs: createdAtMs,
      acquireMs,
    }
  } finally {
    await Promise.all(entries.map((e) => e.handle?.close().catch(() => {})))
  }
}

const laneOrder = laneExecutionOrder(POLICY.lanes, REPLICATE)
const totals = totalTimedCalls(PROFILE, FIXTURES.length)
const report = {
  schema: 'snapdom-r9-hosted-topology-challenge-v1',
  experimental: true,
  promotable: false,
  performanceClaim: false,
  generatedAt: new Date().toISOString(),
  label: LABEL,
  profile: PROFILE_NAME,
  replicate: REPLICATE,
  seed: SEED,
  laneOrder,
  fixtures: FIXTURES.map((f) => f.name),
  provenance: hostedProvenance({
    protocol: {
      mode: POLICY.mode,
      profile: PROFILE_NAME,
      replicate: REPLICATE,
      seed: SEED,
      lanes: POLICY.lanes,
      laneOrder,
      bootstrap: BOOT,
      sampling: PROFILE,
      positiveControl: POLICY.positiveControl,
      budgetPairs: budgetPairReport(PROFILE),
      callColumns: CALL_COLUMNS,
      fixtureNames: FIXTURES.map((f) => f.name),
      fixtureManifestSha256: sha256Text(stableJson(FIXTURES)),
      policySha256: sha256File(POLICY_PATH),
    },
    browser: {
      requested: BROWSER,
      actualName: actualBrowserName,
      actualVersion: actualBrowserVersion,
      playwrightVersion,
    },
    code: {
      harness: {
        path: 'lane6-scratch/r9-calibration/challenge/bench-r9-topology.mjs',
        sha256: sha256File(path.resolve(process.argv[1])),
      },
      protocol: { path: 'lane6-scratch/r9/protocol.mjs', sha256: sha256File(path.resolve(ROOT, 'lane6-scratch/r9/protocol.mjs')) },
      fixtureSource: {
        path: 'lane6-scratch/atlas/profiler/fixtures.mjs',
        sha256: sha256File(path.resolve(ROOT, 'lane6-scratch/atlas/profiler/fixtures.mjs')),
      },
      laneAlgebra: {
        path: 'lane6-scratch/r9-calibration/challenge/algebra/call-budget.mjs',
        sha256: sha256File(path.join(CHAL, 'algebra/call-budget.mjs')),
      },
      manifestSha256: process.env.SNAPDOM_BENCH_MANIFEST_SHA256 || null,
    },
    git: {
      candidateSha: process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null,
    },
    bundle: { path: BUNDLE_REL, sha256: sha256File(BUNDLE_ABS), bytes: BUNDLE_BYTES.length },
    budget: {
      perLane: Object.fromEntries(POLICY.lanes.map((l) => [l, laneBudget(l, PROFILE)])),
      pages: Object.fromEntries(POLICY.lanes.map((l) => [l, lanePages(l)])),
      timedCallsPerFixture: totals.perFixture,
      timedCallsTotal: totals.total,
      equalBudgetPairs: budgetPairReport(PROFILE),
    },
  }),
  budget: {
    perLane: Object.fromEntries(POLICY.lanes.map((l) => [l, laneBudget(l, PROFILE)])),
    equalBudgetPairs: budgetPairReport(PROFILE),
    timedCallsPerFixture: totals.perFixture,
    timedCallsTotal: totals.total,
  },
  runner: {},
  fixtureResults: {},
}

try {
  for (let f = 0; f < FIXTURES.length; f++) {
    const fixture = FIXTURES[f].name
    report.fixtureResults[fixture] = { lanes: {} }
    for (const lane of laneOrder) {
      const result = await runLane(lane, fixture, f)
      result.cells = evaluateCells(lane, result.pageRows, f)
      report.fixtureResults[fixture].lanes[lane] = result
      const cells = result.cells.cells
        ? Object.entries(result.cells.cells).map(([k, v]) => `${k}=${v.pct.toFixed(2)}%`).join(' ')
        : Object.entries(result.cells.doses).map(([k, v]) => `${k}=${v.recovery.pct.toFixed(2)}%`).join(' ')
      console.log(
        `[${PROFILE_NAME} r${REPLICATE}] ${fixture} ${lane} calls=${result.executedTimedCalls} ` +
        `posPremium=${result.diagnostics.positionPremiumPct.toFixed(2)}% ${cells}`,
      )
    }
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

// Fail closed on the equal-cost claim, on the real artifact, after the fact.
const executedByLane = {}
for (const fixture of report.fixtures) {
  for (const lane of POLICY.lanes) {
    executedByLane[lane] = report.fixtureResults[fixture].lanes[lane].executedTimedCalls
  }
}
report.runner = {
  executedTimedCallsPerLane: executedByLane,
  executedTimedCallsPerFixture: totals.perFixture,
  executedTimedCallsTotal: totals.total,
  equalBudgetPairsVerified: budgetPairReport(PROFILE).map((r) => ({
    pair: r.pair,
    executed: r.pair.map((l) => executedByLane[l]),
    equal: executedByLane[r.pair[0]] === executedByLane[r.pair[1]],
  })),
  wallClockMs: Object.fromEntries(Object.keys(report.fixtureResults).map((fixture) => [
    fixture,
    {
      total: POLICY.lanes.reduce((a, l) => a + report.fixtureResults[fixture].lanes[l].wallClockMs, 0),
      perLane: Object.fromEntries(POLICY.lanes.map((l) => [l, report.fixtureResults[fixture].lanes[l].wallClockMs])),
    },
  ])),
}
const violations = report.runner.equalBudgetPairsVerified.filter((r) => !r.equal)
if (violations.length) {
  throw new Error(`equal-cost claim violated on the executed artifact: ${JSON.stringify(violations)}`)
}
for (const fixture of report.fixtures) {
  for (const lane of POLICY.lanes) {
    const lanes = report.fixtureResults[fixture].lanes
    for (const meta of lanes[lane].pages) {
      if (!meta.oracle?.parity) throw new Error(`${fixture}/${lane}: raw parity failed on ${meta.layout}#${meta.page}`)
    }
    if (LANES[lane].identityCanary && lanes[lane].pages.some((p) => !p.physicalIdentityShared)) {
      throw new Error(`${fixture}/${lane}: identity canary page did not share one module URL across both slots`)
    }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const outPath = path.join(OUT_DIR, OUT_NAME)
fs.writeFileSync(outPath, JSON.stringify(report))
console.log(`[challenge] ${LABEL} ${BROWSER} ${actualBrowserVersion} profile=${PROFILE_NAME} replicate=${REPLICATE}`)
console.log(`[challenge] equal timed calls verified on ${report.runner.equalBudgetPairsVerified.length} compared pairs`)
console.log(`[challenge] artifact ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`)
