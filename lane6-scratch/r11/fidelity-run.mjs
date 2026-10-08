#!/usr/bin/env node
/**
 * R11 AS-BLOB cross-engine FIDELITY acceptance: hosted engine runner.
 *
 * ONE engine per invocation (`--engine=chromium|firefox|webkit`). This script collects evidence
 * and nothing else: every verdict is taken by fidelity-lib.mjs from the frozen prepared.json, so
 * the same rules apply whether the evidence came from a browser or from the contract suite's
 * synthetic fixtures.
 *
 * Design decisions that matter, and why:
 *
 *  - ONE PAGE PER SIDE. Baseline and candidate each get their own browser context and their own
 *    page. Sharing a page would let the first capture leave state (a sandbox node, injected styles,
 *    a warm module registry) that the second capture inherits, which is precisely the kind of
 *    confound a parity gate must not have. The cost is that pixel and raw comparison happens in
 *    node rather than in-page.
 *  - QUERY-ISOLATED IMPORTS are therefore not needed; each page imports exactly one bundle.
 *  - RAW OUTPUT COMPARED BY BYTES WHERE AFFORDABLE, BY FROZEN SHA-256 + LENGTH OTHERWISE. A
 *    compress:false capture of the large fixture carries a multi-megabyte data: URL inside its SVG,
 *    so carrying every raw inline would make the artifact enormous for no extra certainty. Records
 *    under the inline limit are carried as real bytes AND digested, and a disagreement between the
 *    two is a failure.
 *  - RENDERED PIXELS COMPARED AS RAW RGBA. The canvas ImageData is transferred per step and compared
 *    byte for byte in node. No tolerance is applied at the required tier.
 *  - NO TIMING ANYWHERE. This file contains no clock read and writes no elapsed-time field. The
 *    Chromium speed result is not evidence about this or any other engine, and nothing here
 *    consumes it.
 *  - TWO CONTEXTS PER CELL PER SIDE (A and B), which is the self-null control. An engine that
 *    cannot reproduce its own output twice cannot adjudicate anyone else's.
 *  - FAILS CLOSED. A cell that throws, a page that never becomes ready, a bundle whose digest moved,
 *    a provenance mismatch or an unavailable crypto.subtle all raise. There is no path that turns a
 *    problem into a skipped cell.
 *
 * GitHub-Actions-only, enforced by assertHostedOnly() with no local override.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import {
  BASELINE_SHA,
  CANDIDATE_SHA,
  CELL_IDS,
  CELLS,
  ENGINES,
  PREPARED_SCHEMA,
  RUNNER_SCHEMA,
  assertHostedOnly,
  cellPageSpec,
  fixtureBytes,
  sha256,
} from './fidelity-lib.mjs'

const ROOT = process.cwd()
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '='
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

assertHostedOnly(process.env)

const PREPARED_PATH = path.resolve(ROOT, arg('prepared', 'lane6-scratch/r11/prepared.json'))
const ENGINE = arg('engine', '')
const OUT = path.resolve(ROOT, arg(
  'out',
  'lane6-scratch/r11/results/engine-' + (ENGINE || 'unknown') + '.json',
))
/** Raws at or below this size travel as real bytes; larger ones travel as digest + length. */
const RAW_INLINE_LIMIT = Number(arg('raw-inline-limit', String(256 * 1024)))

if (!ENGINES.includes(ENGINE)) {
  throw new Error('--engine must be one of ' + ENGINES.join(', ') + ', got ' + JSON.stringify(ENGINE))
}
if (!Number.isInteger(RAW_INLINE_LIMIT) || RAW_INLINE_LIMIT < 0) {
  throw new Error('--raw-inline-limit must be a nonnegative integer')
}

if (!fs.existsSync(PREPARED_PATH)) throw new Error('prepared.json missing: ' + PREPARED_PATH)
const prepared = JSON.parse(fs.readFileSync(PREPARED_PATH, 'utf8'))
if (prepared.schema !== PREPARED_SCHEMA) throw new Error('prepared schema mismatch')
if (prepared.candidateGitSha !== CANDIDATE_SHA) throw new Error('prepared candidate SHA is not d391556')
if (prepared.baselineGitSha !== BASELINE_SHA) throw new Error('prepared baseline SHA is not c523ddb')

