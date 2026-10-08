#!/usr/bin/env node
// R20 browser-visible evidence: independent pinned source bundles, alternating public
// capture order, exact SVG/pixel differential, low-risk mutation controls and timings.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'
if(process.env.GITHUB_ACTIONS!=='true' || process.env.GITHUB_REPOSITORY!=='thelabcorner/snapdom')
  throw new Error('R20 browser measurements must be GitHub-hosted')
const engine=process.argv.find(a=>a.startsWith('--engine='))?.slice(9)
const type={chromium,firefox,webkit}[engine]
if(!type) throw new Error('unknown browser')
const bundle={
  '/baseline.mjs':fs.readFileSync(path.join(process.cwd(),'__r20_baseline/dist/snapdom.mjs')),
  '/candidate.mjs':fs.readFileSync(path.join(process.cwd(),'dist/snapdom.mjs')),
}
const srv=http.createServer((req,res)=>{
  if(bundle[req.url]){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle[req.url])}
  else{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><body></body>')}
})
await new Promise(r=>srv.listen(0,'127.0.0.1',r))
let browser
try{
  browser=await type.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1400,height:1200}})
  page.setDefaultTimeout(180000)
  await page.goto('http://127.0.0.1:'+srv.address().port)
  const result=await page.evaluate(async ()=>{
    const [{snapdom:before},{snapdom:after}]=await Promise.all([import('/baseline.mjs'),import('/candidate.mjs')])
    const baseOpts={burst:false,cache:'disabled',compress:false,embedFonts:false,dpr:1,__styleShare:false,__elementUniverse:true}
    const hash=async u=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',u))).map(b=>b.toString(16).padStart(2,'0')).join('')
    const median=xs=>xs.slice().sort((a,b)=>a-b)[xs.length>>1]
    const cases=[
      {name:'deep-inherited',depth:20,branches:12,leaves:10,css:true},
      {name:'deep-neutral',depth:24,branches:10,leaves:10,css:false},
      {name:'shallow-control',depth:1,branches:30,leaves:5,css:true},
      {name:'nested-style-veto',depth:18,branches:10,leaves:8,css:true,veto:true},
    ]
    const report=[]
    for (const cfg of cases){
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
          if(d===0) p.style.letterSpacing='0.1px'
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
      const pair=async which=>{
        const now=performance.now()
        const res=await [before,after][which](root,{...baseOpts})
        return {ms:performance.now()-now,raw:res.toRaw(),res}
      }
      const samples=[[],[]]
      for(let i=0;i<7;i++){
        const order=(i%2)?[1,0]:[0,1]
        const rows=[]
        for(const n of order) rows[n]=await pair(n)
        if(rows[0].raw!==rows[1].raw) throw new Error('raw mismatch '+cfg.name+' iteration='+i)
        if(i===0){
          const pixels=[]
          for (const n of [0,1]){
            const cv=await rows[n].res.toCanvas()
            pixels[n]=await hash(cv.getContext('2d',{willReadFrequently:true}).getImageData(0,0,cv.width,cv.height).data)
          }
          if(pixels[0]!==pixels[1]) throw new Error('pixels differ '+cfg.name)
          if(cfg.name==='deep-inherited'){
            root.firstChild.style.color='rgb(15, 78, 93)'
            const mutated0=await pair(0),mutated1=await pair(1)
            if(mutated0.raw!==mutated1.raw) throw new Error('mutation parity mismatch')
            root.firstChild.style.color='rgb(8, 9, 10)'
          }
        }else{
          for(const n of [0,1])samples[n].push(rows[n].ms)
        }
      }
      report.push({regime:cfg.name,nodes:cfg.branches*(cfg.depth+cfg.leaves)+1,parity:true,
        baselineMedianMs:median(samples[0]),candidateMedianMs:median(samples[1]),
        baselineSamplesMs:samples[0],candidateSamplesMs:samples[1]})
      root.remove();sheet.remove()
    }
    return report
  })
  for (const row of result) console.log(JSON.stringify({engine,...row}))
}finally{
  await browser?.close()
  await new Promise(r=>srv.close(r))
}
