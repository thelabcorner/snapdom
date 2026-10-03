/**
 * Browser-free model of every R9 hosted topology-challenge lane.
 *
 * Replays the exact control flow of the six preregistered lanes over synthetic per-call latencies,
 * so the properties the challenge is supposed to establish are decidable before any hosted runner
 * is spent, and falsifiable in milliseconds. It imports `crossoverEffect` from the real
 * `lane6-scratch/r9/protocol.mjs`, so the shipped estimator is what the tests exercise, not a
 * restatement of it.
 *
 * It never imports Playwright. `node --test` runs it anywhere.
 *
 * THE COST MODEL
 *
 *   ms = baseMs * exp( pageLog(page,t) + recordLog(record,t) + posLog[position]
 *                       + interactLog(page,t) * [position == 'first']
 *                       + armLog(arm) )
 *       + additiveMs(page,t)
 *       + injectMs * [this arm carries the synthetic positive-control cost]
 *       + baseMs * eps
 *
 * Every term is keyed to something a hosted runner makes non-zero for reasons that have nothing to
 * do with snapDOM:
 *
 *   pageLog        stationary physical-page speed        (the shipped estimator cancels this exactly)
 *   recordLog      per-MODULE-RECORD JIT/decode state    (cancelled only when both slots share one
 *                                                          record, i.e. only in the identity canary)
 *   posLog         first-of-pair vs second-of-pair cost   (cancelled by position balancing)
 *   interactLog    page x position, possibly NONSTATIONARY in wall time (the §4 channel; the only
 *                   term the shipped crossover cannot cancel)
 *   armLog         a REAL arm-keyed treatment effect      (what a candidate improvement would be)
 *   injectMs       the DETERMINISTIC SYNTHETIC positive control, additive, arm-keyed
 *
 * `t` is a wall-clock proxy (round index plus the layout's position within that round), not a
 * per-page call counter. Every page receives exactly the same number of calls, so a call-count
 * clock would make the two pages of a pair trivially identical.
 */

import { crossoverEffect } from '../../../r9/protocol.mjs'
import { lcg, gaussian } from '../../algebra/schedule.mjs'
import {
  DOSES,
  LANES,
  armsForLane,
  injectedArmsFor,
  laneLayoutOrder,
} from './call-budget.mjs'

function resolve(field, key, t) {
  if (typeof field === 'function') return field(key, t)
  if (Array.isArray(field)) {
    const v = field[key]
    return typeof v === 'function' ? v(key, t) : (v ?? 0)
  }
  return field ?? 0
}

export function makeChallengeCall(world) {
  const rng = lcg((world.seed ?? 1) >>> 0)
  const baseMs = world.baseMs ?? 40
  const noiseLog = world.noiseLog ?? 0
  const armLog = world.armLog ?? 0
  const recordLog = world.recordLog
  const injectMs = world.injectMs ?? 0
  return function call({ page, record, slot, arm, position, wall, inject = false }) {
    const pageTerm = resolve(world.pageLog, page, wall)
    const recTerm = recordLog ? resolve(recordLog, record, wall) : 0
    const add = resolve(world.additiveMs, page, wall)
    const pos = world.posLog?.[position] ?? 0
    const inter = position === 'first' ? resolve(world.interactLog, page, wall) : 0
    const armTerm = armLog ? armLog(arm) : 0
    const inj = inject && injectMs ? injectMs : 0
    const eps = noiseLog ? gaussian(rng) * noiseLog : 0
    return baseMs * Math.exp(pageTerm + recTerm + pos + inter + armTerm + eps) + add + inj
  }
}

/** Counting wrapper so a test can measure actually-executed timed calls, not a declared number. */
export function countingCall(world, counter) {
  const inner = makeChallengeCall(world)
  return function counted(spec) {
    if (spec.timed !== false) counter.timed += 1
    else counter.untimed += 1
    return inner(spec)
  }
}

