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

export function parseVmRssKb(statusText) {
  const m = String(statusText).match(/^VmRSS:\s+(\d+)\s+kB$/m)
  return m ? Number(m[1]) : 0
}

export function parseProcChildren(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger)
}

export function collectProcessTree(rootPid, readText = (p) => fs.readFileSync(p, 'utf8')) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new TypeError('rootPid must be a positive integer')
  const seen = new Set()
  const stack = [rootPid]
  const pids = []

  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)

    let status
    try {
      status = readText('/proc/' + pid + '/status')
    } catch {
      continue
    }
    pids.push({ pid, rssKb: parseVmRssKb(status) })

    try {
      const children = parseProcChildren(readText('/proc/' + pid + '/task/' + pid + '/children'))
      for (const child of children) if (!seen.has(child)) stack.push(child)
    } catch {
      // A short-lived child may disappear between status and children reads.
    }
  }
  return pids
}

export function processTreeRss(rootPid, readText) {
  const processes = collectProcessTree(rootPid, readText)
  if (!processes.some((p) => p.pid === rootPid)) {
    throw new Error('Chromium root process disappeared while sampling /proc')
  }
  return {
    rootPid,
    processCount: processes.length,
    rssKb: processes.reduce((sum, p) => sum + p.rssKb, 0),
    processes,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function settleProcessTreeRss(rootPid, {
  deltaKb = 2048,
  consecutive = 3,
  intervalMs = 250,
  maxSamples = 120,
  readText,
} = {}) {
  const samples = []
  let stable = 0
  let prev = processTreeRss(rootPid, readText)

  for (let i = 0; i < maxSamples && stable < consecutive; i++) {
    await sleep(intervalMs)
    const next = processTreeRss(rootPid, readText)
    const rssDeltaKb = next.rssKb - prev.rssKb
    const processCountStable = next.processCount === prev.processCount
    samples.push({
      at: Date.now(),
      rssKb: next.rssKb,
      processCount: next.processCount,
      deltaKb: rssDeltaKb,
      processCountStable,
    })
    stable = Math.abs(rssDeltaKb) <= deltaKb && processCountStable ? stable + 1 : 0
    prev = next
  }

  return {
    ...prev,
    stable: stable >= consecutive,
    terminalStableSamples: stable,
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
