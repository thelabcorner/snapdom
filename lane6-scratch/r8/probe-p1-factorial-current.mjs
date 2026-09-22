#!/usr/bin/env node
// R8-P1 deterministic 2x2 + cardinality/breaker routing probe. No wall-time claims.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const C = ROOT
const plugin = {
  name: 'r8p1-factorial-probe',
  setup(b) {
    b.onLoad({ filter: /src[\\/]utils[\\/]css\.js$/ }, async (a) => {
      let s = fs.readFileSync(a.path, 'utf8')
      s = s.replace(
        'export function getStyleKey(snapshot, tagName, sizedByContent = true, isFlexItem = false) {',
        `export function getStyleKey(snapshot, tagName, sizedByContent = true, isFlexItem = false) {\n` +
        `  if (globalThis.__r7pProbe && tagName === 'span') globalThis.__r7pProbe.getStyleKey++`,
      )
      return { contents: s, loader: 'js' }
    })
    b.onLoad({ filter: /src[\\/]modules[\\/]styles\.js$/ }, async (a) => {
      let s = fs.readFileSync(a.path, 'utf8')
      s = s.replace(
        '  if (!useCache || !__sharedPseudoSnapshots.has(snap) || session?.__pseudoStyleKeyCacheDisabled) {\n    return getStyleKey(snap, \'span\', sizedByContent, isFlexItem)\n  }',
        `  if (!useCache || !__sharedPseudoSnapshots.has(snap) || session?.__pseudoStyleKeyCacheDisabled) {\n` +
        `    if (globalThis.__r7pProbe) globalThis.__r7pProbe.cacheBypass++\n` +
        `    return getStyleKey(snap, 'span', sizedByContent, isFlexItem)\n` +
        `  }\n` +
        `  if (globalThis.__r7pProbe) {\n` +
        `    const p = globalThis.__r7pProbe; p.cacheEligible++;\n` +
        `    if (__snapshotSig.has(snap)) p.compactSig++; else p.fullSig++;\n` +
        `  }`,
      )
      s = s.replace(
        `  if (key !== undefined) {\n` +
        `    session.__pseudoStyleKeyMissStreak = 0\n` +
        `    return key\n` +
        `  }\n` +
        `  key = getStyleKey`,
        `  if (key !== undefined) {\n` +
        `    if (globalThis.__r7pProbe) globalThis.__r7pProbe.keyHit++\n` +
        `    session.__pseudoStyleKeyMissStreak = 0\n` +
        `    return key\n` +
        `  }\n` +
        `  if (globalThis.__r7pProbe) globalThis.__r7pProbe.keyMiss++\n` +
        `  key = getStyleKey`,
      )
      s = s.replace(
        '    const snap = useOverlay ? Object.create(rec.snap) : { ...rec.snap }',
        `    const snap = useOverlay ? Object.create(rec.snap) : { ...rec.snap }\n` +
        `    if (globalThis.__r7pProbe) globalThis.__r7pProbe[useOverlay ? 'overlay' : 'spread']++`,
      )
      s = s.replace(
        '  if (misses >= PSEUDO_KEY_MISS_STREAK_LIMIT) {\n    session.__pseudoStyleKeyCacheDisabled = true',
        `  if (misses >= PSEUDO_KEY_MISS_STREAK_LIMIT) {\n` +
        `    if (globalThis.__r7pProbe) globalThis.__r7pProbe.breaker++\n` +
        `    session.__pseudoStyleKeyCacheDisabled = true`,
      )
      return { contents: s, loader: 'js' }
    })
  },
}
const built = await build({
  entryPoints: [path.join(C, 'src/index.js')], bundle: true, format: 'esm', platform: 'browser',
  write: false, minify: false, plugins: [plugin], logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((q, r) => {
  if (q.url === '/m.mjs') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(mod) }
  else { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE) }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } })

