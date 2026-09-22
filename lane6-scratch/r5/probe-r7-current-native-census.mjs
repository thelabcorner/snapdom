#!/usr/bin/env node
// R7 current integrated residual native-boundary census. Deterministic call counts only.
// Compares corrected 456ca8f against the current style-authority/PC1/SA6 scout.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mods = {
  baseline: fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-clean-456/dist/snapdom.mjs')),
  current: fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs')),
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase().slice(0, 12)
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__mods={baseline:await import('/baseline.mjs'),current:await import('/current.mjs')};window.__ready=true</script></body></html>`
const server = http.createServer((req,res)=>{
  if(req.url?.startsWith('/baseline.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mods.baseline);return}
  if(req.url?.startsWith('/current.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mods.current);return}
  res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true,args:['--no-first-run','--disable-extensions']})
const fixtures=['light-20cards','cards400-safe','cards400-neutral-unsafe','cards400-non-neutral','asset-heavy','entropy-400']

try {
  const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1})
  await page.goto(origin);await page.waitForFunction(()=>window.__ready===true)
  for(const fixture of fixtures){
    console.log(`\n${fixture}`)
    const rows={}
    for(const which of ['baseline','current']){
      rows[which]=await page.evaluate(async ({fixture,which,opts})=>{
        const counts=Object.create(null),restorers=[]
        const wrapMethod=(obj,name,label=name)=>{
          if(!obj)return
          const original=obj[name]
          if(typeof original!=='function')return
          try{obj[name]=function(...args){counts[label]=(counts[label]||0)+1;return original.apply(this,args)};restorers.push(()=>{try{obj[name]=original}catch{}})}catch{}
        }
        const wrapGetter=(obj,name,label=name)=>{
          if(!obj)return
          const d=Object.getOwnPropertyDescriptor(obj,name)
          if(!d?.get||!d.configurable)return
          try{Object.defineProperty(obj,name,{...d,get:function(){counts[label]=(counts[label]||0)+1;return d.get.call(this)}});restorers.push(()=>{try{Object.defineProperty(obj,name,d)}catch{}})}catch{}
        }
        const og=window.getComputedStyle
        window.getComputedStyle=function(...args){counts.getComputedStyle=(counts.getComputedStyle||0)+1;return og.apply(this,args)}
        restorers.push(()=>{window.getComputedStyle=og})
        wrapMethod(CSSStyleDeclaration.prototype,'getPropertyValue','getPropertyValue')
        wrapMethod(Element.prototype,'matches','matches')
        wrapMethod(Element.prototype,'getBoundingClientRect','getBoundingClientRect')
        wrapMethod(Element.prototype,'getClientRects','getClientRects')
        wrapMethod(Element.prototype,'querySelector','element.querySelector')
        wrapMethod(Element.prototype,'querySelectorAll','element.querySelectorAll')
        wrapMethod(Document.prototype,'querySelector','document.querySelector')
        wrapMethod(Document.prototype,'querySelectorAll','document.querySelectorAll')
        for(const [proto,name] of [
          [Element.prototype,'scrollWidth'],[Element.prototype,'scrollHeight'],[Element.prototype,'clientWidth'],[Element.prototype,'clientHeight'],
          [HTMLElement.prototype,'offsetWidth'],[HTMLElement.prototype,'offsetHeight'],
        ]) wrapGetter(proto,name,name)
        if(Element.prototype.computedStyleMap)wrapMethod(Element.prototype,'computedStyleMap','computedStyleMap')
        let el,st=null
        if(fixture==='entropy-400'){
          st=document.createElement('style');st.textContent='.rr-root{width:900px;font:13px Arial}.rr-row{display:block;padding:2px 4px}.rr-row[data-r]{outline-offset:0}';document.head.appendChild(st)
          el=document.createElement('div');el.className='rr-root';for(let i=0;i<400;i++){const r=document.createElement('div');r.className='rr-row';r.dataset.r=String(i);r.textContent='row '+i;el.appendChild(r)}document.body.appendChild(el)
        }else el=window.__fx.build(fixture)
        try{const raw=await window.__mods[which].snapdom.toRaw(el,{...opts,cache:'disabled',embedFonts:false});return {counts,bytes:raw.length}}
        finally{if(fixture==='entropy-400'){el.remove();st?.remove()}else window.__fx.cleanup(el);while(restorers.length)restorers.pop()()}
      },{fixture,which,opts:FIXTURE_OPTIONS})
    }
    const keys=[...new Set([...Object.keys(rows.baseline.counts),...Object.keys(rows.current.counts)])]
      .sort((a,b)=>(rows.baseline.counts[b]||0)-(rows.baseline.counts[a]||0))
    for(const k of keys){
      const a=rows.baseline.counts[k]||0,b=rows.current.counts[k]||0,d=b-a
      if(a||b)console.log(`  ${k.padEnd(25)} ${String(a).padStart(7)} -> ${String(b).padStart(7)}  ${d>=0?'+':''}${d}`)
    }
    console.log(`  bytes ${rows.baseline.bytes}/${rows.current.bytes} ${rows.baseline.bytes===rows.current.bytes?'EQ':'DIFF'}`)
  }
  console.log(`\nbaseline ${sha(mods.baseline)} current ${sha(mods.current)}`)
} finally {await browser.close();await new Promise(r=>server.close(r))}
