#!/usr/bin/env node
// R8-PWH1 production-cost harness: current SO1+FP1 integration bundle vs PWH1 bundle.
// Unlike the internal option counterfactual, this comparison includes PWH1's stylesheet-scan
// proof cost, which is paid even on pages where the rider never admits.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'

const ROOT = process.cwd()
const arg = (name, fallback) => {
  const p = `--${name}=`
  const x = process.argv.find((v) => v.startsWith(p))
  return x ? x.slice(p.length) : fallback
}
const QUICK = process.argv.includes('--quick')
const PARITY_ONLY = process.argv.includes('--parity-only')
const BASE_REL = arg('base', '../snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs')
const CAND_REL = arg('candidate', 'dist/snapdom.mjs')
const N = Number(arg('n', QUICK ? 8 : 20))
const BATCH = Number(arg('batch', QUICK ? 2 : 3))
const WARM = Number(arg('warmup', QUICK ? 1 : 3))
const BOOT = Number(arg('bootstrap', QUICK ? 4000 : 10000))
const EPS = Number(arg('epsilon', 0.02))
const ENGINE = arg('browser', 'chromium').toLowerCase()
const ONLY = new Set(arg('only', '').split(',').map((x) => x.trim()).filter(Boolean))
const baseMod = fs.readFileSync(path.resolve(ROOT, BASE_REL))
const candMod = fs.readFileSync(path.resolve(ROOT, CAND_REL))
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r8/results')
fs.mkdirSync(OUT, { recursive: true })

const FIXTURES = [
  ['inline-before-400', 400, 1, 'inlineBefore'],
  ['inline-both-400', 400, 1, 'inlineBoth'],
  ['inline-inert-token-400', 400, 1, 'inlineInert'],
  ['inline-unrelated-container-400', 400, 1, 'inlineUnrelatedContainer'],
  ['inline-mixed-400', 400, 20, 'inlineUnique'],
  ['inline-pairs-400', 400, 200, 'inlineUnique'],
  ['inline-triples-360', 360, 120, 'inlineUnique'],
  ['inline-entropy-400', 400, 400, 'inlineUnique'],
  ['inline-block-400', 400, 1, 'inlineBlock'],
  ['block-400', 400, 1, 'block'],
  ['container-veto-400', 400, 1, 'container'],
  ['no-pseudo-400', 400, 1, 'none'],
  ['no-pseudo-many-rules-400', 400, 400, 'manyRules'],
].filter(([name]) => !ONLY.size || ONLY.has(name))

