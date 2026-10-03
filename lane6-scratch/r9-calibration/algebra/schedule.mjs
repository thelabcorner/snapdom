/**
 * Browser-free model of the R9 hosted acquisition schedule.
 *
 * Replays the exact control flow of lane6-scratch/r9/bench-r9-controlled.mjs over synthetic
 * per-call latencies, so the crossover algebra can be exercised and falsified without ever
 * importing Playwright.
 *
 * In an option-pair self-null the six physical pages are byte-identical in configuration: same
 * bundle body, same options object, same fixture DOM, same viewport. The only thing that
 * distinguishes them is the integer index they were created at. Every cost model here is therefore
 * written as a function of (page index, page-local call counter, slot, position-within-pair), which
 * makes "is this rig biased, and by exactly what" a decidable question rather than a hypothesis.
 */

import { crossoverEffect } from '../../r9/protocol.mjs'

/** Layout identity and creation order of the shipped harness. */
export const LAYOUT_ORDER = [
  'effectForward', 'effectReverse',
  'baseNullForward', 'baseNullReverse',
  'optNullForward', 'optNullReverse',
]

/** Design B collapses the six pages into three logical layouts on `pagesPerLayout` pages each. */
export const BLOCKED_LAYOUTS = ['effect', 'baseNull', 'optNull']

export function lcg(seed) {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}

