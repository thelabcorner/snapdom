#!/usr/bin/env node
// R10-ANIM1 fixture-structure contract. Node only — no browser, no bundle, no timing.
//
// WHY THIS FILE EXISTS
// --------------------
// Two of this lane's hosted fixtures asserted a read-savings contract that their own DOM geometry did
// not support:
//
//   1. `descendant-of-root` appended its animated node to the capture root AFTER the corpus, so the
//      queried rows were that node's SIBLINGS. v2 released them — correctly — and the fixture's
//      "saved === 0" contract rejected a correct implementation.
//   2. `anim-self-60` animated `opacity` on the capture root. Root opacity changes no descendant's
//      computed style, so demanding saved === 0 demanded conservatism, not correctness: a tighter
//      implementation would be RIGHT to release.
//
// Both were invisible to the hosted run until it cost a runner, and both are invisible to any check
// that only looks at the code rather than at the fixture's actual DOM shape. This file closes that
// gap: it builds a mock DOM from the SAME plan the probe builds the real one from
// (lane6-scratch/r10/fixture-geometry.mjs), and holds every role against an independent oracle.
//
// The contract asserted for each fixture, over EVERY queried row:
//
//   opportunity  no queried row is at or below the animated node        -> spec RELEASES
//   falsifier    every queried row is at or below the animated node      -> spec BLOCKS
//   control      no animation                                            -> spec RELEASES
//   conservative reported only, never gated
//
// Plus the admissibility rule that keeps a fixture out of the zero-savings contract unless blocking is
// MANDATORY: an `inherited` channel (descendants' computed values really move) or `unresolvable` (the
// scan must fail closed). A `nonInherited` channel is blocked by this lane only because it tests
// position, and the spec permits a release, so it is reported and never gated.
//
// Run: node lane6-scratch/r10/check-r10-fixture-contract.mjs

import { CHANNELS, FIXTURES, fixturePlan, isGatedFalsifier } from './fixture-geometry.mjs'

const failures = []
const check = (label, cond) => { if (!cond) failures.push(label) }

// --- mock DOM built from the shared plan -------------------------------------
function makeNode(name, parent, root) {
  return {
    name,
    nodeType: 1,
    parentElement: parent || null,
    root,
    getRootNode() { return this.root },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === this) return true
      return false
    },
  }
}

function buildFromPlan(plan) {
  const doc = { name: '#document', documentElement: null }
  const byName = {}
  for (const [child, parent] of plan.edges) {
    const node = makeNode(child, parent ? byName[parent] : null, doc)
    byName[child] = node
    if (child === plan.docElement) doc.documentElement = node
  }
  if (plan.shadowInner) {
    // Shadow content: its getRootNode() is a ShadowRoot, not the document, so the scan cannot
    // attribute it and every consumer must fail closed.
    const shadowRoot = { name: '#shadow-root' }
    const host = byName[plan.edges.find(([c]) => c === 'shadowHost')[0]]
    const inner = makeNode(plan.shadowInner, null, shadowRoot)
    byName[plan.shadowInner] = inner
    host.shadowChildren = [inner]
  }
  return { doc, byName }
}

// --- independent oracle: enumerate everything, ask the spec question --------
function specBlocks(byName, targetName, elName) {
  if (!targetName) return false
  const target = byName[targetName]
  const el = byName[elName]
  if (target.root !== el.root) return true // unattributable -> fail closed
  return el === target || target.contains(el)
}