/**
 * Which orders a lane is created, warmed and rotated in, derived from the ONE canonical list.
 *
 * `reversalScope` exists so a test can prove the ledger's §3 claim directly: reversing creation
 * alone does NOT flip the §4 leak, because the leak depends on the page-keyed term evaluated at
 * each layout's WITHIN-ROUND POSITION. Only the full reversal of creation + warm + rotation moves
 * both arguments and flips the sign. That is the whole justification for keeping one list with no
 * per-knob ordering override.
 */
function ordersFor(lane, reversalScope) {
  const spec = LANES[lane]
  const original = spec.layouts.slice()
  const full = laneLayoutOrder(lane)
  if (!spec.reversed) {
    return { pageOrder: original, warmOrder: original.slice(), rotationBase: original.slice() }
  }
  if (reversalScope === 'creationOnly') {
    return { pageOrder: full, warmOrder: original.slice(), rotationBase: original.slice() }
  }
  if (reversalScope === 'rotationOnly') {
    return { pageOrder: original.slice(), warmOrder: original.slice(), rotationBase: full }
  }
  if (reversalScope !== 'all') throw new Error(`unknown reversalScope: ${reversalScope}`)
  return { pageOrder: full, warmOrder: full.slice(), rotationBase: full.slice() }
}

function pageRecords(identityCanary) {
  // One module record per slot, unless the canary collapses both slots onto a single URL.
  return (page, slot) => (identityCanary ? page * 2 : page * 2 + slot)
}

function blockSummary(slot1Sum, slot2Sum, batch) {
  const slot1 = slot1Sum / batch
  const slot2 = slot2Sum / batch
  return { slot1, slot2, logRatio: Math.log(slot2 / slot1), callsPerPageBlock: 2 * batch }
}

/**
 * Current rig: one physical page per layout, `batch` micro-interleaved replicate-pairs per
 * acquisition block, Latin rotation over the canonical layout list.
 *
 * This is `bench-r9-controlled.mjs`'s `sample` verbatim, including the `(index + b) & 1` surplus
 * rule and the odd-batch parity mirror the ledger (§2) depends on.
 */
export function runCrossoverLane(call, lane, {
  blocks, batch, warmup = 6, reversalScope = 'all', wall = null,
} = {}) {
  const spec = LANES[lane]
  const orders = ordersFor(lane, reversalScope)
  const { pageOrder, warmOrder, rotationBase } = orders
  const record = pageRecords(spec.identityCanary)
  const pageIndex = new Map(pageOrder.map((name, i) => [name, i]))
  const rows = Object.fromEntries(pageOrder.map((name) => [name, []]))
  const pages = []
  const t0 = wall ?? { value: 0 }

  const tick = (layout, slot, position, w, timed) => {
    const page = pageIndex.get(layout)
    const arms = armsForLane(lane, layout)
    const inject = injectedArmsFor(layout)
    return call({
      page,
      record: record(page, slot),
      slot,
      arm: arms[slot],
      position,
      wall: w,
      inject: inject[slot],
      timed,
    })
  }

  for (const name of warmOrder) {
    for (let i = 0; i < warmup; i++) {
      const seq = i & 1 ? [1, 0] : [0, 1]
      for (const slot of seq) tick(name, slot, seq[0] === slot ? 'first' : 'second', -1, false)
    }
    tick(name, 0, 'first', -1, false)
    tick(name, 1, 'second', -1, false)
  }

  for (let i = 0; i < blocks; i++) {
    const shift = i % rotationBase.length
    const rotated = rotationBase.slice(shift).concat(rotationBase.slice(0, shift))
    for (let oi = 0; oi < rotated.length; oi++) {
      const name = rotated[oi]
      const w = i + oi / rotated.length
      let s1 = 0
      let s2 = 0
      const perCall = []
      for (let b = 0; b < batch; b++) {
        const seq = (i + b) & 1 ? [1, 0] : [0, 1]
        for (const slot of seq) {
          const ms = tick(name, slot, seq[0] === slot ? 'first' : 'second', w, true)
          if (slot === 0) s1 += ms
          else s2 += ms
          perCall.push({ slot, position: seq[0] === slot ? 0 : 1, ms })
        }
      }
      pages.push({
        layout: name,
        page: pageIndex.get(name),
        creationIndex: pageIndex.get(name),
        warmIndex: warmOrder.indexOf(name),
        block: i,
        roundPos: oi,
        ...blockSummary(s1, s2, batch),
        perCall,
      })
      rows[name].push({ block: i, roundPos: oi, slot1: s1 / batch, slot2: s2 / batch })
    }
    t0.value += 1
  }
  return { rows, pages, orders }
}

