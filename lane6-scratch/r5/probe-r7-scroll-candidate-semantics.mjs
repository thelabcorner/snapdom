#!/usr/bin/env node
// R7 burst scroll-candidate semantics: which computed overflow values admit programmatic
// scrolling, and how large is the conservative overflow-based candidate set? No timings.
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'
import { PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const PAGE=`<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>','<\\/script>')}</script><script>window.__ready=true</script></body></html>`
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`

try{
  for(const [name,launcher] of Object.entries({chromium,firefox,webkit})){
    const browser=await launcher.launch({headless:true})
    try{
      const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1});await page.goto(origin);await page.waitForFunction(()=>window.__ready===true)
      const semantics=await page.evaluate(()=>{
        const vals=['visible','clip','hidden','auto','scroll','overlay']
        const out=[]
        for(const v of vals){
          const el=document.createElement('div');el.style.cssText=`width:40px;height:40px;overflow:${v};position:absolute;left:-9999px;top:-9999px`
          const child=document.createElement('div');child.style.cssText='width:120px;height:120px';el.appendChild(child);document.body.appendChild(el)
          const cs=getComputedStyle(el);el.scrollLeft=17;el.scrollTop=19
          out.push({requested:v,computedX:cs.overflowX,computedY:cs.overflowY,left:el.scrollLeft,top:el.scrollTop,sw:el.scrollWidth,cw:el.clientWidth,sh:el.scrollHeight,ch:el.clientHeight})
          el.remove()
        }
        return out
      })
      console.log(`\n${name} overflow semantics`);for(const x of semantics)console.log(x)
      const counts=await page.evaluate(()=>{
        const rows=[]
        for(const fixture of ['light-20cards','cards400-safe','cards400-neutral-unsafe','cards400-non-neutral','asset-heavy']){
          const root=window.__fx.build(fixture);let total=0,candidates=0,nonzero=0,actual=0
          try{
            for(const el of [root,...root.querySelectorAll('*')]){
              total++
              const cs=getComputedStyle(el),ox=cs.overflowX,oy=cs.overflowY
              if(!['visible','clip'].includes(ox)||!['visible','clip'].includes(oy))candidates++
              if(el.scrollLeft||el.scrollTop)nonzero++
              if(el.scrollWidth>el.clientWidth||el.scrollHeight>el.clientHeight)actual++
            }
          }finally{window.__fx.cleanup(root)}
          rows.push({fixture,total,candidates,nonzero,actual})
        }
        return rows
      })
      console.log(`${name} candidate cardinality`,counts)
      await page.close()
    }finally{await browser.close()}
  }
}finally{await new Promise(r=>server.close(r))}
