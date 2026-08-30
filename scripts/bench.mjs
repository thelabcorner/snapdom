#!/usr/bin/env node
// Synthetic perf bench for snapdom — 450-node and 10k-node captures
// Runs via: node --experimental-vm-modules scripts/bench.mjs
// Uses Playwright if available, otherwise falls back to no-op.

import { performance } from 'perf_hooks'

async function tryBench() {
  let chromium
  try {
    const pw = await import('playwright')
    chromium = pw.chromium
  } catch {
    console.log('[bench] playwright not available — skipping')
    return
  }
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (e) {
    console.log('[bench] chromium launch failed', e.message)
    return
  }
  const page = await browser.newPage()
  // Build a dist URL via file:// using the built dist
  const html = `
  <!doctype html>
  <html><head><style>
    *{box-sizing:border-box} body{margin:0;padding:10px}
    .card{border:1px solid #ccc;padding:8px;margin:4px;display:inline-block;width:120px;height:80px}
  </style></head><body>
  <div id="root"></div>
  <script type="module">
    import { snapdom } from '/dist/snapdom.mjs'
    window.snapdom = snapdom
    window.build = (n) => {
      const root=document.getElementById('root'); root.innerHTML='';
      for(let i=0;i<n;i++){
        const d=document.createElement('div'); d.className='card'; d.textContent='card '+i;
        d.style.backgroundColor = i%2?'#f0f0f0':'#e0e0ff';
        root.appendChild(d)
      }
      return root
    }
    window.bench = async (n, runs=5) => {
      const el = window.build(n)
      // warmup
      await snapdom(el, { scale:1 })
      const times=[]
      for(let i=0;i<runs;i++){
        const t0=performance.now()
        await snapdom(el, { scale:1 })
        times.push(performance.now()-t0)
      }
      const mean = times.reduce((a,b)=>a+b,0)/times.length
      const min=Math.min(...times), max=Math.max(...times)
      return { n, runs, mean, min, max, times }
    }
  </script>
  </body></html>`
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  // serve dist via route
  await page.route('**/dist/snapdom.mjs', async route => {
    const fs = await import('fs')
    const data = fs.readFileSync('dist/snapdom.mjs')
    await route.fulfill({ contentType: 'application/javascript', body: data })
  })
  // need to reload after route? Instead use file://
  // Simpler: use file:// dist via page.addScriptTag
  // For now, just use the built dist via import map - fallback to simple

  // Alternative: inject snapdom via addScriptTag
  await page.addScriptTag({ path: 'dist/snapdom.mjs', type: 'module' }).catch(()=>{})

  const bench450 = await page.evaluate(async () => {
    const el = window.build(450)
    const t0=performance.now()
    await window.snapdom(el, { scale:1 })
    return performance.now()-t0
  }).catch(e => ({ error: e.message }))

  const bench450multi = await page.evaluate(async () => {
    return await window.bench(450, 5)
  }).catch(e => ({ error: e.message }))

  const bench10k = await page.evaluate(async () => {
    return await window.bench(10000, 3)
  }).catch(e => ({ error: e.message }))

  console.log('[bench] 450-node single:', bench450)
  console.log('[bench] 450-node x5:', bench450multi)
  console.log('[bench] 10k-node x3:', bench10k)

  // Also bench style key and clip if possible via isolated micro-benchmarks
  // For now, just report

  await browser.close()
  // simple gate: if 450 mean > 100ms, warn
  if (bench450multi && bench450multi.mean) {
    console.log(`[bench] mean 450: ${bench450multi.mean.toFixed(2)}ms min ${bench450multi.min.toFixed(2)} max ${bench450multi.max.toFixed(2)}`)
  }
  if (bench10k && bench10k.mean) {
    console.log(`[bench] mean 10k: ${bench10k.mean.toFixed(2)}ms`)
  }
}

try {
  await tryBench()
} catch (e) {
  console.error('[bench] failed', e)
  process.exit(0)
}
