#!/usr/bin/env node
// R13 hosted-only COLD Worker end-to-end experiment: prime Blob memo without opening Worker.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { chromium } from 'playwright'
import { makeDeterministicPng } from '../lane6-scratch/r10/asset-bench-lib.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('R13 capture experiments are GitHub-Actions-only')
}
const BASELINE_SHA = 'ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b'
const REPLICA = Number(process.env.RUNNER_INDEX)
if (!Number.isInteger(REPLICA) || REPLICA < 1 || REPLICA > 6) throw new Error('invalid replica')
const candidateBundle = fs.readFileSync('dist/snapdom.mjs')
const baselineBundle = fs.readFileSync('__r12_reference/dist/snapdom.mjs')
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex').toUpperCase()
const bundleSha = { baseline: sha(baselineBundle), candidate: sha(candidateBundle) }
const fixtures = {
  large: makeDeterministicPng(1200, 800, { seed: 0x51a7, entropy: true }),
  small: makeDeterministicPng(96, 96, { seed: 0x51a7, entropy: false }),
}
if (fixtures.large.length < 1000000) throw new Error('large fixture entropy collapsed')

const ARMS = [
  { id: 'six-shared-source', fixture: 'large', cache: 'soft', six: true, shared: true,
    geometry: (i) => ({ scale: 1.15 + 0.07 * i, dpr: 1 }), expectedPosts: 6 },
  { id: 'six-distinct-sources', fixture: 'large', cache: 'soft', six: true, shared: false,
    geometry: (i) => ({ scale: 1.15 + 0.07 * i, dpr: 1 }), expectedPosts: 6 },
  { id: 'single-image-control', fixture: 'large', cache: 'soft', six: false, shared: false,
    geometry: (i) => ({ scale: 1.15 + 0.07 * i, dpr: 1 }), expectedPosts: 1 },
]

function htmlFor(side, arm) {
  const count = arm.six ? 6 : 1
  const sources = Array.from({ length: count }, (_, i) => {
    const width = arm.six ? 216 + 17 * i : 300
    const height = arm.six ? 144 + 11 * i : 200
    const suffix = arm.shared ? '' : '?i=' + i
    return '<img loading="eager" decoding="sync" width="1200" height="800" src="/' +
      arm.fixture + '.png' + suffix +
      '" style="display:block;width:' + width + 'px;height:' + height +
      'px;object-fit:cover">'
  }).join('')
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
    'window.__prime=async()=>{',
    'const paths=[...new Set(Array.from(root.querySelectorAll("img")).map(img=>img.getAttribute("src")))]',
    'for(const src of paths){',
    'const img=document.createElement("img");img.setAttribute("src",src);img.width=1200;img.height=800;',
    'img.style.cssText="display:block;width:1200px;height:800px;object-fit:contain";',
    'document.body.append(img);try{await img.decode();',
    'const result=await snap.snapdom(img,{cache:"soft",burst:false,compress:true,embedFonts:false,scale:1,dpr:1});',
    'result.toRaw();}finally{img.remove()}}',
    'if(window.__workerStats.posts!==0)throw new Error("cold preprime reached Worker unexpectedly");',
    '}',
    'window.__ready=true',
  ].join('\n')
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}#root{display:grid;grid-template-columns:' +
    (arm.six ? 'repeat(3,280px)' : '300px') +
    ';width:' + (arm.six ? 840 : 300) + 'px}</style></head><body><div id="root">' +
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
    const samples = []
    for (let i=0; i<8; i++) {
      const pair = {}
      const order = (i + REPLICA) % 2 === 0 ? ['baseline','candidate'] : ['candidate','baseline']
      for (const side of order) {
        // Every observation gets a new document/Worker. Prime only the fetched Blob
        // memo through the PNG-header no-gain route; decoded Worker cache stays COLD.
        const context = await browser.newContext({ deviceScaleFactor: 1 })
        try {
          const page = await context.newPage()
          const pageErrors = []
          page.on('pageerror',e=>pageErrors.push(e.message))
          page.on('console',m=>{if(m.type()==='error')pageErrors.push(m.text())})
          await page.goto(origin + '/?side=' + side + '&arm=' + arm.id)
          await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 })
          await page.evaluate(() => window.__prime())
          pair[side] = await page.evaluate(opts => window.__capture(opts), {
            cache: arm.cache, geometry: arm.geometry(i),
          })
          const v = pair[side]
          if (![v.captureMs,v.totalMs].every(n=>Number.isFinite(n)&&n>0))
            throw new Error('nonfinite timings '+arm.id+'/'+side+'/'+i)
          if(v.errors!==0)throw new Error('worker error '+arm.id+'/'+side+'/'+i)
          if(pageErrors.length)throw new Error('page errors '+arm.id+'/'+side+':'+pageErrors.join('; '))
        } finally {
          await context.close().catch(()=>{})
        }
      }
      if (pair.baseline.rawSha!==pair.candidate.rawSha||
          pair.baseline.pixelsSha!==pair.candidate.pixelsSha||
          pair.baseline.width!==pair.candidate.width||
          pair.baseline.height!==pair.candidate.height)
        throw new Error('OUTPUT_FIDELITY_FAILURE '+arm.id+'/'+i)
      if(pair.baseline.posts<arm.expectedPosts||pair.candidate.posts<arm.expectedPosts)
        throw new Error('cold-Worker compression not reached '+arm.id+'/'+i+' '+
          JSON.stringify({baseline:pair.baseline.posts,candidate:pair.candidate.posts}))
      if(arm.shared&&pair.candidate.hits<4)
        throw new Error('shared-Blob single-flight not exercised '+arm.id+'/'+i)
      samples.push({ index:i, order, baseline:pair.baseline, candidate:pair.candidate })
    }
    arms[arm.id]={ samples, fixture:arm.fixture, cache:arm.cache, shared:!!arm.shared, six:!!arm.six,
      decodedWorkerCold:true }
    console.log('[r13-cold] replica='+REPLICA+' completed '+arm.id)
  }
  const evidence={
    schema:'snapdom-r13-cold-capture-singleflight-v1',
    runId:process.env.GITHUB_RUN_ID, candidateSha:process.env.GITHUB_SHA,
    baselineSha:BASELINE_SHA, replica:REPLICA, browserVersion:browser.version(), runnerImageVersion:process.env.ImageVersion||null,
    bundleSha,fixtureSha:Object.fromEntries(Object.entries(fixtures).map(([k,v])=>[k,sha(v)])),
    arms, conclusion:'EVIDENCE_ONLY', performanceClaim:false,
  }
  const out = 'lane6-scratch/r13/cold-capture-results/replica-' + REPLICA + '.json'
  fs.mkdirSync(path.dirname(out),{recursive:true})
  fs.writeFileSync(out,JSON.stringify(evidence))
  console.log('[r13] wrote '+out)
} finally {
  if(browser)await browser.close().catch(()=>{})
  await new Promise(resolve => server.close(resolve))
}