/**
 * Blocked rig: `pagesPerLayout` physical pages per logical layout; every acquisition block runs
 * `batch/2` adjacent replicate-pairs on ONE page, each pair executing the two arms in opposite
 * orders with a seeded coin choosing which order leads.
 *
 * This is `bench-r9-blocked.mjs`'s `block` verbatim, with the coin seed extended by the page index
 * so two pages in the same block do not replay an identical lead pattern.
 */
export function runBlockedLane(call, lane, {
  blocks, batch, warmup = 6, seed = 1, reversalScope = 'all', wall = null,
} = {}) {
  if (batch % 2) throw new Error('blocked lane requires an even batch for within-block balance')
  const spec = LANES[lane]
  const orders = ordersFor(lane, reversalScope)
  const { pageOrder, warmOrder, rotationBase } = orders
  const record = pageRecords(spec.identityCanary)

  const pageOf = new Map()
  for (const name of pageOrder) {
    for (let p = 0; p < spec.pagesPerLayout; p++) pageOf.set(`${name}#${p}`, { layout: name, page: p })
  }
  const globalIndex = new Map()
  warmOrder.forEach((_, i) => globalIndex.set(warmOrder[i], i))

  const pageRows = Object.fromEntries(pageOrder.map((n) => [n, []]))
  const blocksByLayout = Object.fromEntries(pageOrder.map((n) => [n, Array.from({ length: blocks }, () => [])]))

  const tick = (layout, pageSlot, slot, position, w, timed) => {
    const arms = armsForLane(lane, layout)
    const inject = injectedArmsFor(layout)
    return call({
      page: globalIndex.get(layout) * spec.pagesPerLayout + pageSlot,
      record: record(globalIndex.get(layout) * spec.pagesPerLayout + pageSlot, slot),
      slot,
      arm: arms[slot],
      position,
      wall: w,
      inject: inject[slot],
      timed,
    })
  }

  for (const name of warmOrder) {
    for (let p = 0; p < spec.pagesPerLayout; p++) {
      for (let i = 0; i < warmup; i++) {
        const seq = i & 1 ? [1, 0] : [0, 1]
        for (const slot of seq) tick(name, p, slot, seq[0] === slot ? 'first' : 'second', -1, false)
      }
      // Untimed byte oracle, exactly as the harness runs it on every page of every lane.
      tick(name, p, 0, 'first', -1, false)
      tick(name, p, 1, 'second', -1, false)
    }
  }

  for (let i = 0; i < blocks; i++) {
    const shift = i % rotationBase.length
    const ordered = []
    for (const name of rotationBase.slice(shift).concat(rotationBase.slice(0, shift))) {
      for (let p = 0; p < spec.pagesPerLayout; p++) ordered.push({ name, p })
    }
    for (let oi = 0; oi < ordered.length; oi++) {
      const { name, p } = ordered[oi]
      const w = i + oi / ordered.length
      let rngState = (seed + i * 104729 + p * 7919 + globalIndex.get(name) * 31) >>> 0
      const rnd = () => {
        rngState = (rngState * 1664525 + 1013904223) >>> 0
        return rngState / 4294967296
      }
      let s1 = 0
      let s2 = 0
      const perCall = []
      for (let k = 0; k < batch / 2; k++) {
        const lead = rnd() < 0.5 ? 0 : 1
        for (const seq of [[lead, 1 - lead], [1 - lead, lead]]) {
          for (const slot of seq) {
            const ms = tick(name, p, slot, seq[0] === slot ? 'first' : 'second', w, true)
            if (slot === 0) s1 += ms
            else s2 += ms
            perCall.push({ slot, position: seq[0] === slot ? 0 : 1, ms })
          }
        }
      }
      const summary = blockSummary(s1, s2, batch)
      pageRows[name].push({
        layout: name,
        page: p,
        creationIndex: globalIndex.get(name) * spec.pagesPerLayout + p,
        warmIndex: warmOrder.indexOf(name) * spec.pagesPerLayout + p,
        block: i,
        roundPos: oi,
        ...summary,
        perCall,
      })
      blocksByLayout[name][i].push(summary.logRatio)
    }
  }
  return { pageRows, blocksByLayout, orders }
}

