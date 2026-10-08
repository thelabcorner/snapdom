// R18 native-memory corroboration: paired isolated Chromium processes, not
// two loaded snapdom bundles in one renderer. Linux /proc smaps_rollup PSS,
// including child renderers and utility processes; browser-free output contains
// raw source SHA + pixel equality checks from the separate R15 timing gate.
import { createServer } from 'node:http'
import { readFile, readdir, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve, dirname } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const arg = (key, fallback) => process.argv.find(x => x.startsWith('--' + key + '='))?.slice(key.length + 3) || fallback
const runner = Number(arg('runner', '0'))
const baseline = await readFile(resolve(arg('baseline', 'lane6-scratch/r18/bundles/baseline.mjs')))
const candidate = await readFile(resolve(arg('candidate', 'lane6-scratch/r18/bundles/candidate.mjs')))
const out = resolve(arg('out', 'r18-font-memory-evidence/runner-' + runner + '.json'))
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
    res.end('<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0}#stage{display:grid;width:1200px;grid-template-columns:repeat(10,110px);gap:2px;font:12px sans-serif}#stage>span{display:block;width:105px;height:20px;white-space:nowrap;overflow:hidden}</style></head><body><div id="stage"></div></body></html>')
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
// Playwright Browser intentionally does not expose a process() API. Launch Chromium
// explicitly and connect through its CDP endpoint; the OS child PID is then authoritative
// for smaps_rollup descendant accounting, without touching undocumented Playwright state.
async function launchMeasuredBrowser() {
  const profile = await mkdtemp(join(tmpdir(), 'snapdom-r18-pss-'))
  const child = spawn(chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--no-first-run',
    '--js-flags=--expose-gc', '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' })
  if (!child.pid) throw Error('unable to launch measurable Chromium process')
  let browser
  try {
    let port
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Chromium exited before CDP readiness')
      try {
        const rows = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')
        const discovered = Number(rows[0])
        if (Number.isInteger(discovered) && discovered > 0) { port = discovered; break }
      } catch { /* CDP endpoint has not been written yet */ }
      await new Promise(r => setTimeout(r, 100))
    }
    if (!port) throw Error('Chromium CDP readiness timeout')
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 })
  } catch (e) {
    child.kill()
    await rm(profile, { recursive: true, force: true })
    throw e
  }
  return {
    browser, pid: child.pid,
    close: async () => {
      try { await browser.close() } finally {
        child.kill()
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      }
    }
  }
}

async function settledProcessPss(rootPid,page) {
  const devtools=await page.context().newCDPSession(page)
  const samples=[]
  for(let i=0;i<4;i++){
    await devtools.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(260)
    samples.push(await processSetPss(rootPid))
  }
  await devtools.detach()
  return {
    processMiB:median(samples.map(x=>x.processMiB)),
    rendererMiB:median(samples.map(x=>x.rendererMiB)),
    browserMiB:median(samples.map(x=>x.browserMiB)),
    processes:median(samples.map(x=>x.processes))
  }
}
async function isolatedSample(side,replicate) {
  const measured=await launchMeasuredBrowser()
  const {browser, pid}=measured
  const page=await browser.newPage({viewport:{width:1280,height:1100},deviceScaleFactor:1})
  try{
    await page.goto(origin+'/',{waitUntil:'load'})
    await page.evaluate(async({side})=>{
      const mod=await import('/'+side+'.mjs')
      if(typeof mod.snapdom!=='function')throw Error('invalid named snapdom ESM export')
      window.__capture=async(start,count)=>{
        const stage=document.getElementById('stage')
        stage.replaceChildren()
        const frag=document.createDocumentFragment()
        for(let i=0;i<count;i++){
          const span=document.createElement('span')
          span.style.fontFamily=start===0
            ? '"R18 Memory", "R18 Fallback", Arial, sans-serif'
            : '"R18 Unique '+(start+i)+'", sans-serif'
          span.style.fontWeight=i%7?'400':'700'
          span.style.fontStyle=i%13?'normal':'italic'
          span.textContent='Glyph Ω 42 '+(i%100)
          frag.appendChild(span)
        }
        stage.appendChild(frag)
        const captured=await mod.snapdom(stage,{burst:false,compress:false,embedFonts:true,cache:'disabled'})
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(captured.url))
        return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')
      }
    },{side})
    const warmHashes=[]
    for(let i=0;i<3;i++)warmHashes.push(await page.evaluate(()=>window.__capture(0,1200)))
    const warmed=await settledProcessPss(pid,page)
    const sweepHashes=[]
    for(let i=0;i<2;i++)sweepHashes.push(await page.evaluate(()=>window.__capture(1200,700)))
    const swept=await settledProcessPss(pid,page)
    return {side,replicate,alreadyWarmed:warmed,afterUniqueSweep:swept,warmHashes,sweepHashes}
  }finally{
    await measured.close()
  }
}
const observations=[]
try{
  for(let replicate=0;replicate<2;replicate++){
    const order=(runner+replicate)%2===0?['A','B']:['B','A']
    const pair={}
    for(const side of order)pair[side]=await isolatedSample(side,replicate)
    if(JSON.stringify(pair.A.warmHashes)!==JSON.stringify(pair.B.warmHashes)||
       JSON.stringify(pair.A.sweepHashes)!==JSON.stringify(pair.B.sweepHashes))
      throw new Error('R18 PSS source output SHA-256 parity failed on isolated process trial '+replicate)
    observations.push({
      order:order.join(''),
      A:pair.A,B:pair.B,
      warmProcessDeltaMiB:pair.B.alreadyWarmed.processMiB-pair.A.alreadyWarmed.processMiB,
      sweptProcessDeltaMiB:pair.B.afterUniqueSweep.processMiB-pair.A.afterUniqueSweep.processMiB,
      sweptRendererDeltaMiB:pair.B.afterUniqueSweep.rendererMiB-pair.A.afterUniqueSweep.rendererMiB
    })
  }
  const report={
    schema:'snapdom-r18-font-pss-v1',runner,
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
