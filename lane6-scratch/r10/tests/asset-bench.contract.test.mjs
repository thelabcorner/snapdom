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
  sha256,
} from '../asset-bench-lib.mjs'
import { WORKER_MIN_PAYLOAD_CHARS } from '../../../src/core/cache.js'

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

test('AB/BA order is balanced across consecutive samples and runner parity', () => {
  const a = Array.from({ length: 8 }, (_, i) => pairOrder(0, 0, i)[0])
  const b = Array.from({ length: 8 }, (_, i) => pairOrder(1, 0, i)[0])
  assert.equal(a.filter((x) => x === 'baseline').length, 4)
  assert.equal(a.filter((x) => x === 'candidate').length, 4)
  assert.deepEqual(b, a.map((x) => x === 'baseline' ? 'candidate' : 'baseline'))
})

test('geometry sweeps keep null constant and claim arms unique', () => {
  const same = geometrySweep('same', 7)
  const scale = geometrySweep('scale', 7)
  const dpr = geometrySweep('dpr', 7)
  assert.equal(new Set(same.map((x) => JSON.stringify(x))).size, 1)
  assert.equal(new Set(scale.map((x) => JSON.stringify(x))).size, 7)
  assert.equal(new Set(dpr.map((x) => JSON.stringify(x))).size, 7)
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
