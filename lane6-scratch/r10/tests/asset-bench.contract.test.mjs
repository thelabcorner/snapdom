import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateLinear,
  aggregateLogPoints,
  candidateWarmRouteValid,
  collectProcessTree,
  crc32,
  dataUrlCharsForBytes,
  geometrySweep,
  makeDeterministicPng,
  pairOrder,
  parseProcChildren,
  parseProcStartTime,
  parseProcStatusMemory,
  parseProcType,
  parseSmapsRollupPssKb,
  parseVmRssKb,
  processTreeRss,
  settleProcessTreeRss,
  sha256,
} from '../asset-bench-lib.mjs'
import { WORKER_MIN_PAYLOAD_CHARS } from '../../../src/core/cache.js'

const status = ({ vm = 1000, anon = 600, file = 300, shmem = 100 } = {}) =>
  'VmRSS:\t' + vm + ' kB\n' +
  'RssAnon:\t' + anon + ' kB\n' +
  'RssFile:\t' + file + ' kB\n' +
  'RssShmem:\t' + shmem + ' kB\n'

const stat = (pid, startTime) =>
  pid + ' (chrome helper) ' + ['S', ...Array(18).fill('0'), String(startTime)].join(' ')

const smaps = (pss) => 'Pss:\t' + pss + ' kB\n'

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

test('proc parsers read status memory, PSS, process type, start-time and child pid lists', () => {
  const text = status({ vm: 12345, anon: 7000, file: 4000, shmem: 1345 })
  assert.equal(parseVmRssKb(text), 12345)
  assert.deepEqual(parseProcStatusMemory(text), {
    vmRssKb: 12345,
    rssAnonKb: 7000,
    rssFileKb: 4000,
    rssShmemKb: 1345,
  })
  assert.equal(parseSmapsRollupPssKb(smaps(6789)), 6789)
  assert.equal(parseProcStartTime(stat(10, 987654)), 987654)
  assert.equal(parseProcType('/usr/bin/chromium\0--type=renderer\0--foo\0'), 'renderer')
  assert.equal(parseProcType('/usr/bin/chromium\0--foo\0'), 'browser')
  assert.deepEqual(parseProcChildren('12  34\n56'), [12, 34, 56])
})

test('process-tree memory sums PSS and diagnostics across descendants', () => {
  const files = new Map([
    ['/proc/10/status', status({ vm: 1000, anon: 600, file: 300, shmem: 100 })],
    ['/proc/10/stat', stat(10, 100)],
    ['/proc/10/smaps_rollup', smaps(800)],
    ['/proc/10/cmdline', '/usr/bin/chromium\0'],
    ['/proc/10/task/10/children', '11 12'],
    ['/proc/11/status', status({ vm: 2000, anon: 1400, file: 400, shmem: 200 })],
    ['/proc/11/stat', stat(11, 110)],
    ['/proc/11/smaps_rollup', smaps(1500)],
    ['/proc/11/cmdline', '/usr/bin/chromium\0--type=renderer\0'],
    ['/proc/11/task/11/children', '13'],
    ['/proc/12/status', status({ vm: 3000, anon: 2000, file: 700, shmem: 300 })],
    ['/proc/12/stat', stat(12, 120)],
    ['/proc/12/smaps_rollup', smaps(2200)],
    ['/proc/12/cmdline', '/usr/bin/chromium\0--type=gpu-process\0'],
    ['/proc/12/task/12/children', ''],
    ['/proc/13/status', status({ vm: 4000, anon: 2600, file: 1000, shmem: 400 })],
    ['/proc/13/stat', stat(13, 130)],
    ['/proc/13/smaps_rollup', smaps(3000)],
    ['/proc/13/cmdline', '/usr/bin/chromium\0--type=renderer\0'],
    ['/proc/13/task/13/children', ''],
  ])
  const read = (p) => {
    if (!files.has(p)) throw new Error('gone')
    return files.get(p)
  }

  const tree = collectProcessTree(10, read)
  assert.deepEqual(tree.map((x) => x.pid).sort((a, b) => a - b), [10, 11, 12, 13])
  const memory = processTreeRss(10, read)
  assert.equal(memory.pssKb, 7500)
  assert.equal(memory.rssKb, 10000)
  assert.equal(memory.anonShmemKb, 7600)
  assert.equal(memory.processCount, 4)
  assert.deepEqual(memory.rendererPids, [11, 13])
  assert.equal(memory.rendererPssKb, 4500)
  assert.match(memory.identityKey, /10:100/)
  assert.match(memory.identityKey, /13:130/)
})

