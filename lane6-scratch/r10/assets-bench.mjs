#!/usr/bin/env node
/**
 * R10 AS-BLOB hosted experiment.
 *
 * Timing and memory are deliberately separate:
 *  - timing: baseline and candidate pages share one Chromium process and are crossed AB/BA;
 *  - memory: each side gets a fresh Chromium BrowserServer and Linux process-tree VmRSS.
 *
 * This script is GitHub-Actions-only. It produces one runner-level point per condition; raw browser
 * samples stay in the artifact and are never pooled across VMs by asset-aggregate.mjs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  dataUrlCharsForBytes,
  geometrySweep,
  makeDeterministicPng,
  mean,
  pairOrder,
  settleProcessTreeRss,
  sha256,
} from './asset-bench-lib.mjs'
import { MAX_IMAGE_BLOB_BYTES, WORKER_MIN_PAYLOAD_CHARS } from '../../src/core/cache.js'

const ROOT = process.cwd()
const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '='
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.error('R10 asset benchmark is GitHub-Actions-only')
  process.exit(1)
}
if (process.platform !== 'linux' || !fs.existsSync('/proc/self/status')) {
  console.error('R10 asset benchmark requires Linux /proc for authoritative process-tree VmRSS')
  process.exit(1)
}

const PREPARED = path.resolve(ROOT, arg('prepared', 'lane6-scratch/r10/prepared.json'))
const REPLICATE = Number(arg('replicate', '0'))
const OUT = path.resolve(ROOT, arg('out', 'lane6-scratch/r10/results/runner-r' + REPLICATE + '.json'))
const REPEATS = Number(arg('repeats', '8'))
const WARMUP = 2

if (!Number.isInteger(REPLICATE) || REPLICATE < 0) throw new Error('replicate must be a nonnegative integer')
if (!Number.isInteger(REPEATS) || REPEATS < 4 || (REPEATS & 1)) {
  throw new Error('repeats must be an even integer >= 4 so every runner is internally AB/BA balanced')
}
if (!fs.existsSync(PREPARED)) throw new Error('prepared.json missing')

const prepared = JSON.parse(fs.readFileSync(PREPARED, 'utf8'))
if (prepared.schema !== 'snapdom-r10-asblob-prepared-v1') throw new Error('prepared schema mismatch')

const baselinePath = path.resolve(ROOT, prepared.baseline.path)
const candidatePath = path.resolve(ROOT, prepared.candidate.path)
if (sha256(fs.readFileSync(baselinePath)) !== prepared.baseline.sha256) throw new Error('baseline bundle digest mismatch')
if (sha256(fs.readFileSync(candidatePath)) !== prepared.candidate.sha256) throw new Error('candidate bundle digest mismatch')

for (const [rel, expected] of Object.entries(prepared.measurementFiles || {})) {
  const observed = sha256(fs.readFileSync(path.resolve(ROOT, rel)))
  if (observed !== expected) throw new Error('measurement file digest mismatch: ' + rel)
}
if (prepared.mechanism.workerMinPayloadChars !== WORKER_MIN_PAYLOAD_CHARS) throw new Error('worker threshold drifted after prepare')
if (prepared.mechanism.maxImageBlobBytes !== MAX_IMAGE_BLOB_BYTES) throw new Error('retention cap drifted after prepare')

const measurementEnv = process.env.SNAPDOM_MEASUREMENT_GIT_SHA || process.env.GITHUB_SHA || ''
const candidateEnv = process.env.SNAPDOM_CANDIDATE_GIT_SHA || ''
const baselineEnv = process.env.SNAPDOM_BASELINE_GIT_SHA || prepared.baselineGitSha
if (measurementEnv !== prepared.measurementGitSha) throw new Error('measurement git SHA mismatch')
if (candidateEnv !== prepared.candidateGitSha) throw new Error('candidate git SHA mismatch')
if (baselineEnv !== prepared.baselineGitSha) throw new Error('baseline git SHA mismatch')

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
if (playwrightVersion !== prepared.playwrightVersion) throw new Error('Playwright version mismatch')
const { chromium } = await import('playwright')

const fixtures = {
  large: {
    name: 'large',
    width: 1200,
    height: 800,
    cssWidth: 300,
    cssHeight: 200,
    bytes: makeDeterministicPng(1200, 800, { seed: 0x51a7, entropy: true }),
  },
  small: {
    name: 'small',
    width: 96,
    height: 96,
    cssWidth: 32,
    cssHeight: 32,
    bytes: makeDeterministicPng(96, 96, { seed: 0x51a7, entropy: false }),
  },
}
for (const fixture of Object.values(fixtures)) {
  fixture.sha256 = sha256(fixture.bytes)
  fixture.dataUrlChars = dataUrlCharsForBytes(fixture.bytes.length)
}
if (fixtures.large.dataUrlChars <= WORKER_MIN_PAYLOAD_CHARS) throw new Error('large fixture does not clear worker threshold')
if (fixtures.small.dataUrlChars >= WORKER_MIN_PAYLOAD_CHARS) throw new Error('small fixture is not below worker threshold')

const CONDITIONS = [
  { id: 'large-same', fixture: 'large', csp: 'none', sweep: 'same', role: 'null-memo' },
  { id: 'large-scale', fixture: 'large', csp: 'none', sweep: 'scale', role: 'claim' },
  { id: 'large-dpr', fixture: 'large', csp: 'none', sweep: 'dpr', role: 'claim' },
  { id: 'small-scale', fixture: 'small', csp: 'none', sweep: 'scale', role: 'small-negative' },
  { id: 'large-csp', fixture: 'large', csp: 'worker-none', sweep: 'scale', role: 'worker-negative' },
].map((c) => ({ ...c, warm: { scale: 1, dpr: 1 }, samples: geometrySweep(c.sweep, REPEATS) }))

const CSP = {
  none: null,
  'worker-none': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; worker-src 'none'",
}

let origin = ''
function htmlFor(side, fixtureName, cspName) {
  const csp = CSP[cspName]
  const fixture = fixtures[fixtureName]
  const cspMeta = csp ? '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' : ''
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    cspMeta,
    '<link rel="stylesheet" href="/style.css?fixture=' + fixtureName + '">',
    '</head><body>',
    '<img id="asset" src="/' + fixtureName + '.png" width="' + fixture.width + '" height="' + fixture.height + '">',
    '<script type="module" src="/page.js?side=' + side + '"></script>',
    '</body></html>',
  ].join('')
}

function scriptFor(side) {
  const bundle = side === 'candidate' ? '/candidate.mjs' : '/baseline.mjs'
  return [
    "import { snapdom } from '" + bundle + "'",
    "window.__ready = false",
    "window.__routes = null",
    "const routeReader = { name: 'r10-route-reader', afterRender(context) {",
    "  window.__routes = context.__assetRoutes ? { ...context.__assetRoutes } : null",
    "} }",
    "window.__capture = async (opts) => {",
    "  window.__routes = null",
    "  const t0 = performance.now()",
    "  const result = await snapdom(document.getElementById('asset'), {",
    "    cache: 'soft', burst: false, compress: true, embedFonts: false, plugins: [routeReader], ...opts",
    "  })",
    "  const t1 = performance.now()",
    "  await result.toCanvas()",
    "  const t2 = performance.now()",
    "  return { captureMs: t1 - t0, renderMs: t2 - t1, totalMs: t2 - t0, routes: window.__routes }",
    "}",
    "document.getElementById('asset').decode().then(() => { window.__ready = true })",
  ].join('\n')
}

async function serve() {
  const baselineBytes = fs.readFileSync(baselinePath)
  const candidateBytes = fs.readFileSync(candidatePath)
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', origin || 'http://127.0.0.1')
    if (u.pathname === '/') {
      const side = u.searchParams.get('side')
      const fixture = u.searchParams.get('fixture')
      const csp = u.searchParams.get('csp') || 'none'
      if (!['baseline', 'candidate'].includes(side) || !fixtures[fixture] || !(csp in CSP)) {
        res.writeHead(400).end('bad page args')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(htmlFor(side, fixture, csp))
      return
    }
    if (u.pathname === '/page.js') {
      const side = u.searchParams.get('side')
      if (!['baseline', 'candidate'].includes(side)) {
        res.writeHead(400).end('bad side')
        return
      }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(scriptFor(side))
      return
    }
    if (u.pathname === '/style.css') {
      const fixture = fixtures[u.searchParams.get('fixture')]
      if (!fixture) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      res.end('html,body{margin:0;padding:0}#asset{display:block;width:' + fixture.cssWidth + 'px;height:' + fixture.cssHeight + 'px;object-fit:cover}')
      return
    }
    if (u.pathname === '/baseline.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(baselineBytes)
      return
    }
    if (u.pathname === '/candidate.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(candidateBytes)
      return
    }
    if (u.pathname === '/large.png' || u.pathname === '/small.png') {
      const fixture = u.pathname.includes('large') ? fixtures.large : fixtures.small
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(fixture.bytes.length),
        'cache-control': 'no-store',
      })
      res.end(fixture.bytes)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  return server
}

async function openPage(browser, side, condition) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const bootstrapErrors = []
  page.on('pageerror', (error) => bootstrapErrors.push('pageerror: ' + error.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') bootstrapErrors.push('console: ' + msg.text())
  })
  await page.goto(origin + '/?side=' + side + '&fixture=' + condition.fixture + '&csp=' + condition.csp)
  try {
    await page.waitForFunction(() => window.__ready === true)
  } catch (error) {
    await context.close().catch(() => {})
    throw new Error(
      condition.id + '/' + side + ': page bootstrap did not reach __ready; ' +
      (bootstrapErrors.length ? bootstrapErrors.join(' | ') : 'no page error was reported'),
      { cause: error },
    )
  }
  return { context, page }
}

async function capture(page, geometry) {
  return page.evaluate(
    (g) => window.__capture({ scale: g.scale, dpr: g.dpr }),
    geometry,
  )
}

function assertCandidateRoute(condition, routes, label) {
  if (!routes) throw new Error(label + ': candidate afterRender did not publish route counters')
  if (condition.role === 'null-memo') {
    if (!(routes.memo > 0) || routes.workerBlob !== 0 || routes.workerString !== 0) {
      throw new Error(label + ': same-geometry null did not terminate at memo: ' + JSON.stringify(routes))
    }
  } else if (condition.role === 'claim') {
    if (!(routes.workerBlob > 0) || routes.workerString !== 0) {
      throw new Error(label + ': claim arm did not execute Blob worker route: ' + JSON.stringify(routes))
    }
  } else if (condition.role === 'small-negative') {
    if (routes.workerBlob !== 0 || routes.workerString !== 0) {
      throw new Error(label + ': below-threshold fixture reached worker: ' + JSON.stringify(routes))
    }
  } else if (condition.role === 'worker-negative') {
    if (routes.workerBlob !== 0 || routes.workerString !== 0 || !(routes.main > 0)) {
      throw new Error(label + ': CSP worker-negative did not fall through to main: ' + JSON.stringify(routes))
    }
  }
}

async function warm(sidePage, geometry) {
  for (let i = 0; i < WARMUP; i++) await capture(sidePage.page, geometry)
}

async function timingCondition(browser, condition, conditionIndex) {
  const createOrder = pairOrder(REPLICATE, conditionIndex, 0)
  const sides = {}
  for (const side of createOrder) sides[side] = await openPage(browser, side, condition)
  try {
    for (const side of createOrder) await warm(sides[side], condition.warm)

    const pairs = []
    for (let i = 0; i < condition.samples.length; i++) {
      const geometry = condition.samples[i]
      const order = pairOrder(REPLICATE, conditionIndex, i)
      const observed = {}
      for (const side of order) observed[side] = await capture(sides[side].page, geometry)
      if (observed.baseline.routes !== null) {
        throw new Error(condition.id + ': baseline unexpectedly exposed candidate route counters')
      }
      assertCandidateRoute(condition, observed.candidate.routes, condition.id + ' timing sample ' + i)
      pairs.push({
        sample: i,
        order,
        geometry,
        baselineCaptureMs: observed.baseline.captureMs,
        candidateCaptureMs: observed.candidate.captureMs,
        baselineRenderMs: observed.baseline.renderMs,
        candidateRenderMs: observed.candidate.renderMs,
        baselineTotalMs: observed.baseline.totalMs,
        candidateTotalMs: observed.candidate.totalMs,
        logRatio: Math.log(observed.candidate.captureMs / observed.baseline.captureMs),
        totalLogRatio: Math.log(observed.candidate.totalMs / observed.baseline.totalMs),
        candidateRoutes: observed.candidate.routes,
      })
    }
    const logPoint = mean(pairs.map((x) => x.logRatio))
    const totalLogPoint = mean(pairs.map((x) => x.totalLogRatio))
    return {
      pairs,
      logPoint,
      pct: (Math.exp(logPoint) - 1) * 100,
      totalLogPoint,
      totalPct: (Math.exp(totalLogPoint) - 1) * 100,
      primary: 'capture',
    }
  } finally {
    await Promise.all(Object.values(sides).map((x) => x.context.close().catch(() => {})))
  }
}

async function memorySide(side, condition) {
  const server = await chromium.launchServer({ headless: true })
  const proc = server.process()
  if (!proc || !Number.isInteger(proc.pid)) {
    await server.close().catch(() => {})
    throw new Error('BrowserServer did not expose a Chromium root pid')
  }

  const browser = await chromium.connect(server.wsEndpoint())
  let sidePage
  try {
    sidePage = await openPage(browser, side, condition)

    // State 0: page + source image are loaded, but snapDOM has never captured. This is the only
    // baseline that can observe the memory AS-BLOB retains during the first warm capture.
    const initial = await settleProcessTreeRss(proc.pid)
    if (!initial.stable) throw new Error(condition.id + '/' + side + ': process-tree RSS did not settle before first capture')

    const warmRoutes = []
    for (let i = 0; i < WARMUP; i++) {
      const observed = await capture(sidePage.page, condition.warm)
      if (side === 'candidate') {
        if (!observed.routes) throw new Error(condition.id + ': candidate warmup did not publish route counters')
        warmRoutes.push(observed.routes)
      } else if (observed.routes !== null) {
        throw new Error(condition.id + ': baseline warmup exposed candidate route counters')
      }
    }

    // State 1: image cache and same-geometry compress memo are warm. Candidate Blob retention has
    // already happened here, so warmupDelta is the direct retained-memory signal.
    const warmed = await settleProcessTreeRss(proc.pid)
    if (!warmed.stable) throw new Error(condition.id + '/' + side + ': process-tree RSS did not settle after warmup')

    const routeSamples = []
    for (let i = 0; i < condition.samples.length; i++) {
      const observed = await capture(sidePage.page, condition.samples[i])
      if (side === 'candidate') {
        assertCandidateRoute(condition, observed.routes, condition.id + ' memory sample ' + i)
        routeSamples.push(observed.routes)
      } else if (observed.routes !== null) {
        throw new Error(condition.id + ': baseline memory page exposed candidate route counters')
      }
    }

    // State 2: after the unique geometry sweep. This separates "memory retained merely by caching
    // the Blob" from incremental decode/encode/process memory created by the claim workload.
    const final = await settleProcessTreeRss(proc.pid)
    if (!final.stable) throw new Error(condition.id + '/' + side + ': process-tree RSS did not settle after geometry sweep')
    return {
      rootPid: proc.pid,
      rssInitialKb: initial.rssKb,
      rssWarmedKb: warmed.rssKb,
      rssFinalKb: final.rssKb,
      warmupDeltaKb: warmed.rssKb - initial.rssKb,
      sweepDeltaKb: final.rssKb - warmed.rssKb,
      totalDeltaKb: final.rssKb - initial.rssKb,
      initial,
      warmed,
      final,
      warmRoutes,
      routeSamples,
    }
  } finally {
    if (sidePage) await sidePage.context.close().catch(() => {})
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

async function memoryCondition(condition, conditionIndex) {
  const order = pairOrder(REPLICATE, conditionIndex, REPEATS + 1)
  const sides = {}
  for (const side of order) sides[side] = await memorySide(side, condition)
  return {
    order,
    baseline: sides.baseline,
    candidate: sides.candidate,
    // Primary memory signal: how much more process-tree RSS the candidate retained while merely
    // warming the same source image and same geometry.
    candidateMinusBaselineRetentionKb:
      sides.candidate.warmupDeltaKb - sides.baseline.warmupDeltaKb,
    // Secondary: incremental cost of the unique-geometry workload after both sides are warm.
    candidateMinusBaselineSweepKb:
      sides.candidate.sweepDeltaKb - sides.baseline.sweepDeltaKb,
    candidateMinusBaselineTotalKb:
      sides.candidate.totalDeltaKb - sides.baseline.totalDeltaKb,
  }
}

const server = await serve()
let timingBrowser
try {
  timingBrowser = await chromium.launch({ headless: true })
  const browserVersion = timingBrowser.version()
  const conditions = {}

  for (let ci = 0; ci < CONDITIONS.length; ci++) {
    const condition = CONDITIONS[ci]
    console.log('R10 condition ' + condition.id + ' timing')
    const timing = await timingCondition(timingBrowser, condition, ci)
    console.log('R10 condition ' + condition.id + ' isolated VmRSS')
    const memory = await memoryCondition(condition, ci)
    conditions[condition.id] = {
      fixture: condition.fixture,
      csp: condition.csp,
      sweep: condition.sweep,
      role: condition.role,
      warm: condition.warm,
      timing,
      memory,
    }
  }

  const doc = {
    schema: 'snapdom-r10-asblob-runner-v1',
    generatedAt: new Date().toISOString(),
    replicate: REPLICATE,
    provenance: {
      measurementGitSha: prepared.measurementGitSha,
      candidateGitSha: prepared.candidateGitSha,
      baselineGitSha: prepared.baselineGitSha,
      candidateBundleSha256: prepared.candidate.sha256,
      baselineBundleSha256: prepared.baseline.sha256,
      preparedSha256: sha256(fs.readFileSync(PREPARED)),
      measurementFiles: prepared.measurementFiles,
      nodeVersion: process.version,
      playwrightVersion,
      browser: { name: 'chromium', version: browserVersion },
      runner: {
        os: process.platform,
        imageOs: process.env.ImageOS || null,
        imageVersion: process.env.ImageVersion || null,
        runnerName: process.env.RUNNER_NAME || null,
      },
      github: {
        repository: process.env.GITHUB_REPOSITORY || null,
        runId: process.env.GITHUB_RUN_ID || null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
        job: process.env.GITHUB_JOB || null,
      },
      mechanism: prepared.mechanism,
      acquisition: {
        repeats: REPEATS,
        warmup: WARMUP,
        timingPrimary: 'snapdom capture/compression time',
        timingSecondary: 'capture + toCanvas end-to-end time',
        timingOrder: 'AB/BA crossed by replicate + condition + sample parity; even repeats gives 4/4 balance per runner',
        memory: 'fresh BrowserServer per side/condition; settled Linux Chromium process-tree VmRSS at pre-capture, post-warmup, and post-sweep states',
        rssSettle: { deltaKb: 2048, consecutive: 3, intervalMs: 250, maxSamples: 120 },
      },
    },
    fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, {
      width: f.width,
      height: f.height,
      cssWidth: f.cssWidth,
      cssHeight: f.cssHeight,
      bytes: f.bytes.length,
      dataUrlChars: f.dataUrlChars,
      sha256: f.sha256,
    }])),
    conditions,
    performanceClaim: false,
    interpretation: 'Hosted paired mechanism experiment only; runner-level aggregation is required before any speed or memory claim.',
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
  console.log(JSON.stringify({
    schema: doc.schema,
    replicate: REPLICATE,
    out: path.relative(ROOT, OUT).replaceAll('\\', '/'),
    conditions: Object.f