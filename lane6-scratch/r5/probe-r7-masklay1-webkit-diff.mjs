#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import { webkit } from 'playwright'

const mod = fs.readFileSync('dist/snapdom.mjs')
const pageHtml = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, {'content-type':'text/javascript'}); res.end(mod); return }
  res.writeHead(200, {'content-type':'text/html'}); res.end(pageHtml)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await webkit.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.__ready)
  const rows = await page.evaluate(async () => {
    const style = document.createElement('style')
    style.textContent = '.probe{width:80px;height:30px;background:linear-gradient(red,blue);mask-position:17px 9px;mask-size:33px 22px}'
    document.head.appendChild(style)
    const root = document.createElement('div')
    root.innerHTML = '<div class="probe">x</div>'
    document.body.appendChild(root)
    try {
      const common = {cache:'disabled',burst:false,embedFonts:false}
      const historical = await window.__m.snapdom.toRaw(root,{...common,__maskLayoutSourceGate:false})
      const candidate = await window.__m.snapdom.toRaw(root,{...common,__maskLayoutSourceGate:true})
      return { historical: decodeURIComponent(historical.split(',')[1]), candidate: decodeURIComponent(candidate.split(',')[1]) }
    } finally { root.remove(); style.remove() }
  })
  let i = 0
  while (i < rows.historical.length && rows.historical[i] === rows.candidate[i]) i++
  console.log(`firstDiff=${i} historicalBytes=${rows.historical.length} candidateBytes=${rows.candidate.length}`)
  console.log('HIST', rows.historical.slice(Math.max(0,i-300), i+700))
  console.log('CAND', rows.candidate.slice(Math.max(0,i-300), i+700))
} finally {
  await browser.close()
  await new Promise(r => server.close(r))
}
