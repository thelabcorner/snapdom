#!/usr/bin/env node
// Hosted-only R12 probe. No local browser performance claims. Exactly compiled SHA-separated sides.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { chromium } from 'playwright'
import { makeDeterministicPng } from '../r10/asset-bench-lib.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('R12 browser experiments are GitHub-Actions-only')
}
const BASELINE_SHA = 'd391556b80be7a6d97bc4834d2ce6e24137515b2'
const REPLICA = Number(process.env.RUNNER_INDEX)
if (!Number.isInteger(REPLICA) || REPLICA < 1 || REPLICA > 6) throw new Error('invalid replica')
const candidateBundle = fs.readFileSync('dist/snapdom.mjs')
const baselineBundle = fs.readFileSync('baseline/dist/snapdom.mjs')
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex').toUpperCase()
const bundleSha = { baseline: sha(baselineBundle), candidate: sha(candidateBundle) }
const fixtures = {
  large: makeDeterministicPng(1200, 800, { seed: 0x51a7, entropy: true }),
  small: makeDeterministicPng(96, 96, { seed: 0x51a7, entropy: false }),
}
if (fixtures.large.length < 1000000) throw new Error('large fixture entropy collapsed')

const ARMS = [
  { id: 'large-scale', fixture: 'large', cache: 'soft',
    geometry: (i) => ({ scale: 1.15 + 0.07 * i, dpr: 1 }), expectHit: true },
  { id: 'large-width', fixture: 'large', cache: 'soft',
    geometry: (i) => ({ width: 330 + 18 * i, dpr: 1 }), expectHit: true },
  { id: 'large-same', fixture: 'large', cache: 'soft',
    geometry: () => ({ scale: 1, dpr: 1 }), expectHit: false, expectNoPosts: true },
  { id: 'small-scale', fixture: 'small', cache: 'soft',
    geometry: (i) => ({ scale: 1.15 + 0.07 * i, dpr: 1 }), expectHit: false, expectNoPosts: true },
  { id: 'cache-disabled', fixture: 'large', cache: 'disabled',
    geometry: (i) => ({ scale: 1.15 + 0.07 * i, dpr: 1 }), expectHit: false },
  { id: 'nine-image-gallery', fixture: 'large', cache: 'soft', gallery: true,
    geometry: (i) => ({ scale: 1.15 + 0.07 * i, dpr: 1 }), expectHit: null },
]

