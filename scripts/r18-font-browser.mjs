// R18: frozen R12 vs capture-local font-variant memo, complete SVG and pixel parity.
// Browser timing uses public snapdom API with embedFonts:true to force font usage collection.
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
const arg=(key,fallback)=>process.argv.find(x=>x.startsWith('--'+key+'='))?.slice(key.length+3)||fallback
const runner=Number(arg('runner','0'))
const baseline=await readFile(resolve(arg('baseline','baseline/dist/snapdom.mjs')))
const candidate=await readFile(resolve(arg('candidate','dist/snapdom.mjs')))
const out=resolve(arg('out','r18-evidence/runner-'+runner+'.json'))
const sha=x=>createHash('sha256').update(x).digest('hex')
const scenarios=[
  {name:'font-repeat-1200',count:1200,kind:'repeated',embedFonts:true},
  {name:'font-fallback-1200',count:1200,kind:'fallback',embedFonts:true},
  {name:'font-entropy-350',count:350,kind:'entropy',embedFonts:true},
  {name:'font-repeat-400',count:400,kind:'repeated',embedFonts:true},
  {name:'font-phase-off',count:1200,kind:'repeated',embedFonts:false}
]
const server=createServer((req,res)=>{
  const url=new URL(req.url||'/','http://localhost')
  if(url.pathname==='/baseline.mjs'||url.pathname==='/candidate.mjs'){
    res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'})
    res.end(url.pathname==='/baseline.mjs'?baseline:candidate)
    return
  }
  if(url.pathname==='/'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'})
    res.end('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#stage{display:grid;grid-template-columns:repeat(8,140px);gap:2px;width:1150px;font:12px sans-serif}#stage>span{display:block;min-width:0;height:20px;white-space:nowrap;overflow:hidden}</style></head><body><div id="stage"></div></body></html>')
    return
  }
  res.writeHead(404);res.end('not found')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+server.address().port
let browser
async function pixelHash(page,url) {
  return page.evaluate(async encoded=>{
    const img=new Image();img.src=encoded;await img.decode()
    const canvas=document.createElement('canvas')
    canvas.width=Math.max(1,img.naturalWidth);canvas.height=Math.max(1,img.naturalHeight)
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0)
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data
    const digest=await crypto.subtle.digest('SHA-256',pixels)
    return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')
  },url)
}
async function measure(sc){
  const page=await browser.newPage({viewport:{width:1280,height:1000},deviceScaleFactor:1})
  try{
    await page.goto(origin+'/',{waitUntil:'load'})
    await page.evaluate(async cfg=>{
      const mods=await Promise.all([import('/baseline.mjs'),import('/candidate.mjs')])
      if(typeof mods[0].snapdom!=='function'||typeof mods[1].snapdom!=='function')
        throw Error('named public snapdom API missing')
      const root=document.getElementById('stage')
      const fragment=document.createDocumentFragment()
      for(let i=0;i<cfg.count;i++){
        const el=document.createElement('span')
        const family=cfg.kind==='entropy' ? '"R18 Unique '+i+'", sans-serif' :
          cfg.kind==='fallback' ? '"R18 Name", "R18 Symbols", Arial, sans-serif' :
          '"R18 Name", Arial, sans-serif'
        el.style.fontFamily=family
        el.style.fontWeight=i%7===0?'700':'400'
        el.style.fontStyle=i%13===0?'italic':'normal'
        el.textContent='Text 42 Ω '+(i%20)
        fragment.appendChild(el)
      }
      root.appendChild(fragment)
      const methods={A:mods[0].snapdom,B:mods[1].snapdom}
      window.__r18={
        capture:async which=>{
          const t0=performance.now()
          const result=await methods[which](root,{burst:false,cache:'disabled',compress:false,embedFonts:cfg.embedFonts})
          return {ms:performance.now()-t0,raw:result.url}
        }
      }
    },sc)
    for(const arm of ['A','B'])await page.evaluate(x=>window.__r18.capture(x),arm)
    const pairs=[]
    for(let i=0;i<8;i++){
      const order=(runner+i)%2===0?['A','B']:['B','A']
      const arm={}
      for(const which of order)arm[which]=await page.evaluate(x=>window.__r18.capture(x),which)
      if(arm.A.raw!==arm.B.raw)
        throw Error(sc.name+' pair '+i+' raw SVG mismatch '+sha(arm.A.raw)+' != '+sha(arm.B.raw))
      if(i===0||i===7){
        const pixels=await Promise.all([pixelHash(page,arm.A.raw),pixelHash(page,arm.B.raw)])
        if(pixels[0]!==pixels[1])throw Error(sc.name+' pair '+i+' pixel mismatch')
      }
      pairs.push({order:order.join(''),A:{ms:arm.A.ms},B:{ms:arm.B.ms},rawSha256:sha(arm.A.raw)})
    }
    return {scenario:sc,pairs,exactRaw:true,exactPixels:true}
  }finally{await page.close()}
}
const results=[]
try{
  browser=await chromium.launch({headless:true,args:['--disable-background-timer-throttling']})
  for(const sc of scenarios){
    results.push(await measure(sc))
    const last=results.at(-1)
    const ratios=last.pairs.map(p=>100*(p.B.ms/p.A.ms-1)).sort((a,b)=>a-b)
    console.log(JSON.stringify({runner,scenario:sc.name,medianChangePct:ratios[Math.floor(ratios.length/2)],parity:true}))
  }
  await mkdir(dirname(out),{recursive:true})
  await writeFile(out,JSON.stringify({
    schema:'snapdom-r18-font-paired-v1',runner,
    baselineSha:process.env.BASELINE_SHA,candidateSha:process.env.CANDIDATE_SHA,
    runnerImage:process.env.ImageVersion||null,node:process.version,scenarios:results
  },null,2))
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
