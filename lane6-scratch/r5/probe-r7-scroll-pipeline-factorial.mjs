#!/usr/bin/env node
// R7 BRST1 x BRST2 deterministic 2x2. Native getter counts only; NO wall time.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { PAGE_FIXTURE_SRC, FIXTURE_OPTIONS } from '../atlas/profiler/fixtures.mjs'

const ROOT=process.cwd()
const mod=fs.readFileSync(path.join(ROOT,'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE=`<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>','<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server=http.createServer((req,res)=>{if(req.url?.startsWith('/m.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod);return}res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)})
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`
const props=['scrollWidth','clientWidth','scrollHeight','clientHeight','scrollLeft','scrollTop']

async function arm(browserType, fixture, b, w){
  const browser=await browserType.launch({headless:true}); const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1})
  try{await page.goto(origin);await page.waitForFunction(()=>window.__ready===true)
    return await page.evaluate(async({fixture,b,w,opts,props})=>{
      let cleanup=()=>{}; let root
      if(fixture==='entropy-400'){
        const st=document.createElement('style');st.textContent='.r{width:900px}.x{display:block;width:120px;white-space:nowrap}';document.head.appendChild(st)
        root=document.createElement('div');root.className='r';for(let i=0;i<400;i++){const e=document.createElement('div');e.className='x';e.textContent='row '+i+' xxxxxxxxxxxxxxxxxxxxx';root.appendChild(e)}document.body.appendChild(root);cleanup=()=>{root.remove();st.remove()}
      }else root=window.__fx.build(fixture), cleanup=()=>window.__fx.cleanup(root)
      const counts=Object.fromEntries(props.map(x=>[x,0]));const restore=[]
      for(const prop of props){let owner=Element.prototype;while(owner&&!Object.getOwnPropertyDescriptor(owner,prop))owner=Object.getPrototypeOf(owner);const d=owner&&Object.getOwnPropertyDescriptor(owner,prop);if(!d?.get||!d.configurable)continue;Object.defineProperty(owner,prop,{...d,get(){counts[prop]++;return d.get.call(this)}});restore.push(()=>Object.defineProperty(owner,prop,d))}
      try{const raw=await window.__m.snapdom.toRaw(root,{...opts,burst:true,__burstSemanticScrollTracking:b,__wrapScrolledSemanticGate:w});return{raw,counts}}
      finally{while(restore.length)restore.pop()();cleanup()}
    },{fixture,b,w,opts:FIXTURE_OPTIONS,props})
  }finally{await page.close();await browser.close()}
}
const fixtures=['cards400-safe','entropy-400']
try{
 for(const [engine,browserType] of Object.entries({chromium,firefox,webkit})){
  console.log(`\n${engine}`)
  for(const fixture of fixtures){
   const out={}; for(const b of [false,true])for(const w of [false,true])out[`${+b}${+w}`]=await arm(browserType,fixture,b,w)
   const ref=out['00'].raw; console.log(fixture, Object.entries(out).every(([,x])=>x.raw===ref)?'PARITY=PASS':'PARITY=FAIL')
   for(const key of ['00','10','01','11']){const c=out[key].counts;const dims=c.scrollWidth+c.clientWidth+c.scrollHeight+c.clientHeight;const offs=c.scrollLeft+c.scrollTop;console.log(`  ${key} dims=${dims} offsets=${offs} total=${dims+offs}`)}
  }
 }
}finally{await new Promise(r=>server.close(r))}