// ---- frozen identity: nothing runs against a bundle or a harness file that has moved ----
const baselinePath = path.resolve(ROOT, prepared.baseline.path)
const candidatePath = path.resolve(ROOT, prepared.candidate.path)
if (sha256(fs.readFileSync(baselinePath)) !== prepared.baseline.sha256) {
  throw new Error('baseline bundle digest mismatch')
}
if (sha256(fs.readFileSync(candidatePath)) !== prepared.candidate.sha256) {
  throw new Error('candidate bundle digest mismatch')
}
for (const [rel, expected] of Object.entries(prepared.measurementFiles ?? {})) {
  const observed = sha256(fs.readFileSync(path.resolve(ROOT, rel)))
  if (observed !== expected) throw new Error('harness file digest mismatch: ' + rel)
}
for (const [name, spec] of Object.entries(prepared.fixtures ?? {})) {
  const observed = sha256(fixtureBytes(name))
  if (observed !== spec.sha256) throw new Error('fixture digest mismatch: ' + name)
}
if (prepared.mechanism?.workerMinPayloadChars !== 65536) {
  throw new Error('prepared worker threshold is not the production threshold')
}
if (prepared.acquisition?.rawInlineLimit !== undefined &&
    prepared.acquisition.rawInlineLimit !== RAW_INLINE_LIMIT) {
  throw new Error('raw inline limit drifted after prepare')
}
if (prepared.cellIds && JSON.stringify(prepared.cellIds) !== JSON.stringify(CELL_IDS)) {
  throw new Error('cell matrix drifted after prepare')
}

const envIdentity = {
  measurementGitSha: process.env.SNAPDOM_MEASUREMENT_GIT_SHA || process.env.GITHUB_SHA || '',
  candidateGitSha: process.env.SNAPDOM_CANDIDATE_GIT_SHA || prepared.candidateGitSha,
  baselineGitSha: process.env.SNAPDOM_BASELINE_GIT_SHA || prepared.baselineGitSha,
}
for (const [key, value] of Object.entries(envIdentity)) {
  if (value !== prepared[key]) throw new Error('environment ' + key + ' does not match prepared.json')
}

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
if (playwrightVersion !== prepared.playwrightVersion) throw new Error('Playwright version mismatch')

const { [ENGINE]: browserType } = await import('playwright')

// ---------------------------------------------------------------------------
// Fixture bytes, generated once and served from memory
// ---------------------------------------------------------------------------
const fixtureBuffers = new Map()
for (const name of Object.keys(prepared.fixtures ?? {})) fixtureBuffers.set(name, fixtureBytes(name))

const CSP = {
  none: null,
  'worker-none': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; worker-src 'none'",
}

// ---------------------------------------------------------------------------
// The served page. One bundle, one cell, instrumented before the import.
// ---------------------------------------------------------------------------