test('process-tree discovery includes children spawned by non-main Chromium threads', () => {
  const files = new Map([
    ['/proc/10/status', status({ vm: 1000, anon: 600, file: 300, shmem: 100 })],
    ['/proc/10/stat', stat(10, 100)],
    ['/proc/10/smaps_rollup', smaps(800)],
    ['/proc/10/cmdline', '/usr/bin/chromium\0'],
    ['/proc/10/task/10/children', ''],
    ['/proc/10/task/17/children', '11'],
    ['/proc/11/status', status({ vm: 2000, anon: 1400, file: 400, shmem: 200 })],
    ['/proc/11/stat', stat(11, 110)],
    ['/proc/11/smaps_rollup', smaps(1500)],
    ['/proc/11/cmdline', '/usr/bin/chromium\0--type=renderer\0'],
    ['/proc/11/task/11/children', ''],
  ])
  const read = (p) => {
    if (!files.has(p)) throw new Error('gone')
    return files.get(p)
  }
  const readDir = (p) => {
    if (p === '/proc/10/task') return ['10', '17']
    if (p === '/proc/11/task') return ['11']
    throw new Error('gone')
  }

  const memory = processTreeRss(10, read, readDir)
  assert.deepEqual(memory.rendererPids, [11])
  assert.equal(memory.rendererPssKb, 1500)
  assert.equal(memory.pssKb, 2300)
  assert.equal(memory.processCount, 2)
})

test('process-tree sampling refuses a vanished Chromium root pid', () => {
  assert.throws(
    () => processTreeRss(10, () => { throw new Error('gone') }),
    /root process disappeared/,
  )
})

