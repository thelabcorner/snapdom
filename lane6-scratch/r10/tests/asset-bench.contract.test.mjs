import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateLinear,
  aggregateLogPoints,
  collectProcessTree,
  crc32,
  dataUrlCharsForBytes,
  geometrySweep,
  makeDeterministicPng,
  pairOrder,
  parseProcChildren,
  parseVmRssKb,
  processTreeRss,
  settleProcessTreeRss,
  sha256,
} from '../asset-bench-lib.mjs'
import { WORKER_MIN_PAYLOAD_CHARS } from '../../../src/core/cache.js'

test('hosted page bootstraps the actual named ESM snapdom export', () => {
  const root = process.cwd()
  const harness = fs.readFileSync(path.resolve(root, 'lane6-scratch/r10/assets-bench.mjs'), 'utf8')
  const entry = fs.readFileSync(path.resolve(root, 'src/index.js'), 'utf8')
  assert.match(entry, /export \{ snapdom \} from/)
  assert.match(harness, /"import \{ snapdom \} from '"/)
  assert.doesNotMatch(harness, /"import snapdom from '"/)
})

test('deterministic PNG generator produces stable valid-threshold fixtures', () => {
  const largeA = makeDeterministicPng(1200, 800, { seed: 0x51a7, entropy: true })
  const largeB = makeDeterministicPng(1200, 800, { seed: 0x51a7, entropy: true })
  const small = makeDeterministicPng(96, 96, { seed: 0x51a7, entropy: false })

  assert.deepEqual([...largeA.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(sha256(largeA), sha256(largeB))
  assert.ok(dataUrlCharsForBytes(largeA.length) > WORKER_MIN_PAYLOAD_CHARS * 10)
  assert.ok(dataUrlCharsForBytes(small.length) < WORKER_MIN_PAYLOAD_CHARS)
})

test('CRC32 implementation matches the canonical check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('proc parsers read VmRSS and child pid lists', () => {
  assert.equal(parseVmRssKb('Name:\tchrome\nVmRSS:\t12345 kB\n'), 12345)
  assert.equal(parseVmRssKb('Name:\tchrome\n'), 0)
  assert.deepEqual(parseProcChildren('12  34\n56'), [12, 34, 56])
})

test('process-tree RSS walks descendants and tolerates disappeared children', () => {
  const files = new Map([
    ['/proc/10/status', 'VmRSS:\t1000 kB\n'],
    ['/proc/10/task/10/children', '11 12'],
    ['/proc/11/status', 'VmRSS:\t2000 kB\n'],
    ['/proc/11/task/11/children', '13'],
    ['/proc/12/status', 'VmRSS:\t3000 kB\n'],
    ['/proc/12/task/12/children', ''],
    ['/proc/13/status', 'VmRSS:\t4000 kB\n'],
  ])
  const read = (p) => {
    if (!files.has(p)) throw new Error('gone')
    return files.get(p)
  }
  const tree = collectProcessTree(10, read)
  assert.deepEqual(tree.map((x) => x.pid).sort((a, b) => a - b), [10, 11, 12, 13])
  assert.equal(processTreeRss(10, read).rssKb, 10000)
})

test('process-tree RSS refuses a vanished Chromium root pid', () => {
  assert.throws(
    () => processTreeRss(10, () => { throw new Error('gone') }),
    /root process disappeared/,
  )
})

test('RSS settle requires process-count stability, not just a flat summed RSS', async () => {
  const snapshots = [
    { children: '11', rss: { 10: 1000, 11: 2000 } },
    { children: '11 12', rss: { 10: 1000, 11: 1000, 12: 1000 } },
    { children: '11 12', rss: { 10: 1000, 11: 1000, 12: 1000 } },
    { children: '11 12', rss: { 10: 1000, 11: 1000, 12: 1000 } },
    { children: '11 12', rss: { 10: 1000, 11: 1000, 12: 1000 } },
  ]
  let index = -1
  const read = (p) => {
    if (p === '/proc/10/status') {
      index = Math.min(index + 1, snapshots.length - 1)
      return 'VmRSS:\t' + snapshots[index].rss[10] + ' kB\n'
    }
    if (p === '/proc/10/task/10/children') return snapshots[index].children
    const m = p.match(/^\/proc\/(11|12)\/status$/)
    if (m) return 'VmRSS:\t' + snapshots[index].rss[Number(m[1])] + ' kB\n'
    if (/^\/proc\/(11|12)\/task\//.test(p)) return ''
    throw new Error('missing ' + p)
  }

  const settled = await settleProcessTreeRss(10, {
    deltaKb: 1,
    consecutive: 3,
    intervalMs: 0,
    maxSamples: 4,
    readText: read,
  })
  assert.equal(settled.stable, true)
  assert.equal(settled.samples[0].deltaKb, 0)
  assert.equal(settled.samples[0].processCountStable, false)
  assert.equal(settled.samples.length, 4)
})

test('AB/BA order is balanced across consecutive samples and runner parity', () => {
  const a = Array.from({ length: 8 }, (_, i) => pairOrder(0, 0, i)[0])
  const b = Array.from({ length: 8 }, (_, i) => pairOrder(1, 0, i)[0])
  assert.equal(a.filter((x) => x === 'baseline').length, 4)
  assert.equal(a.filter((x) => x === 'candidate').length, 4)
  assert.deepEqual(b, a.map((x) => x === 'baseline' ? 'candidate' : 'baseline'))
})

test('geometry sweeps keep null constant and claim arms unique', () => {
  const same = geometrySweep('same', 8)
  const scale = geometrySweep('scale', 8)
  const dpr = geometrySweep('dpr', 8)
  assert.equal(new Set(same.map((x) => JSON.stringify(x))).size, 1)
  assert.equal(new Set(scale.map((x) => JSON.stringify(x))).size, 8)
  assert.equal(new Set(dpr.map((x) => JSON.stringify(x))).size, 8)
  assert.ok(scale.every((x) => x.scale > 1 && x.scale < 2 && x.dpr === 1))
  assert.ok(dpr.every((x) => x.dpr > 1 && x.dpr < 2 && x.scale === 1))
})

test('runner-level aggregators consume one point per runner', () => {
  const logs = aggregateLogPoints([-0.10, -0.08, -0.12, -0.09, -0.11, -0.10])
  assert.equal(logs.available, true)
  assert.equal(logs.n, 6)
  assert.ok(logs.pct < 0)
  assert.ok(logs.ci95[1] < 0)

  const rss = aggregateLinear([100, 110, 90, 105, 95, 100])
  assert.equal(rss.available, true)
  assert.equal(rss.n, 6)
  assert.equal(rss.point, 100)
})
