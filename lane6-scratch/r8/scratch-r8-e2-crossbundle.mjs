// Scratch cross-bundle default-parity harness (NOT committed).
// Loads the candidate dist and an independently compiled certified R7 baseline bundle from
// 58b97b0, runs toRaw with default (no pseudo flag) options across E1's workloads, asserts
// byte-identical output. Guards against common-mode change: a renamed candidate must not be
// used as its own base.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'

const CAND = fs.readFileSync(path.resolve('dist/snapdom.mjs'))
const R7 = fs.readFileSync('/tmp/r7base/dist/snapdom.mjs')
const candSha = crypto.createHash('sha256').update(CAND).digest('hex').toUpperCase()
const r7Sha = crypto.createHash('sha256').update(R7).digest('hex').toUpperCase()
console.log('candidate  ', candSha.slice(0, 12))
console.log('r7 baseline', r7Sha.slice(0, 12))

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
  async init(u1,u2){this.mods={slot1:await import(u1),slot2:await import(u2)}},
  async one(slot,nodes,cardinality,mode){const x=build(nodes,cardinality,mode);try{const raw=await this.mods[slot].snapdom.toRaw(x.root,{burst:false,cache:'disabled',embedFonts:false});return{raw}}finally{x.cleanup()}}
}
window.__ready=true
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE); return }
  if (u.pathname === '/cand.mjs') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(CAND); return }
  if (u.pathname === '/r7.mjs') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(R7); return }
  res.writeHead(404); res.end('nf')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

// [name, nodes, cardinality, mode]
const WORKLOADS = [
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
]

const browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--disable-extensions'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
try {
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  await page.evaluate(() => window.__bench.init('/cand.mjs', '/r7.mjs'))
  let allPass = true
  for (const [name, nodes, cardinality, mode] of WORKLOADS) {
    const r = await page.evaluate(({ nodes, cardinality, mode }) => window.__bench.one('slot1', nodes, cardinality, mode), { nodes, cardinality, mode })
    const b = await page.evaluate(({ nodes, cardinality, mode }) => window.__bench.one('slot2', nodes, cardinality, mode), { nodes, cardinality, mode })
    const pass = r.raw === b.raw
    if (!pass) {
      let firstDiff = -1
      const min = Math.min(r.raw.length, b.raw.length)
      for (let i = 0; i < min; i++) { if (r.raw[i] !== b.raw[i]) { firstDiff = i; break } }
      console.log(`  FAIL ${name}: len cand=${r.raw.length} r7=${b.raw.length} firstDiff=${firstDiff}`)
      allPass = false
    } else {
      console.log(`  PASS ${name} (${r.raw.length} bytes)`)
    }
  }
  console.log(allPass ? 'CROSS-BUNDLE DEFAULT PARITY: ALL PASS' : 'CROSS-BUNDLE DEFAULT PARITY: FAIL')
} finally {
  await page.close()
  await browser.close()
  await new Promise((r) => server.close(r))
}