function scriptFor(side, spec) {
  const bundle = side === 'candidate' ? '/candidate.mjs' : '/baseline.mjs'
  return [
    '"use strict"',
    'window.__ready = false',
    'window.__routes = null',
    'window.__fidelity = { spec: ' + JSON.stringify(spec) + ', side: ' + JSON.stringify(side) + ' }',
    'window.__bootstrapErrors = []',
    // crypto.subtle is required, not optional: raw parity rests on it for outputs too large to
    // carry inline. An engine without it fails the cell rather than silently degrading the compare.
    'if (!(globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.subtle.digest)) {',
    '  throw new Error("crypto.subtle.digest is unavailable: raw parity cannot be established")',
    '}',
    'window.__workerTelemetry = { attempts: 0, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0, blobPayloadPosts: 0, blobPayloadBytes: 0, stringPayloadPosts: 0, stringPayloadChars: 0, badBlobDataUrlPosts: 0 }',
    'window.addEventListener("error", (e) => window.__bootstrapErrors.push("error: " + e.message))',
    'window.addEventListener("unhandledrejection", (e) => window.__bootstrapErrors.push("rejection: " + String(e.reason)))',
    // Worker instrumentation is installed BEFORE the bundle import on both sides. It is a platform
    // surface, so it exists in c523ddb as well; that is what lets the baseline's own route be
    // checked rather than assumed.
    'const NativeWorker = window.Worker',
    'if (NativeWorker) {',
    '  const nativePostMessage = NativeWorker.prototype.postMessage',
    '  NativeWorker.prototype.postMessage = function (...args) {',
    '    const payload = args[0]',
    '    window.__workerTelemetry.posts++',
    '    if (payload && typeof payload === "object") {',
    '      if (payload.blob instanceof Blob) {',
    '        window.__workerTelemetry.blobPayloadPosts++',
    '        window.__workerTelemetry.blobPayloadBytes += payload.blob.size || 0',
    '        if (payload.dataURL !== "") window.__workerTelemetry.badBlobDataUrlPosts++',
    '      } else if (typeof payload.dataURL === "string") {',
    '        window.__workerTelemetry.stringPayloadPosts++',
    '        window.__workerTelemetry.stringPayloadChars += payload.dataURL.length',
    '      }',
    '    }',
    '    return nativePostMessage.apply(this, args)',
    '  }',
    '  function InstrumentedWorker(...args) {',
    '    window.__workerTelemetry.attempts++',
    '    const worker = new NativeWorker(...args)',
    '    window.__workerTelemetry.constructed++',
    '    worker.addEventListener("message", (event) => {',
    '      window.__workerTelemetry.messages++',
    '      if (event.data && event.data.error) window.__workerTelemetry.errorPosts++',
    '    })',
    '    worker.addEventListener("error", () => { window.__workerTelemetry.errors++ })',
    '    return worker',
    '  }',
    '  InstrumentedWorker.prototype = NativeWorker.prototype',
    '  Object.setPrototypeOf(InstrumentedWorker, NativeWorker)',
    '  window.Worker = InstrumentedWorker',
    '}',
    // The route reader is a CALLER-LOCAL plugin. `options.__assetRoutes` is deliberately absent from
    // the public CaptureResult, so this is how a benchmark sees it: afterRender(context) reads the
    // tallies after the clone has been serialized, when they are final. On the baseline the same
    // plugin runs and finds nothing, which is recorded rather than assumed.
    'const routeReader = { name: "r11-route-reader", afterRender(context) {',
    '  window.__routeReaderSeen = true',
    '  window.__routes = context.__assetRoutes ? { ...context.__assetRoutes } : null',
    '} }',
    'const telemetry = () => ({ ...window.__workerTelemetry })',
    'const delta = (after, before) => Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]))',
    'const RAW_INLINE_LIMIT = ' + RAW_INLINE_LIMIT,
    'const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("")',
    // Raw output is a percent-encoded SVG data URL. Count distinct, actual inlined image
    // attributes INSIDE the SVG, not the outer data:image/svg+xml wrapper.
    'const countInlineDataUrls = (raw) => {',
    '  const comma = raw.indexOf(",")',
    '  if (!raw.startsWith("data:image/svg+xml") || comma < 0) throw new Error("unexpected raw SVG encoding")',
    '  const xml = decodeURIComponent(raw.slice(comma + 1))',
    '  const doc = new DOMParser().parseFromString(xml, "image/svg+xml")',
    '  if (doc.querySelector("parsererror")) throw new Error("raw SVG is unparseable")',
    '  const sources = new Set()',
    '  for (const node of doc.querySelectorAll("img, image")) {',
    '    const src = node.getAttribute("src") || node.getAttribute("href") || node.getAttribute("xlink:href") || ""',
    '    if (src.startsWith("data:image/")) sources.add(src)',
    '  }',
    '  return sources.size',
    '}',
    'const canvasPixels = (canvas) => {',
    '  const ctx = canvas.getContext("2d", { willReadFrequently: true })',
    '  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data',
    '  let binary = ""',
    '  const chunk = 0x8000',
    '  for (let i = 0; i < data.length; i += chunk) {',
    '    binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk))',
    '  }',
    '  return { w: canvas.width, h: canvas.height, pixelsB64: btoa(binary) }',
    '}',
    'window.__runCell = async () => {',
    '  const spec = window.__fidelity.spec',
    '  const root = document.createElement("div")',
    '  root.id = "fidelity-root"',
    '  root.style.cssText = "display:block;background:#ffffff"',
    '  for (const image of spec.images) {',
    '    const img = document.createElement("img")',
    '    img.setAttribute("src", image.src)',
    '    img.setAttribute("width", String(image.naturalWidth))',
    '    img.setAttribute("height", String(image.naturalHeight))',
    '    img.setAttribute("data-fidelity-image", image.name)',
    '    img.style.cssText = "display:block;width:" + image.box[0] + "px;height:" + image.box[1] + "px;object-fit:cover"',
    '    root.appendChild(img)',
    '  }',
    '  document.body.appendChild(root)',
    '  for (const img of root.querySelectorAll("img")) {',
    // The 404 pseudo-fixture is intentionally undecodable. That specific decode rejection is
    // evidence of the fixture, not an unexpected bootstrap failure; all other failures stay red.
    '    try { await img.decode() } catch (error) {',
    '      if (img.getAttribute("data-fidelity-image") !== "missing") {',
    '        window.__bootstrapErrors.push("decode " + img.getAttribute("data-fidelity-image") + ": " + error.message)',
    '      }',
    '    }',
    '  }',
    '  const records = []',
    '  for (const step of spec.steps) {',
    '    window.__routes = null',
    '    window.__routeReaderSeen = false',
    '    const before = telemetry()',
    '    const result = await snapdom(root, {',
    '      cache: spec.cache,',
    '      burst: false,',
    '      compress: spec.compress,',
    '      embedFonts: false,',
    '      plugins: [routeReader],',
    '      fallbackURL: spec.fallbackURL || undefined,',
    '      ...step.geometry,',
    '    })',
    '    const raw = result.toRaw()',
    '    const canvas = await result.toCanvas()',
    // A large baseline worker reply may arrive after the capture result in WebKit. On the
    // eviction stress cell alone, flush outstanding replies before taking per-step deltas.
    // This requires every posted message to complete; it does not relax route parity.
    '    if (spec.id === "budget-eviction") {',
    '      for (let poll = 0; poll < 800 && window.__workerTelemetry.messages < window.__workerTelemetry.posts; poll++) {',
    '        await new Promise((resolve) => setTimeout(resolve, 25))',
    '      }',
    '      if (window.__workerTelemetry.messages !== window.__workerTelemetry.posts) {',
    '        throw new Error("budget-eviction worker replies did not match posts")',
    '      }',
    '    }',
    '    const after = telemetry()',
    '    const rawBytes = new TextEncoder().encode(raw).length',
    '    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))',
    '    records.push({',
    '      label: step.label,',
    '      geometry: step.geometry,',
    '      raw: rawBytes <= RAW_INLINE_LIMIT ? raw : null,',
    '      rawBytes,',
    '      rawSha256: hex(digest).toUpperCase(),',
    '      inlineDataUrls: countInlineDataUrls(raw),',
    '      canvas: canvasPixels(canvas),',
    '      routeReaderSeen: window.__routeReaderSeen,',
    '      routes: window.__routes,',
    '      telemetry: delta(after, before),',
    '    })',
    '  }',
    '  root.remove()',
    '  return { records, bootstrapErrors: window.__bootstrapErrors }',
    '}',
    'const { snapdom } = await import("' + bundle + '")',
    'window.__ready = true',
  ].join('\n')
}