/**
 * Run a lane's control flow with the model call function.
 *
 * `profile` is the whole sampling profile (`{ warmup, blocks: {lane: n}, batch: {lane: b} }`) so
 * the model and the harness are driven by the same POLICY document and cannot drift apart.
 */
export function runLane(world, lane, profile, opts = {}) {
  if (!LANES[lane]) throw new Error(`unknown lane: ${lane}`)
  const sampling = {
    blocks: profile.blocks[lane],
    batch: profile.batch[lane],
    warmup: profile.warmup,
  }
  const counter = { timed: 0, untimed: 0 }
  const call = countingCall(world, counter)
  const data = LANES[lane].topology === 'current'
    ? runCrossoverLane(call, lane, { ...sampling, ...opts })
    : runBlockedLane(call, lane, { ...sampling, ...opts })
  return { lane, data, counter, sampling }
}

function blockedCell(logRatios, seed, bootstrap) {
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
  const logPoint = mean(logRatios)
  const random = lcg(seed >>> 0)
  const draws = new Array(bootstrap)
  for (let i = 0; i < bootstrap; i++) {
    let total = 0
    for (let j = 0; j < logRatios.length; j++) total += logRatios[(random() * logRatios.length) | 0]
    draws[i] = total / logRatios.length
  }
  draws.sort((a, b) => a - b)
  const pct = x => (Math.exp(x) - 1) * 100
  return {
    logPoint,
    pct: pct(logPoint),
    ci95: [
      pct(draws[Math.floor(draws.length * 0.025)]),
      pct(draws[Math.floor(draws.length * 0.975)]),
    ],
    logRatios: { blocks: logRatios.slice() },
  }
}

/** Mean of a blocked layout's per-block ratios, after averaging that block's physical pages. */
export function blockedBlockSeries(blocksByLayout, layout) {
  return blocksByLayout[layout].map(xs => xs.reduce((a, b) => a + b, 0) / xs.length)
}

const pairCell = (data, fwd, rev, seed, bootstrap) =>
  crossoverEffect(data.rows[fwd], data.rows[rev], seed, bootstrap)

/**
 * Evaluate a lane into the cells it is preregistered to publish.
 *
 * Current rig  -> { candidate, baseNull, optNull }   (the ledger's §5 triplet)
 * Blocked rig  -> { effect, baseNull, optNull }
 * Canary       -> { canary }                         (no arm-sensitive cell, by construction)
 * Recovery     -> { doses: { low: { treatment, treatmentNull, recovery }, high: {...} } }
 */