export function gaussian(rng) {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Resolve a world field that may be a constant, an array indexed by page, or a function of
 * (pageIndex, pageLocalCallCount).
 */
function resolve(field, page, t) {
  if (typeof field === 'function') return field(page, t)
  if (Array.isArray(field)) return typeof field[page] === 'function' ? field[page](page, t) : (field[page] ?? 0)
  return field ?? 0
}

/**
 *   ms = baseMs * exp( pageLog(page,t) + posLog[position]
 *                       + interactLog(page,t) * [position == 'first']
 *                       + armLog * [slot2] ) + additiveMs(page,t) + baseMs * eps
 *
 * `t` is a wall-clock proxy: round index plus the layout's position within that round. It matters
 * that `t` is wall time and not a per-page call counter, because every page receives exactly the
 * same number of calls — a call-count clock would make the two pages of a pair identical.
 *
 * `interactLog` is the page x position term: the cost of holding the first slot of a pair on a
 * particular physical page at a particular moment. It is the only term the shipped crossover
 * cannot cancel, because it is keyed to page identity and to wall time rather than to position
 * alone, and both are things a hosted runner makes non-zero for reasons that have nothing to do
 * with snapDOM.
 */
export function makeCall(world) {
  const rng = lcg((world.seed ?? 1) >>> 0)
  const baseMs = world.baseMs ?? 40
  const noiseLog = world.noiseLog ?? 0
  const armLog = world.armLog ?? 0
  return function call(page, slot, position, t) {
    const pageTerm = resolve(world.pageLog, page, t)
    const add = resolve(world.additiveMs, page, t)
    const pos = world.posLog?.[position] ?? 0
    const inter = position === 'first' ? resolve(world.interactLog, page, t) : 0
    const arm = slot === 'slot2' ? armLog : 0
    const eps = noiseLog ? gaussian(rng) * noiseLog : 0
    return baseMs * Math.exp(pageTerm + pos + inter + arm + eps) + add
  }
}

/**
 * The shipped schedule: six pages created in LAYOUT_ORDER, all created before any warmup; warmup
 * and oracle in that same fixed order; then N rounds of Latin-rotated micro-interleaved sampling.
 *
 * `pageOrder`, `warmOrder` and `rotationBase` are separate knobs so the page-creation confound can
 * be reversed on its own. They default to one shared list, exactly as the harness has it.
 */
export function runCurrentLayout(call, {
  n, batch, warmup,
  pageOrder = LAYOUT_ORDER,
  warmOrder = pageOrder,
  rotationBase = LAYOUT_ORDER,
} = {}) {
  const index = new Map(pageOrder.map((name, i) => [name, i]))
  const rows = Object.fromEntries(pageOrder.map((name) => [name, []]))
  const order = (flip) => (flip ? ['slot2', 'slot1'] : ['slot1', 'slot2'])
  const tick = (name, slot, position, wall) =>
    call(index.get(name), slot, position, wall)

  for (const name of warmOrder) {
    for (let i = 0; i < warmup; i++) {
      const seq = order(i & 1)
      for (const slot of seq) tick(name, slot, seq[0] === slot ? 'first' : 'second', -1)
    }
    tick(name, 'slot1', 'first', -1)
    tick(name, 'slot2', 'second', -1)
  }

  for (let i = 0; i < n; i++) {
    const shift = i % rotationBase.length
    const rotated = rotationBase.slice(shift).concat(rotationBase.slice(0, shift))
    for (let oi = 0; oi < rotated.length; oi++) {
      const name = rotated[oi]
      const wall = i + oi / rotated.length
      let slot1 = 0
      let slot2 = 0
      for (let b = 0; b < batch; b++) {
        const seq = order((i + b) & 1)
        for (const slot of seq) {
          const ms = tick(name, slot, seq[0] === slot ? 'first' : 'second', wall)
          if (slot === 'slot1') slot1 += ms
          else slot2 += ms
        }
      }
      rows[name].push({ slot1: slot1 / batch, slot2: slot2 / batch })
    }
  }
  return { rows, pageIndex: index }
}

/**
 * Design B: three logical layouts on `pagesPerLayout` physical pages each. Every acquisition block
 * runs `batch/2` replicate-pairs on every page; each pair is two back-to-back calls that execute the
 * arms in opposite orders, and the coin that decides which order comes first is seeded and
 * per-block. Pairing replicates adjacently rather than shuffling a whole block is what makes the
 * cancellation second-order accurate against drift *inside* a block.
 */
export function runBlockedLayout(call, {
  n, batch, layouts = BLOCKED_LAYOUTS, pagesPerLayout = 2,
  pageOrder = null, rotationBase = null, warmOrder = null, warmup = 6, seed = 1,
} = {}) {
  if (batch % 2) throw new Error('Design B requires an even batch for within-block exact balance')
  const pages = pageOrder || layouts.flatMap((layout) =>
    Array.from({ length: pagesPerLayout }, (_, i) => ({ layout, page: i })))
  const base = rotationBase || layouts
  const warm = warmOrder || pages
  const index = new Map(pages.map((p, i) => [`${p.layout}#${p.page}`, i]))
  const blocks = Object.fromEntries(layouts.map((l) => [l, Array.from({ length: n }, () => [])]))
  const rng = lcg(seed >>> 0)
  const tick = (key, slot, position, wall) => call(index.get(key), slot, position, wall)

  for (const { layout, page } of warm) {
    const key = `${layout}#${page}`
    for (let i = 0; i < warmup; i++) {
      const seq = i & 1 ? ['slot2', 'slot1'] : ['slot1', 'slot2']
      for (const slot of seq) tick(key, slot, seq[0] === slot ? 'first' : 'second', -1)
    }
  }

  for (let i = 0; i < n; i++) {
    const shift = i % base.length
    const ordered = []
    for (const layout of base.slice(shift).concat(base.slice(0, shift))) {
      for (const { page } of pages.filter((p) => p.layout === layout)) ordered.push(`${layout}#${page}`)
    }
    for (let oi = 0; oi < ordered.length; oi++) {
      const key = ordered[oi]
      const wall = i + oi / ordered.length
      let slot1 = 0
      let slot2 = 0
      for (let k = 0; k < batch / 2; k++) {
        const seq = rng() < 0.5 ? ['slot1', 'slot2'] : ['slot2', 'slot1']
        for (const half of [seq, seq.slice().reverse()]) {
          for (const slot of half) {
            const ms = tick(key, slot, half[0] === slot ? 'first' : 'second', wall)
            if (slot === 'slot1') slot1 += ms
            else slot2 += ms
          }
        }
      }
      blocks[key.slice(0, key.lastIndexOf('#'))][i].push(
        Math.log((slot2 / batch) / (slot1 / batch)),
      )
    }
  }
  return { blocks, pageIndex: index }
}

/**
 * Design B estimator. Blocks are already temporally paired across the pages of a layout, so the
 * point estimate is the plain mean of the block log-ratios and the bootstrap resamples blocks.
 */
export function blockedEffect(blocks, seed, bootstrap = 12000) {
  const logPoint = blocks.reduce((a, b) => a + b, 0) / blocks.length
  const random = lcg(seed >>> 0)
  const draws = new Array(bootstrap)
  for (let i = 0; i < bootstrap; i++) {
    let total = 0
    for (let j = 0; j < blocks.length; j++) total += blocks[(random() * blocks.length) | 0]
    draws[i] = total / blocks.length
  }
  draws.sort((a, b) => a - b)
  const pct = (x) => (Math.exp(x) - 1) * 100
  return {
    logPoint,
    pct: pct(logPoint),
    ci95: [
      pct(draws[Math.floor(draws.length * 0.025)]),
      pct(draws[Math.floor(draws.length * 0.975)]),
    ],
    logRatios: { blocks: blocks.slice() },
  }
}

/** The shipped harness' estimator, re-exported so tests exercise the real crossover algebra. */
export { crossoverEffect }

/**
 * The estimator the shipped harness actually computes, restated in the only form that matters for
 * a self-null: it is half the difference between two pages' mean slot2/slot1 log ratios.
 */
export function selfNullAsPageDifference(rows) {
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  const v = (rs) => mean(rs.map((r) => Math.log(r.slot2 / r.slot1)))
  return {
    forward: v(rows.effectForward),
    reverse: v(rows.effectReverse),
    estimator: 0.5 * (v(rows.effectForward) - v(rows.effectReverse)),
  }
}

/**
 * Reproduces the aggregate the calibration closeout reports: a Student-t interval on the
 * fresh-runner log-effect point estimates.
 */
export function aggregateRunnerPoints(points, t975) {
  const m = points.reduce((a, b) => a + b, 0) / points.length
  const sd = Math.sqrt(points.reduce((a, b) => a + (b - m) ** 2, 0) / (points.length - 1))
  const h = t975(points.length - 1) * sd / Math.sqrt(points.length)
  const pct = (x) => (Math.exp(x) - 1) * 100
  return { logPoint: m, pct: pct(m), runnerSdLog: sd, ci95: [pct(m - h), pct(m + h)] }
}