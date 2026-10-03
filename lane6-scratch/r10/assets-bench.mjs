/**
 * AS-BLOB hosted benchmark prototype. NOT EXECUTED — written and syntax-checked only, because
 * this branch runs no browser. Everything it asserts is a HOSTED-ONLY claim; the matrix and the
 * gates it implements live in ASSET-BENCH-DESIGN.md next to it.
 *
 * What it is for: AS-BLOB claims a saving on REPEAT captures whose GEOMETRY changes the compress
 * memo key, and nowhere else. This harness is built to make that falsifiable in both directions —
 * it must show the Blob route is reached where the claim says it is, and must show no change
 * where the claim says there is none.
 *
 * Route counters are read through a CALLER-LOCAL plugin's afterRender(context) hook, copying
 * `context.__assetRoutes` onto a page-side global. There is deliberately no public
 * `result.assets`: a measurement surface is not a reason to widen CaptureResult.
 *
 * Run (hosted CI only):  node lane6-scratch/r10/assets-bench.mjs --engine=chromium
 * Requires: a built `dist/` (`npm run compile`), Playwright's chromium, and the harness serving
 * `dist/` plus the two fixtures from a local origin (same-origin keeps `cssRules` readable and
 * the fetches cheap, which is the regime AS-BLOB targets).
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKER_MIN_PAYLOAD_CHARS, MAX_IMAGE_BLOB_BYTES } from '../../src/core/cache.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const DIST = path.join(ROOT, 'dist', 'snapdom.mjs')
const MB = 1024 * 1024

/** Warm-up captures before any arm is timed. One-shot JIT and font work must not land in arm 1. */
const WARMUP = 3
/** Repetitions per arm. Medians over this many, never a single sample. */
const REPEATS = 7
/** Heap must move less than this between consecutive samples for RSS to count as settled. */
const RSS_SETTLE_DELTA = 2 * 1024 * 1024
/** Consecutive settled samples required before an arm is measured. */
const RSS_SETTLE_SAMPLES = 3

/**
 * The two fixtures the claim needs. `large` clears compress's worker threshold in base64
 * characters, so its Blob is retained and the worker route is reachable; `small` is far under it,
 * so NO Blob is retained and the main thread is the only route it can take. A page carrying only
 * `small` must report workerBlob === 0 — that is the red team's "small images retain zero blobs"
 * requirement observed end to end rather than asserted at the cache.
 */
const FIXTURES = {
  large: { file: 'fixture-large.jpg', width: 2400, height: 1600, expectWorkerBlob: true },
  small: { file: 'fixture-small.png', width: 96, height: 96, expectWorkerBlob: false },
}

/** CSP arms. `worker-src 'none'` must close the worker route and, per the design, drop retention. */
const CSP_ARMS = [
  { name: 'no-csp', csp: null },
  { name: 'worker-src-none', csp: "default-src 'self'; img-src 'self' data:; worker-src 'none'" },
]

/** Geometry arms. Same-geometry is the null arm; the others move the compress memo key. */
const GEOMETRY_ARMS = [
  { name: 'same-geometry', scales: [1], dprs: [1] },
  { name: 'scale-1-then-2', scales: [1, 2], dprs: [1] },
  { name: 'dpr-1-then-2', scales: [1], dprs: [1, 2] },
]

/** Absolute path of the local server origin the page is served from. */
let origin = ''