const OPTS = { burst: false, cache: 'disabled', embedFonts: false }
const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
function color(i){return 'rgb('+((i*47)%256)+','+((i*83)%256)+','+((i*131)%256)+')'}
function build(nodes, cardinality, mode){
  const st=document.createElement('style')
  let css='.r8-root{width:900px;font:13px Arial,sans-serif}.r8-row{display:block;box-sizing:border-box;min-height:18px}'
  if(mode!=='none'&&mode!=='manyRules'){
    const d=mode==='inlineBlock'?'inline-block':mode==='block'?'block':'inline'
    css+='.r8-row::before{content:"#";display:'+d+';width:12px;height:8px;color:#64748b}'
    if(mode==='inlineBoth') css+='.r8-row::after{content:"!";display:inline;width:8px;height:6px;color:#94a3b8}'
    if(mode==='container') css+='.r8-root{container-type:inline-size}.r8-row::before{width:2cqw;height:1cqh}'
  }
  if(mode==='inlineUnique'){
    for(let i=0;i<cardinality;i++)css+='.r8-row.g'+i+'::before{color:'+color(i)+'}'
  }
  if(mode==='manyRules'){
    for(let i=0;i<cardinality;i++)css+='.r8-row.g'+i+'{color:'+color(i)+';padding-left:'+(i%5)+'px}'
  }
  st.textContent=css;document.head.appendChild(st)
  const root=document.createElement('div');root.className='r8-root'
  if(mode==='inlineUnrelatedContainer'){
    const unrelated=document.createElement('div');unrelated.style.cssText='container-type:inline-size';unrelated.textContent='unrelated';root.appendChild(unrelated)
  }
  for(let i=0;i<nodes;i++){
    const e=document.createElement('div');e.className='r8-row g'+(i%cardinality);e.textContent='row '+i
    if(mode==='inlineInert')e.style.cssText='--container-label:plain;--acq-token:1'
    root.appendChild(e)
  }
  document.body.appendChild(root)
  return{root,cleanup(){root.remove();st.remove()}}
}
window.__bench={
 async init(u1,u2){this.mods={slot1:await import(u1),slot2:await import(u2)}},
 async one(slot,nodes,cardinality,mode){const x=build(nodes,cardinality,mode);try{const t0=performance.now();const raw=await this.mods[slot].snapdom.toRaw(x.root,${JSON.stringify(OPTS)});return{ms:performance.now()-t0,raw}}finally{x.cleanup()}},
 async warm(nodes,cardinality,mode,n){for(let i=0;i<n;i++)for(const s of(i&1?['slot2','slot1']:['slot1','slot2']))await this.one(s,nodes,cardinality,mode)},
 async pair(nodes,cardinality,mode,n,batch){const out=[];for(let i=0;i<n;i++){const row={};for(const s of(i&1?['slot2','slot1']:['slot1','slot2'])){let total=0;for(let b=0;b<batch;b++)total+=(await this.one(s,nodes,cardinality,mode)).ms;row[s]=total/batch}out.push(row)}return out},
 async oracle(nodes,cardinality,mode){const a=await this.one('slot1',nodes,cardinality,mode),b=await this.one('slot2',nodes,cardinality,mode);return{parity:a.raw===b.raw,aBytes:a.raw.length,bBytes:b.raw.length}}
};window.__ready=true
</script></body></html>`

const server=http.createServer((req,res)=>{const u=new URL(req.url||'/','http://127.0.0.1');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE);return}if(u.pathname.startsWith('/base')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(baseMod);return}if(u.pathname.startsWith('/cand')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(candMod);return}res.writeHead(404);res.end('nf')})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
const mean=x=>x.reduce((a,b)=>a+b,0)/x.length
function stats(x){const m=mean(x),sd=Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,x.length-1));const s=[...x].sort((a,b)=>a-b);return{mean:m,median:s.length%2?s[s.length>>1]:(s[s.length/2-1]+s[s.length/2])/2,cov:m?sd/m:0}}
function rng(seed){let x=seed>>>0;return()=>{x=(x*1664525+1013904223)>>>0;return x/4294967296}}
const pct=x=>(Math.exp(x)-1)*100
function effect(a,b,ar,br,seed){const la=a.map(ar).map(Math.log),lb=b.map(br).map(Math.log),point=(mean(la)+mean(lb))/2,r=rng(seed),draw=[];for(let i=0;i<BOOT;i++){let sa=0,sb=0;for(let j=0;j<la.length;j++)sa+=la[(r()*la.length)|0];for(let j=0;j<lb.length;j++)sb+=lb[(r()*lb.length)|0];draw.push(sa/la.length/2+sb/lb.length/2)}draw.sort((x,y)=>x-y);return{pct:pct(point),ci95:[pct(draw[(BOOT*.025)|0]),pct(draw[(BOOT*.975)|0])]}}
const browserType={chromium,firefox,webkit}[ENGINE]
if(!browserType)throw new Error(`unsupported --browser=${ENGINE}`)
const browser=await browserType.launch(ENGINE==='chromium'?{headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--disable-extensions']}:{headless:true})
async function layout(name,a,b){const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1});try{await page.goto(origin);await page.waitForFunction(()=>window.__ready===true);await page.evaluate(({u1,u2})=>window.__bench.init(u1,u2),{u1:`/${a}.mjs?${name}-1`,u2:`/${b}.mjs?${name}-2`});const out={};for(const[f,nodes,cardinality,mode]of FIXTURES){if(!PARITY_ONLY)await page.evaluate(({nodes,cardinality,mode,n})=>window.__bench.warm(nodes,cardinality,mode,n),{nodes,cardinality,mode,n:WARM});const oracle=await page.evaluate(({nodes,cardinality,mode})=>window.__bench.oracle(nodes,cardinality,mode),{nodes,cardinality,mode});const rows=PARITY_ONLY?[]:await page.evaluate(({nodes,cardinality,mode,n,batch})=>window.__bench.pair(nodes,cardinality,mode,n,batch),{nodes,cardinality,mode,n:N,batch:BATCH});out[f]={oracle,rows,s1:rows.length?stats(rows.map(x=>x.slot1)):null,s2:rows.length?stats(rows.map(x=>x.slot2)):null}}return out}finally{await page.close()}}
let L;try{L={cf:await layout('cf','base','cand'),cr:await layout('cr','cand','base'),zf:PARITY_ONLY?null:await layout('zf','base','base'),zr:PARITY_ONLY?null:await layout('zr','base','base')}}finally{await browser.close();await new Promise(r=>server.close(r))}
const fixtures={};for(let i=0;i<FIXTURES.length;i++){const f=FIXTURES[i][0],cf=L.cf[f],cr=L.cr[f];if(PARITY_ONLY){fixtures[f]={parity:cf.oracle.parity&&cr.oracle.parity};continue}const zf=L.zf[f],zr=L.zr[f],candidate=effect(cf.rows,cr.rows,r=>r.slot2/r.slot1,r=>r.slot1/r.slot2,0x8a00+i),control=effect(zf.rows,zr.rows,r=>r.slot2/r.slot1,r=>r.slot1/r.slot2,0xda00+i),maxCov=Math.max(cf.s1.cov,cf.s2.cov,cr.s1.cov,cr.s2.cov),controlPass=control.ci95[0]<=0&&control.ci95[1]>=0,stabilityPass=maxCov<0.15,win=candidate.ci95[1]<-(EPS*100),regression=candidate.ci95[0]>(EPS*100);fixtures[f]={candidate,control,maxCov,controlPass,stabilityPass,claimable:controlPass&&stabilityPass&&win,regression,parity:cf.oracle.parity&&cr.oracle.parity}}
const baseSha=sha(baseMod),candidateSha=sha(candMod)
const report={
  provenance:{generatedAt:new Date().toISOString(),sha256:candidateSha,baseSha256:baseSha,browser:ENGINE,n:N,batch:BATCH,warmup:WARM,bootstrap:BOOT,epsilon:EPS},
  base:{path:BASE_REL,sha256:baseSha},candidate:{path:CAND_REL,sha256:candidateSha},mode:PARITY_ONLY?'parity-only':'timed',fixtures,layouts:L,
}
const outPath=path.join(OUT,`pwh1-bundle-${ENGINE}-${PARITY_ONLY?'parity':QUICK?'quick':'full'}.json`);fs.writeFileSync(outPath,JSON.stringify(report,null,2))
console.log(`PWH1 bundle base=${baseSha.slice(0,12)} cand=${candidateSha.slice(0,12)} ${ENGINE} ${PARITY_ONLY?'PARITY-ONLY':`N=${N} batch=${BATCH}`}`);for(const[f,x]of Object.entries(fixtures)){if(PARITY_ONLY)console.log(`${f.padEnd(28)} parity=${x.parity?'PASS':'FAIL'}`);else console.log(`${f.padEnd(28)} parity=${x.parity?'PASS':'FAIL'} effect ${x.candidate.pct.toFixed(1)}% CI[${x.candidate.ci95.map(v=>v.toFixed(1)).join(', ')}] null ${x.control.pct.toFixed(1)}% CI[${x.control.ci95.map(v=>v.toFixed(1)).join(', ')}] CoV=${(x.maxCov*100).toFixed(1)}% claim=${x.claimable?'PASS':x.regression?'REGRESSION':'INCONCLUSIVE'}`)}
console.log(`artifact ${path.relative(ROOT,outPath).replaceAll('\\','/')}`)
