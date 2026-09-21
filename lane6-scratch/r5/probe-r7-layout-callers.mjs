#!/usr/bin/env node
// R7 residual layout-getter caller attribution on the current integrated scout. No timings.
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT=process.cwd()
const entry=path.join(ROOT,'worktrees/snapdom-v3-r7-style-authority-integration/src/index.js')
const built=await build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',write:false,minify:false,logLevel:'silent'})
const mod=built.outputFiles[0].contents
const PAGE=`<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>','<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server=http.createServer((req,res)=>{if(req.url?.startsWith('/m.mjs')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod);return}res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true})
try{
  const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1});await page.goto(origin);await page.waitForFunction(()=>window.__ready===true)
  for(const fixture of ['cards400-safe','asset-heavy','entropy-400']){
    const rows=await page.evaluate(async({fixture,opts})=>{
      const counts=new Map(), restores=[]
      const wrapGetter=(proto,name)=>{
        const d=Object.getOwnPropertyDescriptor(proto,name);if(!d?.get||!d.configurable)return
        Object.defineProperty(proto,name,{...d,get:function(){
          const stack=(new Error().stack||'').split('\n').slice(2,9).map(x=>x.trim().replace(/https?:\/\/[^/]+\/m\.mjs:\d+:\d+/,'m.mjs')).join(' <- ')
          const key=name+' | '+stack;counts.set(key,(counts.get(key)||0)+1);return d.get.call(this)
        }})
        restores.push(()=>Object.defineProperty(proto,name,d))
      }
      for(const [p,n] of [[Element.prototype,'scrollWidth'],[Element.prototype,'scrollHeight'],[Element.prototype,'clientWidth'],[Element.prototype,'clientHeight'],[HTMLElement.prototype,'offsetWidth'],[HTMLElement.prototype,'offsetHeight']])wrapGetter(p,n)
      let el,st=null
      if(fixture==='entropy-400'){
        st=document.createElement('style');st.textContent='.r7e{width:900px;font:13px Arial}.r7r{display:block;padding:2px}.r7r[data-i]{outline-offset:0}';document.head.appendChild(st)
        el=document.createElement('div');el.className='r7e';for(let i=0;i<400;i++){const r=document.createElement('div');r.className='r7r';r.dataset.i=i;r.textContent='row '+i;el.appendChild(r)}document.body.appendChild(el)
      }else el=window.__fx.build(fixture)
      try{await window.__m.snapdom.toRaw(el,{...opts,cache:'disabled',embedFonts:false})}
      finally{if(fixture==='entropy-400'){el.remove();st.remove()}else window.__fx.cleanup(el);while(restores.length)restores.pop()()}
      return [...counts].map(([key,count])=>({key,count})).sort((a,b)=>b.count-a.count).slice(0,40)
    },{fixture,opts:FIXTURE_OPTIONS})
    console.log('\n'+fixture);for(const r of rows)console.log(String(r.count).padStart(6),r.key)
  }
  await page.close()
}finally{await browser.close();await new Promise(r=>server.close(r))}
