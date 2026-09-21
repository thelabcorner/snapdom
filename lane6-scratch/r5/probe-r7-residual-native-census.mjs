#!/usr/bin/env node
// R7 residual native-boundary census. Deterministic call counts only; NO wall-time claims.
// Purpose: rank remaining browser/native crossings on the corrected 456ca8f frontier before
// proposing another optimization family.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const REL = 'worktrees/snapdom-v3-clean-456/dist/snapdom.mjs'
const mod = fs.readFileSync(path.join(ROOT, REL))
const sha = crypto.createHash('sha256').update(mod).digest('hex').toUpperCase()
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>','<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req,res)=>{if(req.url?.startsWith('/m.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod);return}res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true,args:['--no-first-run','--disable-extensions']})
const fixtures=['light-20cards','cards400-safe','cards400-neutral-unsafe','cards400-non-neutral','asset-heavy','entropy-400']

try {
  const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1})
  await page.goto(origin); await page.waitForFunction(()=>window.__ready===true)
  for(const fixture of fixtures){
    const result=await page.evaluate(async ({fixture,opts})=>{
      const counts=Object.create(null)
      const restorers=[]
      const wrapMethod=(obj,name,label=name)=>{
        if(!obj) return
        const d=Object.getOwnPropertyDescriptor(obj,name)
        const original=obj[name]
        if(typeof original!=='function') return
        try{
          obj[name]=function(...args){counts[label]=(counts[label]||0)+1;return original.apply(this,args)}
          restorers.push(()=>{try{obj[name]=original}catch{}})
        }catch{}
      }
      const originalGCS=window.getComputedStyle
      try{window.getComputedStyle=function(...args){counts.getComputedStyle=(counts.getComputedStyle||0)+1;return originalGCS.apply(this,args)};restorers.push(()=>{window.getComputedStyle=originalGCS})}catch{}
      wrapMethod(CSSStyleDeclaration.prototype,'getPropertyValue','getPropertyValue')
      wrapMethod(Element.prototype,'matches','matches')
      wrapMethod(Element.prototype,'getBoundingClientRect','getBoundingClientRect')
      wrapMethod(Element.prototype,'getClientRects','getClientRects')
      wrapMethod(Element.prototype,'querySelector','element.querySelector')
      wrapMethod(Element.prototype,'querySelectorAll','element.querySelectorAll')
      wrapMethod(Document.prototype,'querySelector','document.querySelector')
      wrapMethod(Document.prototype,'querySelectorAll','document.querySelectorAll')
      if(globalThis.ShadowRoot){wrapMethod(ShadowRoot.prototype,'querySelector','shadow.querySelector');wrapMethod(ShadowRoot.prototype,'querySelectorAll','shadow.querySelectorAll')}
      if(Element.prototype.computedStyleMap) wrapMethod(Element.prototype,'computedStyleMap','computedStyleMap')
      let el
      let entropyStyle=null
      if(fixture==='entropy-400'){
        entropyStyle=document.createElement('style');entropyStyle.textContent='.rr-root{width:900px;font:13px Arial}.rr-row{display:block;padding:2px 4px}.rr-row[data-r]{outline-offset:0}';document.head.appendChild(entropyStyle)
        el=document.createElement('div');el.className='rr-root'
        for(let i=0;i<400;i++){const row=document.createElement('div');row.className='rr-row';row.dataset.r=String(i);row.textContent='row '+i;el.appendChild(row)}document.body.appendChild(el)
      }else el=window.__fx.build(fixture)
      try{
        const raw=await window.__m.snapdom.toRaw(el,{...opts,cache:'disabled'})
        return {counts,bytes:raw.length}
      }finally{
        if(fixture==='entropy-400'){el.remove();entropyStyle?.remove()}else window.__fx.cleanup(el)
        while(restorers.length) restorers.pop()()
      }
    },{fixture,opts:FIXTURE_OPTIONS})
    const c=result.counts
    const order=['getPropertyValue','getComputedStyle','matches','getBoundingClientRect','getClientRects','computedStyleMap','element.querySelector','element.querySelectorAll','document.querySelector','document.querySelectorAll','shadow.querySelector','shadow.querySelectorAll']
    console.log(`\n${fixture} rawBytes=${result.bytes}`)
    for(const k of order) if(c[k]) console.log(`  ${k.padEnd(24)} ${String(c[k]).padStart(8)}`)
  }
  console.log(`\nbundle ${sha.slice(0,12)} bytes=${mod.length}`)
}finally{await browser.close();await new Promise(r=>server.close(r))}