function htmlFor(side, cellId) {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<link rel="stylesheet" href="/style.css?cell=' + cellId + '">',
    '</head><body>',
    '<script type="module" src="/page.js?side=' + side + '&cell=' + cellId + '"></script>',
    '</body></html>',
  ].join('')
}

let origin = ''
function startServer() {
  const baselineBytes = fs.readFileSync(baselinePath)
  const candidateBytes = fs.readFileSync(candidatePath)
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', origin || 'http://127.0.0.1')
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers })
      res.end(body)
    }
    if (url.pathname === '/baseline.mjs') return send(200, 'text/javascript; charset=utf-8', baselineBytes)
    if (url.pathname === '/candidate.mjs') return send(200, 'text/javascript; charset=utf-8', candidateBytes)
    if (url.pathname === '/style.css') {
      return send(200, 'text/css; charset=utf-8', 'html,body{margin:0;padding:0}#fidelity-root{display:block}')
    }
    if (url.pathname === '/fixtures/missing.png') {
      // A real 404, not a synthetic failure: snapFetch sees the same status the network would give.
      return send(404, 'text/plain; charset=utf-8', 'not found')
    }
    if (url.pathname.startsWith('/fixtures/')) {
      const name = url.pathname.slice('/fixtures/'.length).replace(/\.png$/, '')
      const buffer = fixtureBuffers.get(name)
      if (!buffer) return send(404, 'text/plain; charset=utf-8', 'not found')
      return send(200, 'image/png', buffer, { 'content-length': String(buffer.length) })
    }
    if (url.pathname === '/page.js') {
      const side = url.searchParams.get('side')
      const cellId = url.searchParams.get('cell')
      const cell = CELLS.find((c) => c.id === cellId)
      if (!['baseline', 'candidate'].includes(side) || !cell) return send(400, 'text/plain', 'bad page args')
      return send(200, 'text/javascript; charset=utf-8', scriptFor(side, cellPageSpec(cell)))
    }
    if (url.pathname === '/') {
      const side = url.searchParams.get('side')
      const cellId = url.searchParams.get('cell')
      const cell = CELLS.find((c) => c.id === cellId)
      if (!['baseline', 'candidate'].includes(side) || !cell) return send(400, 'text/plain', 'bad page args')
      const csp = CSP[cell.csp ?? 'none']
      // A response header, not a meta tag: it has to govern the module script and the worker
      // construction, which a meta tag only reaches after the document has already started parsing.
      return send(200, 'text/html; charset=utf-8', htmlFor(side, cellId), csp ? { 'content-security-policy': csp } : {})
    }
    return send(404, 'text/plain', 'not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port
      resolve(server)
    })
  })
}