/** Bytes of each fixture, as a data URL of the exact kind compress sees after inlining. */
async function readFixture(name) {
  const p = path.join(HERE, 'fixtures', name)
  if (!existsSync(p)) throw new Error(`missing fixture ${p} — see ASSET-BENCH-DESIGN.md §2`)
  const buf = await readFile(p)
  const mime = name.endsWith('.png') ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * The page under test. `cache: 'soft'` is passed explicitly so the arms cannot drift onto a
 * future default, and the two fixtures sit side by side so one capture exercises both gates.
 */
function page({ large, small, csp }) {
  const cspTag = csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : ''
  return `<!doctype html><html><head><meta charset="utf-8">${cspTag}
<style>body{margin:0;font:14px system-ui}#stage{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px}
img{display:block;width:100%}</style></head><body><div id="stage">
<img id="big" src="${large}" width="2400" height="1600">
<img id="ico" src="${small}" width="96" height="96">
</div><script type="module">
import snapdom from '${origin}/snapdom.mjs'
window.__snapdom = snapdom
window.__routes = null
// afterRender runs once the clone is serialized (engines/svg.js), so the tallies are final.
// It is the ONLY way this harness reads them: they live on context.__assetRoutes and are not
// on the public result.
const routeReader = { name: 'r10-route-reader', afterRender(context) { window.__routes = { ...(context.__assetRoutes || {}) } } }
window.__capture = async (opts) => {
  window.__routes = null
  const t0 = performance.now()
  const r = await snapdom(document.getElementById('stage'), { cache: 'soft', burst: false, plugins: [routeReader], ...opts })
  await r.toCanvas()   // force the raster so every arm pays the same encode
  return { ms: performance.now() - t0, routes: window.__routes }
 }
window.__rss = () => performance.memory ? performance.memory.usedJSHeapSize : 0
window.__ready = true
</script></body></html>`
}

/** Serves dist/ and the fixture page from one origin. */
async function serve({ large, small, csp }) {
  const html = page({ large, small, csp })
  const server = createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (req.url === '/snapdom.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(await readFile(DIST))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

/**
 * Poll until `__rss()` stops moving. A capture leaves blob-store and decode scratch behind that
 * a fixed sleep would either miss or waste minutes on, and an unsettled arm makes every later
 * number meaningless — so this gate is not optional.
 * @param {Function} page_
 */
async function settleRss(page_) {
  let previous = await page_.evaluate(() => window.__rss())
  let stable = 0
  for (let i = 0; i < 120 && stable < RSS_SETTLE_SAMPLES; i++) {
    await page_.waitForTimeout(250)
    const now = await page_.evaluate(() => window.__rss())
    stable = Math.abs(now - previous) <= RSS_SETTLE_DELTA ? stable + 1 : 0
    previous = now
  }
  return previous
}

/** Median of the samples. A mean would let one scheduler spike define the arm. */
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/**
 * One arm: warm up, settle, then REPEATS timed captures at each geometry in order, returning the
 * per-capture route counters so the claim can be checked, not just timed.
 */
async function runArm(browser, { fixture, csp, geometry, repeats, warmup, label }) {
  const large = await readFixture(FIXTURES[fixture].file)
  const small = await readFixture('fixture-small.png')
  const { server, origin: o } = await serve({ large, small, csp })
  origin = o
  const results = []
  try {
    const page_ = await browser.newPage()
    await page_.goto(`${o}/`)
    await page_.waitForFunction(() => window.__ready === true)

    for (const _ of Array.from({ length: warmup })) {
      await page_.evaluate(() => window.__capture({ scale: 1, dpr: 1 }))
    }
    const rssBefore = await settleRss(page_)

    for (let rep = 0; rep < repeats; rep++) {
      for (const scale of geometry.scales) {
        for (const dpr of geometry.dprs) {
          const sample = await page_.evaluate(
            ([s, d]) => window.__capture({ scale: s, dpr: d }),
            [scale, dpr],
          )
          results.push({ rep, scale, dpr, ms: sample.ms, routes: sample.routes })
        }
      }
    }
    const rssAfter = await settleRss(page_)
    return { label, fixture, csp, geometry: geometry.name, results, rssBefore, rssAfter }
  } finally {
    server.close()
  }
}

async function main() {
  if (!existsSync(DIST)) {
    console.error('dist/snapdom.mjs missing — run `npm run compile` first')
    process.exit(2)
  }
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const arms = []
  try {
    for (const fixture of ['large', 'small']) {
      for (const { name, csp } of CSP_ARMS) {
        for (const geometry of GEOMETRY_ARMS) {
          arms.push(await runArm(browser, {
            fixture, csp, geometry, repeats: REPEATS, warmup: WARMUP,
            label: `${fixture}/${name}/${geometry.name}`,
          }))
        }
      }
    }
  } finally {
    await browser.close()
  }

  const provenance = {
    engine: 'chromium',
    cache: 'soft',
    workerMinPayloadChars: WORKER_MIN_PAYLOAD_CHARS,
    retentionCapBytes: MAX_IMAGE_BLOB_BYTES,
    retentionCapStatus: 'HYPOTHESIS — not a certified policy. Lower or freeze from this run RSS.',
    warmup: WARMUP,
    repeats: REPEATS,
    rssSettle: { deltaBytes: RSS_SETTLE_DELTA, consecutiveSamples: RSS_SETTLE_SAMPLES, pollMs: 250 },
    note: 'route counters come from context.__assetRoutes via an afterRender plugin; there is no public result.assets',
  }
  console.log(JSON.stringify({ provenance, arms }, null, 2))

  // The route gates, asserted rather than eyeballed. See ASSET-BENCH-DESIGN.md §4.
  for (const arm of arms) {
    const last = arm.results[arm.results.length - 1].routes
    if (!last) throw new Error(`${arm.label}: afterRender never published __assetRoutes`)
    if (arm.fixture === 'small' && (last.workerBlob !== 0 || last.workerString !== 0)) {
      throw new Error(`${arm.label}: a small raster reached a worker (${JSON.stringify(last)})`)
    }
    if (arm.csp?.name === 'worker-src-none' && (last.workerBlob !== 0 || last.workerString !== 0)) {
      throw new Error(`${arm.label}: worker-src 'none' did not close the worker route`)
    }
    if (arm.csp?.name === 'worker-src-none' && arm.fixture === 'large' && last.main === 0) {
      throw new Error(`${arm.label}: worker route closed but nothing took the main thread`)
    }
  }

  console.log(`\n${arms.length} arms; route gates held\n`)
  console.log('arm'.padEnd(46) + 'median ms'.padStart(11) + 'settled RSS delta'.padStart(20) + '  routes (last)')
  for (const arm of arms) {
    const ms = median(arm.results.map((r) => r.ms))
    const rss = arm.rssAfter - arm.rssBefore
    const r = arm.results[arm.results.length - 1].routes
    console.log(
      arm.label.padEnd(46) +
      ms.toFixed(1).padStart(11) +
      `${(rss / MB).toFixed(1)} MiB`.padStart(20) +
      `  blob=${r.workerBlob} str=${r.workerString} main=${r.main} memo=${r.memo}`,
    )
  }
  console.log('\nThe retention cap is a hypothesis. Read the RSS column before defending it:')
  console.log(`  if A2/A3 (the claim arms) sit well above A1/B1/C1 (${(MAX_IMAGE_BLOB_BYTES / MB).toFixed(0)} MiB cap),`)
  console.log('  lower MAX_IMAGE_BLOB_BYTES and re-run before this ships.')
}

main().catch((e) => { console.error(e); process.exit(1) })