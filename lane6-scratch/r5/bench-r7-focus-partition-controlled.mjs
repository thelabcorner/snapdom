#!/usr/bin/env node
// R7-FP1 decision-quality timing harness.
// SAME candidate bundle on both arms; only __styleShareFocusPartition differs.
// Do not run while unrelated CPU/browser/compiler jobs are active.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const arg = (name, fallback) => {
  const prefix = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
const REL = arg('candidate', 'worktrees/snapdom-v3-r7-focus-partition/dist/snapdom.mjs')
const N = Number(arg('n', 20))
const BATCH = Number(arg('batch', 3))
const WARM = Number(arg('warmup', 3))
const BOOT = Number(arg('bootstrap', 12000))
const EPS = Number(arg('epsilon', 0.02))
const ONLY = new Set(arg('only', '').split(',').map((x) => x.trim()).filter(Boolean))
const mod = fs.readFileSync(path.join(ROOT, REL))
const sha = crypto.createHash('sha256').update(mod).digest('hex').toUpperCase()

const FIXTURES = [
  ['focus-20', 20, 1, 'focus'],
  ['focus-400', 400, 1, 'focus'],
  ['focus-1000', 1000, 1, 'focus'],
  ['focus-within-400', 400, 1, 'focus-within'],
  ['mixed-focus-400', 400, 20, 'focus'],
  ['focus-plus-hover-veto-400', 400, 1, 'focus-hover-veto'],
  ['no-focus-400', 400, 1, 'none'],
].filter(([name]) => !ONLY.size || ONLY.has(name))

const HIST = { burst: false, cache: 'disabled', embedFonts: false, __styleShareFocusPartition: false }
const PART = { ...HIST, __styleShareFocusPartition: true }

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
function build(nodes,cardinality,mode){
 const st=document.createElement('style');const common='.fp-root{width:900px;font:13px Arial,sans-serif}.fp-card{display:block;width:120px;height:14px;outline:none;background:rgb(0,0,255)}';
 if(mode==='focus')st.textContent=common+'.fp-card:focus{background:rgb(255,0,0)}';
 else if(mode==='focus-within')st.textContent=common+'.fp-group{display:block;width:130px;height:16px;background:rgb(0,0,255)}.fp-probe{outline:none}.fp-group:focus-within{background:rgb(255,0,0)}';
 else if(mode==='focus-hover-veto')st.textContent=common+'.fp-card:focus:not(:hover),.fp-card:not(:hover){background:rgb(10,20,30)}';
 else st.textContent=common;
 document.head.appendChild(st);const root=document.createElement('div');root.className='fp-root';
 if(mode==='focus-within'){for(let i=0;i<nodes;i++){const g=document.createElement('div');g.className='fp-group g'+(i%cardinality);const p=document.createElement('span');p.className='fp-probe';p.tabIndex=0;g.appendChild(p);root.appendChild(g)}}
 else{for(let i=0;i<nodes;i++){const e=document.createElement('span');e.className='fp-card g'+(i%cardinality);e.tabIndex=0;root.appendChild(e)}}
 document.body.appendChild(root);if(mode==='focus-within')root.querySelectorAll('.fp-probe')[nodes>>1]?.focus();else if(mode==='focus'||mode==='focus-hover-veto')root.children[nodes>>1]?.focus();
 return{root,cleanup(){try{document.activeElement?.blur?.()}catch{}root.remove();st.remove()}}
}
window.__bench={
 async init(u1,u2,o1,o2){this.mods={slot1:await import(u1),slot2:await import(u2)};this.opts={slot1:o1,slot2:o2}},
 async one(slot,nodes,cardinality,mode){const x=build(nodes,cardinality,mode);try{const t0=performance.now();const raw=await this.mods[slot].snapdom.toRaw(x.root,this.opts[slot]);return{ms:performance.now()-t0,raw}}finally{x.cleanup()}},
 async warm(nodes,cardinality,mode,n){for(let i=0;i<n;i++)for(const s of(i&1?['slot2','slot1']:['slot1','slot2']))await this.one(s,nodes,cardinality,mode)},
 async oracle(nodes,cardinality,mode){const a=await this.one('slot1',nodes,cardinality,mode),b=await this.one('slot2',nodes,cardinality,mode);return{parity:a.raw===b.raw}},
 async pair(nodes,cardinality,mode,n,batch){const out=[];for(let i=0;i<n;i++){const row={};for(const s of(i&1?['slot2','slot1']:['slot1','slot2'])){let total=0;for(let b=0;b<batch;b++)total+=(await this.one(s,nodes,cardinality,mode)).ms;row[s]=total/batch}out.push(row)}return out}
};window.__ready=true
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE); return }
  if (u.pathname.startsWith('/candidate')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
  res.writeHead(404); res.end('nf')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length
function stats(x) { const m=mean(x),sd=Math.sqrt(x.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,x.length-1));const s=[...x].sort((a,b)=>a-b);return{mean:m,median:s.length%2?s[s.length>>1]:(s[s.length/2-1]+s[s.length/2])/2,cov:m?sd/m:0} }
function rng(seed){let x=seed>>>0;return()=>{x=(x*1664525+1013904223)>>>0;return x/4294967296}}
const pct=(x)=>(Math.exp(x)-1)*100
function effect(a,b,ar,br,seed){const la=a.map(ar).map(Math.log),lb=b.map(br).map(Math.log),point=(mean(la)+mean(lb))/2,r=rng(seed),draw=[];for(let i=0;i<BOOT;i++){let sa=0,sb=0;for(let j=0;j<la.length;j++)sa+=la[(r()*la.length)|0];for(let j=0;j<lb.length;j++)sb+=lb[(r()*lb.length)|0];draw.push(sa/la.length/2+sb/lb.length/2)}draw.sort((x,y)=>x-y);return{pct:pct(point),ci95:[pct(draw[(BOOT*.025)|0]),pct(draw[(BOOT*.975)|0])]}}

