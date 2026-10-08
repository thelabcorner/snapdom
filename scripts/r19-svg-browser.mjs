#!/usr/bin/env node
// R19 exploratory capture crossover. Public API, independent frozen bundles,
// exact raw SVG/pixel guard, balanced capture order, no cross-capture cache.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('Browser timing is GitHub-hosted only')
}
const engine = process.argv.find(x => x.startsWith('--engine='))?.slice(9)
const engines = { chromium, firefox, webkit }
if (!engines[engine]) throw new Error('unknown engine')
const root = process.cwd()
const bundles = {
  '/baseline.mjs': fs.readFileSync(path.join(root, '__r19_baseline/dist/snapdom.mjs')),
  '/candidate.mjs': fs.readFileSync(path.join(root, 'dist/snapdom.mjs')),
}
const server = http.createServer((req,res) => {
  if (bundles[req.url]) {
    res.writeHead(200, { 'content-type':'application/javascript' })
    res.end(bundles[req.url])
  } else {
    res.writeHead(200, { 'content-type':'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body></body></html>')
  }
})
await new Promise(r => server.listen(0,'127.0.0.1',r))
let browser
try {
  browser = await engines[engine].launch({headless:true})
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  const out = await page.evaluate(async () => {
    const [{snapdom:baseline},{snapdom:candidate}] = await Promise.all([
      import('/baseline.mjs'),import('/candidate.mjs')
    ])
    const seedCanvas = document.createElement('canvas')
    seedCanvas.width = seedCanvas.height = 1024
    const ctx = seedCanvas.getContext('2d')
    const image = ctx.createImageData(1024,1024)
    let state=0xbad5eed
    for (let i=0;i<image.data.length;i+=4) {
      state ^= state<<13;state ^= state>>>17;state ^= state<<5
      image.data[i]=state&255
      image.data[i+1]=(state>>>8)&255
      image.data[i+2]=(state>>>16)&255
      image.data[i+3]=255
    }
    ctx.putImageData(image,0,0)
    const dataURL=seedCanvas.toDataURL('image/png')
    if(dataURL.length < 2e6) throw new Error('large source fixture compressed unexpectedly')
    const hash=async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('')
    const median=xs=>xs.slice().sort((a,b)=>a-b)[xs.length>>1]
    const regimes=[
      {label:'large-image-repetition',rows:4,src:true},
      {label:'repetitive-inline-styles',rows:300,src:false},
      {label:'image-and-table',rows:300,src:true},
    ]
    const results=[]
    for(const cfg of regimes) {
      const root=document.createElement('div')
      root.style.cssText='width:512px;background:white'
      for(let i=0;i<cfg.rows;i++){
        const n=document.createElement('div')
        n.style.cssText='height:4px;margin:1px;background:'+(i%2?'#aaffcc':'#ffaaee')
        root.append(n)
      }
      if (cfg.src) {
        const img=document.createElement('img')
        img.src=dataURL;img.width=512;img.height=512
        img.style.cssText='display:block;width:512px;height:512px'
        root.append(img)
      }
      document.body.append(root)
      const opts={cache:'disabled',burst:false,compress:false,embedFonts:false,dpr:1}
      const times=[[],[]]
      for(let pair=0;pair<7;pair++){
        const first=pair%2
        const samples=[]
        for(const n of [first,1-first]) {
          const start=performance.now()
          const snap=await [baseline,candidate][n](root, {...opts})
          const ms=performance.now()-start
          const raw=snap.toRaw()
          samples[n]={ms,raw,snap}
        }
        if (samples[0].raw!==samples[1].raw) throw new Error('raw URL mismatch '+cfg.label+' pair '+pair)
        if(pair===0){
          const pixels=[]
          for (const n of [0,1]) {
            const canvas=await samples[n].snap.toCanvas()
            pixels[n]=await hash(canvas.getContext('2d',{willReadFrequently:true})
              .getImageData(0,0,canvas.width,canvas.height).data)
          }
          if(pixels[0]!==pixels[1]) throw new Error('pixel mismatch '+cfg.label)
        } else {
          for(const n of [0,1]) times[n].push(samples[n].ms)
        }
      }
      root.remove()
      results.push({regime:cfg.label,outputBytes:dataURL.length,
        baselineMedianMs:median(times[0]),candidateMedianMs:median(times[1]),
        baselineSamplesMs:times[0],candidateSamplesMs:times[1],parity:true})
    }
    return results
  })
  for(const x of out) console.log(JSON.stringify({engine,...x}))
} finally {
  await browser?.close()
  await new Promise(r => server.close(r))
}
