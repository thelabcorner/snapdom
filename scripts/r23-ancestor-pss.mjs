#!/usr/bin/env node
/**
 * R23 native-memory acceptance. /proc/smaps_rollup PSS across an isolated Chromium
 * browser's COMPLETE descendant process tree, including renderer/utility/GPU children.
 * Independent candidate/baseline browser processes avoid same-renderer contamination.
 *
 * Source fidelity is checked with exact SVG hashes at the same deterministic steps;
 * the separately hosted R23 browser matrix also checks rendered RGBA pixel equality.
 * Never interpret PSS samples or repeated captures as statistically independent hosts.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { chromium } from 'playwright'
if (process.env.GITHUB_ACTIONS!=='true' ||
    process.env.GITHUB_REPOSITORY!=='thelabcorner/snapdom' ||
    process.platform!=='linux') throw new Error('R23 native-memory tests require GitHub Linux')
const host=Number(process.env.SNAPDOM_R23_HOST||0)
const imageVersion=process.env.ImageVersion
const imageOS=process.env.ImageOS
if(!imageVersion || !imageOS)throw Error('Hosted runner image provenance missing')
const baseline=await readFile('__r23_baseline/dist/snapdom.mjs')
const candidate=await readFile('dist/snapdom.mjs')
const source={A:baseline,B:candidate}
const srv=createServer((req,res)=>{
  const body=req.url==='/A.mjs'?source.A:req.url==='/B.mjs'?source.B:null
  res.writeHead(200,{'content-type':body?'text/javascript':'text/html; charset=utf-8',
    'cache-control':'no-store'})
  res.end(body||'<!doctype html><html><body></body></html>')
})
await new Promise(r=>srv.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+srv.address().port
const median=a=>a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)]
async function treePss(root){
  const names=(await readdir('/proc')).filter(x=>/^\d+$/.test(x))
  const ps=new Map()
  await Promise.all(names.map(async x=>{
    try {
      const [s,cmd]=await Promise.all([readFile('/proc/'+x+'/stat','utf8'),
        readFile('/proc/'+x+'/cmdline','utf8')])
      const tail=s.slice(s.lastIndexOf(')')+2).split(' ')
      ps.set(Number(x),{ppid:Number(tail[1]),cmd})
    } catch { /* short-lived process */ }
  }))
  const members=new Set([root])
  let grow=true
  while(grow){
    grow=false
    for(const [pid,p] of ps)if(!members.has(pid)&&members.has(p.ppid)){
      members.add(pid);grow=true
    }
  }
  let pss=0,renderer=0,used=0
  for(const pid of members)try{
    const text=await readFile('/proc/'+pid+'/smaps_rollup','utf8')
    const k=/^Pss:\s+(\d+)\s+kB/m.exec(text)
    if(!k)continue
    const kib=Number(k[1])
    pss+=kib
    if(ps.get(pid)?.cmd?.includes('--type=renderer'))renderer+=kib
    used++
  }catch{ /* process may disappear */ }
  if(used<2||pss<=0)throw Error('Incomplete PSS process family '+used)
  return {MiB:pss/1024,rendererMiB:renderer/1024,processes:used}
}
async function launch(){
  const profile=await mkdtemp(join(tmpdir(),'snapdom-r23-pss-'))
  const child=spawn(chromium.executablePath(),[
    '--headless=new','--no-sandbox','--disable-dev-shm-usage',
    '--disable-background-timer-throttling','--no-first-run',
    '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'
  ],{stdio:'ignore'})
  let browser
  try {
    let port
    for(let n=0;n<120;n++){
      if(child.exitCode!==null)throw Error('Chromium quit before DevTools readiness')
      try {
        const v=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])
        if(Number.isInteger(v)&&v>0){port=v;break}
      }catch{/* wait for DevTools */}
      await new Promise(done=>setTimeout(done,100))
    }
    if(!port)throw Error('DevTools port not available')
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port)
    return {browser,pid:child.pid,async close(){
      try{await browser.close()}finally{
        child.kill()
        await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})
      }
    }}
  }catch(e){
    child.kill()
    await rm(profile,{recursive:true,force:true})
    throw e
  }
}
async function collect(handle,page){
  const session=await page.context().newCDPSession(page)
  const items=[]
  try{
    for(let i=0;i<5;i++){
      await session.send('HeapProfiler.collectGarbage')
      await page.waitForTimeout(230)
      items.push(await treePss(handle.pid))
    }
  }finally{await session.detach()}
  return {MiB:median(items.map(x=>x.MiB)),
    rendererMiB:median(items.map(x=>x.rendererMiB)),
    processes:median(items.map(x=>x.processes))}
}
async function sample(side,index){
  const handle=await launch()
  try {
    const page=await handle.browser.newPage({viewport:{width:1200,height:960}})
    await page.goto(origin)
    await page.evaluate(async(side)=>{
      const {snapdom}=await import('/'+side+'.mjs')
      const css=document.createElement('style')
      css.textContent='.stem{color:rgb(42,45,48);line-height:12px}.leaf{display:inline-block;font-size:11px}'
      document.head.append(css)
      const root=document.createElement('div')
      root.style.cssText='width:620px;background:white'
      for(let a=0;a<7;a++){
        let parent=root
        for(let d=0;d<68;d++){
          const el=document.createElement('div')
          el.className='stem'
          if(d%9===0)el.style.fontFamily='Arial'
          if(d%13===0)el.style.color='rgb(33,44,55)'
          parent.append(el);parent=el
        }
        for(let i=0;i<18;i++){
          const leaf=document.createElement('span')
          leaf.className='leaf';leaf.textContent='m'+a+' '+i
          parent.append(leaf)
        }
      }
      document.body.append(root)
      const options={burst:false,cache:'disabled',invalidate:true,compress:false,
        embedFonts:false,dpr:1,__styleShare:false,__elementUniverse:true}
      window.__r23mem=async(step)=>{
        root.firstChild.style.color='rgb('+((step*11)%240)+',43,57)'
        const telemetry={}
        const res=await snapdom(root,{...options,__ancestorUniverseTelemetry:telemetry})
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(res.toRaw()))
        if(side==='B' && !(telemetry.summaryUses>0))throw Error('Ancestor summary inactive on forced style invalidation')
        return {sha:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join(''),
          summaryUses:telemetry.summaryUses}
      }
    },side)
    const hashes=[]
    for(let n=0;n<4;n++)hashes.push(await page.evaluate(n=>window.__r23mem(n),n))
    const warm=await collect(handle,page)
    for(let n=4;n<36;n++){
      const value=await page.evaluate(n=>window.__r23mem(n),n)
      if(n===4||n===18||n===35)hashes.push(value)
    }
    const swept=await collect(handle,page)
    return {side,index,warm,swept,hashes,
      growthMiB:swept.MiB-warm.MiB,
      rendererGrowthMiB:swept.rendererMiB-warm.rendererMiB}
  }finally{await handle.close()}
}
const fields=['growthDifferenceMiB','retainedDifferenceMiB','rendererGrowthDifferenceMiB']
async function nullPair(repeat) {
  // Both aliases resolve to the EXACT SAME immutable pre-R20 source. Reversing
  // their artificial labels ensures time/order drift cannot masquerade as a
  // baseline-vs-baseline treatment effect.
  const labels=repeat===0?['X','Y']:['Y','X']
  const results={}
  for(const label of labels)results[label]=await sample('A',100+repeat*2+(label==='X'?0:1))
  const sha=x=>JSON.stringify(x.hashes.map(v=>v.sha))
  if(sha(results.X)!==sha(results.Y))throw Error('Same-source null SVG fidelity mismatch')
  return {order:labels.join(''),X:results.X,Y:results.Y,
    growthDifferenceMiB:results.Y.growthMiB-results.X.growthMiB,
    retainedDifferenceMiB:results.Y.swept.MiB-results.X.swept.MiB,
    rendererGrowthDifferenceMiB:results.Y.rendererGrowthMiB-results.X.rendererGrowthMiB}
}
const observations=[]
const nullObservations=[]
try {
  // Bracket treatment comparisons with same-source null controls rather than
  // measuring only after treatment, to constrain long-term VM drift.
  nullObservations.push(await nullPair(0))
  for(let repeat=0;repeat<2;repeat++){
    const order=(host+repeat)%2===0?['A','B']:['B','A']
    const pair={}
    for(const side of order)pair[side]=await sample(side,repeat)
    if(JSON.stringify(pair.A.hashes.map(x=>x.sha))!==
       JSON.stringify(pair.B.hashes.map(x=>x.sha)))
      throw Error('R23 exact source SVG hash parity failed on isolated memory trial '+repeat)
    observations.push({order:order.join(''),A:pair.A,B:pair.B,
      growthDifferenceMiB:pair.B.growthMiB-pair.A.growthMiB,
      retainedDifferenceMiB:pair.B.swept.MiB-pair.A.swept.MiB,
      rendererGrowthDifferenceMiB:pair.B.rendererGrowthMiB-pair.A.rendererGrowthMiB})
  }
  nullObservations.push(await nullPair(1))
  const sameSourceNull=Object.fromEntries(fields.map(key=>[key,
    nullObservations.reduce((sum,o)=>sum+o[key],0)/nullObservations.length]))
  const report={schema:'r23-memory-v1',host,imageVersion,imageOS,
    sameSourceNull,nullObservations,
    frozenBaseline:'cac07a4108086718bc9511663346e1b9fcf4e226',
    candidate:process.env.GITHUB_SHA,observations}
  const out=resolve('lane6-scratch/r23/evidence/pss-'+host+'.json')
  await mkdir(dirname(out),{recursive:true})
  await writeFile(out,JSON.stringify(report,null,2))
  console.log(JSON.stringify({host,imageVersion,
    nullOrders:nullObservations.map(x=>x.order),
    sameSourceNull,
    pairedResults:observations.map(o=>({order:o.order,
      processPssMiB:o.retainedDifferenceMiB,growthMiB:o.growthDifferenceMiB}))}))
}finally{await new Promise(r=>srv.close(r))}