// ---------------------------------------------------------------------------
// Emulation, applied before module execution
// ---------------------------------------------------------------------------

/**
 * `compressWorkerRouteSupported()` asks whether `Worker` and `OffscreenCanvas` exist. Once the
 * module has executed, that answer is already fixed by the bundle's own capability check, so the
 * absence has to be established by an init script: Playwright runs those before any page script,
 * which is before module evaluation. `delete` on the window property is used rather than an
 * assignment to undefined because the check is `typeof Worker !== 'undefined'`, and a leftover
 * own property that merely holds undefined would satisfy it.
 */
function initScript(emulate) {
  if (!emulate) return null
  const target = emulate === 'no-worker' ? 'Worker' : 'OffscreenCanvas'
  return 'try { delete window.' + target + ' } catch (error) { Object.defineProperty(window, "' +
    target + '", { configurable: true, get() { return undefined } }) }'
}

async function runSidePage(browser, side, cell, contextId) {
  const context = await browser.newContext({ deviceScaleFactor: 1 })
  try {
    const emulate = cell.emulate
    if (emulate) {
      const source = initScript(emulate)
      if (!source) throw new Error('unknown emulation ' + emulate)
      // { content } rather than a bare string, so the body is never mistaken for a module path.
      await context.addInitScript({ content: source })
    }
    const page = await context.newPage()
    const bootstrapErrors = []
    page.on('pageerror', (error) => bootstrapErrors.push('pageerror: ' + error.message))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const value = message.text()
      // Chromium/Firefox/WebKit may emit a console error for a deliberately failing resource
      // or for CSP worker-src 'none'. Admit only those precise, declared negative controls.
      // Unexpected CSP directives and all other page errors remain fatal.
      const expectedMissing404 = cell.images.includes('missing') && /\b404\b/.test(value) &&
        (!message.location().url || /\/fixtures\/missing\.png(?:[?#]|$)/.test(message.location().url))
      const expectedWorkerCsp = cell.csp === 'worker-none' &&
        /worker-src|Refused to create a worker/i.test(value) &&
        /Content Security Policy|violat|Refused to create a worker/i.test(value)
      if (!expectedMissing404 && !expectedWorkerCsp) bootstrapErrors.push('console: ' + value)
    })
    await page.goto(origin + '/?side=' + side + '&cell=' + cell.id)
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 })
    const outcome = await page.evaluate(() => window.__runCell())
    if (outcome.bootstrapErrors.length) {
      throw new Error(
        cell.id + '/' + side + '/' + contextId + ': page reported ' +
        outcome.bootstrapErrors.join(' | '),
      )
    }
    if (bootstrapErrors.length) {
      throw new Error(
        cell.id + '/' + side + '/' + contextId + ': page errored with ' +
        bootstrapErrors.join(' | '),
      )
    }
    for (const record of outcome.records) {
      if (record.rawSha256 == null || record.canvas?.pixelsB64 == null) {
        throw new Error(cell.id + '/' + side + '/' + contextId + ': incomplete evidence at ' + record.label)
      }
    }
    return { steps: outcome.records }
  } finally {
    await context.close().catch(() => {})
  }
}

