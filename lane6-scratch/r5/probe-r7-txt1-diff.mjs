#!/usr/bin/env node
// Inspect the first representation delta between historical extras and the TXT2 synthesis arm.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { PAGE_FIXTURE_SRC, FIXTURE_OPTIONS } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((q,r)=>{
  if(q.url?.startsWith('/m.mjs')){r.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});r.end(mod);return}
  r.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});r.end(PAGE)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`

async function arm(fixture, gate){
  const b=await chromium.launch({headless:true}); const p=await b.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1})
  try{
    await p.goto(origin); await p.waitForFunction(()=>window.__ready===true)
    return await p.evaluate(async({fixture,opts,gate})=>{
      let el,style=null
      if(fixture==='entropy-400'){
        style=document.createElement('style');style.textContent='.td-root{width:900px;font:13px Arial}.td-row{display:block;padding:2px 4px}.td-row[data-r]{outline-offset:0}';document.head.appendChild(style)
        el=document.createElement('div');el.className='td-root';for(let i=0;i<400;i++){const row=document.createElement('div');row.className='td-row';row.dataset.r=String(i);row.textContent='row '+i;el.appendChild(row)}document.body.appendChild(el)
      } else el=window.__fx.build(fixture)
      try{return await window.__m.snapdom.toRaw(el,{...opts,cache:'disabled',embedFonts:false,__snapshotDecorationSynthesis:gate})}
      finally{if(style){el.remove();style.remove()}else window.__fx.cleanup(el)}
    },{fixture,opts:FIXTURE_OPTIONS,gate})
  }finally{await p.close();await b.close()}
}

function report(name,a,b){
  let i=0; while(i<a.length&&i<b.length&&a.charCodeAt(i)===b.charCodeAt(i)) i++
  let ae=a.length-1,be=b.length-1; while(ae>=i&&be>=i&&a.charCodeAt(ae)===b.charCodeAt(be)){ae--;be--}
  console.log(`\n${name} len ${a.length}->${b.length} first=${i} oldSpan=${ae-i+1} newSpan=${be-i+1}`)
  console.log('OLD',JSON.stringify(a.slice(Math.max(0,i-300),Math.min(a.length,ae+301))))
  console.log('NEW',JSON.stringify(b.slice(Math.max(0,i-300),Math.min(b.length,be+301))))
}

try{
  for(const fixture of ['cards400-safe','entropy-400']) report(fixture,await arm(fixture,false),await arm(fixture,true))
}finally{await new Promise(r=>server.close(r))}