test('PSS settle requires a stable pid:starttime set, not merely a flat total', async () => {
  const snapshots = [
    { children: '11', pss: { 10: 1000, 11: 2000 }, starts: { 10: 100, 11: 110 } },
    { children: '11 12', pss: { 10: 1000, 11: 1000, 12: 1000 }, starts: { 10: 100, 11: 110, 12: 120 } },
    { children: '11 12', pss: { 10: 1000, 11: 1000, 12: 1000 }, starts: { 10: 100, 11: 110, 12: 120 } },
    { children: '11 12', pss: { 10: 1000, 11: 1000, 12: 1000 }, starts: { 10: 100, 11: 110, 12: 120 } },
    { children: '11 12', pss: { 10: 1000, 11: 1000, 12: 1000 }, starts: { 10: 100, 11: 110, 12: 120 } },
  ]
  let index = -1
  const read = (p) => {
    if (p === '/proc/10/status') {
      index = Math.min(index + 1, snapshots.length - 1)
      return status({ vm: 1500, anon: 900, file: 400, shmem: 200 })
    }
    if (p === '/proc/10/stat') return stat(10, snapshots[index].starts[10])
    if (p === '/proc/10/smaps_rollup') return smaps(snapshots[index].pss[10])
    if (p === '/proc/10/cmdline') return '/usr/bin/chromium\0'
    if (p === '/proc/10/task/10/children') return snapshots[index].children

    const m = p.match(/^\/proc\/(11|12)\/(status|stat|smaps_rollup|cmdline)$/)
    if (m) {
      const pid = Number(m[1])
      if (!(pid in snapshots[index].pss)) throw new Error('gone')
      if (m[2] === 'status') return status({ vm: snapshots[index].pss[pid], anon: snapshots[index].pss[pid], file: 0, shmem: 0 })
      if (m[2] === 'stat') return stat(pid, snapshots[index].starts[pid])
      if (m[2] === 'cmdline') return '/usr/bin/chromium\0--type=renderer\0'
      return smaps(snapshots[index].pss[pid])
    }
    if (/^\/proc\/(11|12)\/task\/(11|12)\/children$/.test(p)) return ''
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
  assert.equal(settled.samples[0].pssDeltaKb, 0)
  assert.equal(settled.samples[0].identityStable, false)
  assert.equal(settled.samples.length, 4)
})

test('PSS settle times out fail-closed under monotone drift', async () => {
  let call = 0
  const read = (p) => {
    if (p === '/proc/10/status') {
      call++
      return status({ vm: 1000 + call, anon: 700 + call, file: 200, shmem: 100 })
    }
    if (p === '/proc/10/stat') return stat(10, 100)
    if (p === '/proc/10/smaps_rollup') return smaps(1000 + call * 10)
    if (p === '/proc/10/cmdline') return '/usr/bin/chromium\0'
    if (p === '/proc/10/task/10/children') return ''
    throw new Error('missing ' + p)
  }
  const settled = await settleProcessTreeRss(10, {
    deltaKb: 5,
    consecutive: 3,
    intervalMs: 0,
    maxSamples: 3,
    readText: read,
  })
  assert.equal(settled.stable, false)
})

test('AB/BA order is exactly balanced inside each shipped runner', () => {
  for (let replicate = 0; replicate < 6; replicate++) {
    const first = Array.from({ length: 8 }, (_, i) => pairOrder(replicate, 0, i)[0])
    assert.equal(first.filter((x) => x === 'baseline').length, 4)
    assert.equal(first.filter((x) => x === 'candidate').length, 4)
  }
})

test('geometry sweeps keep null constant and claim paths unique and distinct', () => {
  const same = geometrySweep('same', 8)
  const scale = geometrySweep('scale', 8)
  const width = geometrySweep('width', 8)
  assert.equal(new Set(same.map((x) => JSON.stringify(x))).size, 1)
  assert.equal(new Set(scale.map((x) => JSON.stringify(x))).size, 8)
  assert.equal(new Set(width.map((x) => JSON.stringify(x))).size, 8)
  assert.ok(scale.every((x) => x.scale > 1 && x.scale < 2 && x.dpr === 1))
  assert.ok(width.every((x) => x.width > 300 && x.scale === 1 && x.dpr === 1))
  assert.notDeepEqual(
    scale.map((x) => Number(x.scale.toFixed(4))),
    width.map((x) => Number((x.width / 300).toFixed(4))),
  )
})

test('candidate warmup route contract accepts only the intended CSP dual-accounting', () => {
  const memo = { memo: 1, inflight: 0, header: 0, workerBlob: 0, workerString: 0, main: 0 }
  const blob = { memo: 0, inflight: 0, header: 0, workerBlob: 1, workerString: 0, main: 0 }
  const main = { memo: 0, inflight: 0, header: 0, workerBlob: 0, workerString: 0, main: 1 }
  const asyncDenied = { memo: 0, inflight: 0, header: 0, workerBlob: 1, workerString: 0, main: 1 }

  assert.equal(candidateWarmRouteValid('claim', blob, 0), true)
  assert.equal(candidateWarmRouteValid('null-memo', blob, 0), true)
  assert.equal(candidateWarmRouteValid('small-negative', main, 0), true)
  assert.equal(candidateWarmRouteValid('worker-negative', main, 0), true)
  assert.equal(candidateWarmRouteValid('worker-negative', asyncDenied, 0), true)

  assert.equal(candidateWarmRouteValid('small-negative', asyncDenied, 0), false)
  assert.equal(candidateWarmRouteValid('claim', asyncDenied, 0), false)
  assert.equal(candidateWarmRouteValid('worker-negative', { ...asyncDenied, workerString: 1 }, 0), false)
  assert.equal(candidateWarmRouteValid('worker-negative', { ...asyncDenied, main: 0 }, 0), false)

  for (const role of ['claim', 'null-memo', 'small-negative', 'worker-negative']) {
    assert.equal(candidateWarmRouteValid(role, memo, 1), true)
    assert.equal(candidateWarmRouteValid(role, asyncDenied, 1), false)
  }
})

test('runner-level aggregators consume one point per runner', () => {
  const logs = aggregateLogPoints([-0.10, -0.08, -0.12, -0.09, -0.11, -0.10])
  assert.equal(logs.available, true)
  assert.equal(logs.n, 6)
  assert.ok(logs.pct < 0)
  assert.ok(logs.ci95[1] < 0)

  const memory = aggregateLinear([100, 110, 90, 105, 95, 100])
  assert.equal(memory.available, true)
  assert.equal(memory.n, 6)
  assert.equal(memory.point, 100)
})
