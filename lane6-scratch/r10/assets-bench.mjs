#!/usr/bin/env node
/**
 * R10 AS-BLOB hosted experiment.
 *
 * Timing and memory are deliberately separate:
 *  - timing: baseline and candidate pages share one Chromium process and are crossed AB/BA;
 *  - memory: each side gets a fresh Chromium BrowserServer; Chromium CDP owns process membership/type
 *    and Linux /proc smaps_rollup owns the PSS measurement.
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
  assetRouteTotal,
  candidateWarmRouteValid,
  dataUrlCharsForBytes,
  geometrySweep,
  makeDeterministicPng,
  mean,
  pairOrder,
  PSS_SETTLE_POLICY,
  settleCdpProcessPss,
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
  console.error('R10 asset benchmark requires Linux /proc for authoritative Chromium-process PSS')
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
if (REPLICATE >= prepared.acquisition?.runnerReplicates) throw new Error('replicate outside prepared acquisition plan')
if (
  prepared.acquisition?.repeats !== REPEATS ||
  prepared.acquisition?.warmup !== WARMUP ||
  prepared.acquisition?.runnerReplicates !== Number(process.env.SNAPDOM_COHORT_RUNNERS || 6) ||
  JSON.stringify(prepared.acquisition?.memorySettlePolicy) !== JSON.stringify(PSS_SETTLE_POLICY)
) {
  throw new Error('acquisition policy drifted after prepare')
}

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
  { id: 'large-width', fixture: 'large', csp: 'none', sweep: 'width', role: 'claim' },
  { id: 'small-scale', fixture: 'small', csp: 'none', sweep: 'scale', role: 'small-negative' },
  { id: 'large-csp', fixture: 'large', csp: 'worker-none', sweep: 'scale', role: 'worker-negative' },
].map((c) => ({ ...c, warm: { scale: 1, dpr: 1 }, samples: geometrySweep(c.sweep, REPEATS) }))

const CSP = {
  none: null,
  'worker-none': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'none'",
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
    "window.__ready = false",
    "window.__routes = null",
    "window.__workerTelemetry = { attempts: 0, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0, stringPayloadPosts: 0, stringPayloadChars: 0, blobPayloadPosts: 0, blobPayloadBytes: 0, badBlobDataUrlPosts: 0 }",
    "const NativeWorker = window.Worker",
    "if (NativeWorker) {",
    "  const nativePostMessage = NativeWorker.prototype.postMessage",
    "  NativeWorker.prototype.postMessage = function(...args) {",
    "    const payload = args[0]",
    "    window.__workerTelemetry.posts++",
    "    if (payload && typeof payload === 'object') {",
    "      if (payload.blob instanceof Blob) {",
    "        window.__workerTelemetry.blobPayloadPosts++",
    "        window.__workerTelemetry.blobPayloadBytes += payload.blob.size || 0",
    "        if (payload.dataURL !== '') window.__workerTelemetry.badBlobDataUrlPosts++",
    "      } else if (typeof payload.dataURL === 'string') {",
    "        window.__workerTelemetry.stringPayloadPosts++",
    "        window.__workerTelemetry.stringPayloadChars += payload.dataURL.length",
    "      }",
    "    }",
    "    return nativePostMessage.apply(this, args)",
    "  }",
    "  function InstrumentedWorker(...args) {",
    "    window.__workerTelemetry.attempts++",
    "    const worker = new NativeWorker(...args)",
    "    window.__workerTelemetry.constructed++",
    "    worker.addEventListener('message', (event) => {",
    "      window.__workerTelemetry.messages++",
    "      if (event.data && event.data.error) window.__workerTelemetry.errorPosts++",
    "    })",
    "    worker.addEventListener('error', () => { window.__workerTelemetry.errors++ })",
    "    return worker",
    "  }",
    "  InstrumentedWorker.prototype = NativeWorker.prototype",
    "  Object.setPrototypeOf(InstrumentedWorker, NativeWorker)",
    "  window.Worker = InstrumentedWorker",
    "}",
    "const { snapdom } = await import('" + bundle + "')",
    "const routeReader = { name: 'r10-route-reader', afterRender(context) {",
    "  window.__routes = context.__assetRoutes ? { ...context.__assetRoutes } : null",
    "} }",
    "const telemetry = () => ({ ...window.__workerTelemetry })",
    "const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]))",
    "window.__capture = async (opts) => {",
    "  window.__routes = null",
    "  const workerBefore = telemetry()",
    "  const t0 = performance.now()",
    "  const result = await snapdom(document.getElementById('asset'), {",
    "    cache: 'soft', burst: false, compress: true, embedFonts: false, plugins: [routeReader], ...opts",
    "  })",
    "  const t1 = performance.now()",
    "  await result.toCanvas()",
    "  const t2 = performance.now()",
    "  const workerAfter = telemetry()",
    "  return {",
    "    captureMs: t1 - t0, renderMs: t2 - t1, totalMs: t2 - t0,",
    "    routes: window.__routes, workerTelemetry: delta(workerAfter, workerBefore)",
    "  }",
    "}",
    "await document.getElementById('asset').decode()",
    "window.__ready = true",
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
  return page.evaluate((g) => window.__capture(g), geometry)
}

const routeTotal = assetRouteTotal

function assertCandidateRoute(condition, routes, label) {
  if (!routes) throw new Error(label + ': candidate afterRender did not publish route counters')
  if (routeTotal(routes) !== 1) {
    throw new Error(label + ': expected exactly one terminal asset route: ' + JSON.stringify(routes))
  }

  if (condition.role === 'null-memo') {
    if (routes.memo !== 1) throw new Error(label + ': same-geometry null did not terminate at memo: ' + JSON.stringify(routes))
  } else if (condition.role === 'claim') {
    if (routes.workerBlob !== 1 || routes.workerString !== 0 || routes.main !== 0) {
      throw new Error(label + ': claim arm did not complete exclusively on Blob worker route: ' + JSON.stringify(routes))
    }
  } else if (condition.role === 'small-negative') {
    if (routes.main !== 1) throw new Error(label + ': below-threshold fixture did not take main route: ' + JSON.stringify(routes))
  } else if (condition.role === 'worker-negative') {
    if (routes.main !== 1) throw new Error(label + ': CSP worker-negative did not take main route: ' + JSON.stringify(routes))
  }
}

function assertColdWorkerBlob(condition, telemetry, label) {
  if (
    telemetry.blobPayloadPosts !== 1 ||
    telemetry.blobPayloadBytes !== fixtures[condition.fixture].bytes.length ||
    telemetry.stringPayloadPosts !== 0 ||
    telemetry.badBlobDataUrlPosts !== 0
  ) {
    throw new Error(label + ': cold capture did not post exactly one fetched source Blob: ' + JSON.stringify(telemetry))
  }
}

function assertWorkerPayload(side, condition, telemetry, label) {
  if (!['baseline','candidate'].includes(side)) throw new Error(label + ': invalid side')
  // R12 compares AS-BLOB vs bitmap reuse. BOTH mechanisms send a retained source Blob,
  // unlike the original R10 experiment where its pre-AS-BLOB baseline sent a string.
  // Never silently accept a baseline string payload or a missing Worker post.
  if (
    telemetry.blobPayloadPosts !== 1 ||
    telemetry.blobPayloadBytes !== fixtures[condition.fixture].bytes.length ||
    telemetry.stringPayloadPosts !== 0 ||
    telemetry.badBlobDataUrlPosts !== 0
  ) {
    throw new Error(label + ': both R12 sides must post one exact fetched Blob: ' + JSON.stringify(telemetry))
  }
}

function assertWorkerTelemetry(condition, telemetry, label, { warmIndex = null, side } = {}) {
  if (!telemetry) throw new Error(label + ': missing browser-level worker telemetry')
  const posts = telemetry.posts || 0
  const messages = telemetry.messages || 0
  const errors = telemetry.errors || 0
  const errorPosts = telemetry.errorPosts || 0

  const firstWarm = warmIndex === 0
  const laterWarm = Number.isInteger(warmIndex) && warmIndex > 0
  const workerExpected = condition.role === 'claim' || condition.role === 'null-memo'

  if (firstWarm && workerExpected) {
    if (posts !== 1 || messages !== 1 || errors !== 0 || errorPosts !== 0) {
      throw new Error(label + ': cold warmup worker did not complete one successful request/response: ' + JSON.stringify(telemetry))
    }
    // Both the frozen AS-BLOB baseline and R12 candidate post source Blob on cold captures.
    assertColdWorkerBlob(condition, telemetry, label)
    return
  }
  if (firstWarm && condition.role === 'worker-negative') {
    // Chromium may reject a CSP-blocked blob worker synchronously in the constructor OR create the
    // Worker object and surface the CSP denial asynchronously via its error event after postMessage.
    // Both are valid negative controls. What must never happen is a successful worker response.
    const syncDenied =
      telemetry.attempts >= 1 &&
      telemetry.constructed === 0 &&
      posts === 0 &&
      messages === 0
    const asyncDenied =
      telemetry.attempts >= 1 &&
      telemetry.constructed >= 1 &&
      posts >= 0 &&
      messages === 0 &&
      errors >= 1
    if ((!syncDenied && !asyncDenied) || errorPosts !== 0) {
      throw new Error(label + ': CSP warmup did not end in a denied worker route: ' + JSON.stringify(telemetry))
    }
    return
  }
  if (firstWarm && condition.role === 'small-negative') {
    if (telemetry.attempts !== 0 || posts !== 0 || messages !== 0 || errors !== 0 || errorPosts !== 0) {
      throw new Error(label + ': below-threshold warmup unexpectedly touched worker: ' + JSON.stringify(telemetry))
    }
    return
  }
  if (laterWarm || condition.role !== 'claim') {
    if (posts !== 0 || messages !== 0 || errors !== 0 || errorPosts !== 0) {
      throw new Error(label + ': null/control capture unexpectedly touched worker: ' + JSON.stringify(telemetry))
    }
    if (condition.role === 'worker-negative' && telemetry.attempts !== 0) {
      throw new Error(label + ': CSP-disabled worker route was retried after the first denial: ' + JSON.stringify(telemetry))
    }
    return
  }
  if (posts !== 1 || messages !== 1 || errors !== 0 || errorPosts !== 0) {
    throw new Error(label + ': claim capture did not complete one successful worker request/response: ' + JSON.stringify(telemetry))
  }
  assertWorkerPayload(side, condition, telemetry, label)
}

function assertWarmCandidateRoute(condition, routes, label, warmIndex) {
  if (!routes) throw new Error(label + ': candidate warmup did not publish route counters')
  if (!candidateWarmRouteValid(condition.role, routes, warmIndex)) {
    throw new Error(label + ': candidate warmup route contract failed: ' + JSON.stringify(routes))
  }
}

async function warm(sidePage, side, condition, label) {
  const observations = []
  for (let i = 0; i < WARMUP; i++) {
    const observed = await capture(sidePage.page, condition.warm)
    // Both sides are post-AS-BLOB sources and BOTH expose caller-local route counters.
    assertWarmCandidateRoute(condition, observed.routes, label + ' warmup ' + i, i)
    assertWorkerTelemetry(condition, observed.workerTelemetry, label + ' warmup ' + i, { warmIndex: i, side })
    observations.push({ routes: observed.routes, workerTelemetry: observed.workerTelemetry })
  }
  return observations
}

async function timingCondition(browser, condition, conditionIndex) {
  const createOrder = pairOrder(REPLICATE, conditionIndex, 0)
  const sides = {}
  for (const side of createOrder) sides[side] = await openPage(browser, side, condition)
  try {
    const warmup = {}
    for (const side of createOrder) {
      warmup[side] = await warm(sides[side], side, condition, condition.id + '/timing/' + side)
    }

    const pairs = []
    for (let i = 0; i < condition.samples.length; i++) {
      const geometry = condition.samples[i]
      const order = pairOrder(REPLICATE, conditionIndex, i)
      const observed = {}
      for (const side of order) observed[side] = await capture(sides[side].page, geometry)
      for (const side of ['baseline','candidate']) {
        assertCandidateRoute(condition, observed[side].routes, condition.id + ' timing ' + side + ' sample ' + i)
      }
      assertWorkerTelemetry(condition, observed.baseline.workerTelemetry, condition.id + '/timing/baseline sample ' + i, { side: 'baseline' })
      assertWorkerTelemetry(condition, observed.candidate.workerTelemetry, condition.id + '/timing/candidate sample ' + i, { side: 'candidate' })
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
        renderLogRatio: Math.log(observed.candidate.renderMs / observed.baseline.renderMs),
        totalLogRatio: Math.log(observed.candidate.totalMs / observed.baseline.totalMs),
        candidateRoutes: observed.candidate.routes,
        baselineWorkerTelemetry: observed.baseline.workerTelemetry,
        candidateWorkerTelemetry: observed.candidate.workerTelemetry,
      })
    }
    const candidateFirst = pairs.filter((x) => x.order[0] === 'candidate')
    const baselineFirst = pairs.filter((x) => x.order[0] === 'baseline')
    if (candidateFirst.length !== REPEATS / 2 || baselineFirst.length !== REPEATS / 2) {
      throw new Error(condition.id + ': AB/BA strata are not exactly balanced inside this runner')
    }
    const logPoint = 0.5 * (mean(candidateFirst.map((x) => x.logRatio)) + mean(baselineFirst.map((x) => x.logRatio)))
    const renderLogPoint = 0.5 * (mean(candidateFirst.map((x) => x.renderLogRatio)) + mean(baselineFirst.map((x) => x.renderLogRatio)))
    const totalLogPoint = 0.5 * (mean(candidateFirst.map((x) => x.totalLogRatio)) + mean(baselineFirst.map((x) => x.totalLogRatio)))
    const orderBiasLog = mean(candidateFirst.map((x) => x.logRatio)) - mean(baselineFirst.map((x) => x.logRatio))
    return {
      warmup,
      pairs,
      logPoint,
      pct: (Math.exp(logPoint) - 1) * 100,
      renderLogPoint,
      renderPct: (Math.exp(renderLogPoint) - 1) * 100,
      totalLogPoint,
      totalPct: (Math.exp(totalLogPoint) - 1) * 100,
      orderBiasLog,
      orderBiasPct: (Math.exp(orderBiasLog) - 1) * 100,
      primary: 'capture',
    }
  } finally {
    await Promise.all(Object.values(sides).map((x) => x.context.close().catch(() => {})))
  }
}

function assertMemoryState(state, label) {
  if (!state?.stable) throw new Error(label + ': CDP-owned Chromium PSS did not settle')
  if (state.membershipSource !== 'cdp:SystemInfo.getProcessInfo') {
    throw new Error(label + ': unexpected Chromium membership source')
  }
  if (!Array.isArray(state.browserPids) || state.browserPids.length < 1) {
    throw new Error(label + ': CDP process set contains no browser process')
  }
  if (!Array.isArray(state.rendererPids) || state.rendererPids.length < 1) {
    throw new Error(label + ': CDP process set contains no renderer process')
  }
  if (state.settleRangePssKb > PSS_SETTLE_POLICY.deltaKb) {
    throw new Error(label + ': PSS settle range exceeds preregistered policy')
  }
  if (state.settleDriftPssKb > PSS_SETTLE_POLICY.maxDriftKb) {
    throw new Error(label + ': PSS settle drift exceeds preregistered policy')
  }
}

async function memorySide(side, condition) {
  const server = await chromium.launchServer({ headless: true })
  const proc = server.process()
  if (!proc || !Number.isInteger(proc.pid)) {
    await server.close().catch(() => {})
    throw new Error('BrowserServer did not expose a Chromium launcher pid')
  }

  const browser = await chromium.connect(server.wsEndpoint())
  const cdp = await browser.newBrowserCDPSession()
  let sidePage
  try {
    sidePage = await openPage(browser, side, condition)

    // State 0: page + source image are loaded, but snapDOM has never captured. Chromium itself
    // supplies the authoritative browser/renderer/GPU/utility PID set through CDP; Linux /proc
    // supplies PSS for those exact PIDs. Parentage is diagnostic only because Chromium may fork
    // through zygotes/threads in ways that are not preserved as a simple BrowserServer subtree.
    const initial = await settleCdpProcessPss(cdp, PSS_SETTLE_POLICY)
    assertMemoryState(initial, condition.id + '/' + side + '/initial')

    const warmObservations = await warm(
      sidePage,
      side,
      condition,
      condition.id + '/memory/' + side,
    )

    // State 1: image cache and same-geometry compress memo are warm. Candidate Blob retention has
    // already happened here, so warmupDelta is the direct retained-memory signal.
    const warmed = await settleCdpProcessPss(cdp, PSS_SETTLE_POLICY)
    assertMemoryState(warmed, condition.id + '/' + side + '/warmed')

    const routeSamples = []
    for (let i = 0; i < condition.samples.length; i++) {
      const observed = await capture(sidePage.page, condition.samples[i])
      assertCandidateRoute(condition, observed.routes, condition.id + ' memory ' + side + ' sample ' + i)
      routeSamples.push(observed.routes)
      assertWorkerTelemetry(condition, observed.workerTelemetry, condition.id + '/memory/' + side + ' sample ' + i, { side })
    }

    // State 2: after the unique geometry sweep. This separates "memory retained merely by caching
    // the Blob" from incremental decode/encode/process memory created by the claim workload.
    const final = await settleCdpProcessPss(cdp, PSS_SETTLE_POLICY)
    assertMemoryState(final, condition.id + '/' + side + '/final')
    if (initial.identityKey !== warmed.identityKey || warmed.identityKey !== final.identityKey) {
      throw new Error(condition.id + '/' + side + ': Chromium CDP process identity changed across memory states')
    }
    return {
      launcherPid: proc.pid,
      launcherPidMatchesCdpBrowser: initial.browserPids.includes(proc.pid),
      primaryMemoryMetric: 'CDP-owned Chromium process-set PSS from /proc/smaps_rollup',
      pssInitialKb: initial.pssKb,
      pssWarmedKb: warmed.pssKb,
      pssFinalKb: final.pssKb,
      warmupDeltaKb: warmed.pssKb - initial.pssKb,
      sweepDeltaKb: final.pssKb - warmed.pssKb,
      totalDeltaKb: final.pssKb - initial.pssKb,
      vmRssWarmupDeltaKb: warmed.rssKb - initial.rssKb,
      vmRssTotalDeltaKb: final.rssKb - initial.rssKb,
      anonShmemWarmupDeltaKb: warmed.anonShmemKb - initial.anonShmemKb,
      anonShmemTotalDeltaKb: final.anonShmemKb - initial.anonShmemKb,
      rendererPssWarmupDeltaKb: warmed.rendererPssKb - initial.rendererPssKb,
      rendererPssTotalDeltaKb: final.rendererPssKb - initial.rendererPssKb,
      initial,
      warmed,
      final,
      warmRoutes: warmObservations.map((x) => x.routes),
      warmWorkerTelemetry: warmObservations.map((x) => x.workerTelemetry),
      routeSamples,
    }
  } finally {
    await cdp.detach().catch(() => {})
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
    // Primary memory signal: how much more process-tree PSS the candidate retained while merely
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
  const timingById = {}

  for (let ci = 0; ci < CONDITIONS.length; ci++) {
    const condition = CONDITIONS[ci]
    console.log('R10 condition ' + condition.id + ' timing')
    timingById[condition.id] = await timingCondition(timingBrowser, condition, ci)
  }

  // Memory sampling owns its Chromium trees. Do not leave the timing browser resident while
  // comparing process-tree PSS of fresh baseline/candidate sides.
  await timingBrowser.close()
  timingBrowser = null

  const conditions = {}
  for (let ci = 0; ci < CONDITIONS.length; ci++) {
    const condition = CONDITIONS[ci]
    console.log('R10 condition ' + condition.id + ' isolated process-tree PSS')
    const memory = await memoryCondition(condition, ci)
    conditions[condition.id] = {
      fixture: condition.fixture,
      csp: condition.csp,
      sweep: condition.sweep,
      role: condition.role,
      warm: condition.warm,
      timing: timingById[condition.id],
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
        memory: 'fresh BrowserServer per side/condition; primary=sum process-tree smaps_rollup PSS, renderer PSS + VmRSS + RssAnon+RssShmem retained as diagnostics',
        memorySettlePolicy: prepared.acquisition.memorySettlePolicy,
        memoryIdentity: 'exact pid:starttime process set must remain constant within and across initial/warmed/final states',
        memoryRepresentative: 'median PSS of accepted stable window',
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
    conditions: Object.fromEntries(Object.entries(conditions).map(([id, x]) => [id, {
      capturePct: x.timing.pct,
      endToEndPct: x.timing.totalPct,
      candidateMinusBaselineRetentionKb: x.memory.candidateMinusBaselineRetentionKb,
      candidateMinusBaselineSweepKb: x.memory.candidateMinusBaselineSweepKb,
      candidateMinusBaselineTotalKb: x.memory.candidateMinusBaselineTotalKb,
    }])),
  }, null, 2))
} finally {
  if (timingBrowser) await timingBrowser.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}
