// R15 hosted-only browser experiment: exact source and pixel parity, balanced A/B
// capture times, and JS fetch-route proofs for warmed SVG-image captures.
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const arg = (key, fallback) => {
  const found = process.argv.find((x) => x.startsWith('--' + key + '='))
  return found ? found.slice(key.length + 3) : fallback
}
const runner = Number(arg('runner', '0'))
const baselinePath = resolve(arg('baseline', '.r15-baseline/dist/snapdom.mjs'))
const candidatePath = resolve(arg('candidate', '.r15-candidate/dist/snapdom.mjs'))
const outputPath = resolve(arg('out', 'lane6-scratch/r15/results/runner-' + runner + '.json'))
const data = await Promise.all([readFile(baselinePath), readFile(candidatePath)])
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)
const scenarios = [
  { name: 'svg-hot', kind: 'svg', count: 36, unique: 6, delay: 0, cache: 'soft' },
  { name: 'svg-hot-latency', kind: 'svg', count: 36, unique: 6, delay: 12, cache: 'soft' },
  { name: 'html-only', kind: 'html', count: 36, unique: 6, delay: 0, cache: 'soft' },
  { name: 'svg-proxy-control', kind: 'svg', count: 36, unique: 6, delay: 0, cache: 'soft', proxy: true },
  { name: 'svg-disabled-control', kind: 'svg', count: 36, unique: 6, delay: 0, cache: 'disabled' },
  { name: 'svg-eviction-control', kind: 'svg', count: 120, unique: 120, delay: 0, cache: 'soft' }
]
const sha = (s) => createHash('sha256').update(s).digest('hex')
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
const results = []
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/baseline.mjs' || url.pathname === '/candidate.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(data[url.pathname === '/baseline.mjs' ? 0 : 1])
    return
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:12px sans-serif}#stage{width:620px;display:grid;grid-template-columns:repeat(6,80px);gap:4px;padding:8px}svg,img{display:block;width:64px;height:64px}</style></head><body><div id="stage"></div></body></html>')
    return
  }
  if (url.pathname.startsWith('/asset/')) {
    const delay = Number(url.searchParams.get('delay')) || 0
    if (delay) await new Promise((r) => setTimeout(r, delay))
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-length': png.length })
    res.end(png)
    return
  }
  res.writeHead(404); res.end('not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = 'http://127.0.0.1:' + server.address().port
let browser = null

async function pixelHash(page, url) {
  return page.evaluate(async (encoded) => {
    const img = new Image()
    img.decoding = 'sync'
    img.src = encoded
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, img.naturalWidth)
    canvas.height = Math.max(1, img.naturalHeight)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const digest = await crypto.subtle.digest('SHA-256', pixels)
    return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('')
  }, url)
}

async function runScenario(sc) {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 })
  try {
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.evaluate(async (cfg) => {
      const modules = await Promise.all([import('/baseline.mjs'), import('/candidate.mjs')])
      window.__r15 = {
        A: modules[0].default,
        B: modules[1].default,
        calls: [],
        realFetch: window.fetch.bind(window)
      }
      window.fetch = (...args) => {
        window.__r15.calls.push(String(args[0]))
        return window.__r15.realFetch(...args)
      }
      const root = document.getElementById('stage')
      for (let i = 0; i < cfg.count; i++) {
        const src = cfg.origin + '/asset/' + (i % cfg.unique) + '.png?delay=' + cfg.delay
        if (cfg.kind === 'html') {
          const img = document.createElement('img')
          img.src = src
          img.width = 64; img.height = 64
          root.appendChild(img)
        } else {
          const ns = 'http://www.w3.org/2000/svg'
          const svg = document.createElementNS(ns, 'svg')
          svg.setAttribute('width', '64')
          svg.setAttribute('height', '64')
          svg.setAttribute('viewBox', '0 0 64 64')
          const img = document.createElementNS(ns, 'image')
          img.setAttribute('href', src)
          img.setAttribute('x', '0')
          img.setAttribute('y', '0')
          img.setAttribute('width', '64')
          img.setAttribute('height', '64')
          svg.appendChild(img)
          root.appendChild(svg)
        }
      }
      window.__r15.capture = async (which) => {
        const opts = {
          cache: cfg.cache, burst: false, compress: false, embedFonts: false,
          ...(cfg.proxy ? { useProxy: '/proxy?url=' } : {})
        }
        window.__r15.calls.length = 0
        const t0 = performance.now()
        const result = await window.__r15[which](root, opts)
        const ms = performance.now() - t0
        return { ms, raw: result.url, fetchCalls: window.__r15.calls.length }
      }
    }, { ...sc, origin })
    // Source-native SVG image loads are not part of the measured snapFetch route.
    // fetch instrumentation below counts only JS fetch, never browser image requests.
    await page.evaluate(async () => {
      await window.__r15.capture('A')
      await window.__r15.capture('B')
    })
    const pairs = []
    for (let i = 0; i < 8; i++) {
      const order = ((runner + i) % 2 === 0) ? ['A', 'B'] : ['B', 'A']
      const capture = {}
      for (const side of order) capture[side] = await page.evaluate((s) => window.__r15.capture(s), side)
      if (capture.A.raw !== capture.B.raw) {
        throw new Error(sc.name + ' pair ' + i + ': raw SVG mismatch ' + sha(capture.A.raw) + ' vs ' + sha(capture.B.raw))
      }
      if ((sc.name === 'svg-hot' || sc.name === 'svg-hot-latency') &&
          (capture.B.fetchCalls !== 0 || capture.A.fetchCalls === 0)) {
        throw new Error(sc.name + ' pair ' + i + ': route failed baseline=' + capture.A.fetchCalls + ' candidate=' + capture.B.fetchCalls)
      }
      if (i === 0) {
        const pixelA = await pixelHash(page, capture.A.raw)
        const pixelB = await pixelHash(page, capture.B.raw)
        if (pixelA !== pixelB) throw new Error(sc.name + ': pixel hash mismatch')
      }
      pairs.push({
        order: order.join(''),
        A: { ms: capture.A.ms, fetchCalls: capture.A.fetchCalls },
        B: { ms: capture.B.ms, fetchCalls: capture.B.fetchCalls },
        sha256: sha(capture.A.raw)
      })
    }
    const ratios = pairs.map((p) => (p.B.ms / p.A.ms - 1) * 100)
    return { scenario: sc, pairs, medianChangePct: median(ratios), rawParity: true, pixelParity: true }
  } finally {
    await page.close()
  }
}
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling'] })
  for (const sc of scenarios) {
    const result = await runScenario(sc)
    results.push(result)
    console.log(JSON.stringify({ scenario: sc.name, medianChangePct: result.medianChangePct, rawParity: result.rawParity, pixelParity: result.pixelParity }))
  }
  const report = {
    schema: 'snapdom-r15-svg-memo-paired-v1',
    runner,
    baselineGitSha: process.env.BASELINE_SHA || null,
    candidateGitSha: process.env.CANDIDATE_SHA || null,
    measurementGitSha: process.env.GITHUB_SHA || null,
    runnerImage: process.env.ImageVersion || null,
    node: process.version,
    scenarios: results
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2))
} finally {
  if (browser) await browser.close()
  await new Promise((r) => server.close(r))
}
