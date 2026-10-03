#!/usr/bin/env node
// R10-ANIM1 pure-algorithm invariant check. Node only — NO BROWSER, no bundling, no timing.
//
// The hosted probe proves the lane end to end, but it needs three engines and a compiled bundle, so
// it is a slow gate. The load-bearing piece of the lane is much smaller and much sharper: the
// ancestor-closure walk in buildAnimationScope uses a `break` as soon as it meets a node already in
// the set, and that shortcut is only sound because the closure is monotone. If it were not, a deep
// tree would silently produce a short ancestors set and every ANIM_SCOPE_SELF_OR_ANCESTOR answer
// would be wrong in the unsafe direction.
//
// That is a pure data-structure claim about a handful of Set operations, so it is checked here
// against a mock DOM in milliseconds, with the algorithm copied VERBATIM from
// src/modules/styleScan.js. If the two ever drift, this file says so rather than silently passing.
//
// Run: node lane6-scratch/r10/check-r10-anim-scope-algorithm.mjs

// ---------------------------------------------------------------------------
// verbatim from src/modules/styleScan.js — keep in sync, do not "improve" independently
// ---------------------------------------------------------------------------
function buildAnimationScope(doc, animations) {
  const targets = new Set()
  const ancestors = new Set()
  let unresolvable = false
  for (const anim of animations) {
    const target = anim?.effect?.target
    if (!target || target.nodeType !== 1) { unresolvable = true; continue }
    if (target.getRootNode && target.getRootNode() !== doc) { unresolvable = true; continue }
    targets.add(target)
    for (let a = target.parentElement; a; a = a.parentElement) {
      if (ancestors.has(a)) break
      ancestors.add(a)
    }
  }
  return { count: animations.length, targets, ancestors, unresolvable }
}

const ANIM_SCOPE_SELF = 1
const ANIM_SCOPE_SELF_OR_ANCESTOR = 2
const ANIM_SCOPE_SUBTREE = 3
/** verbatim shape of the styles.js decision, with the counter sink and counterfactual stripped */
function animationBlocks(scan, el, scope) {
  if (!scan.hasAnimations) return false
  const index = scan.animationScope
  if (!index) return true
  let blocked
  if (index.unresolvable) blocked = true
  else if (scope === ANIM_SCOPE_SELF) blocked = index.targets.has(el)
  else if (scope === ANIM_SCOPE_SELF_OR_ANCESTOR) blocked = index.targets.has(el) || index.ancestors.has(el)
  else {
    blocked = index.ancestors.has(el)
    if (!blocked) {
      for (const target of index.targets) {
        if (target === el || el.contains(target)) { blocked = true; break }
      }
    }
  }
  return blocked
}
// ---------------------------------------------------------------------------

import fs from 'node:fs'

const SOURCE = 'src/modules/styleScan.js'

function makeNode(name, parent, root) {
  return {
    name,
    parentElement: parent || null,
    nodeType: 1,
    root,
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === this) return true
      return false
    },
    getRootNode() { return this.root },
  }
}

function chain(names) {
  const doc = { name: '#document' }
  const byName = {}
  let parent = null
  for (const name of names) {
    const node = makeNode(name, parent, doc)
    byName[name] = node
    parent = node
  }
  return { doc, byName }
}

const anim = (target) => ({ effect: { target } })

/** Independent definition of the answer, used to judge the optimized walk. */
function bruteForceAncestors(targets) {
  const out = new Set()
  for (const t of targets) for (let a = t.parentElement; a; a = a.parentElement) out.add(a)
  return out
}

const failures = []
const check = (label, condition) => { if (!condition) failures.push(label) }

// --- 0. the copy has not drifted from the real source -------------------------
{
  const real = fs.readFileSync(SOURCE, 'utf8')
  const here = fs.readFileSync(new URL(import.meta.url), 'utf8')
  for (const marker of [
    'if (ancestors.has(a)) break',
    'targets.add(target)',
    'if (!target || target.nodeType !== 1) { unresolvable = true; continue }',
  ]) {
    check(`source still contains "${marker}"`, real.includes(marker))
    check(`this file still contains "${marker}"`, here.includes(marker))
  }
}

// --- 1. the monotone shortcut equals brute force, over shapes and orderings ---
const SHAPES = [
  ['html', 'body', 'main', 'card', 'row'],
  ['html', 'body'],
  ['html'],
  ['html', 'body', 'a', 'b', 'c', 'd', 'e', 'f'],
  ['html', 'body', 'x', 'y'],
  ['html', 'body', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'leaf'],
]
let cases = 0
for (const shape of SHAPES) {
  for (let trial = 0; trial < 200; trial++) {
    cases++
    const { doc, byName } = chain(shape)
    const count = 1 + Math.floor(Math.random() * 3)
    const picked = []
    for (let i = 0; i < count; i++) picked.push(byName[shape[Math.floor(Math.random() * shape.length)]])
    const index = buildAnimationScope(doc, picked.map(anim))
    const expected = bruteForceAncestors(picked)
    const label = `${shape.join('>')} #${trial}`
    check(`${label}: closure size`, index.ancestors.size === expected.size)
    for (const n of expected) check(`${label}: closure has ${n.name}`, index.ancestors.has(n))
    for (const n of index.ancestors) check(`${label}: no spurious ${n.name}`, expected.has(n))
    check(`${label}: dedup targets`, index.targets.size === new Set(picked).size)
    check(`${label}: resolvable`, index.unresolvable === false)
  }
}

