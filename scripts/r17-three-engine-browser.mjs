// R17: frozen R12 vs image work queue; browser-only evidence, never a microbenchmark claim.
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'

const arg = (name, fallback) => {
  const item = process.argv.find(x => x.startsWith('--' + name + '='))
  return item ? item.slice(name.length + 3) : fallback
}
const runner = Number(arg('runner', '0'))
const engine = arg('engine', 'chromium')
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw Error('unknown browser engine: ' + engine)
const baselinePath = resolve(arg('baseline', '.r17-baseline/dist/snapdom.mjs'))
const candidatePath = resolve(arg('candidate', 'dist/snapdom.mjs'))
const outputPath = resolve(arg('out', 'r17-engine-evidence/' + engine + '.json'))
const bundles = await Promise.all([readFile(baselinePath), readFile(candidatePath)])
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const sha = x => createHash('sha256').update(x).digest('hex')
const scenarios = [
  { name: 'mixed-straggler', kind: 'mixed', count: 36, slow: 90, fast: 3, cache: 'disabled' },
  { name: 'html-straggler', kind: 'html', count: 36, slow: 90, fast: 3, cache: 'disabled' },
  { name: 'svg-straggler', kind: 'svg', count: 36, slow: 90, fast: 3, cache: 'disabled' },
  { name: 'mixed-fast', kind: 'mixed', count: 36, slow: 0, fast: 0, cache: 'disabled' },
  { name: 'mixed-small', kind: 'mixed', count: 6, slow: 3, fast: 3, cache: 'disabled' },
  { name: 'inline-control', kind: 'inline', count: 36, slow: 0, fast: 0, cache: 'disabled' }
]
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/baseline.mjs' || url.pathname === '/candidate.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(bundles[url.pathname === '/baseline.mjs' ? 0 : 1])
    return
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:12px sans-serif}#stage{display:grid;grid-template-columns:repeat(6,80px);gap:4px;padding:8px;width:520px}svg,img{display:block;width:64px;height:64px}</style></head><body><div id="stage"></div></body></html>')
    return
  }
  if (url.pathname.startsWith('/asset/')) {
    const delay = Number(url.searchParams.get('delay')) || 0
    if (delay > 0) await new Promise(r => setTimeout(r, delay))
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-length': png.length })
    res.end(png)
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = 'http://127.0.0.1:' + server.address().port
let browser

async function pixelHash(page, url) {
  return page.evaluate(async encoded => {
    const image = new Image()
    image.src = encoded
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, image.naturalWidth)
    canvas.height = Math.max(1, image.naturalHeight)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(image, 0, 0)
    const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('')
  }, url)
}

