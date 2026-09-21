#!/usr/bin/env node
// Deterministic R7 representation probe using the candidate SOURCE modules.
// No timings are reported. It inspects the actual snapshots cached by a real capture.
import http from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const candidate = path.join(ROOT, 'worktrees/snapdom-v3-r7-overlay-gutterfix')
const entry = `
  export { snapdom } from ${JSON.stringify(path.join(candidate, 'src/index.js').replaceAll('\\\\','/'))};
  export { snapshotFor } from ${JSON.stringify(path.join(candidate, 'src/modules/styles.js').replaceAll('\\\\','/'))};
`
const built = await build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'r7-probe-entry.js' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = `<!doctype html><html><body><script type="module">
window.__m = await import('/probe.mjs'); window.__ready = true;
</script></body></html>`
const server = http.createServer((req,res)=>{
  if(req.url==='/probe.mjs'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod);return}
  res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true})
const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1})
try{
  await page.goto(origin); await page.waitForFunction(()=>window.__ready===true)
  const out=await page.evaluate(async()=>{
    const make=(n=400,cardinality=2)=>{
      const st=document.createElement('style')
      st.textContent='.root{width:900px;font:13px Arial,sans-serif}.row{display:block;padding:2px 4px;color:#334155;background:#f8fafc}'
      document.head.appendChild(st)
      const root=document.createElement('div');root.className='root'
      for(let i=0;i<n;i++){const e=document.createElement('div');e.className='row g'+(i%cardinality);e.textContent='row '+i;root.appendChild(e)}
      document.body.appendChild(root)
      return {root,rows:[...root.children],cleanup(){root.remove();st.remove()}}
    }
    const arm=async overlay=>{
      const x=make()
      try{
        await window.__m.snapdom.toRaw(x.root,{burst:false,cache:'disabled',embedFonts:false,__styleShareSnapshotOverlay:overlay})
        const shapes=x.rows.map((el,i)=>{
          const s=window.__m.snapshotFor(el)
          const own=Object.keys(s)
          const all=[];for(const k in s)all.push(k)
          const proto=Object.getPrototypeOf(s)
          const protoKeys=proto&&proto!==Object.prototype?Object.keys(proto):[]
          let tombstones=0,shadowed=0
          for(const k of own){if(s[k]==='')tombstones++;if(proto&&proto!==Object.prototype&&Object.prototype.hasOwnProperty.call(proto,k))shadowed++}
          return {i,own:own.length,all:all.length,proto:protoKeys.length,tombstones,shadowed,hasOverlay:!!(proto&&proto!==Object.prototype)}
        })
        return shapes
      }finally{x.cleanup()}
    }
    return {historical:await arm(false),overlay:await arm(true)}
  })
  const summarize=rows=>{
    const sum=k=>rows.reduce((a,x)=>a+x[k],0)
    const overlayRows=rows.filter(x=>x.hasOverlay)
    const avg=(k,rs=rows)=>rs.length?rs.reduce((a,x)=>a+x[k],0)/rs.length:0
    return {nodes:rows.length,overlayNodes:overlayRows.length,avgOwn:+avg('own').toFixed(2),avgAll:+avg('all').toFixed(2),avgProto:+avg('proto').toFixed(2),avgOwnOverlay:+avg('own',overlayRows).toFixed(2),avgProtoOverlay:+avg('proto',overlayRows).toFixed(2),avgShadowedOverlay:+avg('shadowed',overlayRows).toFixed(2),tombstones:sum('tombstones')}
  }
  const report={historical:summarize(out.historical),overlay:summarize(out.overlay),overlaySample:out.overlay.slice(0,6)}
  const dest=path.join(ROOT,'lane6-scratch/r5/results/r7-overlay-shape-real.json');fs.writeFileSync(dest,JSON.stringify(report,null,2))
  console.log(JSON.stringify(report,null,2));console.log('artifact lane6-scratch/r5/results/r7-overlay-shape-real.json')
}finally{await browser.close();await new Promise(r=>server.close(r))}
