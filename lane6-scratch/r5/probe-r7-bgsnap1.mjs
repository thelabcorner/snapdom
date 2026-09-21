#!/usr/bin/env node
// R7-BGSNAP1 fresh-page causal probe. Deterministic browser-bound call counts; no wall claims.
import fs from 'node:fs'
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'

const mod = fs.readFileSync('dist/snapdom.mjs')
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lxR3WQAAAABJRU5ErkJggg==','base64')
const server = http.createServer((req,res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'}); res.end(mod); return }
  if (req.url?.startsWith('/font/')) { setTimeout(()=>{res.writeHead(200,{'content-type':'font/ttf','cache-control':'no-store'});res.end(Buffer.from('AA==','base64'))},10); return }
  if (req.url?.startsWith('/img/')) { setTimeout(()=>{res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});res.end(PNG_BYTES)},35); return }
  res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'}); res.end('<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>')
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`
const engine=process.env.BROWSER||'chromium'
const browser=await ({chromium,firefox,webkit}[engine]).launch({headless:true})

async function one(gate, token) {
  const context=await browser.newContext({viewport:{width:1400,height:1800},deviceScaleFactor:1})
  const page=await context.newPage()
  try {
    await page.goto(`${origin}/?${token}`); await page.waitForFunction(()=>window.__ready)
    return await page.evaluate(async({gate})=>{
      let fontEvents=0;const onFont=()=>fontEvents++;document.fonts?.addEventListener?.('loadingdone',onFont)
      const style=document.createElement('style')
      style.textContent="@font-face{font-family:Probe;src:url('/font/probe.ttf')} .root{width:900px;padding:10px;background:#fff;font:13px Arial}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}.card{position:relative;padding:6px;border:1px solid #cbd5e1;border-radius:6px;background-image:url('/img/a.png');background-size:24px 12px}.fonty{font-family:Probe,Arial;font-size:12px}"
      document.head.appendChild(style)
      const root=document.createElement('div');root.className='root';const grid=document.createElement('div');grid.className='grid'
      for(let i=0;i<60;i++){
        const card=document.createElement('div');card.className='card'
        const img=document.createElement('img');img.src='/img/a.png';img.width=60;img.height=24
        const p=document.createElement('p');p.className='fonty';p.textContent='asset '+i+' text'
        const span=document.createElement('span');span.textContent='s'+i
        card.append(img,p,span);grid.appendChild(card)
      }
      root.appendChild(grid);document.body.appendChild(root)
      const proto=CSSStyleDeclaration.prototype,original=proto.getPropertyValue
      let gpv=0,bg=0
      proto.getPropertyValue=function(prop){gpv++;if(/^(?:background|mask|-webkit-mask|border-image)/.test(String(prop)))bg++;return original.apply(this,arguments)}
      try{
        const raw=await window.__m.snapdom.toRaw(root,{cache:'disabled',burst:false,embedFonts:false,__backgroundFontEpochReuse:gate,__maskLayoutSourceGate:false})
        return {raw,gpv,bg,fontEvents}
      }finally{
        proto.getPropertyValue=original;document.fonts?.removeEventListener?.('loadingdone',onFont);root.remove();style.remove()
      }
    },{gate})
  } finally { await page.close(); await context.close() }
}

try{
  const hist=await one(false,`${engine}-hist-${Date.now()}`)
  const cand=await one(true,`${engine}-cand-${Date.now()+1}`)
  console.log(`${engine} gPV ${hist.gpv}->${cand.gpv} saved=${hist.gpv-cand.gpv} bg ${hist.bg}->${cand.bg} fontEvents=${hist.fontEvents}/${cand.fontEvents} raw=${hist.raw===cand.raw?'EQ':'DIFF'}`)
}finally{await browser.close();await new Promise(r=>server.close(r))}
