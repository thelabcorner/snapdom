import crypto from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.allocUnsafe(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.allocUnsafe(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function xorshift32(seed) {
  let x = (seed >>> 0) || 0x9e3779b9
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
}

/**
 * Deterministic RGBA PNG. entropy=true produces incompressible-ish pixels for the large fixture;
 * false produces a highly compressible checker for the small below-threshold negative control.
 */
export function makeDeterministicPng(width, height, { seed = 1, entropy = true } = {}) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new TypeError('width/height must be positive integers')
  }

  const stride = width * 4 + 1
  const raw = Buffer.allocUnsafe(stride * height)
  const rand = xorshift32(seed)

  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4
      if (entropy) {
        const r = rand()
        raw[i] = r & 0xff
        raw[i + 1] = (r >>> 8) & 0xff
        raw[i + 2] = (r >>> 16) & 0xff
      } else {
        const v = ((x >>> 3) ^ (y >>> 3)) & 1 ? 0x24 : 0xd8
        raw[i] = v
        raw[i + 1] = v
        raw[i + 2] = v
      }
      raw[i + 3] = 0xff
    }
  }

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = zlib.deflateSync(raw, { level: 6 })
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND'),
  ])
}

export function dataUrlCharsForBytes(bytes, mime = 'image/png') {
  return ('data:' + mime + ';base64,').length + Math.ceil(bytes / 3) * 4
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex').toUpperCase()
}

function parseKbField(text, name) {
  const m = String(text).match(new RegExp('^' + name + ':\\s+(\\d+)\\s+kB$', 'm'))
  return m ? Number(m[1]) : NaN
}

export function parseVmRssKb(statusText) {
  const value = parseKbField(statusText, 'VmRSS')
  return Number.isFinite(value) ? value : 0
}

export function parseProcStatusMemory(statusText) {
  return {
    vmRssKb: parseKbField(statusText, 'VmRSS'),
    rssAnonKb: parseKbField(statusText, 'RssAnon'),
    rssFileKb: parseKbField(statusText, 'RssFile'),
    rssShmemKb: parseKbField(statusText, 'RssShmem'),
  }
}

export function parseSmapsRollupPssKb(text) {
  return parseKbField(text, 'Pss')
}

export function parseProcStartTime(statText) {
  const text = String(statText)
  const end = text.lastIndexOf(')')
  if (end < 0) return NaN
  const fields = text.slice(end + 1).trim().split(/\s+/)
  // The slice starts at procfs stat field 3 (state); starttime is field 22.
  return Number(fields[19])
}

export function parseProcChildren(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger)
}

export function collectProcessTree(rootPid, readText = (p) => fs.readFileSync(p, 'utf8')) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new TypeError('rootPid must be a positive integer')
  const seen = new Set()
  const stack = [rootPid]
  const processes = []

  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)

    let status
    let stat
    let smaps
    try {
      status = readText('/proc/' + pid + '/status')
      stat = readText('/proc/' + pid + '/stat')
      smaps = readText('/proc/' + pid + '/smaps_rollup')
    } catch (error) {
      if (pid === rootPid) throw new Error('Chromium root process disappeared while sampling /proc', { cause: error })
      continue
    }

    const memory = parseProcStatusMemory(status)
    const startTime = parseProcStartTime(stat)
    const pssKb = parseSmapsRollupPssKb(smaps)
    if (
      !Number.isFinite(memory.vmRssKb) ||
      !Number.isFinite(memory.rssAnonKb) ||
      !Number.isFinite(memory.rssFileKb) ||
      !Number.isFinite(memory.rssShmemKb) ||
      !Number.isFinite(startTime) ||
      !Number.isFinite(pssKb)
    ) {
      throw new Error('Chromium process ' + pid + ' exposed incomplete /proc memory identity')
    }

    processes.push({
      pid,
      startTime,
      pssKb,
      ...memory,
      anonShmemKb: memory.rssAnonKb + memory.rssShmemKb,
    })

    try {
      const children = parseProcChildren(readText('/proc/' + pid + '/task/' + pid + '/children'))
      for (const child of children) if (!seen.has(child)) stack.push(child)
    } catch {
      // A short-lived child may disappear between memory sampling and the children read.
    }
  }
  return processes
}