export function evaluateLane(lane, data, { seed = 1, bootstrap = 4000 } = {}) {
  const spec = LANES[lane]
  if (spec.role === 'canary') {
    return {
      lane,
      role: spec.role,
      treatmentSensitive: false,
      cells: {
        canary: pairCell(data, 'effectForward', 'effectReverse', seed + 1, bootstrap),
      },
    }
  }
  if (spec.role === 'null-triplet') {
    if (spec.topology === 'current') {
      return {
        lane,
        role: spec.role,
        treatmentSensitive: true,
        cells: {
          candidate: pairCell(data, 'effectForward', 'effectReverse', seed + 1, bootstrap),
          baseNull: pairCell(data, 'baseNullForward', 'baseNullReverse', seed + 3, bootstrap),
          optNull: pairCell(data, 'optNullForward', 'optNullReverse', seed + 5, bootstrap),
        },
      }
    }
    return {
      lane,
      role: spec.role,
      treatmentSensitive: true,
      cells: {
        effect: blockedCell(blockedBlockSeries(data.blocksByLayout, 'effect'), seed + 1, bootstrap),
        baseNull: blockedCell(blockedBlockSeries(data.blocksByLayout, 'baseNull'), seed + 3, bootstrap),
        optNull: blockedCell(blockedBlockSeries(data.blocksByLayout, 'optNull'), seed + 5, bootstrap),
      },
    }
  }
  const doses = {}
  DOSES.forEach((d, i) => {
    const D = d[0].toUpperCase() + d.slice(1)
    const treatment = spec.topology === 'current'
      ? pairCell(data, `treatment${D}Forward`, `treatment${D}Reverse`, seed + 11 + i * 2, bootstrap)
      : blockedCell(blockedBlockSeries(data.blocksByLayout, `treatment${D}`), seed + 11 + i * 2, bootstrap)
    const treatmentNull = spec.topology === 'current'
      ? pairCell(data, `treatmentNull${D}Forward`, `treatmentNull${D}Reverse`, seed + 13 + i * 2, bootstrap)
      : blockedCell(blockedBlockSeries(data.blocksByLayout, `treatmentNull${D}`), seed + 13 + i * 2, bootstrap)
    doses[d] = {
      treatment,
      treatmentNull,
      recovery: { logPoint: treatment.logPoint - treatmentNull.logPoint },
    }
    doses[d].recovery.pct = (Math.exp(doses[d].recovery.logPoint) - 1) * 100
  })
  return { lane, role: spec.role, treatmentSensitive: true, doses }
}

/** Convenience: run and evaluate a lane in one call. */
export function measureLane(world, lane, profile, opts = {}) {
  const { data } = runLane(world, lane, profile, opts)
  return evaluateLane(lane, data, { seed: opts.seed ?? 1, bootstrap: opts.bootstrap ?? 4000 })
}
/**
 * The ledger's §4 hostile world: a NONSTATIONARY page x position term with a per-page phase.
 *
 * Every discontinuity of this term contributes at most half its own size over the affected window,
 * because the alternating block parity only ever sums to +/-1 there. The ledger proved that a
 * single-step toy model leaks <= 0.5%; the hosted corrected run then falsified 0.5% as a
 * real-hardware ceiling. This world is the algebra-side stand-in for that §4 channel and is used
 * only to compare topologies to each other, never as a magnitude prediction.
 */
export function hostileNonstationaryWorld({ seed = 29, scale = 1, ...rest } = {}) {
  const phase = [2.0, 0.0, 1.4, 0.3, 1.1, 0.6]
  const step = (t, thr, s) => (t > thr ? s : 0)
  return {
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    pageLog: [0.01, -0.02, 0.03, 0.0, -0.01, 0.02],
    additiveMs: [3, 0, 7, 1, 5, 2],
    interactLog: (p, t) => -scale * step(t + phase[p % 6], 8, 1.0) - scale * step(t + phase[p % 6], 15, 0.4),
    seed,
    ...rest,
  }
}

/**
 * A per-MODULE-RECORD channel: two records of identical bytes that JIT/decode differently.
 *
 * The record term is deliberately a function of (record, wall time) rather than a constant per
 * record: a stationary per-record term is cancelled exactly by the crossover's odd-batch parity
 * mirror, so a constant would prove nothing. The record coefficient is spaced by 1.7 radians so
 * neighbouring records differ maximally; spacing it by the raw record index with a shared LCG seed
 * would leave neighbouring records nearly identical, because an LCG's first output for seed s and
 * s+1 differs by only about 4e-4.
 */
export function recordChannelWorld({ seed = 41, spread = 0.2, phaseStep = 1.7, decay = 3, ...rest } = {}) {
  return {
    baseMs: 40,
    posLog: { first: 0, second: -0.03 },
    recordLog: (_r, t) => spread * Math.sin(phaseStep * _r + t / decay),
    seed,
    ...rest,
  }
}
