#!/usr/bin/env node
// R20 hosted-browser paired measurements. Each source version owns a separate browser page:
// this prevents the severe same-page first/second capture timing oscillation in the R20 scout.
// A/A identical-source control is run alongside the candidate A/B, with exact raw/pixel gates.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom')
  throw new Error('R20 browser measurements must be GitHub-hosted')
const engine = process.argv.find(a=>a.startsWith('--engine='))?.slice(9)
const browserType={chromium,firefox,webkit}[engine]
if(!browserType) throw new Error('unsupported browser')
const RUNS=Number(process.argv.find(a=>a.startsWith('--pairs='))?.slice(8) || 12)
const bundles={
  '/baseline.mjs':fs.readFileSync(path.join(process.cwd(),'__r20_baseline/dist/snapdom.mjs')),
  '/candidate.mjs':fs.readFileSync(path.join(process.cwd(),'dist/snapdom.mjs')),
}
const srv=http.createServer((req,res)=>{
  if(bundles[req.url]){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundles[req.url])}
  else{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><html><body></body></html>')}
})
await new Promise(r=>srv.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+srv.address().port
let browser
try {
  browser=await browserType.launch({headless:true})
  const regimes=[
    {name:'deep-inherited',depth:20,branches:12,leaves:10,css:true},
    {name:'deep-neutral',depth:24,branches:10,leaves:10,css:false},
    {name:'deep-wide-stress',depth:64,branches:8,leaves:32,css:true},
    {name:'ultra-deep-stress',depth:192,branches:3,leaves:18,css:true},
    {name:'shallow-control',depth:1,branches:30,leaves:5,css:true},
    {name:'nested-style-veto',depth:18,branches:10,leaves:8,css:true,veto:true},
  ]
  const median=xs=>xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)]
  const pairedEffect=(a,b)=>100*(Math.exp(b.reduce((acc,v,i)=>acc+Math.log(v/a[i]),0)/b.length)-1)
  async function initialize(page,source,cfg){
    await page.goto(origin)
    return page.evaluate(async ({source,cfg})=>{
      const {snapdom}=await import('/'+source+'.mjs')
      const sheet=document.createElement('style')
      sheet.textContent=cfg.css
        ? '.node {display:block;font-size:11px}.leaf {display:inline-block;padding:1px}.branch {font-weight:400;color:rgb(8, 9, 10)}'
        : '.root {background-color:rgb(255,255,255)}'
      if(cfg.veto) sheet.textContent += '\n[data-force="yes"] * {all:inherit}'
      document.head.append(sheet)
      const root=document.createElement('div')
      root.style.cssText='width:500px;background:white'
      root.className='root'
      for(let k=0;k<cfg.branches;k++){
        let el=root
        for(let d=0;d<cfg.depth;d++){
          const p=document.createElement('div')
          p.className='node branch'
          p.style.fontFamily='Arial'
          p.style.color='rgb(8, 9, 10)'
          if(d===0)p.style.letterSpacing='0.1px'
          el.append(p);el=p
        }
        for(let j=0;j<cfg.leaves;j++){
          const leaf=document.createElement('span')
          leaf.className='node leaf'
          leaf.textContent='item-'+k+'-'+j
          leaf.style.cssText='font-size:11px;line-height:13px;color:rgb(20, 30, 40);padding:1px;'
          el.append(leaf)
        }
      }
      document.body.append(root)
      // R20 acts only on fresh or invalidated snapshots. A warm repeated capture may
      // bypass elementUniverseFor via the separate cross-capture snapshot WeakMap; merely
      // using cache:'disabled' does not establish that this mechanism was exercised.
      // Force the documented style-cache invalidation on EACH capture in both arms.
      const options={burst:false,cache:'disabled',invalidate:true,compress:false,embedFonts:false,dpr:1,__styleShare:false,__elementUniverse:true}
      const hex=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
        .map(v=>v.toString(16).padStart(2,'0')).join('')
      window.__runner={
        async probe(){
          const stats={}
          await snapdom(root,{...options,__ancestorUniverseTelemetry:stats})
          return stats
        },
        async snap(pixels=false){
          const t0=performance.now()
          const res=await snapdom(root,{...options})
          const ms=performance.now()-t0
          const raw=res.toRaw()
          let pixelHash=null
          if(pixels){
            const cv=await res.toCanvas()
            pixelHash=await hex(cv.getContext('2d',{willReadFrequently:true}).getImageData(0,0,cv.width,cv.height).data)
          }
          return {ms,raw,pixelHash}
        },
        change(color){root.firstChild.style.color=color}
      }
      return {nodes:cfg.branches*(cfg.depth+cfg.leaves)+1}
    },{source,cfg})
  }
  async function run(cfg,sourceA='baseline',sourceB='candidate',pairs=RUNS){
    const pages=await Promise.all([browser.newPage({viewport:{width:1400,height:1200}}),
      browser.newPage({viewport:{width:1400,height:1200}})])
    try{
      pages.forEach(p=>p.setDefaultTimeout(180000))
      await Promise.all(pages.map((p,i)=>initialize(p,i?sourceB:sourceA,cfg)))
      const take=(i,pixels=false)=>pages[i].evaluate(p=>window.__runner.snap(p),pixels)
      // A source-level optimization must prove that the experiment actually exercised it.
      // Probe FIRST, before any other snapshots can be reused; invalidate:true ensures
      // that every later timing sample is also genuinely eligible.
      const telemetry=sourceB==='candidate'
        ? await pages[1].evaluate(()=>window.__runner.probe()) : null
      if(sourceB==='candidate' && !cfg.veto && !(telemetry?.summaryUses > 0))
        throw new Error('candidate ancestor-memo was never exercised '+cfg.name+' '+JSON.stringify(telemetry))
      const rawProbe=await Promise.all(pages.map((_,i)=>take(i,true)))
      if(rawProbe[0].raw!==rawProbe[1].raw || rawProbe[0].pixelHash!==rawProbe[1].pixelHash)
        throw new Error('fresh parity mismatch '+cfg.name)
      // Verify between-capture changed inherited styles produce identical frozen snapshots.
      if(cfg.name==='deep-inherited'){
        await Promise.all(pages.map(p=>p.evaluate(()=>window.__runner.change('rgb(15, 78, 93)'))))
        const mutated=await Promise.all(pages.map((_,i)=>take(i,true)))
        if(mutated[0].raw!==mutated[1].raw || mutated[0].pixelHash!==mutated[1].pixelHash)
          throw new Error('ancestor mutation mismatch')
        await Promise.all(pages.map(p=>p.evaluate(()=>window.__runner.change('rgb(8, 9, 10)'))))
      }
      // Mirror warmups independently. Timing excludes the cold browser/template costs.
      for(let n=0;n<3;n++) for(const i of n%2?[1,0]:[0,1]) await take(i)
      const values=[[],[]]
      for(let n=0;n<pairs;n++){
        const row=[]
        for(const i of n%2?[1,0]:[0,1]) row[i]=await take(i)
        if(row[0].raw!==row[1].raw) throw new Error('measured output mismatch '+cfg.name+' pair '+n)
        for(const i of [0,1]) values[i].push(row[i].ms)
      }
      return {regime:cfg.name,sourceA,sourceB,nodes:cfg.branches*(cfg.depth+cfg.leaves)+1,telemetry,
        parity:true,pairs,baselineMedianMs:median(values[0]),candidateMedianMs:median(values[1]),
        pairedEffectPct:pairedEffect(values[0],values[1]),
        baselineSamplesMs:values[0],candidateSamplesMs:values[1]}
    }finally{await Promise.all(pages.map(p=>p.close()))}
  }
  const all=[]
  for(const cfg of regimes) all.push(await run(cfg))
  // Same-source control directly tests whether apparent speedups survive page/slot bias.
  all.push(await run(regimes[0],'baseline','baseline',8))
  for(const row of all) console.log(JSON.stringify({engine,...row}))
}finally{
  await browser?.close()
  await new Promise(r=>srv.close(r))
}
