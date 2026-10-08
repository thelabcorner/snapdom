#!/usr/bin/env node
/**
 * R21 independent cross-engine acceptance for the frozen R20 ancestor-universe memo.
 * NO production modifications: a separately compiled, pinned pre-R20 baseline is the oracle.
 *
 * Parity is exact SVG data-URL equality AND equality of the rendered RGBA SHA-256 digest.
 * Captures explicitly invalidate style snapshots to exercise R20's actual hot path.
 * Stateful changes happen between captures and are applied identically to two pages.
 */
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('R21 browser acceptance must use a hosted GitHub Actions runner')
}
const engine = process.argv.find(x=>x.startsWith('--engine='))?.split('=')[1]
const browserType = { chromium, firefox, webkit }[engine]
if (!browserType) throw new Error('Unsupported engine')
const baseline=await fs.readFile('__r21_baseline/dist/snapdom.mjs')
const candidate=await fs.readFile('dist/snapdom.mjs')
const srv=http.createServer((req,res)=>{
  const item=req.url==='/A.mjs'?baseline:req.url==='/B.mjs'?candidate:null
  res.writeHead(200,{'content-type':item?'text/javascript':'text/html; charset=utf-8',
    'cache-control':'no-store'})
  res.end(item||'<!doctype html><html><body></body></html>')
})
await new Promise(r=>srv.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+srv.address().port
let browser
const result=[]
try {
  browser=await browserType.launch({headless:true})
  const cases=[
    {name:'inherited-cssom-attribute',depth:64,leaves:12,mode:'cssom'},
    {name:'deep-hover-pseudo',depth:90,leaves:8,mode:'hover'},
    {name:'shadow-slot-mutation',depth:40,leaves:8,mode:'shadow'},
    {name:'semantic-risk-veto',depth:60,leaves:8,mode:'risk'},
    {name:'ultra-deep-cutoff',depth:1028,leaves:1,mode:'deep'},
  ]
  async function init(page,side,cfg){
    await page.goto(origin)
    return await page.evaluate(async({side,cfg})=>{
      const {snapdom}=await import('/'+side+'.mjs')
      const css=document.createElement('style')
      css.id='author-css'
      css.textContent=`
        .scene { font-family: Arial,sans-serif; background:#fff; width:640px; }
        .branch { color:rgb(31, 43, 59); line-height:14px; }
        .leaf { font-size:11px; display:inline-block; padding:2px 3px; }
        .scene[data-state="changed"] .leaf { color:rgb(73, 21, 125) }
        .scene > div { border-left:1px solid rgb(20,30,40) }
      `
      if(cfg.mode==='hover')css.textContent+='\n.scene:hover .leaf:last-child { text-decoration:underline }'
      document.head.append(css)
      const root=document.createElement('div')
      root.className='scene'
      for(let b=0;b<2;b++){
        let parent=root
        for(let i=0;i<cfg.depth;i++){
          const el=document.createElement('div')
          el.className='branch'
          if(i%19===0)el.style.letterSpacing='0.12px'
          if(i%23===0)el.style.fontWeight='400'
          parent.append(el);parent=el
        }
        for(let j=0;j<cfg.leaves;j++){
          const leaf=document.createElement('span')
          leaf.className='leaf'
          leaf.textContent='Αλφα Ωμέγα 漢字 '+b+' '+j
          parent.append(leaf)
        }
        if(cfg.mode==='shadow'){
          const host=document.createElement('span')
          const shadow=host.attachShadow({mode:'open'})
          const style=document.createElement('style')
          style.textContent='slot { display:inline } .nested {color:rgb(21,36,77)}'
          const slot=document.createElement('slot')
          const child=document.createElement('span')
          child.className='nested'
          child.textContent='slotted text'
          shadow.append(style,slot,child)
          const assigned=document.createElement('b')
          assigned.textContent='distributed'
          host.append(assigned);parent.append(host)
        }
      }
      if(cfg.mode==='risk'){
        const a=document.createElement('a')
        a.setAttribute('href','#valid')
        a.textContent='risk link'
        root.lastChild.append(a)
      }
      document.body.append(root)
      const opts={burst:false,cache:'disabled',invalidate:true,compress:false,
        embedFonts:false,dpr:1,__styleShare:false,__elementUniverse:true}
      const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
        .map(x=>x.toString(16).padStart(2,'0')).join('')
      window.__r21={
        async capture(){
          const stats={}
          const cap=await snapdom(root,{...opts,__ancestorUniverseTelemetry:stats})
          const raw=cap.toRaw()
          const canvas=await cap.toCanvas()
          const rgba=canvas.getContext('2d',{willReadFrequently:true})
            .getImageData(0,0,canvas.width,canvas.height).data
          return {raw,pixels:await sha(rgba),stats,width:canvas.width,height:canvas.height}
        },
        async change(stage){
          if(stage==='attribute')root.setAttribute('data-state','changed')
          if(stage==='cssom')css.sheet.cssRules[1].style.setProperty('color','rgb(130, 61, 19)')
          if(stage==='inline')root.lastChild.style.color='rgb(155, 26, 63)'
          if(stage==='append'){
            const el=document.createElement('span')
            el.className='leaf'
            el.textContent='late inserted leaf'
            root.lastChild.append(el)
          }
          if(stage==='shadow'){
            const host=Array.from(root.querySelectorAll('span')).find(node=>node.shadowRoot)
            if(host?.shadowRoot){
              const child=document.createElement('i')
              child.textContent=' new shadow content'
              host.shadowRoot.append(child)
            }
          }
          if(stage==='risk'){
            const em=document.createElement('em')
            em.textContent='semantic update'
            root.lastChild.append(em)
          }
        },
      }
    },{side,cfg})
  }
  const fingerprint=({raw,pixels,width,height})=>({raw,pixels,width,height})
  for(const cfg of cases){
    const [a,b]=await Promise.all([browser.newPage(),browser.newPage()])
    try {
      a.setDefaultTimeout(180000);b.setDefaultTimeout(180000)
      await Promise.all([init(a,'A',cfg),init(b,'B',cfg)])
      const steps=cfg.mode==='deep'?['initial','inline']:['initial','attribute','cssom','inline','append']
      if(cfg.mode==='shadow')steps.push('shadow')
      if(cfg.mode==='risk')steps.push('risk')
      if(cfg.mode==='hover')steps.push('hover')
      let previous=null, active=0
      for(const step of steps){
        if(step==='hover')await Promise.all([a,b].map(p=>p.hover('.scene')))
        else if(step!=='initial')await Promise.all([a,b].map(p=>p.evaluate(s=>window.__r21.change(s),step)))
        const [left,right]=await Promise.all([a,b].map(p=>p.evaluate(()=>window.__r21.capture())))
        const x=fingerprint(left),y=fingerprint(right)
        if(x.raw!==y.raw||x.pixels!==y.pixels||x.width!==y.width||x.height!==y.height)
          throw new Error('R21 exact output/pixel mismatch '+engine+' '+cfg.name+' '+step)
        if(step==='initial' && cfg.mode==='cssom' && !(right.stats?.summaryUses>0))
          throw new Error('R20 ancestor memo not exercised '+engine+' '+cfg.name)
        if(previous && previous.raw!==x.raw)active++
        previous=x
        result.push({engine,case:cfg.name,step,parity:true,pixels:x.pixels,
          summaryUses:right.stats?.summaryUses||0})
      }
      if(active===0)throw new Error('R21 mutation stimulus ineffective '+cfg.name)
    } finally {await Promise.all([a.close(),b.close()])}
  }
  const out={schema:'r21-fidelity-v1',engine,pinnedBaseline:'cac07a4108086718bc9511663346e1b9fcf4e226',
    candidate:process.env.GITHUB_SHA,checks:result.length,results:result}
  await fs.mkdir('lane6-scratch/r21/evidence',{recursive:true})
  await fs.writeFile('lane6-scratch/r21/evidence/'+engine+'.json',JSON.stringify(out,null,2))
  console.log(JSON.stringify({engine,checks:result.length,allExact:true,cases:cases.map(x=>x.name)}))
}finally {
  await browser?.close()
  await new Promise(r=>srv.close(r))
}
