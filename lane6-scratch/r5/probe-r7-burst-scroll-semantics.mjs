#!/usr/bin/env node
// R7-BRST1 deterministic native-boundary probe. NO wall-time claims.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { PAGE_FIXTURE_SRC, FIXTURE_OPTIONS } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>','<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req,res)=>{if(req.url?.startsWith('/m.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod);return}res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`

const fixtures = ['cards400-safe','asset-heavy','entropy-400']
const engines = { chromium, firefox, webkit }

async function runArm(browserType, fixture, semantic) {
  const browser = await browserType.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  try {
    await page.goto(origin); await page.waitForFunction(()=>window.__ready===true)
    return await page.evaluate(async ({fixture, semantic, opts}) => {
      const root = fixture === 'entropy-400' ? (() => {
        const st=document.createElement('style');st.textContent='.rr-root{width:900px;font:13px Arial}.rr-row{display:block;width:120px;white-space:nowrap}.rr-row[data-r]{outline-offset:0}';document.head.appendChild(st)
        const el=document.createElement('div');el.className='rr-root';for(let i=0;i<400;i++){const row=document.createElement('div');row.className='rr-row';row.dataset.r=String(i);row.textContent='entropy row '+i+' xxxxxxxxxxxxxxxxxxxx';el.appendChild(row)}document.body.appendChild(el);el.__cleanup=()=>{el.remove();st.remove()};return el
      })() : window.__fx.build(fixture)
      const props=['scrollWidth','clientWidth','scrollHeight','clientHeight','scrollLeft','scrollTop']
      const counts=Object.fromEntries(props.map(p=>[p,0]))
      const restores=[]
      for(const prop of props){
        let owner=root
        owner=Element.prototype
        while(owner && !Object.getOwnPropertyDescriptor(owner,prop)) owner=Object.getPrototypeOf(owner)
        const d=owner && Object.getOwnPropertyDescriptor(owner,prop)
        if(!d?.get || !d.configurable) continue
        Object.defineProperty(owner,prop,{...d,get(){counts[prop]++;return d.get.call(this)}})
        restores.push(()=>Object.defineProperty(owner,prop,d))
      }
      const snap = () => Object.fromEntries(props.map(p=>[p,counts[p]]))
      const delta=(a,b)=>Object.fromEntries(props.map(p=>[p,b[p]-a[p]]))
      try {
        const options={...opts,burst:true,__burstSemanticScrollTracking:semantic}
        const z0=snap(); const raw1=await window.__m.snapdom.toRaw(root,options); const z1=snap()
        const raw2=await window.__m.snapdom.toRaw(root,options); const z2=snap()
        return { raw1, raw2, first:delta(z0,z1), hit:delta(z1,z2), memoEqual:raw1===raw2 }
      } finally {
        while(restores.length) restores.pop()()
        if(root.__cleanup) root.__cleanup(); else window.__fx.cleanup(root)
      }
    }, { fixture, semantic, opts: FIXTURE_OPTIONS })
  } finally { await page.close(); await browser.close() }
}

try {
  for(const [engine,browserType] of Object.entries(engines)){
    console.log(`\n${engine}`)
    for(const fixture of fixtures){
      const h=await runArm(browserType,fixture,false)
      const s=await runArm(browserType,fixture,true)
      const sum=o=>Object.values(o).reduce((a,b)=>a+b,0)
      const dims=o=>o.scrollWidth+o.clientWidth+o.scrollHeight+o.clientHeight
      const offs=o=>o.scrollLeft+o.scrollTop
      console.log(`${fixture.padEnd(18)} parity=${h.raw1===s.raw1?'PASS':'FAIL'} memo=${h.memoEqual&&s.memoEqual?'PASS':'FAIL'}`)
      console.log(`  first dims ${dims(h.first)} -> ${dims(s.first)} offsets ${offs(h.first)} -> ${offs(s.first)} total ${sum(h.first)} -> ${sum(s.first)}`)
      console.log(`  hit   dims ${dims(h.hit)} -> ${dims(s.hit)} offsets ${offs(h.hit)} -> ${offs(s.hit)} total ${sum(h.hit)} -> ${sum(s.hit)}`)
    }
  }
} finally { await new Promise(r=>server.close(r)) }