const reset = () => ({ getStyleKey: 0, keyHit: 0, keyMiss: 0, compactSig: 0, fullSig: 0, cacheEligible: 0, cacheBypass: 0, overlay: 0, spread: 0, breaker: 0 })
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.__ready)
  const run = async (name, overlay, keyCache, mode = 'repeated') => page.evaluate(async ({ name, overlay, keyCache, mode }) => {
    globalThis.__r7pProbe = { getStyleKey: 0, keyHit: 0, keyMiss: 0, compactSig: 0, fullSig: 0, cacheEligible: 0, cacheBypass: 0, overlay: 0, spread: 0, breaker: 0 }
    const st = document.createElement('style')
    st.textContent = '.root{width:900px;font:13px Arial}.row{display:block}.row::before{content:"#";display:inline-block;width:12px;color:#64748b}.row::after{content:"!";display:inline-block;width:8px;color:#94a3b8}'
    if (mode === 'pairUnique' || mode === 'tripleUnique' || mode === 'quadUnique' || mode === 'breakerTail') {
      const color = (i, salt) => 'rgb(' + ((i * 47 + salt) % 256) + ',' + ((i * 83 + salt * 3) % 256) + ',' + ((i * 131 + salt * 7) % 256) + ')'
      const uniqueCardinality = mode === 'breakerTail' ? 18 : mode === 'tripleUnique' ? 120 : mode === 'quadUnique' ? 100 : 200
      for (let i = 0; i < uniqueCardinality; i++) {
        const prefix = mode === 'breakerTail' ? '.head.h' : '.row.g'
        st.textContent += prefix + i + '::before{color:' + color(i, 11) + '}' + prefix + i + '::after{color:' + color(i, 29) + '}'
      }
    }
    document.head.appendChild(st)
    const root = document.createElement('div'); root.className = 'root'
    if (mode === 'breakerTail') {
      for (let i = 0; i < 18; i++) {
        for (let j = 0; j < 4; j++) {
          const e = document.createElement('div'); e.className = 'row head h' + i; e.textContent = 'head ' + i + '/' + j; root.appendChild(e)
        }
      }
      for (let i = 0; i < 80; i++) {
        const e = document.createElement('div'); e.className = 'row tail'; e.textContent = 'tail ' + i; root.appendChild(e)
      }
    } else {
    const shape = mode === 'pairSame' ? [400, 200]
      : mode === 'tripleSame' ? [360, 120]
      : mode === 'tripleUnique' ? [360, 120]
        : mode === 'quadUnique' ? [400, 100]
        : mode === 'quadSame' ? [400, 100]
          : mode === 'fiveSame' ? [400, 80]
            : [400, mode === 'pairUnique' ? 200 : 1]
    const [nodes, cardinality] = shape
    for (let i = 0; i < nodes; i++) {
      const e = document.createElement('div')
      e.className = ['pairUnique', 'tripleUnique', 'quadUnique', 'pairSame', 'tripleSame', 'quadSame', 'fiveSame'].includes(mode)
        ? 'row g' + (i % cardinality)
        : 'row'
      // data-identity is CSS-observable below only in the entropy case, forcing 400 distinct
      // style-share identities without changing the pseudo's rendered style.
      if (mode === 'entropy') e.setAttribute('data-identity', String(i))
      e.textContent = 'row ' + i
      root.appendChild(e)
    }
    }
    if (mode === 'entropy') {
      st.textContent += '.row[data-identity]{outline-offset:0px}'
    }
    document.body.appendChild(root)
    try {
      const raw = await window.__m.snapdom.toRaw(root, {
        burst: false, cache: 'disabled', embedFonts: false,
        __styleSharePseudoOverlay: overlay,
        __styleSharePseudoKeyCache: keyCache,
      })
      return { name, ...globalThis.__r7pProbe, raw }
    } finally { root.remove(); st.remove() }
  }, { name, overlay, keyCache, mode })

  const repeated = []
  for (const [name, overlay, keyCache] of [
    ['historical', false, false], ['overlay-only', true, false],
    ['key-only', false, true], ['combined', true, true],
  ]) repeated.push(await run(name, overlay, keyCache, 'repeated'))
  const repeatedBase = repeated[0].raw
  console.log('REPEATED')
  for (const r of repeated) {
    console.log(r.name, { rawEqual: r.raw === repeatedBase, overlay: r.overlay, spread: r.spread, breaker: r.breaker, getStyleKey: r.getStyleKey, cacheEligible: r.cacheEligible, cacheBypass: r.cacheBypass, keyHit: r.keyHit, keyMiss: r.keyMiss, compactSig: r.compactSig, fullSig: r.fullSig })
  }

  const entropyHistorical = await run('entropy-historical', false, false, 'entropy')
  const entropyCombined = await run('entropy-combined', true, true, 'entropy')
  console.log('HIGH_ENTROPY')
  for (const r of [entropyHistorical, entropyCombined]) {
    console.log(r.name, { rawEqual: r.raw === entropyHistorical.raw, overlay: r.overlay, spread: r.spread, breaker: r.breaker, getStyleKey: r.getStyleKey, cacheEligible: r.cacheEligible, cacheBypass: r.cacheBypass, keyHit: r.keyHit, keyMiss: r.keyMiss, compactSig: r.compactSig, fullSig: r.fullSig })
  }

  const pairHistorical = await run('pair-unique-historical', false, false, 'pairUnique')
  const pairCombined = await run('pair-unique-combined', true, true, 'pairUnique')
  console.log('PAIR-ONLY UNIQUE STYLE')
  for (const r of [pairHistorical, pairCombined]) {
    console.log(r.name, { rawEqual: r.raw === pairHistorical.raw, overlay: r.overlay, spread: r.spread, breaker: r.breaker, getStyleKey: r.getStyleKey, cacheEligible: r.cacheEligible, cacheBypass: r.cacheBypass, keyHit: r.keyHit, keyMiss: r.keyMiss, compactSig: r.compactSig, fullSig: r.fullSig })
  }

  const tripleUniqueHistorical = await run('triple-unique-historical', false, false, 'tripleUnique')
  const tripleUniqueCombined = await run('triple-unique-combined', true, true, 'tripleUnique')
  console.log('TRIPLE-ONLY UNIQUE STYLE')
  for (const r of [tripleUniqueHistorical, tripleUniqueCombined]) {
    console.log(r.name, { rawEqual: r.raw === tripleUniqueHistorical.raw, overlay: r.overlay, spread: r.spread, breaker: r.breaker, getStyleKey: r.getStyleKey, cacheEligible: r.cacheEligible, cacheBypass: r.cacheBypass, keyHit: r.keyHit, keyMiss: r.keyMiss, compactSig: r.compactSig, fullSig: r.fullSig })
  }

  const quadUniqueHistorical = await run('quad-unique-historical', false, false, 'quadUnique')
  const quadUniqueCombined = await run('quad-unique-combined', true, true, 'quadUnique')
  console.log('QUAD-ONLY UNIQUE STYLE')
  for (const r of [quadUniqueHistorical, quadUniqueCombined]) {
    console.log(r.name, { rawEqual: r.raw === quadUniqueHistorical.raw, overlay: r.overlay, spread: r.spread, breaker: r.breaker, getStyleKey: r.getStyleKey, cacheEligible: r.cacheEligible, cacheBypass: r.cacheBypass, keyHit: r.keyHit, keyMiss: r.keyMiss, compactSig: r.compactSig, fullSig: r.fullSig })
  }

  for (const mode of ['pairSame', 'tripleSame', 'quadSame', 'fiveSame']) {
    const h = await run(mode + '-historical', false, false, mode)
    const c = await run(mode + '-combined', true, true, mode)
    console.log(mode.toUpperCase())
    for (const r of [h, c]) {
      console.log(r.name, { rawEqual: r.raw === h.raw, overlay: r.overlay, spread: r.spread, breaker: r.breaker, getStyleKey: r.getStyleKey, cacheEligible: r.cacheEligible, cacheBypass: r.cacheBypass, keyHit: r.keyHit, keyMiss: r.keyMiss, compactSig: r.compactSig, fullSig: r.fullSig })
    }
  }

  const breakerHistorical = await run('breaker-tail-historical', false, false, 'breakerTail')
  const breakerCombined = await run('breaker-tail-combined', true, true, 'breakerTail')
  console.log('BREAKER THEN HOMOGENEOUS TAIL')
  for (const r of [breakerHistorical, breakerCombined]) {
    console.log(r.name, { rawEqual: r.raw === breakerHistorical.raw, overlay: r.overlay, spread: r.spread, breaker: r.breaker, getStyleKey: r.getStyleKey, cacheEligible: r.cacheEligible, cacheBypass: r.cacheBypass, keyHit: r.keyHit, keyMiss: r.keyMiss, compactSig: r.compactSig, fullSig: r.fullSig })
  }
  const postBreakerFresh = await run('post-breaker-fresh-repeated', true, true, 'repeated')
  console.log('NEXT CAPTURE FRESH SESSION', { getStyleKey: postBreakerFresh.getStyleKey, cacheEligible: postBreakerFresh.cacheEligible, cacheBypass: postBreakerFresh.cacheBypass, keyHit: postBreakerFresh.keyHit, keyMiss: postBreakerFresh.keyMiss, compactSig: postBreakerFresh.compactSig })
} finally {
  await page.close(); await browser.close(); await new Promise((r) => server.close(r))
}