async function measure(sc) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 })
  try {
    await page.goto(origin + '/', { waitUntil: 'load' })
    await page.evaluate(async cfg => {
      const modules = await Promise.all([import('/baseline.mjs'), import('/candidate.mjs')])
      const root = document.getElementById('stage')
      const ns = 'http://www.w3.org/2000/svg'
      const inline = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
      if (typeof modules[0].snapdom !== 'function' || typeof modules[1].snapdom !== 'function') {
        throw new Error('R17 measurement requires named snapdom export on both frozen bundles')
      }
      const record = { A: modules[0].snapdom, B: modules[1].snapdom, calls: [], inFlight: 0, maxFlight: 0 }
      const realFetch = window.fetch.bind(window)
      window.fetch = (...args) => {
        const url = String(args[0])
        if (!url.includes('/asset/')) return realFetch(...args)
        record.inFlight++
        record.maxFlight = Math.max(record.maxFlight, record.inFlight)
        record.calls.push(url)
        return realFetch(...args).finally(() => { record.inFlight-- })
      }
      for (let i = 0; i < cfg.count; i++) {
        const isSvg = cfg.kind === 'svg' || (cfg.kind === 'mixed' && i % 2 === 1)
        const slow = i % 6 === 0 ? cfg.slow : cfg.fast
        const src = cfg.kind === 'inline' ? inline : cfg.origin + '/asset/' + i + '.png?delay=' + slow
        if (!isSvg) {
          const image = document.createElement('img')
          image.src = src
          image.width = 64
          image.height = 64
          root.appendChild(image)
        } else {
          const svg = document.createElementNS(ns, 'svg')
          svg.setAttribute('width', '64')
          svg.setAttribute('height', '64')
          svg.setAttribute('viewBox', '0 0 64 64')
          const image = document.createElementNS(ns, 'image')
          image.setAttribute('href', src)
          image.setAttribute('width', '64')
          image.setAttribute('height', '64')
          svg.appendChild(image)
          root.appendChild(svg)
        }
      }
      window.__r17 = {
        record,
        capture: async which => {
          record.calls.length = 0
          record.maxFlight = 0
          const t = performance.now()
          const result = await record[which](root, { burst: false, cache: cfg.cache, compress: false, embedFonts: false })
          const ms = performance.now() - t
          return { ms, raw: result.url, fetchCalls: record.calls.length, maxFlight: record.maxFlight }
        }
      }
    }, { ...sc, origin })
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => {
      await window.__r17.capture('A')
      await window.__r17.capture('B')
    })
    const pairs = []
    for (let i = 0; i < 8; i++) {
      const order = ((runner + i) % 2) === 0 ? ['A', 'B'] : ['B', 'A']
      const arm = {}
      for (const which of order) arm[which] = await page.evaluate(x => window.__r17.capture(x), which)
      if (arm.A.raw !== arm.B.raw) {
        throw Error(sc.name + ' pair ' + i + ': raw mismatch ' + sha(arm.A.raw) + ' != ' + sha(arm.B.raw))
      }
      if (i === 0 || i === 7) {
        const pixels = await Promise.all([pixelHash(page, arm.A.raw), pixelHash(page, arm.B.raw)])
        if (pixels[0] !== pixels[1]) throw Error(sc.name + ' pair ' + i + ': rendered-pixel mismatch')
      }
      if (sc.kind !== 'inline' && (arm.A.fetchCalls === 0 || arm.B.fetchCalls === 0)) {
        throw Error(sc.name + ': missing asset fetch path ' + arm.A.fetchCalls + ' / ' + arm.B.fetchCalls)
      }
      if (arm.A.maxFlight > 6 || arm.B.maxFlight > 6) {
        throw Error(sc.name + ': exceeded six-request limit ' + arm.A.maxFlight + ' / ' + arm.B.maxFlight)
      }
      pairs.push({
        order: order.join(''),
        A: { ms: arm.A.ms, fetchCalls: arm.A.fetchCalls, maxFlight: arm.A.maxFlight },
        B: { ms: arm.B.ms, fetchCalls: arm.B.fetchCalls, maxFlight: arm.B.maxFlight },
        rawSha256: sha(arm.A.raw)
      })
    }
    return { scenario: sc, pairs, exactRaw: true, exactPixels: true }
  } finally {
    await page.close()
  }
}
const results = []
try {
  browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true })
  for (const sc of scenarios) {
    results.push(await measure(sc))
    const last = results.at(-1)
    const changes = last.pairs.map(p => 100 * (p.B.ms / p.A.ms - 1))
    const median = changes.toSorted((a, b) => a - b)[Math.floor(changes.length / 2)]
    console.log(JSON.stringify({ runner, scenario: sc.name, medianChangePct: median, parity: true }))
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify({
    schema: 'snapdom-r17-cross-engine-v1', engine, runner, baselineSha: process.env.BASELINE_SHA,
    candidateSha: process.env.CANDIDATE_SHA || process.env.GITHUB_SHA,
    runnerImage: process.env.ImageVersion, node: process.version, scenarios: results
  }, null, 2))
} finally {
  if (browser) await browser.close()
  await new Promise(r => server.close(r))
}
