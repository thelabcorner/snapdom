#!/usr/bin/env node
// Exploratory, hosted-only Chromium Worker experiment. Not a production speed claim.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { makeDeterministicPng } from '../lane6-scratch/r10/asset-bench-lib.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('R13 real-browser timing is allowed only on public GitHub Actions')
}
const expectedReference = 'ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b'
if (process.env.R13_REFERENCE_SHA !== expectedReference) throw new Error('reference identity drift')
const replicate = Number(process.argv.find((v) => v.startsWith('--replicate='))?.split('=')[1])
if (!Number.isInteger(replicate) || replicate < 0 || replicate > 5) throw new Error('invalid replicate')
const reference = path.resolve('__r12_reference/src/modules/compress.js')
const candidate = path.resolve('src/modules/compress.js')
const source = (filename) => {
  const text = fs.readFileSync(filename, 'utf8')
  const marker = 'const WORKER_SRC = ' + String.fromCharCode(96)
  const part = text.split(marker)[1]
  if (!part) throw new Error('Worker source not found: ' + filename)
  const worker = part.split(String.fromCharCode(96))[0]
  if (!worker.includes('self.onmessage = async')) throw new Error('Worker source is incomplete')
  return worker
}
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
const baseSrc = source(reference)
const candidateSrc = source(candidate)
if (baseSrc === candidateSrc) throw new Error('no experimental change to the Worker source')
const fixture = makeDeterministicPng(1200, 800, { seed: 0x1A73, entropy: true })
const server = http.createServer((req, res) => {
  if (req.url === '/fixture.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(fixture)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
  res.end('<!doctype html><title>R13 Worker single-flight trial</title>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port + '/')
  const results = await page.evaluate(async ({ baseSrc, candidateSrc, replicate }) => {
    const fixture = await (await fetch('/fixture.png', { cache: 'no-store' })).blob()
    const instrument = [
      'let __decodes = 0;',
      'const __originalDecode = self.createImageBitmap;',
      'self.createImageBitmap = (...xs) => { __decodes++; return __originalDecode.apply(self, xs) };',
      'const __originalPost = self.postMessage.bind(self);',
      'self.postMessage = (data) => __originalPost({ ...data, decodeCalls: __decodes });',
    ].join('\n')
    const workers = {}
    const waiting = new Map()
    const count = { baseline: 0, candidate: 0 }
    let nextId = 0
    for (const [side, source] of [['baseline', baseSrc], ['candidate', candidateSrc]]) {
      const url = URL.createObjectURL(new Blob([instrument, '\n', source], { type: 'text/javascript' }))
      const worker = new Worker(url)
      URL.revokeObjectURL(url)
      worker.onmessage = (event) => {
        const done = waiting.get(event.data.id)
        if (done) { waiting.delete(event.data.id); done(event.data) }
      }
      worker.onerror = (event) => { throw new Error(side + ': Worker error ' + event.message) }
      workers[side] = worker
    }
    const once = async (side, concurrency, encode, bitmapKey) => {
      const worker = workers[side]
      const prior = count[side]
      const jobs = []
      const before = performance.now()
      for (let i = 0; i < concurrency; i++) {
        const id = ++nextId
        jobs.push(new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('worker reply timed out')) }, 20000)
          waiting.set(id, (result) => { clearTimeout(timeout); resolve(result) })
        }))
        worker.postMessage({
          id, blob: fixture, bitmapKey, dataURL: '', srcLength: 2e7,
          targetW: encode ? 300 : 1200, targetH: encode ? 200 : 800,
          resFactor: 1, quality: 0.92, mime: 'image/png',
        })
      }
      const replies = await Promise.all(jobs)
      const wallMs = performance.now() - before
      if (replies.some((x) => x.error)) throw new Error(side + ': ' + JSON.stringify(replies.filter((x) => x.error)))
      count[side] = Math.max(...replies.map((x) => x.decodeCalls))
      const decodeDelta = count[side] - prior
      const first = replies[0].url
      if (replies.some((x) => x.url !== first)) throw new Error(side + ': same-size output mismatch')
      if (encode && !(typeof first === 'string' && first.startsWith('data:image/png;'))) {
        throw new Error(side + ': PNG encoding was not exercised')
      }
      if (!encode && first !== null) throw new Error(side + ': no-gain control unexpectedly encoded')
      return { wallMs, decodeDelta, first }
    }
    const arms = [
      { name: 'solo-decode', concurrency: 1, encode: false },
      { name: 'four-way-decode', concurrency: 4, encode: false },
      { name: 'eight-way-decode', concurrency: 8, encode: false },
      { name: 'four-way-full-encode', concurrency: 4, encode: true },
    ]
    const report = {}
    let key = replicate * 100000 + 100
    try {
      for (const arm of arms) {
        const pairs = []
        for (let round = 0; round < 8; round++) {
          const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
          const outcome = {}
          for (const side of order) {
            outcome[side] = await once(side, arm.concurrency, arm.encode, ++key)
          }
          if (outcome.baseline.first !== outcome.candidate.first) {
            throw new Error(arm.name + ': source changed the encoded output')
          }
          if (outcome.baseline.decodeDelta !== arm.concurrency || outcome.candidate.decodeDelta !== 1) {
            throw new Error(arm.name + ': decode count contract baseline=' +
              outcome.baseline.decodeDelta + ', candidate=' + outcome.candidate.decodeDelta)
          }
          pairs.push({
            order, baselineMs: outcome.baseline.wallMs, candidateMs: outcome.candidate.wallMs,
            baselineDecodes: outcome.baseline.decodeDelta, candidateDecodes: outcome.candidate.decodeDelta,
            logRatio: Math.log(outcome.candidate.wallMs / outcome.baseline.wallMs),
          })
        }
        report[arm.name] = pairs
      }
    } finally {
      for (const worker of Object.values(workers)) worker.terminate()
    }
    return report
  }, { baseSrc, candidateSrc, replicate })
  const rows = Object.entries(results).map(([name, pairs]) => {
    const avg = pairs.reduce((sum, x) => sum + x.logRatio, 0) / pairs.length
    return { name, concurrency: pairs[0].baselineDecodes, changePct: (Math.exp(avg) - 1) * 100,
      baselineMeanMs: pairs.reduce((s, x) => s + x.baselineMs, 0) / pairs.length,
      candidateMeanMs: pairs.reduce((s, x) => s + x.candidateMs, 0) / pairs.length }
  })
  const report = {
    schema: 'snapdom-r13-singleflight-browser-v1',
    replicate, repository: process.env.GITHUB_REPOSITORY,
    measurementSha: process.env.GITHUB_SHA, baselineSha: expectedReference,
    referenceWorkerSha256: sha(baseSrc), candidateWorkerSha256: sha(candidateSrc),
    fixtureSha256: sha(fixture), browserVersion: browser.version(),
    runnerImageVersion: process.env.ImageVersion || null,
    runnerName: process.env.RUNNER_NAME || null,
    results, rows, interpretation: 'Exploratory paired worker microbenchmark. No production performance claim.',
  }
  const dest = path.resolve('lane6-scratch/r13/results/runner-r' + replicate + '.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ replicate, rows, provenance: {
    measurementSha: report.measurementSha, baselineSha: report.baselineSha, browserVersion: report.browserVersion,
  } }, null, 2))
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