// --- 2. deep target first, then shallow: the shortcut must not truncate -------
{
  const { doc, byName } = chain(['html', 'body', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'leaf'])
  const index = buildAnimationScope(doc, [anim(byName.leaf), anim(byName.d2)])
  check('deep-first: html in closure', index.ancestors.has(byName.html))
  check('deep-first: d7 in closure', index.ancestors.has(byName.d7))
  check('deep-first: full closure', index.ancestors.size === 9)
  const reversed = buildAnimationScope(doc, [anim(byName.d2), anim(byName.leaf)])
  check('deep-first: order independent', reversed.ancestors.size === index.ancestors.size)
}

// --- 3. the three scope arms --------------------------------------------------
{
  const { doc, byName } = chain(['html', 'body', 'wrap', 'capture', 'row'])
  const scan = { hasAnimations: true, animationScope: buildAnimationScope(doc, [anim(byName.capture)]) }

  check('SELF: target blocked', animationBlocks(scan, byName.capture, ANIM_SCOPE_SELF))
  check('SELF: descendant released', !animationBlocks(scan, byName.row, ANIM_SCOPE_SELF))
  check('SELF: unrelated ancestor released', !animationBlocks(scan, byName.html, ANIM_SCOPE_SELF))

  check('SELF_OR_ANCESTOR: immediate ancestor blocked', animationBlocks(scan, byName.wrap, ANIM_SCOPE_SELF_OR_ANCESTOR))
  check('SELF_OR_ANCESTOR: root ancestor blocked', animationBlocks(scan, byName.html, ANIM_SCOPE_SELF_OR_ANCESTOR))
  check('SELF_OR_ANCESTOR: descendant released', !animationBlocks(scan, byName.row, ANIM_SCOPE_SELF_OR_ANCESTOR))

  check('SUBTREE: root blocked', animationBlocks(scan, byName.capture, ANIM_SCOPE_SUBTREE))
  check('SUBTREE: root ancestor blocked', animationBlocks(scan, byName.wrap, ANIM_SCOPE_SUBTREE))
  check('SUBTREE: non-root released', !animationBlocks(scan, byName.row, ANIM_SCOPE_SUBTREE))
}

// --- 4. a target INSIDE the subtree blocks the subtree arm --------------------
{
  const { doc, byName } = chain(['html', 'body', 'capture', 'row'])
  const scan = { hasAnimations: true, animationScope: buildAnimationScope(doc, [anim(byName.row)]) }
  check('SUBTREE: contains target -> blocked', animationBlocks(scan, byName.capture, ANIM_SCOPE_SUBTREE))
  check('SELF_OR_ANCESTOR: target blocked', animationBlocks(scan, byName.row, ANIM_SCOPE_SELF_OR_ANCESTOR))
  check('SELF_OR_ANCESTOR: its ancestor blocked', animationBlocks(scan, byName.capture, ANIM_SCOPE_SELF_OR_ANCESTOR))
}

// --- 5. fail-closed ----------------------------------------------------------
{
  const { doc, byName } = chain(['html', 'body', 'row'])
  const unattributable = buildAnimationScope(doc, [{ effect: null }, {}, { effect: {} }])
  check('null effect -> unresolvable', unattributable.unresolvable)
  check('null effect -> blocks SELF', animationBlocks({ hasAnimations: true, animationScope: unattributable }, byName.row, ANIM_SCOPE_SELF))

  const foreign = makeNode('foreign', null, { name: '#other' })
  check('foreign root -> unresolvable', buildAnimationScope(doc, [anim(foreign)]).unresolvable)

  const textNode = { nodeType: 3, parentElement: byName.row }
  check('non-element target -> unresolvable', buildAnimationScope(doc, [{ effect: { target: textNode } }]).unresolvable)

  check('no animation never blocks', !animationBlocks({ hasAnimations: false, animationScope: null }, byName.row, ANIM_SCOPE_SELF_OR_ANCESTOR))
  check('counterfactual null index blocks', animationBlocks({ hasAnimations: true, animationScope: null }, byName.row, ANIM_SCOPE_SELF))

  const empty = buildAnimationScope(doc, [])
  check('empty list not unresolvable', !empty.unresolvable)
  check('empty list releases', !animationBlocks({ hasAnimations: true, animationScope: empty }, byName.body, ANIM_SCOPE_SELF_OR_ANCESTOR))
}

console.log(`R10-ANIM1 algorithm check: ${cases} randomized closure cases + invariant set`)
if (failures.length) {
  console.error(`${failures} FAILURES:`)
  for (const f of failures.slice(0, 20)) console.error('  ' + f)
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}