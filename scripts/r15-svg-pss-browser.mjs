// R15 native-memory corroboration: paired isolated Chromium processes, not
// two loaded snapdom bundles in one renderer. Linux /proc smaps_rollup PSS,
// including child renderers and utility processes; browser-free output contains
// raw source SHA + pixel equality checks from the separate R15 timing gate.
import { createServer } from 'node:http'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const arg = (key, fallback) => process.argv.find(x => x.startsWith('--' + key + '='))?.slice(key.length + 3) || fallback
const runner = Number(arg('runner', '0'))
const baseline = await readFile(resolve(arg('baseline', 'lane6-scratch/r15/bundles/baseline.mjs')))
const candidate = await readFile(resolve(arg('candidate', 'lane6-scratch/r15/bundles/candidate.mjs')))
const out = resolve(arg('out', 'lane6-scratch/r15/memory/runner-' + runner + '.json'))
const bundle = { A: baseline, B: candidate }
const SIZE = 128, IMAGE_COUNT = 150
const table = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : c >>> 1
  table[i] = c >>> 0
}
const crc = (b) => {
  let value = 0xffffffff
  for (const byte of b) value = table[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function chunk(name, bytes) {
  const type = Buffer.from(name, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  const check = Buffer.alloc(4)
  check.writeUInt32BE(crc(Buffer.concat([type, bytes])))
  return Buffer.concat([length, type, bytes, check])
}
function generatePng(id) {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  let seed = (id * 65537 + 0x9e3779b9) >>> 0
  for (let y = 0; y < SIZE; y++) {
    const offset = y * (SIZE * 4 + 1)
    raw[offset] = 0
    for (let x = 0; x < SIZE; x++) {
      for (let k = 0; k < 4; k++) {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        raw[offset + 1 + x * 4 + k] = k === 3 ? 255 : (seed >>> 0) & 255
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4)
  header[8] = 8; header[9] = 6
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const pngs = Array.from({length:IMAGE_COUNT},(_,i)=>generatePng(i))
const server = createServer((req,res)=>{
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if(pathname === '/'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'})
    res.end('<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0}#stage{display:grid;width:1200px;grid-template-columns:repeat(12,90px);gap:2px}svg{width:80px;height:80px;display:block}</style></head><body><div id="stage"></div></body></html>')
    return
  }
  if(pathname === '/A.mjs'||pathname === '/B.mjs'){
    res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'})
    res.end(bundle[pathname.slice(1,2)])
    return
  }
  const match = /^\/asset\/(\d+)\.png$/.exec(pathname)
  if(match && Number(match[1]) < IMAGE_COUNT){
    const img = pngs[Number(match[1])]
    res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','content-length':img.length})
    res.end(img);return
  }
  res.writeHead(404);res.end()
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+server.address().port
const median=(arr)=>[...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)]

async function processSetPss(rootPid) {
  const names = (await readdir('/proc')).filter(name=>/^\d+$/.test(name))
  const metadata = new Map()
  await Promise.all(names.map(async n=>{
    try{
      const [stat,cmdline]=await Promise.all([
        readFile('/proc/'+n+'/stat','utf8'),
        readFile('/proc/'+n+'/cmdline','utf8')
      ])
      const tail=stat.slice(stat.lastIndexOf(')')+2).split(' ')
      metadata.set(Number(n),{parent:Number(tail[1]),cmdline})
    }catch{/* processes disappear during sampling */}
  }))
  const descendants=new Set([rootPid])
  let changed=true
  while(changed){
    changed=false
    for(const [pid,p] of metadata)if(!descendants.has(pid)&&descendants.has(p.parent)){
      descendants.add(pid); changed=true
    }
  }
  let totalKiB=0,rendererKiB=0,browserKiB=0,n=0
  for(const pid of descendants){
    try{
      const rollup=await readFile('/proc/'+pid+'/smaps_rollup','utf8')
      const match=/^Pss:\s+(\d+)\s+kB/m.exec(rollup)
      if(!match)throw new Error('Pss absent')
      const kiB=Number(match[1])
      totalKiB+=kiB;n++
      const cmd=metadata.get(pid)?.cmdline || ''
      if(cmd.includes('--type=renderer'))rendererKiB+=kiB
      if(pid===rootPid)browserKiB+=kiB
    }catch{/* child exited since tree walk */}
  }
  if(n<2||!Number.isFinite(totalKiB)||totalKiB<=0)throw new Error('incomplete process set PSS: '+n)
  return {processMiB:totalKiB/1024,rendererMiB:rendererKiB/1024,browserMiB:browserKiB/1024,processes:n}
}
async function settledProcessPss(browser,page) {
  const devtools=await page.context().newCDPSession(page)
  const browserCDP=await browser.newBrowserCDPSession()
  const processInfo=await browserCDP.send('SystemInfo.getProcessInfo')
  const browserPid=processInfo.processInfo?.find(p=>p.type==='browser')?.id
  if(!Number.isInteger(browserPid)||browserPid<=0) {
    throw new Error('CDP SystemInfo returned no browser process PID')
  }
  const samples=[]
  for(let i=0;i<4;i++){
    await devtools.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(260)
    samples.push(await processSetPss(browserPid))
  }
  await browserCDP.detach()
  await devtools.detach()
  return {
    processMiB:median(samples.map(x=>x.processMiB)),
    rendererMiB:median(samples.map(x=>x.rendererMiB)),
    browserMiB:median(samples.map(x=>x.browserMiB)),
    processes:median(samples.map(x=>x.processes))
  }
}
async function isolatedSample(side,replicate) {
  const browser=await chromium.launch({headless:true,args:['--js-flags=--expose-gc']})
  const page=await browser.newPage({viewport:{width:1280,height:1100},deviceScaleFactor:1})
  try{
    await page.goto(origin+'/',{waitUntil:'load'})
    await page.evaluate(async({side,origin})=>{
      const mod=await import('/'+side+'.mjs')
      if(typeof mod.snapdom!=='function')throw new Error('invalid named snapdom ESM export')
      window.__capture=async(start,count)=>{
        const stage=document.getElementById('stage')
        stage.replaceChildren()
        const ns='http://www.w3.org/2000/svg'
        for(let i=0;i<count;i++){
          const svg=document.createElementNS(ns,'svg')
          svg.setAttribute('viewBox','0 0 128 128')
          const img=document.createElementNS(ns,'image')
          img.setAttribute('href',origin+'/asset/'+(start+i)+'.png')
          img.setAttribute('width','128')
          img.setAttribute('height','128')
          svg.append(img);stage.append(svg)
        }
        const captured=await mod.snapdom(stage,{burst:false,compress:false,embedFonts:false,cache:'soft'})
        return captured.url.length
      }
    },{side,origin})
    const warmLengths=[]
    for(let i=0;i<3;i++)warmLengths.push(await page.evaluate(()=>window.__capture(0,40)))
    const warmed=await settledProcessPss(browser,page)
    const sweepLengths=[]
    for(let i=0;i<2;i++)sweepLengths.push(await page.evaluate(()=>window.__capture(40,110)))
    const swept=await settledProcessPss(browser,page)
    return {side,replicate,alreadyWarmed:warmed,afterUniqueSweep:swept,warmLengths,sweepLengths}
  }finally{
    await browser.close()
  }
}
const observations=[]
try{
  for(let replicate=0;replicate<2;replicate++){
    const order=(runner+replicate)%2===0?['A','B']:['B','A']
    const pair={}
    for(const side of order)pair[side]=await isolatedSample(side,replicate)
    if(JSON.stringify(pair.A.warmLengths)!==JSON.stringify(pair.B.warmLengths)||
       JSON.stringify(pair.A.sweepLengths)!==JSON.stringify(pair.B.sweepLengths))
      throw new Error('R15 PSS source output length parity failed on isolated process trial '+replicate)
    observations.push({
      order:order.join(''),
      A:pair.A,B:pair.B,
      warmProcessDeltaMiB:pair.B.alreadyWarmed.processMiB-pair.A.alreadyWarmed.processMiB,
      sweptProcessDeltaMiB:pair.B.afterUniqueSweep.processMiB-pair.A.afterUniqueSweep.processMiB,
      sweptRendererDeltaMiB:pair.B.afterUniqueSweep.rendererMiB-pair.A.afterUniqueSweep.rendererMiB
    })
  }
  const report={
    schema:'snapdom-r15-pss-v1',runner,
    baselineSha:process.env.BASELINE_SHA,
    candidateSha:process.env.CANDIDATE_SHA,
    measurementSha:process.env.GITHUB_SHA,
    imageVersion:process.env.ImageVersion||null,
    node:process.version,
    observations
  }
  await mkdir(dirname(out),{recursive:true})
  await writeFile(out,JSON.stringify(report,null,2))
  console.log(JSON.stringify({
    runner,imageVersion:report.imageVersion,
    pairs:observations.map(o=>({
      order:o.order,warm:o.warmProcessDeltaMiB,
      sweep:o.sweptProcessDeltaMiB,renderer:o.sweptRendererDeltaMiB
    }))
  }))
}finally{
  await new Promise(r=>server.close(r))
}