export function processTreeRss(rootPid, readText) {
  const processes = collectProcessTree(rootPid, readText)
  if (!processes.some((p) => p.pid === rootPid)) {
    throw new Error('Chromium root process disappeared while sampling /proc')
  }
  const identities = processes
    .map((p) => p.pid + ':' + p.startTime)
    .sort()
  return {
    rootPid,
    processCount: processes.length,
    identityKey: identities.join(','),
    pssKb: processes.reduce((sum, p) => sum + p.pssKb, 0),
    rssKb: processes.reduce((sum, p) => sum + p.vmRssKb, 0),
    anonShmemKb: processes.reduce((sum, p) => sum + p.anonShmemKb, 0),
    processes,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function settleProcessTreeRss(rootPid, {
  deltaKb = 1024,
  consecutive = 5,
  intervalMs = 500,
  maxSamples = 60,
  readText,
} = {}) {
  const samples = []
  let prev = processTreeRss(rootPid, readText)
  let window = [prev]

  for (let i = 0; i < maxSamples; i++) {
    await sleep(intervalMs)
    const next = processTreeRss(rootPid, readText)
    const sameIdentity = next.identityKey === prev.identityKey

    samples.push({
      at: Date.now(),
      pssKb: next.pssKb,
      rssKb: next.rssKb,
      anonShmemKb: next.anonShmemKb,
      processCount: next.processCount,
      identityKey: next.identityKey,
      pssDeltaKb: next.pssKb - prev.pssKb,
      identityStable: sameIdentity,
    })

    if (!sameIdentity) window = [next]
    else {
      window.push(next)
      if (window.length > consecutive + 1) window.shift()
    }

    const pssValues = window.map((x) => x.pssKb)
    const pssRangeKb = pssValues.length ? Math.max(...pssValues) - Math.min(...pssValues) : Infinity
    if (window.length >= consecutive + 1 && pssRangeKb <= deltaKb) {
      return {
        ...next,
        stable: true,
        terminalStableSamples: consecutive,
        settleRangePssKb: pssRangeKb,
        samples,
      }
    }
    prev = next
  }

  return {
    ...prev,
    stable: false,
    terminalStableSamples: Math.max(0, window.length - 1),
    settleRangePssKb: window.length ? Math.max(...window.map((x) => x.pssKb)) - Math.min(...window.map((x) => x.pssKb)) : Infinity,
    samples,
  }
}

export function pairOrder(replicate, conditionIndex, sampleIndex) {
  const flip = (replicate + conditionIndex + sampleIndex) & 1
  return flip ? ['candidate', 'baseline'] : ['baseline', 'candidate']
}

export function geometrySweep(kind, repeats) {
  if (!Number.isInteger(repeats) || repeats < 1) throw new TypeError('repeats must be >= 1')
  if (kind === 'same') return Array.from({ length: repeats }, () => ({ scale: 1, dpr: 1 }))
  if (kind === 'scale') {
    return Array.from({ length: repeats }, (_, i) => ({ scale: 1.15 + i * 0.08, dpr: 1 }))
  }
  if (kind === 'dpr') {
    return Array.from({ length: repeats }, (_, i) => ({ scale: 1, dpr: 1.15 + i * 0.08 }))
  }
  if (kind === 'width') {
    return Array.from({ length: repeats }, (_, i) => ({
      scale: 1,
      dpr: 1,
      width: 300 * (1.10 + i * 0.06),
    }))
  }
  throw new Error('unknown geometry sweep ' + kind)
}

export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function sampleSd(xs) {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

export function tCritical95(df) {
  const table = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
    8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
    15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080,
    22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048,
    29: 2.045, 30: 2.042,
  }
  return table[Math.min(30, Math.max(1, df))] ?? 1.96
}

export function aggregateLogPoints(points) {
  const xs = points.filter(Number.isFinite)
  if (xs.length < 2) return { available: false, n: xs.length }
  const logPoint = mean(xs)
  const sd = sampleSd(xs)
  const half = tCritical95(xs.length - 1) * sd / Math.sqrt(xs.length)
  const pct = (x) => (Math.exp(x) - 1) * 100
  return {
    available: true,
    n: xs.length,
    logPoint,
    pct: pct(logPoint),
    runnerSdLog: sd,
    ci95: [pct(logPoint - half), pct(logPoint + half)],
  }
}

export function aggregateLinear(points) {
  const xs = points.filter(Number.isFinite)
  if (xs.length < 2) return { available: false, n: xs.length }
  const point = mean(xs)
  const sd = sampleSd(xs)
  const half = tCritical95(xs.length - 1) * sd / Math.sqrt(xs.length)
  return { available: true, n: xs.length, point, sd, ci95: [point - half, point + half] }
}
