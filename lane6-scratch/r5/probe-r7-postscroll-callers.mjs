#!/usr/bin/env node
// Post-scroll R7 residual caller attribution. Deterministic call counts only; NO timing claims.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { PAGE_FIXTURE_SRC, FIXTURE_OPTIONS } from '../atlas/profiler/fixtures.mjs'
const ROOT=process.cwd()
const mod=fs.readFileSync(path.join(ROOT,'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE=`<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>','<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server=http.createServer((req,res)=>{if(req.url?.startsWith('/m.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod);return}res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true})
function topRows(map,n=20){return [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n)}
try{
 const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1});await page.goto(origin);await page.waitForFunction(()=>window.__ready===true)
 for(const fixture of ['cards400-safe','cards400-non-neutral','asset-heavy','entropy-400']){
  const r=await page.evaluate(async({fixture,opts})=>{
   const g=new Map(),m=new Map();let gp=0,ma=0;const restorers=[]
   const caller=()=>{const s=(new Error()).stack?.split('\n')||[];for(let i=2;i<s.length;i++){const x=s[i].trim();if(!x.includes('caller (eval')&&!x.includes('CSSStyleDeclaration.value')&&!x.includes('Element.value'))return x.replace(/https?:\/\/[^/]+\//g,'/')}return '?'}
   const owner=CSSStyleDeclaration.prototype,d=Object.getOwnPropertyDescriptor(owner,'getPropertyValue'),orig=owner.getPropertyValue
   try{Object.defineProperty(owner,'getPropertyValue',{...d,value:function(...args){gp++;const k=caller();g.set(k,(g.get(k)||0)+1);return orig.apply(this,args)}});restorers.push(()=>Object.defineProperty(owner,'getPropertyValue',d))}catch{}
   const md=Object.getOwnPropertyDescriptor(Element.prototype,'matches'),mo=Element.prototype.matches
   try{Object.defineProperty(Element.prototype,'matches',{...md,value:function(...args){ma++;const k=caller();m.set(k,(m.get(k)||0)+1);return mo.apply(this,args)}});restorers.push(()=>Object.defineProperty(Element.prototype,'matches',md))}catch{}
   let el,st=null
   if(fixture==='entropy-400'){st=document.createElement('style');st.textContent='.rr-root{width:900px;font:13px Arial}.rr-row{display:block;padding:2px 4px}.rr-row[data-r]{outline-offset:0}';document.head.appendChild(st);el=document.createElement('div');el.className='rr-root';for(let i=0;i<400;i++){const row=document.createElement('div');row.className='rr-row';row.dataset.r=String(i);row.textContent='row '+i;el.appendChild(row)}document.body.appendChild(el)}else el=window.__fx.build(fixture)
   try{const raw=await window.__m.snapdom.toRaw(el,{...opts,cache:'disabled'});return{bytes:raw.length,gp,ma,g:[...g],m:[...m]}}finally{if(st){el.remove();st.remove()}else window.__fx.cleanup(el);while(restorers.length)restorers.pop()()}
  },{fixture,opts:FIXTURE_OPTIONS})
  console.log(`\n${fixture} gPV=${r.gp} matches=${r.ma} bytes=${r.bytes}`)
  console.log('gPV callers');for(const[k,v]of topRows(new Map(r.g)))console.log(String(v).padStart(7),k)
  console.log('matches callers');for(const[k,v]of topRows(new Map(r.m)))console.log(String(v).padStart(7),k)
 }
}finally{await browser.close();await new Promise(r=>server.close(r))}
