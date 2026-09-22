#!/usr/bin/env node
// R7-P Stage-1 falsification harness: pseudo snapshot overlay + compact generated-key reuse.
// Same-bundle option-only crossover with protected no-reuse/low-reuse controls.
// --parity-only runs the complete oracle matrix without consuming timing budget.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const arg = (name, fallback) => {
  const p = `--${name}=`
  const x = process.argv.find((v) => v.startsWith(p))
  return x ? x.slice(p.length) : fallback
}
const QUICK = process.argv.includes('--quick')
const PARITY_ONLY = process.argv.includes('--parity-only')
const REL = arg('candidate', 'worktrees/snapdom-v3-r7-pseudo-overlay/dist/snapdom.mjs')
const N = Number(arg('n', QUICK ? 8 : 20))
const BATCH = Number(arg('batch', QUICK ? 2 : 3))
const WARM = Number(arg('warmup', QUICK ? 1 : 3))
const BOOT = Number(arg('bootstrap', QUICK ? 4000 : 10000))
const EPS = Number(arg('epsilon', 0.02))
const mod = fs.readFileSync(path.join(ROOT, REL))
const sha = crypto.createHash('sha256').update(mod).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r5/results')
fs.mkdirSync(OUT, { recursive: true })
const ONLY = new Set(arg('only', '').split(',').map((x) => x.trim()).filter(Boolean))

const FIXTURES = [
  ['pseudo-20', 20, 1, 'both'],
  ['pseudo-400', 400, 1, 'both'],
  ['pseudo-mixed-400', 400, 20, 'both'],
  ['pseudo-pairs-400', 400, 200, 'both'],
  ['pseudo-pairs-unique-style-400', 400, 200, 'pairUnique'],
  ['pseudo-triples-unique-style-360', 360, 120, 'tripleUnique'],
  ['pseudo-quads-unique-style-400', 400, 100, 'quadUnique'],
  ['pseudo-fives-unique-style-400', 400, 80, 'fiveUnique'],
  ['pseudo-sixes-unique-style-400', 420, 70, 'sixUnique'],
  ['pseudo-entropy-400', 400, 400, 'both'],
  ['pseudo-before-only-400', 400, 1, 'before'],
  ['pseudo-flex-400', 400, 1, 'flex'],
  ['pseudo-percent-400', 400, 2, 'percent'],
  ['pseudo-state-veto-400', 400, 1, 'stateVeto'],
  ['no-pseudo-400', 400, 1, 'none'],
].filter(([name]) => !ONLY.size || ONLY.has(name))