const browser = await chromium.launch({ headless:true, args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--no-first-run','--disable-extensions'] })
async function layout(name,o1,o2){const page=await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1});try{await page.goto(origin);await page.waitForFunction(()=>window.__ready===true);await page.evaluate(({u1,u2,o1,o2})=>window.__bench.init(u1,u2,o1,o2),{u1:`/candidate.mjs?${name}-1`,u2:`/candidate.mjs?${name}-2`,o1,o2});const out={};for(const[f,nodes,cardinality,mode]of FIXTURES){await page.evaluate(({nodes,cardinality,mode,n})=>window.__bench.warm(nodes,cardinality,mode,n),{nodes,cardinality,mode,n:WARM});const oracle=await page.evaluate(({nodes,cardinality,mode})=>window.__bench.oracle(nodes,cardinality,mode),{nodes,cardinality,mode});const rows=await page.evaluate(({nodes,cardinality,mode,n,batch})=>window.__bench.pair(nodes,cardinality,mode,n,batch),{nodes,cardinality,mode,n:N,batch:BATCH});out[f]={oracle,rows,s1:stats(rows.map(x=>x.slot1)),s2:stats(rows.map(x=>x.slot2))}}return out}finally{await page.close()}}
let L;try{L={cf:await layout('cf',HIST,PART),cr:await layout('cr',PART,HIST),zf:await layout('zf',HIST,HIST),zr:await layout('zr',HIST,HIST)}}finally{await browser.close();await new Promise(r=>server.close(r))}

const fixtures={};for(let i=0;i<FIXTURES.length;i++){const f=FIXTURES[i][0],cf=L.cf[f],cr=L.cr[f],zf=L.zf[f],zr=L.zr[f];const candidate=effect(cf.rows,cr.rows,r=>r.slot2/r.slot1,r=>r.slot1/r.slot2,0x7f00+i);const control=effect(zf.rows,zr.rows,r=>r.slot2/r.slot1,r=>r.slot1/r.slot2,0xcf00+i);const maxCov=Math.max(cf.s1.cov,cf.s2.cov,cr.s1.cov,cr.s2.cov);const controlPass=control.ci95[0]<=0&&control.ci95[1]>=0;const stabilityPass=maxCov<.15;const win=candidate.ci95[1]<-(EPS*100);const regression=candidate.ci95[0]>(EPS*100);fixtures[f]={candidate,control,maxCov,controlPass,stabilityPass,claimable:cf.oracle.parity&&cr.oracle.parity&&controlPass&&stabilityPass&&win,regression,parity:cf.oracle.parity&&cr.oracle.parity}}
const report={generatedAt:new Date().toISOString(),candidate:{path:REL,sha256:sha},method:'same-bundle option-only; fresh-page slot crossover; symmetric warmup; paired log ratios; historical/historical null; seeded bootstrap; no outlier deletion',n:N,batch:BATCH,warmup:WARM,bootstrap:BOOT,epsilon:EPS,fixtures,layouts:L}
const outPath=path.join(ROOT,'lane6-scratch/r5/results/r7-focus-partition-controlled.json');fs.writeFileSync(outPath,JSON.stringify(report,null,2))
console.log(`R7 focus partition controlled ${sha.slice(0,12)} N=${N} batch=${BATCH}`);for(const[f,x]of Object.entries(fixtures))console.log(`${f.padEnd(29)} parity=${x.parity?'PASS':'FAIL'} effect ${x.candidate.pct.toFixed(1)}% CI[${x.candidate.ci95.map(v=>v.toFixed(1)).join(', ')}] null ${x.control.pct.toFixed(1)}% CI[${x.control.ci95.map(v=>v.toFixed(1)).join(', ')}] CoV=${(x.maxCov*100).toFixed(1)}% claim=${x.claimable?'PASS':x.regression?'REGRESSION':'INCONCLUSIVE'}`)
console.log('artifact lane6-scratch/r5/results/r7-focus-partition-controlled.json')

