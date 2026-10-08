#!/usr/bin/env node
// R16 preregistered hosted-only A/B. Immutable bundles are constructed by the workflow.
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'
import { makeDeterministicPng } from '../r10/asset-bench-lib.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('R16 browser acceptance and timing must run on hosted GitHub Actions')
}
const engineName = process.argv.find(x => x.startsWith('--engine='))?.slice(9) || 'chromium'
const replica = Number(process.argv.find(x => x.startsWith('--replica='))?.slice(10) || '0')
const nPairs = Number(process.argv.find(x => x.startsWith('--pairs='))?.slice(8) || '8')
const engines = { chromium, firefox, webkit }
if (!engines[engineName] || !Number.isInteger(replica) || replica < 0 ||
    !Number.isInteger(nPairs) || nPairs < 2 || nPairs % 2) throw new Error('invalid experiment arguments')
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const baseline = fs.readFileSync('r16-baseline/dist/snapdom.mjs')
const candidate = fs.readFileSync('dist/snapdom.mjs')
const image = 'data:image/png;base64,' + makeDeterministicPng(32, 32, {seed: 241, entropy: true}).toString('base64')
const cases = [
  {name:'no-background', nodes:1800, backgrounds:0, root:false},
  {name:'sparse-background', nodes:1800, backgrounds:3, root:true},
  {name:'dense-background', nodes:480, backgrounds:240, root:false},
]
function htmlFor(c) {
  const rootBg = c.root ? 'background-image:url(&quot;' + image + '&quot;);background-repeat:no-repeat;background-size:cover;' : ''
  let children = ''
  for (let i=0; i<c.nodes; i++) {
    const bg = i < c.backgrounds
      ? 'background-image:url(&quot;' + image + '&quot;);background-repeat:no-repeat;background-size:cover;'
      : ''
    children += '<div style="width:18px;height:12px;overflow:hidden;' + bg + '">x</div>'
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
    '<div id="root" style="display:grid;grid-template-columns:repeat(30,18px);width:540px;' +
    rootBg + '">' + children + '</div></body></html>'
}
const server = http.createServer((req,res)=>{
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/baseline.mjs' || url.pathname === '/candidate.mjs') {
    res.writeHead(200, {'content-type':'text/javascript'})
    res.end(url.pathname === '/baseline.mjs' ? baseline : candidate)
  } else if (url.pathname === '/') {
    const c = cases.find(item=>item.name === url.searchParams.get('case'))
    if (!c) {res.writeHead(400);res.end('invalid case');return}
    res.writeHead(200, {'content-type':'text/html;charset=utf-8'})
    res.end(htmlFor(c))
  } else {res.writeHead(404);res.end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin = 'http://127.0.0.1:' + server.address().port
let browser
const data = {}
try {
  browser = await engines[engineName].launch({headless:true})
  for (const c of cases) {
    const sides = {}
    try {
      for (const side of ['baseline','candidate']) {
        const context = await browser.newContext({deviceScaleFactor:1})
        const page = await context.newPage()
        const errors = []
        page.on('pageerror',e=>errors.push(e.message))
        await page.goto(origin + '/?case=' + c.name)
        await page.evaluate(async side => {
          const {snapdom} = await import('/' + side + '.mjs')
          window.__capture = async () => {
            const root = document.getElementById('root')
            const t0 = performance.now()
            const result = await snapdom(root, {cache:'disabled', compress:true, embedFonts:false, burst:false})
            const captureMs = performance.now()-t0
            const raw = result.toRaw()
            const canvas = await result.toCanvas()
            const totalMs = performance.now()-t0
            const digest = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)))
              .map(v=>v.toString(16).padStart(2,'0')).join('')
            const pixels = canvas.getContext('2d',{willReadFrequently:true})
              .getImageData(0,0,canvas.width,canvas.height).data
            return {
              captureMs, totalMs, rawHash:await digest(new TextEncoder().encode(raw)),
              pixelHash:await digest(pixels), width:canvas.width,height:canvas.height,
              rawLength:raw.length,
            }
          }
        }, side)
        const matched = await page.evaluate(() => ({
          all:document.getElementById('root').querySelectorAll('*').length,
          candidates:document.getElementById('root').querySelectorAll('[style*="data:image"]').length,
        }))
        sides[side] = {context,page,errors,matched}
        await page.evaluate(()=>window.__capture())
      }
      const pairs=[]
      for(let i=0;i<nPairs;i++) {
        const order=(i+replica)%2===0?['candidate','baseline']:['baseline','candidate']
        const pair={order}
        for(const side of order)pair[side]=await sides[side].page.evaluate(()=>window.__capture())
        const a=pair.baseline,b=pair.candidate
        if (!Number.isFinite(a.captureMs) || !Number.isFinite(b.captureMs) ||
            a.captureMs <= 0 || b.captureMs <= 0) throw new Error('invalid timing '+c.name)
        for(const k of ['rawHash','pixelHash','width','height','rawLength']) {
          if(a[k]!==b[k]) throw new Error('EXACT_FIDELITY_FAILURE '+engineName+'/'+c.name+'/'+i+'/'+k)
        }
        pairs.push(pair)
      }
      for(const side of ['baseline','candidate']){
        if(sides[side].errors.length)throw new Error('PAGE_ERROR '+side+' '+sides[side].errors.join(';'))
      }
      data[c.name]={pairs,candidates:sides.candidate.matched,baselineCandidates:sides.baseline.matched}
      console.log('R16 '+engineName+' replicate '+replica+' '+c.name+
        ' parity '+pairs.length+'/'+pairs.length+' candidates '+sides.candidate.matched.candidates+
        '/'+sides.candidate.matched.all)
    } finally {
      await Promise.all(Object.values(sides).map(x=>x.context.close().catch(()=>{})))
    }
  }
  const out = {
    schema:'snapdom-r16-selector-v1',engine:engineName,replica,pairs:nPairs,
    runId:process.env.GITHUB_RUN_ID,measurementSha:process.env.GITHUB_SHA,
    baselineSha:process.env.R16_BASELINE_SHA,
    browserVersion:browser.version(), runnerImage:process.env.ImageVersion,
    bundles:{baseline:sha(baseline),candidate:sha(candidate)},data,claim:false
  }
  fs.mkdirSync('lane6-scratch/r16/results',{recursive:true})
  fs.writeFileSync('lane6-scratch/r16/results/'+engineName+'-r'+replica+'.json',
    JSON.stringify(out,null,2)+'\n')
} finally {
  if(browser)await browser.close().catch(()=>{})
  await new Promise(resolve=>server.close(resolve))
}