const HIST = {
  burst: false, cache: 'disabled', embedFonts: false,
  __styleSharePseudoOverlay: false,
  __styleSharePseudoKeyCache: false,
}
const CAND = {
  ...HIST,
  __styleSharePseudoOverlay: true,
  __styleSharePseudoKeyCache: true,
}

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
function color(i, salt=0){return 'rgb('+((i*47+salt)%256)+','+((i*83+salt*3)%256)+','+((i*131+salt*7)%256)+')'}
function build(nodes, cardinality, mode){
  const st=document.createElement('style')
  let css='.r7p-root{width:900px;font:13px Arial,sans-serif}.r7p-row{display:block;box-sizing:border-box;min-height:18px}'
  if(mode!=='none'){
    css+='.r7p-row::before{content:"#";display:inline-block;width:12px;color:#64748b}'
    if(mode!=='before') css+='.r7p-row::after{content:"!";display:inline-block;width:8px;color:#94a3b8}'
  }
  if(mode==='flex') css+='.r7p-row{display:flex;align-items:center}'
  if(mode==='percent') css+='.r7p-row{width:var(--w)}.r7p-row::before{width:50%}'
  if(mode==='stateVeto') css+='.r7p-row:not(:hover)::before{outline-offset:0px}'
  if(mode==='pairUnique'||mode==='tripleUnique'||mode==='quadUnique'||mode==='fiveUnique'||mode==='sixUnique'){
    for(let i=0;i<cardinality;i++){
      css+='.r7p-row.g'+i+'::before{color:'+color(i,11)+'}.r7p-row.g'+i+'::after{color:'+color(i,29)+'}'
    }
  }
  st.textContent=css;document.head.appendChild(st)
  const root=document.createElement('div');root.className='r7p-root'
  for(let i=0;i<nodes;i++){
    const e=document.createElement('div');e.className='r7p-row g'+(i%cardinality)
    if(mode==='percent') e.style.setProperty('--w', (i&1?'420px':'180px'))
    e.textContent='row '+i;root.appendChild(e)
  }
  document.body.appendChild(root)
  return{root,cleanup(){root.remove();st.remove()}}
}
window.__bench={
 async init(u1,u2,o1,o2){this.mods={slot1:await import(u1),slot2:await import(u2)};this.opts={slot1:o1,slot2:o2}},
 async one(slot,nodes,cardinality,mode){const x=build(nodes,cardinality,mode);try{const t0=performance.now();const raw=await this.mods[slot].snapdom.toRaw(x.root,this.opts[slot]);return{ms:performance.now()-t0,raw}}finally{x.cleanup()}},
 async warm(nodes,cardinality,mode,n){for(let i=0;i<n;i++)for(const s of(i&1?['slot2','slot1']:['slot1','slot2']))await this.one(s,nodes,cardinality,mode)},
 async pair(nodes,cardinality,mode,n,batch){const out=[];for(let i=0;i<n;i++){const row={};for(const s of(i&1?['slot2','slot1']:['slot1','slot2'])){let total=0;for(let b=0;b<batch;b++)total+=(await this.one(s,nodes,cardinality,mode)).ms;row[s]=total/batch}out.push(row)}return out},
 async oracle(nodes,cardinality,mode){const a=await this.one('slot1',nodes,cardinality,mode),b=await this.one('slot2',nodes,cardinality,mode);return{parity:a.raw===b.raw,aBytes:a.raw.length,bBytes:b.raw.length}}
};window.__ready=true
</script></body></html>`

const server=http.createServer((req,res)=>{const u=new URL(req.url||'/','http://127.0.0.1');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(PAGE);return}if(u.pathname.startsWith('/cand')){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(mod);return}res.writeHead(404);res.end('nf')})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`
const mean=x=>x.reduce((a,b)=>a+b,0)/x.length
function stats(x){const m=mean(x),sd=Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,x.length-1));const s=[...x].sort((a,b)=>a-b);return{mean:m,median:s.length%2?s[s.length>>1]:(s[s.length/2-1]+s[s.length/2])/2,cov:m?sd/m:0}}
function rng(seed){let x=seed>>>0;return()=>{x=(x*1664525+1013904223)>>>0;return x/4294967296}}
const pct=x=>(Math.exp(x)-1)*100
function effect(a,b,ar,br,seed){const la=a.map(ar).map(Math.log),lb=b.map(br).map(Math.log),point=(mean(la)+mean(lb))/2,r=rng(seed),draw=[];for(let i=0;i<BOOT;i++){let sa=0,sb=0;for(let j=0;j<la.length;j++)sa+=la[(r()*la.length)|0];for(let j=0;j<lb.length;j++)sb+=lb[(r()*lb.length)|0];draw.push(sa/la.length/2+sb/lb.length/2)}draw.sort((x,y)=>x-y);return{pct:pct(point),ci95:[pct(draw[(BOOT*.025)|0]),pct(draw[(BOOT*.975)|0])]}}
const browser=await chromium.launch({headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--disable-extensions']})
async function layout(name,o1,o2){const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1});try{await page.goto(origin);await page.waitForFunction(()=>window.__ready===true);await page.evaluate(({u1,u2,o1,o2})=>window.__bench.init(u1,u2,o1,o2),{u1:`/cand.mjs?${name}-1`,u2:`/cand.mjs?${name}-2`,o1,o2});const out={};for(const[f,nodes,cardinality,mode]of FIXTURES){if(!PARITY_ONLY)await page.evaluate(({nodes,cardinality,mode,n})=>window.__bench.warm(nodes,cardinality,mode,n),{nodes,cardinality,mode,n:WARM});const oracle=await page.evaluate(({nodes,cardinality,mode})=>window.__bench.oracle(nodes,cardinality,mode),{nodes,cardinality,mode});const rows=PARITY_ONLY?[]:await page.evaluate(({nodes,cardinality,mode,n,batch})=>window.__bench.pair(nodes,cardinality,mode,n,batch),{nodes,cardinality,mode,n:N,batch:BATCH});out[f]={oracle,rows,s1:rows.length?stats(rows.map(x=>x.slot1)):null,s2:rows.length?stats(rows.map(x=>x.slot2)):null}}return out}finally{await page.close()}}
let L;try{L={cf:await layout('cf',HIST,CAND),cr:await layout('cr',CAND,HIST),zf:PARITY_ONLY?null:await layout('zf',HIST,HIST),zr:PARITY_ONLY?null:await layout('zr',HIST,HIST)}}finally{await browser.close();await new Promise(r=>server.close(r))}
const fixtures={};for(let i=0;i<FIXTURES.length;i++){const f=FIXTURES[i][0],cf=L.cf[f],cr=L.cr[f];if(PARITY_ONLY){fixtures[f]={parity:cf.oracle.parity&&cr.oracle.parity};continue}const zf=L.zf[f],zr=L.zr[f],candidate=effect(cf.rows,cr.rows,r=>r.slot2/r.slot1,r=>r.slot1/r.slot2,0x7a00+i),control=effect(zf.rows,zr.rows,r=>r.slot2/r.slot1,r=>r.slot1/r.slot2,0xca00+i),maxCov=Math.max(cf.s1.cov,cf.s2.cov,cr.s1.cov,cr.s2.cov),controlPass=control.ci95[0]<=0&&control.ci95[1]>=0,stabilityPass=maxCov<0.15,win=candidate.ci95[1]<-(EPS*100),regression=candidate.ci95[0]>(EPS*100);fixtures[f]={candidate,control,maxCov,controlPass,stabilityPass,claimable:controlPass&&stabilityPass&&win,regression,parity:cf.oracle.parity&&cr.oracle.parity}}
const report={generatedAt:new Date().toISOString(),candidate:{path:REL,sha256:sha},mode:PARITY_ONLY?'parity-only':'timed',n:N,batch:BATCH,warmup:WARM,bootstrap:BOOT,fixtures,layouts:L};const outPath=path.join(OUT,`r7-pseudo-stage1-${PARITY_ONLY?'parity':QUICK?'quick':'full'}.json`);fs.writeFileSync(outPath,JSON.stringify(report,null,2))
console.log(`R7-P stage1 ${sha.slice(0,12)} ${PARITY_ONLY?'PARITY-ONLY':`N=${N} batch=${BATCH}`}`);for(const[f,x]of Object.entries(fixtures)){if(PARITY_ONLY)console.log(`${f.padEnd(31)} parity=${x.parity?'PASS':'FAIL'}`);else console.log(`${f.padEnd(31)} parity=${x.parity?'PASS':'FAIL'} effect ${x.candidate.pct.toFixed(1)}% CI[${x.candidate.ci95.map(v=>v.toFixed(1)).join(', ')}] null ${x.control.pct.toFixed(1)}% CI[${x.control.ci95.map(v=>v.toFixed(1)).join(', ')}] CoV=${(x.maxCov*100).toFixed(1)}% claim=${x.claimable?'PASS':x.regression?'REGRESSION':'INCONCLUSIVE'}`)}
console.log(`artifact ${path.relative(ROOT,outPath).replaceAll('\\','/')}`)