const rows = []
for (const fx of FIXTURES) {
  const plan = fixturePlan(fx)
  const { byName } = buildFromPlan(plan)

  check(`${fx.name}: channel is declared`, CHANNELS.has(fx.channel))
  check(`${fx.name}: keys present unless control`, fx.role === 'control' ? fx.keys === null : Array.isArray(fx.keys) && fx.keys.length > 0)

  const verdicts = plan.queried.map((row) => specBlocks(byName, plan.target, row))
  const blocked = verdicts.filter(Boolean).length
  const released = verdicts.length - blocked

  let required
  if (fx.role === 'opportunity') required = 'all-released'
  else if (fx.role === 'partial') required = 'partial'
  else if (fx.role === 'falsifier') required = 'all-blocked'
  else if (fx.role === 'control') required = 'all-released'
  else if (fx.role === 'conservative') required = 'report-only'
  else throw new Error('unknown role ' + fx.role)

  // The contract itself: the fixture's role must match what its geometry actually implies.
  if (required === 'all-released') {
    check(`${fx.name}: role=${fx.role} requires every queried row released, geometry gives ${released}/${verdicts.length}`, released === verdicts.length)
  } else if (required === 'partial') {
    // The animated node is itself part of the corpus, so it is blocked while its SIBLINGS are
    // released. Precisely: something must be released, and nothing may be blocked except the
    // animated node and its descendants.
    check(`${fx.name}: role=partial requires at least one released row, got ${released}/${verdicts.length}`, released > 0)
    const target = byName[plan.target]
    const wronglyBlocked = plan.queried.filter((row, i) => verdicts[i] && row !== plan.target && !target.contains(byName[row]))
    check(`${fx.name}: only the animated node and its descendants may be blocked`, wronglyBlocked.length === 0)
  } else if (required === 'all-blocked') {
    check(`${fx.name}: role=${fx.role} requires every queried row blocked, geometry gives ${blocked}/${verdicts.length}`, blocked === verdicts.length)
  }

  // Admissibility: only mandatory channels may be held to saved === 0.
  if (isGatedFalsifier(fx)) {
    check(`${fx.name}: gated falsifier must be on a mandatory channel, got "${fx.channel}"`,
      fx.channel === 'inherited' || fx.channel === 'unresolvable')
  }
  if (fx.role === 'conservative') {
    check(`${fx.name}: conservative fixtures must NOT be on a mandatory channel, got "${fx.channel}"`, fx.channel !== 'inherited' && fx.channel !== 'unresolvable')
    check(`${fx.name}: conservative fixtures must carry a note`, typeof fx.note === 'string' && fx.note.length > 20)
  }
  if (fx.role === 'control') check(`${fx.name}: control must have no animated target`, plan.target === null)
  if (fx.role !== 'control') check(`${fx.name}: must name an animated target`, typeof plan.target === 'string' && plan.target.length > 0)

  rows.push({
    name: fx.name, role: fx.role, channel: fx.channel, where: fx.where,
    animated: plan.target || '-', queried: plan.queried.length, blocked, released,
    gated: isGatedFalsifier(fx),
  })
}

// --- the specific regressions that were found the hard way -------------------
{
  const intermediate = FIXTURES.find((f) => f.where === 'intermediateAncestor')
  const plan = fixturePlan(intermediate)
  const { byName } = buildFromPlan(plan)
  check('intermediateAncestor: the corpus is not parented directly to the capture root',
    plan.edges.some(([c, p]) => c === plan.queried[0] && p === 'wrap'))
  check('intermediateAncestor: rows are genuinely BELOW the animated node, not beside it',
    byName.wrap.contains(byName[plan.queried[0]]))
  check('intermediateAncestor: a sibling-of-target row must NOT exist (that was the bug)',
    !plan.edges.some(([c, p]) => c === plan.queried[0] && p === 'root'))
}
{
  const self = FIXTURES.find((f) => f.name === 'anim-self-60')
  check('anim-self-60 animates an INHERITED property, so zero savings is mandatory rather than conservative',
    Object.keys(self.keys[0]).some((k) => k === 'color' || k === '--'))
  const rootOpacity = FIXTURES.find((f) => f.name === 'anim-root-opacity-60')
  check('anim-root-opacity-60 is retained as an explicitly ungated conservative fixture',
    rootOpacity && rootOpacity.role === 'conservative' && !isGatedFalsifier(rootOpacity))
}

const ROLE_LABEL = { opportunity: 'saved>0 ', partial: 'saved>0*', falsifier: 'saved=0*', conservative: 'report  ', control: 'saved=0 ' }
console.log('  fixture                              geometry               channel        animated   blocked  contract')
for (const r of rows) {
  console.log(`  ${r.name.padEnd(34)} ${r.where.padEnd(22)} ${r.channel.padEnd(14)} ${String(r.animated).padEnd(10)} ` +
    `${String(r.blocked + '/' + r.queried).padEnd(8)} ${ROLE_LABEL[r.role]}${r.gated ? ' (gated)' : ''}`)
}
console.log('')
console.log(`R10-ANIM1 fixture contract: ${FIXTURES.length} fixtures, ` +
  `${rows.filter((r) => r.gated).length} gated falsifiers, ` +
  `${rows.filter((r) => r.role === 'conservative').length} reported-only conservative`)
console.log('  * gated = blocking is MANDATORY by the spec (inherited or unresolvable channel)')
if (failures.length) {
  console.error(`${failures.length} FAILURES:`)
  for (const f of failures) console.error('  ' + f)
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}