function htmlFor(side, arm) {
  const small = arm.fixture === 'small'
  const gallery = !!arm.gallery
  const count = gallery ? 9 : 1
  const imageSize = small ? [32, 32] : [300, 200]
  const sources = Array.from({ length: count }, (_, i) =>
    '<img loading="eager" decoding="sync" width="' + (small ? 96 : 1200) +
    '" height="' + (small ? 96 : 800) + '" src="/' + arm.fixture + '.png?i=' + i +
    '" style="display:block;width:' + imageSize[0] + 'px;height:' + imageSize[1] +
    'px;object-fit:cover">').join('')
  // Instrument only Worker messaging; never alter the input or the result.
  const bootstrap = [
    'window.__workerStats={posts:0,messages:0,hits:0,errors:0}',
    'const NativeWorker=window.Worker',
    'window.Worker=class extends NativeWorker {',
    'constructor(...args){super(...args);this.addEventListener("message",e=>{',
    'window.__workerStats.messages++;if(e.data?.bitmapHit===true)window.__workerStats.hits++',
    '});this.addEventListener("error",()=>window.__workerStats.errors++)}',
    'postMessage(...args){window.__workerStats.posts++;return super.postMessage(...args)}',
    '}',
    'const byteSha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(b=>b.toString(16).padStart(2,"0")).join("").toUpperCase()',
    'const snap=await import("/' + side + '.mjs")',
    'const root=document.getElementById("root")',
    'await Promise.all(Array.from(root.querySelectorAll("img")).map(img=>img.decode()))',
    'window.__capture=async opts=>{',
    'const before={...window.__workerStats}',
    'const t0=performance.now()',
    'const result=await snap.snapdom(root,{cache:opts.cache,burst:false,compress:true,embedFonts:false,...opts.geometry})',
    'const captureMs=performance.now()-t0',
    'const raw=result.toRaw()',
    'const canvas=await result.toCanvas()',
    'const totalMs=performance.now()-t0',
    'const rawSha=await byteSha(new TextEncoder().encode(raw))',
    'const pixels=canvas.getContext("2d",{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height)',
    'const pixelsSha=await byteSha(pixels.data)',
    'const after=window.__workerStats',
    'return {captureMs,totalMs,rawSha,pixelsSha,rawChars:raw.length,width:canvas.width,height:canvas.height,',
    'posts:after.posts-before.posts,messages:after.messages-before.messages,',
    'hits:after.hits-before.hits,errors:after.errors-before.errors}',
    '}',
    'window.__ready=true',
  ].join('\n')
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#root{display:grid;grid-template-columns:' +
    (gallery ? 'repeat(3,300px)' : imageSize[0] + 'px') +
    ';width:' + (gallery ? 900 : imageSize[0]) + 'px}</style></head><body><div id="root">' +
    sources + '</div><script type="module">' + bootstrap + '</script></body></html>'
}
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/candidate.mjs' || u.pathname === '/baseline.mjs') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end(u.pathname === '/candidate.mjs' ? candidateBundle : baselineBundle)
    } else if (u.pathname === '/large.png' || u.pathname === '/small.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' })
      res.end(fixtures[u.pathname === '/large.png' ? 'large' : 'small'])
    } else if (u.pathname === '/') {
      const arm = ARMS.find(a => a.id === u.searchParams.get('arm'))
      const side = u.searchParams.get('side')
      if (!arm || !['baseline', 'candidate'].includes(side)) throw new Error('invalid page')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(htmlFor(side, arm))
    } else {
      res.writeHead(404);res.end()
    }
  } catch (error) { res.writeHead(500);res.end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
let browser
const arms = {}
try {
  browser = await chromium.launch({ headless: true })
  for (const arm of ARMS) {
    const sides = {}
    try {
      for (const side of (REPLICA % 2 ? ['baseline','candidate'] : ['candidate','baseline'])) {
        const context = await browser.newContext({ deviceScaleFactor: 1 })
        const page = await context.newPage()
        const pageErrors = []
        page.on('pageerror',e=>pageErrors.push(e.message))
        page.on('console',m=>{if(m.type()==='error')pageErrors.push(m.text())})
        await page.goto(origin + '/?side=' + side + '&arm=' + arm.id)
        await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 })
        sides[side] = { context, page, pageErrors }
        // Same source/geometry warmup. Distinct target dimensions later miss compress result memo.
        for (let warm = 0; warm < 2; warm++) {
          await page.evaluate(opts => window.__capture(opts), { cache: arm.cache, geometry: { scale: 1, dpr: 1 } })
        }
      }
      const samples = []
      for (let i=0; i<8; i++) {
        const pair = {}
        const order = (i + REPLICA) % 2 === 0 ? ['baseline','candidate'] : ['candidate','baseline']
        for (const side of order) {
          pair[side] = await sides[side].page.evaluate(opts => window.__capture(opts), {
            cache: arm.cache, geometry: arm.geometry(i),
          })
          const v=pair[side]
          if (![v.captureMs,v.totalMs].every(n=>Number.isFinite(n)&&n>0)) throw new Error('nonfinite timings '+arm.id)
          if (v.errors!==0) throw new Error('worker error '+arm.id+'/'+side)
        }
        if (pair.baseline.rawSha !== pair.candidate.rawSha ||
            pair.baseline.pixelsSha !== pair.candidate.pixelsSha ||
            pair.baseline.width !== pair.candidate.width ||
            pair.baseline.height !== pair.candidate.height) throw new Error('OUTPUT_FIDELITY_FAILURE '+arm.id+'/'+i)
        if (arm.expectHit === true &&
            (pair.candidate.hits !== 1 || pair.candidate.posts !== 1 || pair.baseline.posts !== 1)) {
          throw new Error('R12 bitmap mechanism not independently reached at '+arm.id+'/'+i+' '+
            JSON.stringify({candidate:pair.candidate,baseline:pair.baseline}))
        }
        if (arm.expectHit === false && pair.candidate.hits !== 0) throw new Error('null arm hit '+arm.id)
        if (arm.expectNoPosts && (pair.candidate.posts !== 0 || pair.baseline.posts !== 0)) {
          throw new Error('null arm posted unexpected Worker task '+arm.id)
        }
        samples.push({ index:i, order, baseline:pair.baseline, candidate:pair.candidate })
      }
      for(const side of ['baseline','candidate']) {
        if(sides[side].pageErrors.length) throw new Error('page errors '+arm.id+'/'+side+':'+sides[side].pageErrors.join('; '))
      }
      arms[arm.id] = { samples, fixture:arm.fixture, cache:arm.cache, gallery:!!arm.gallery }
      console.log('[r12] replica='+REPLICA+' completed '+arm.id)
    } finally {
      await Promise.all(Object.values(sides).map(s=>s.context.close().catch(()=>{})))
    }
  }
  const evidence={
    schema:'snapdom-r12-decoded-bitmap-experiment-v1',
    runId:process.env.GITHUB_RUN_ID, candidateSha:process.env.GITHUB_SHA,
    baselineSha:BASELINE_SHA, replica:REPLICA, browserVersion:browser.version(),
    bundleSha,fixtureSha:Object.fromEntries(Object.entries(fixtures).map(([k,v])=>[k,sha(v)])),
    arms, conclusion:'EVIDENCE_ONLY', performanceClaim:false,
  }
  const out = 'lane6-scratch/r12/results/replica-' + REPLICA + '.json'
  fs.mkdirSync(path.dirname(out),{recursive:true})
  fs.writeFileSync(out,JSON.stringify(evidence))
  console.log('[r12] wrote '+out)
} finally {
  if(browser)await browser.close().catch(()=>{})
  await new Promise(resolve => server.close(resolve))
}
