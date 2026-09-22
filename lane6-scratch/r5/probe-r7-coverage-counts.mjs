#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { build } from 'esbuild'
const ROOT=process.cwd()
const entry=path.join(ROOT,'worktrees/snapdom-v3-r7-overlay-gutterfix/src/index.js')
const built=await build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',write:false,minify:false,logLevel:'silent'})
const mod=built.outputFiles[0].contents
const PAGE=`<!doctype html><html><body><script type="module">window.__m=await import('/cand.mjs');window.__ready=true</script></body></html>`
const server=http.createServer((req,res)=>{if(req.url.startsWith('/cand.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod)}else{res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)}})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true})
async function arm(overlay){
 const page=await browser.newPage({viewport:{width:1400,height:1800}});const cdp=await page.context().newCDPSession(page)
 try{
  await page.goto(origin);await page.waitForFunction(()=>window.__ready===true)
  await cdp.send('Profiler.enable');await cdp.send('Profiler.startPreciseCoverage',{callCount:true,detailed:true,allowTriggeredUpdates:false})
  await page.evaluate(async overlay=>{const st=document.createElement('style');st.textContent='.root{width:900px;font:13px Arial}.row{display:block;padding:2px 4px;color:#334155;background:#f8fafc}';document.head.appendChild(st);const root=document.createElement('div');root.className='root';for(let i=0;i<400;i++){const e=document.createElement('div');e.className='row g'+(i%2);e.textContent='row '+i;root.appendChild(e)}document.body.appendChild(root);try{await window.__m.snapdom.toRaw(root,{burst:false,cache:'disabled',embedFonts:false,__styleShareSnapshotOverlay:overlay})}finally{root.remove();st.remove()}},overlay)
  const {result}=await cdp.send('Profiler.takePreciseCoverage');await cdp.send('Profiler.stopPreciseCoverage');await cdp.send('Profiler.disable')
  const scripts=result.filter(x=>x.url.includes('/cand.mjs'))
  const f=[];for(const s of scripts)for(const x of s.functions){const calls=Math.max(0,...x.ranges.map(r=>r.count||0));if(calls)f.push({name:x.functionName,calls})}
  return f.sort((a,b)=>b.calls-a.calls)
 }finally{await page.close()}
}
try{for(const [name,val] of [['historical',false],['overlay',true]]){const rows=await arm(val);console.log('\n'+name);for(const x of rows.filter(x=>/getStyleKey|styleSignature|shareLists|getSnapshot|inlineAllStyles|stripHeight|Scrollbar|Snapshot/i.test(x.name)).slice(0,50))console.log(String(x.calls).padStart(6),x.name);console.log('top named');for(const x of rows.filter(x=>x.name).slice(0,25))console.log(String(x.calls).padStart(6),x.name)}}finally{await browser.close();await new Promise(r=>server.close(r))}