/**
 * Both self-null contexts for one cell. Any throw fails the cell; nothing is skipped.
 *
 * Contexts and sides run SEQUENTIALLY on purpose. The budget-eviction cell alone carries ~78 MB of
 * fixture bytes, so two of them in flight at once is the difference between a slow run and an
 * out-of-memory kill. There is no ordering confound to avoid here: each side gets its own context,
 * its own page and its own module instance.
 */
async function runCell(browser, cell) {
  const contexts = {}
  for (const contextId of ['A', 'B']) {
    const baseline = await runSidePage(browser, 'baseline', cell, contextId)
    const candidate = await runSidePage(browser, 'candidate', cell, contextId)
    contexts[contextId] = { baseline, candidate }
  }
  return contexts
}

const server = await startServer()
let browser
const cells = {}
try {
  browser = await browserType.launch({ headless: true })
  const browserVersion = browser.version()
  for (const cellId of CELL_IDS) {
    const cell = CELLS.find((c) => c.id === cellId)
    console.log('[r11] ' + ENGINE + ' cell ' + cellId)
    cells[cellId] = await runCell(browser, cell)
  }

  const doc = {
    schema: RUNNER_SCHEMA,
    generatedAt: new Date().toISOString(),
    engine: ENGINE,
    provenance: {
      measurementGitSha: envIdentity.measurementGitSha,
      candidateGitSha: envIdentity.candidateGitSha,
      baselineGitSha: envIdentity.baselineGitSha,
      candidateBundleSha256: prepared.candidate.sha256,
      baselineBundleSha256: prepared.baseline.sha256,
      preparedSha256: sha256(fs.readFileSync(PREPARED_PATH)),
      cellMatrixSha256: prepared.cellMatrixSha256,
      measurementFiles: prepared.measurementFiles,
      playwrightVersion,
      nodeVersion: process.version,
      browser: { name: ENGINE, version: browserVersion },
      rawInlineLimit: RAW_INLINE_LIMIT,
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
    },
    mechanism: prepared.mechanism,
    fixtures: prepared.fixtures,
    cellIds: CELL_IDS,
    cells,
    // Present so no reader of this artifact can infer a performance statement from it.
    performanceClaim: false,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(doc) + '\n')
  console.log('[r11] wrote ' + path.relative(ROOT, OUT).replaceAll('\\', '/'))
} finally {
  if (browser) await browser.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}
