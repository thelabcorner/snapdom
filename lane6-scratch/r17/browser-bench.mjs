#!/usr/bin/env node
// Hosted only; compare immutable R12 baseline and R17 compiled outputs.
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'
import { makeDeterministicPng } from '../r10/asset-bench-lib.mjs'
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='thelabcorner/snapdom') throw Error('GitHub-hosted only')
const a=key=>process.argv.find(x=>x.startsWith('--'+key+'='))?.split('=')[1]
const engine=a('engine')||'chromium',replica=Number(a('replica')||0),pairs=Number(a('pairs')||8)
if(!['chromium','firefox','webkit'].includes(engine)||!Number.isInteger(replica)||replica<0||!Number.isInteger(pairs)||pairs<2||pairs%2)throw Error('bad args')
const selfNull = process.argv.includes('--self-null')
const sameSource = fs.readFileSync('r17-baseline/dist/snapdom.mjs')
const bundles={baseline:sameSource,candidate:selfNull?sameSource:fs.readFileSync('dist/snapdom.mjs')}
const fixtureImages=Array.from({length:9},(_,i)=>makeDeterministicPng(960,640,{seed:0x7654321+i,entropy:true}))
const cases=[
 {id:'html-only',html:5,bg:0,svg:0,compress:true},
 {id:'mixed-assets',html:2,bg:2,svg:2,compress:true},
 {id:'svg-background-only',html:0,bg:2,svg:3,compress:true},
 {id:'no-compress',html:2,bg:2,svg:2,compress:false},
].filter(x=>!selfNull||x.id==='no-compress')
const imageUrl=i=>'/image-'+i+'.png'
function htmlFor(c){
 let out=''
 let n=0
 for(let i=0;i<c.html;i++)out+='<img src="'+imageUrl(n++)+'" width="240" height="160" style="width:240px;height:160px;object-fit:cover;display:block">'
 for(let i=0;i<c.bg;i++)out+='<div style="display:block;width:240px;height:160px;background-size:cover;background-repeat:no-repeat;background-image:url(&quot;'+imageUrl(n++)+'&quot;)"></div>'
 for(let i=0;i<c.svg;i++)out+='<svg width="240" height="160" viewBox="0 0 240 160"><image href="'+imageUrl(n++)+'" x="0" y="0" width="240" height="160"/></svg>'
 return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#root{display:grid;grid-template-columns:repeat(3,240px);width:720px}</style></head><body><div id="root">'+out+'</div></body></html>'
}
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1')
 if(u.pathname==='/baseline.mjs'||u.pathname==='/candidate.mjs'){
  res.writeHead(200,{'content-type':'text/javascript'});res.end(bundles[u.pathname.slice(1, -4)]);return
 }
 const m=u.pathname.match(/^\/image-(\d+)\.png$/)
 if(m&&+m[1]<fixtureImages.length){res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=3600'});res.end(fixtureImages[+m[1]]);return}
 if(u.pathname==='/'){const c=cases.find(c=>c.id===u.searchParams.get('arm'));if(c){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(htmlFor(c));return}}
 res.writeHead(404);res.end()
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+server.address().port
let browser
const arms={}
try{
 browser=await ({chromium,firefox,webkit})[engine].launch({headless:true})
 for(const c of cases){
  const sides={}
  const sharedContext=selfNull&&process.argv.includes('--shared-context')?await browser.newContext({deviceScaleFactor:1}):null
  try {
   for(const side of ['baseline','candidate']){
    const context=sharedContext||await browser.newContext({deviceScaleFactor:1})
    const page=await context.newPage()
    const errors=[]
    page.on('pageerror',e=>errors.push(e.message))
    page.on('console',e=>{if(e.type()==='error')errors.push(e.text())})
    await page.goto(origin+'/?arm='+c.id)
    await page.evaluate(async ({side,compress})=>{
     const {snapdom}=await import('/'+side+'.mjs')
     const root=document.getElementById('root')
     await Promise.all(Array.from(root.querySelectorAll('img')).map(el=>el.decode()))
     const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',v))).map(i=>i.toString(16).padStart(2,'0')).join('')
     window.__capture=async()=>{
      const t0=performance.now()
      const result=await snapdom(root,{cache:'disabled',compress,embedFonts:false,burst:false})
      const captureMs=performance.now()-t0
      const raw=result.toRaw()
      const canvas=await result.toCanvas()
      const totalMs=performance.now()-t0
      const pixels=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data
      let nontransparent=0
      for(let p=3;p<pixels.length;p+=4)if(pixels[p])nontransparent++
      const probe=(x,y)=>Array.from(pixels.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+4))
      return {captureMs,totalMs,rawHash:await digest(new TextEncoder().encode(raw)),pixelHash:await digest(pixels),nontransparent,centerPixel:probe(Math.floor(canvas.width/2),Math.floor(canvas.height/2)),width:canvas.width,height:canvas.height,rawLength:raw.length,compressedAssets:((raw.startsWith('data:image/svg+xml')?decodeURIComponent(raw.slice(raw.indexOf(',')+1)):raw).match(/data-snapdom-asset=/g)||[]).length}
     }
    },{side,compress:c.compress})
    sides[side]={context,page,errors}
    await page.evaluate(()=>window.__capture()) // warmup per side
   }
   const samples=[]
   for(let k=0;k<pairs;k++){
    const order=(k+replica)%2===0?['baseline','candidate']:['candidate','baseline']
    const pair={order}
    for(const side of order)pair[side]=await sides[side].page.evaluate(()=>window.__capture())
    for(const metric of ['rawHash','pixelHash','width','height','rawLength','compressedAssets']){
     if(pair.baseline[metric]!==pair.candidate[metric])throw Error('PARITY '+engine+'/'+c.id+'/'+k+'/'+metric+': '+JSON.stringify({baseline:{value:pair.baseline[metric],nontransparent:pair.baseline.nontransparent,centerPixel:pair.baseline.centerPixel},candidate:{value:pair.candidate[metric],nontransparent:pair.candidate.nontransparent,centerPixel:pair.candidate.centerPixel}}))
    }
    for(const side of order)if(!Number.isFinite(pair[side].captureMs)||pair[side].captureMs<=0)throw Error('bad timing')
    if(c.compress&&c.id==='mixed-assets'&&pair.candidate.compressedAssets<3)throw Error('FAIL_CLOSED: mixed-assets compression paths not reached')
    if(c.id==='html-only'&&pair.candidate.compressedAssets<2)throw Error('FAIL_CLOSED: HTML-image compression path not reached')
    if(!c.compress&&pair.candidate.compressedAssets!==0)throw Error('FAIL_CLOSED: no-compress emitted asset rewrites')
    samples.push(pair)
   }
   for(const side of ['baseline','candidate'])if(sides[side].errors.length)throw Error('console/page errors: '+side+' '+sides[side].errors.join(';'))
   arms[c.id]={samples,layout:c}
   console.log('R17 '+engine+' r'+replica+' '+c.id+' fidelity '+pairs+'/'+pairs+' compressionAssets '+samples[0].candidate.compressedAssets)
  } finally {if(sharedContext)await sharedContext.close().catch(()=>{});else await Promise.all(Object.values(sides).map(s=>s.context.close().catch(()=>{})))}
 }
 const sha=v=>crypto.createHash('sha256').update(v).digest('hex')
 const out={schema:'snapdom-r17-mixed-asset-v1',engine,replica,selfNull,runId:process.env.GITHUB_RUN_ID,measurementSha:process.env.GITHUB_SHA,baselineSha:process.env.R17_BASELINE_SHA,browserVersion:browser.version(),runnerImage:process.env.ImageVersion,bundles:Object.fromEntries(Object.entries(bundles).map(([k,v])=>[k,sha(v)])),fixtures:fixtureImages.map(sha),arms}
 fs.mkdirSync('lane6-scratch/r17/results',{recursive:true})
 fs.writeFileSync('lane6-scratch/r17/results/'+engine+'-r'+replica+'.json',JSON.stringify(out,null,2))
}finally{
 if(browser)await browser.close().catch(()=>{})
 await new Promise(resolve=>server.close(resolve))
}
