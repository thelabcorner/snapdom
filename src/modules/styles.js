/**
 * Style snapshots: one object of computed values per node, and the caches that keep them
 * across captures.
 *
 * `inlineAllStyles` is the entry. Per node it snapshots the computed style (only the props
 * the page's CSS can touch, see styleScan.js), keys it, and stores the key on the session's
 * styleMap for the class CSS the engine emits. That snapshot is the dominant cost of a
 * capture, so most of this file is about not taking it: a cross-capture cache guarded by
 * per-node stamps and a document epoch, and a per-capture identity share where structural
 * twins copy one read and re-read only the used values.
 *
 * Invalidation for every consumer (burst, pseudo, CSSVar) is wired here, through two epochs:
 * `__epoch` bumps on any external mutation, `__envEpoch` only on what changes rendering with
 * no mutation on the node (head, fonts, resize). CSSOM edits that no observer can see go
 * through `invalidateStyleCaches`.
 * @module styles
 */

import { getStyleKey, softensWidth, softenNeedsAutoWidth, shouldIgnoreProp, getStyle, NO_DEFAULTS_TAGS, isHTMLEl, snapshotComputedStyle } from '../utils/index.js'
import { getDefaultStyleForTag, LOGICAL_TO_PHYSICAL } from '../utils/css.js'
import { isFirefox } from '../utils/browser.js'
import { cache } from '../core/cache.js'
import { scanAuthorStyles, scanInlineStyleDataAttrs, subjectAlternativeAttributeKey, collectSubjectAlternativeKeys } from './styleScan.js'
import { isInternalNode, markInternalNode } from '../utils/ownership.js'
import {
  BACKGROUND_INLINE_FLAG_PROPS,
  BG_LAYOUT_PROPS,
  BORDER_AUX_PROPS,
  MASK_LAYOUT_PROPS,
} from './backgroundProps.js'

/** element -> { env, stamp, snapshot, embedFonts, excludeStyleProps }. Cross-capture; a hit
 *  needs the env epoch and the node's stamp unchanged (snapshotIsCurrent). */
const snapshotCache = new WeakMap()
const MARGIN_PROPS = [
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end',
]
/** style signature -> class key. FIFO-bounded at insertion, see MAX_SNAPSHOT_KEY_CACHE. */
const snapshotKeyCache = new Map()
/** PERF-4: evict snapshotKeyCache when it grows beyond this size.
 *  Each entry stores a long CSS signature string → key string. In SPAs with many
 *  unique element styles, this Map can grow without bound and leak memory. */
const MAX_SNAPSHOT_KEY_CACHE = 2000
let __epoch = 0
function bumpEpoch() { __epoch++ }

/** Bumps the style epoch by hand. Nothing in src calls it; tests use it to force a re-snapshot. */
export function notifyStyleEpoch() { bumpEpoch() }

/** Mutations on snapdom-owned helper nodes (sandbox, measure wrapper, warmup img, injected font
 *  links, …) must NOT invalidate the style epoch: every capture creates and removes them, so
 *  without this filter each capture poisons the snapshot cache for the next one — repeated
 *  captures (gif/video export, cached sessions) paid a full re-snapshot every time. */
function isOwnedNode(node) {
  let el = node && (node.nodeType === 1 ? node : node.parentElement)
  while (el) {
    if (isInternalNode(el)) return true
    if (el.parentElement) el = el.parentElement
    else {
      const root = el.getRootNode?.()
      el = root && root.host ? root.host : null
    }
  }
  return false
}
/**
 * Whether any record in a batch comes from outside snapdom's own helper nodes.
 * @param {MutationRecord[]} records
 * @returns {boolean}
 */
export function hasExternalMutation(records) {
  for (const rec of records) {
    if (isExternalRecord(rec)) return true
  }
  return false
}

/** Per-record variant of the same ownership filter — burst's differential dirty-tracking
 *  needs to attribute each external record to its subtree, not just a boolean.
 *  @param {MutationRecord} rec
 *  @returns {boolean} */
export function isExternalRecord(rec) {
  if (isOwnedNode(rec.target)) return false
  if (rec.type === 'childList') {
    let allOwned = true
    for (const n of rec.addedNodes) if (!isOwnedNode(n)) { allOwned = false; break }
    if (allOwned) for (const n of rec.removedNodes) if (!isOwnedNode(n)) { allOwned = false; break }
    if (allOwned) return false
  }
  return true
}

/** Count mutation sources separately from selector reach. Document minus subtree counts
 *  tells burst whether a local edit coincided with outside work that diff cannot replay. */
const mutationCounts = new WeakMap()
function countMutationSources(records) {
  for (const rec of records) {
    if (!isExternalRecord(rec)) continue
    const doc = rec.target.ownerDocument || document
    mutationCounts.set(doc, (mutationCounts.get(doc) || 0) + 1)
    let el = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement || rec.target.host
    for (; el; el = el.parentElement || el.getRootNode?.()?.host) {
      mutationCounts.set(el, (mutationCounts.get(el) || 0) + 1)
    }
  }
}

/** Count observed mutations outside this subtree, including open shadow trees in its document.
 *  Call after flushStyleInvalidations. Pinned by __tests__/core.burst.environment.test.js.
 *  @param {Element} element
 *  @returns {number} */
export function getOutsideMutationCount(element) {
  const doc = element.ownerDocument || document
  setupInvalidationOnce(doc)
  return (mutationCounts.get(doc) || 0) - (mutationCounts.get(element) || 0)
}

/** There is no separate rule epoch, on purpose. The scanned universe and the pseudo gates
 *  derive from the rule text alone, so keying them on __epoch re-scans every sheet after a
 *  plain text mutation. A rule-only epoch was tried and reverted: three rule sources emit no
 *  mutation record (adoptedStyleSheets, a <link> finishing its load, insertRule), and staying
 *  correct needed a per-capture census of every sheet, which timed WebKit out under
 *  BROWSER=all. Pinned by __tests__/module.styles.ruleEpoch.test.js. */

/** Style-ENVIRONMENT epoch: bumps only on <head> mutations and font loads — the events
 *  that change how any element renders without touching it. Consumers (burst) poll it via
 *  getStyleEnvEpoch() instead of wiring their own observers/listeners: one shared stack,
 *  and polling can't root anything (a subscriber callback would leak its closure). */
let __envEpoch = 0
export function getStyleEnvEpoch(doc = document) {
  setupInvalidationOnce(doc)
  return __envEpoch
}

/** Current style epoch — bumps on any external DOM/head/font mutation. Consumers use it
 *  to scope per-epoch memos (e.g. isInSvgTemplate) that DOM restructuring must invalidate. */
export function getStyleEpoch() {
  setupInvalidationOnce()
  return __epoch
}

/** The scoped stamp used by the style snapshot cache. Burst reads the capture root's stamp
 *  after flushing MutationObservers: an outside sibling/ancestor mutation can restyle the
 *  root through combinators, :has(), inheritance or a container query without producing a
 *  record inside the captured subtree. The stamp already models that selector reach. */
export function getStyleStamp(element) {
  if (!element) return 0
  setupInvalidationOnce(element.ownerDocument || document)
  return stampOf(element, shadowHostsOf(element))
}

/** The user's escape hatch (`invalidate: true`), and the ONLY answer to style changes no
 *  observer can see: `sheet.insertRule()`, `rule.style.x = …`. Those
 *  bump no epoch, so every epoch-scoped memo (property universe, style snapshots, CSSVar,
 *  pseudo gates) would keep serving the pre-edit CSS world — and it did, even with
 *  `burst: false`, because the memos live below burst. Bumps BOTH epochs so the escape
 *  hatch has no exceptions. */
export function invalidateStyleCaches() {
  bumpEpoch()
  __envEpoch++
}

/** Prepare style-local persistent state for a cache-disabled capture BEFORE any consumer reads
 * the document scan. captureDOM calls this immediately after creating the session, before
 * styleSharePlan(). Keeping the fallback call in inlineAllStyles also preserves correctness for
 * isolated/internal callers that bypass captureDOM. */
export function prepareStyleCapture(session, cachePolicy) {
  if (cachePolicy !== 'disabled' || !session || session.__styleCachesPrepared) return
  bumpEpoch()
  snapshotKeyCache.clear()
  session.__styleCachesPrepared = true
}

/** Per-node style stamps: how far a DOM mutation is allowed to reach.
 *
 *  The style snapshot is the expensive thing this module owns — ~340 computed properties per
 *  node — and it was thrown away for every element in the document whenever anything anywhere
 *  mutated. A page where an unrelated component re-renders between captures therefore paid a
 *  cold snapshot pass every time: measured on a 73-node card, 1.6ms became 5.7ms, and 1.4ms
 *  became 3.2ms for the canvas-bearing cards auto-burst deliberately excludes.
 *
 *  A mutation at T can only restyle what a selector can reach from T: T's parent's subtree
 *  covers descendant selectors, inheritance and sibling combinators, and each ancestor's own
 *  snapshot covers `:has()` reaching upwards. What that does NOT cover is `:has()` reaching
 *  SIDEWAYS — `.a:has(.b) ~ .c` restyles a cousin no walk from T would visit — so the
 *  narrowing is only used on documents whose author rules contain no `:has()` at all, and
 *  those documents get the old document-wide invalidation. Fidelity is not traded for speed
 *  here: there is no staleness window, only a case that opts out of the optimization.
 *
 *  Everything that is genuinely document-wide keeps its epoch: rule and head changes, font
 *  loads, viewport resizes, and the invalidate escape hatch all bump __envEpoch, which the
 *  snapshot cache reads alongside the stamp. */
const nodeStamp = new WeakMap()
let nodeClock = 0
/** Bumped instead of the stamps when narrowing is unsound (a `:has()` document), which
 *  invalidates every snapshot at once — exactly the old behaviour. */
let __allStamp = 0

function stampNode(el) { nodeStamp.set(el, ++nodeClock) }

function stampSubtree(root) {
  if (!root || root.nodeType !== 1) return
  nodeClock++
  nodeStamp.set(root, nodeClock)
  const all = root.querySelectorAll('*')
  for (let i = 0; i < all.length; i++) nodeStamp.set(all[i], nodeClock)
}

/** Invalidate everything a change at `el` can restyle (see the note above). */
function invalidateAround(el) {
  stampSubtree(el.parentElement || el)
  for (let p = el.parentElement; p; p = p.parentElement) stampNode(p)
}

/** The stamp a node's cached snapshot was taken at. */
function stampOf(el, hosts = null) {
  let stamp = nodeStamp.get(el) || 0
  if (hosts) for (const host of hosts) stamp = Math.max(stamp, nodeStamp.get(host) || 0)
  return __allStamp * 1e9 + stamp
}

/** Shadow styles inherit through their hosts. Keep that dependency on the snapshot so a
 *  warm light-DOM read stays one WeakMap lookup, without walking shadow trees on mutations.
 *  A move/slot redistribution stamps the host or node and rebuilds this list on the miss. */
function shadowHostsOf(el) {
  let root = el.getRootNode?.()
  if (!root?.host) return null
  const hosts = []
  while (root?.host) {
    // Capturing a child directly never walks its enclosing host in deepClone. Wire that
    // open root here too, or its internal mutations would have no observer at all.
    if (root.mode === 'open') observeShadowRoot(root)
    hosts.push(root.host)
    root = root.host.getRootNode?.()
  }
  return hosts
}

/** Whether narrowing is sound for this document: no author rule uses `:has()`.
 *
 *  Memoized on __envEpoch, NOT __epoch, and that distinction is the whole fix. The answer
 *  derives from rule TEXT alone, but it used to read straight through scanFor, whose memo IS
 *  keyed on __epoch — and onDomRecords bumps __epoch immediately BEFORE asking. The entry
 *  therefore missed on every batch, so once any capture had wired the observer, EVERY
 *  external mutation in the host page (a React commit, a virtualised scroll) paid a full
 *  scanAuthorStyles — every rule in every sheet plus a document-wide getAnimations — with no
 *  capture in flight, forever. onInteraction paid it again on every focus and change.
 *  Hoisting the call above the bump does not help: the PREVIOUS batch's bump already
 *  invalidated the entry, so it saves exactly one scan, not one per batch.
 *
 *  __envEpoch covers the rule changes that matter here: <head> mutations, font loads,
 *  resizes and the `invalidate` escape hatch. The one source it misses is a <style>/<link>
 *  mounted outside <head>, which onDomRecords closes below by dropping this entry.
 *  A failed scan answers "cannot narrow" — the document-wide behaviour, always sound. */
const hasMemo = new WeakMap()
function canNarrow(doc) {
  doc = doc || document
  let h = hasMemo.get(doc)
  if (!h || h.env !== __envEpoch) {
    let usesHas = true
    try { usesHas = scanFor(doc).usesHas } catch { /* unreadable sheets — stay pessimistic */ }
    h = { env: __envEpoch, usesHas }
    hasMemo.set(doc, h)
  }
  return !h.usesHas
}

/** A <style>/<link> mounted, removed or rewritten OUTSIDE <head>: the head observer never
 *  sees it, so nothing bumps __envEpoch and canNarrow's memo would keep answering from
 *  before those rules existed — including a `:has()` rule, which would leave narrowing
 *  wrongly enabled. Cheap tag test; it only has to be conservative. */
function ruleSourceDoc(records) {
  const containsRuleSource = (node) => node?.nodeType === 1 &&
    (node.matches?.('style,link') || node.querySelector?.('style,link'))
  for (const rec of records) {
    const t = rec.target
    const el = t && (t.nodeType === 1 ? t : t.parentElement)
    if (el && (el.tagName === 'STYLE' || el.tagName === 'LINK')) return el.ownerDocument || document
    for (const n of rec.addedNodes) if (containsRuleSource(n)) return n.ownerDocument || document
    for (const n of rec.removedNodes) if (containsRuleSource(n)) return n.ownerDocument || (t && t.ownerDocument) || document
  }
  return null
}

/** Open shadow roots wired into the same invalidation.
 *
 *  Neither the document observer (MutationObserver does not cross a shadow boundary) nor
 *  stampSubtree (querySelectorAll does not either) can see inside one, so a web component
 *  that re-rendered itself between captures moved no stamp and no epoch, and its cached
 *  snapshots were served forever. The damage is not limited to geometry: rewriteShadowCSS
 *  emits shadow rules at specificity zero, so the stale generated class OUTRANKS the
 *  re-injected stylesheet and a `.box` -> `.box.active` flip keeps the previous frame's
 *  colours — verified in pixels, not in the payload, where the new rule is present but loses.
 *
 *  Kept in their own list rather than __observers: the prune in flushStyleInvalidations keys
 *  on defaultView, which a ShadowRoot does not have, so it would disconnect these on the
 *  first flush. Their prune is the host leaving the document, and it drops the WeakSet entry
 *  too so a re-attached host is re-armed.
 *
 *  Stamping is scoped to the tree that changed and its host's light subtree: ::slotted and
 *  inheritance through slots can restyle assigned nodes and their descendants too. Nested
 *  shadows depend on these hosts through their cached shadowHostsOf list. */
const shadowObserved = new WeakSet()
const __shadowObservers = []

function onShadowRecords(records) {
  if (!hasExternalMutation(records)) return
  countMutationSources(records)
  bumpEpoch()
  const stamped = new Set()
  for (const rec of records) {
    if (!isExternalRecord(rec)) continue
    const root = rec.target.getRootNode && rec.target.getRootNode()
    if (!root || root.nodeType !== 11 || stamped.has(root)) continue
    stamped.add(root)
    if (root.host) stampSubtree(root.host)
    else nodeClock++
    const all = root.querySelectorAll('*')
    for (let i = 0; i < all.length; i++) nodeStamp.set(all[i], nodeClock)
  }
}

/** Called from deepClone for every open root it walks — already inside its `node.shadowRoot`
 *  branch, so nodes without one pay nothing. Closed roots stay unobservable by design. */
export function observeShadowRoot(root) {
  if (!root || shadowObserved.has(root)) return
  shadowObserved.add(root)
  try {
    const o = new MutationObserver(onShadowRecords)
    o.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
    __shadowObservers.push({ o, root })
  } catch { /* degrade: this root's changes will not invalidate */ }
}

/** The DOM observer's callback, also replayed by flushStyleInvalidations on drained records:
 *  one pass answers both "did anything paintable change" and "did the author rules change". */
function onDomRecords(records) {
  if (!hasExternalMutation(records)) return
  countMutationSources(records)
  bumpEpoch()
  const ruleDoc = ruleSourceDoc(records)
  if (ruleDoc) {
    hasMemo.delete(ruleDoc)
    // A stylesheet node may live in <body>; its CSS still reaches the entire document.
    // Local stamping at the node's parent would leave distant captures on old snapshots.
    __envEpoch++
    __allStamp++
    return
  }
  // The epoch above still invalidates the memos that key off DOM structure (isInSvgTemplate,
  // CSSVar, burst's out-of-subtree gate). The snapshot cache is the one that reads stamps.
  //
  // Stamping is deduped by the subtree root it would walk. A batch carries one record per
  // mutation, and a re-render emits many against the same target (an attribute flip plus a
  // characterData edit plus a childList splice all share a parent), so the undeduped loop
  // ran one querySelectorAll('*') per RECORD over the same neighbourhood.
  const stamped = new Set()
  for (const rec of records) {
    if (!isExternalRecord(rec)) continue
    const el = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement
    if (!el) continue
    const doc = el.ownerDocument || document
    if (!canNarrow(doc)) { __allStamp++; return }
    // A class or custom-property flip on <html> or <body> reaches the whole document, which
    // is what the all-stamp is for.
    if (el === doc.documentElement || el === doc.body) { __allStamp++; return }
    const root = el.parentElement || el
    if (stamped.has(root)) continue
    stamped.add(root)
    invalidateAround(el)
  }
}

/** Wired PER DOCUMENT, not once per page. A same-origin <iframe> is a second document with
 *  its own observers, listeners and FontFaceSet: wiring only the top one meant nothing
 *  inside an iframe ever bumped the epoch, so the style snapshots kept serving whatever the
 *  first capture saw. Editing a rule inside the frame changed the live pixels and changed
 *  nothing in the next capture. The epoch stays SHARED — a cross-document bump invalidates
 *  a few memos it did not have to, which costs one rescan; the alternative is per-document
 *  epoch bookkeeping in every consumer to fix an over-invalidation nobody can measure. */
const __wiredDocs = new WeakSet()
/** Hot-path memo. `inlineAllStyles` calls setupInvalidationOnce once PER NODE, and before
 *  per-document wiring that call was a single boolean read — effectively free. A WeakSet
 *  lookup per node is not: it did not show up on one engine at a time, but under
 *  `BROWSER=all` (three engines contending for the same machine) it pushed two WebKit tests
 *  past their 15s budget. Nodes come in document order, so an identity compare against the
 *  last document answers essentially every call, and the WeakSet is only consulted when the
 *  document actually changes — which happens once per iframe, not once per node. */
let __lastWiredDoc = null
/** Every observer we wired, in any document. `env` ones also bump the environment epoch.
 *  Entries carry their document so dead ones can be dropped: flushStyleInvalidations walks
 *  this list on EVERY capture, and an <iframe> that is created, captured and removed — which
 *  a test suite or an SPA does constantly — would otherwise leave its two observers here
 *  forever. The list grew without bound and each capture paid a takeRecords() per entry; over
 *  a long run that is a per-capture census of every document the page ever touched, which is
 *  precisely the cost profile that timed WebKit out before. */
const __observers = []
function setupInvalidationOnce(doc = document) {
  if (doc === __lastWiredDoc) return
  if (!doc || doc.nodeType !== 9) return
  if (__wiredDocs.has(doc)) { __lastWiredDoc = doc; return }
  __wiredDocs.add(doc)
  __lastWiredDoc = doc
  const view = doc.defaultView
  const onEnvRecords = (records) => {
    if (hasExternalMutation(records)) {
      bumpEpoch()
      __envEpoch++
    }
  }
  const onFonts = () => { bumpEpoch(); __envEpoch++ }
  try {
    const o = new MutationObserver(onDomRecords)
    o.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    __observers.push({ o, env: false, doc })
  } catch { }
  try {
    const o = new MutationObserver(onEnvRecords)
    o.observe(doc.head, { subtree: true, childList: true, characterData: true, attributes: true })
    __observers.push({ o, env: true, doc })
  } catch { }
  try {
    // Viewport resizes flip media queries — computed styles change with no DOM mutation.
    view?.addEventListener('resize', onFonts, { passive: true })
  } catch { }
  try {
    // Interaction pseudo-classes (:focus, :focus-visible, :checked, :disabled) re-style
    // elements without producing a single mutation record, so a cached snapshot kept
    // serving the pre-interaction styles. focusin/out bubble (focus/blur do not); change
    // covers checkbox/radio/select. :hover is deliberately NOT wired — pointer events fire
    // continuously and would flush the snapshot cache on every mouse move.
    // These bump the epoch AND stamp the neighbourhood the pseudo-class can restyle: the
    // snapshot cache reads stamps, not the epoch, so bumping alone would no longer reach it.
    const onInteraction = (event) => {
      bumpEpoch()
      // Document listeners see a shadow event retargeted to its host. The first composed
      // path entry is the real control whose :focus/:active state can restyle shadow siblings.
      const t = event.composedPath?.()[0] || event.target
      if (t && t.nodeType === 1 && !isOwnedNode(t)) {
        if (canNarrow(t.ownerDocument || doc)) invalidateAround(t)
        else __allStamp++
      } else {
        __allStamp++
      }
    }
    doc.addEventListener('focusin', onInteraction, { capture: true, passive: true })
    doc.addEventListener('focusout', onInteraction, { capture: true, passive: true })
    doc.addEventListener('change', onInteraction, { capture: true, passive: true })
    // :active is already true while pointerdown/keydown dispatches and false again on the
    // matching release. Capturing either edge before a later task must not reuse the other.
    doc.addEventListener('pointerdown', onInteraction, { capture: true, passive: true })
    doc.addEventListener('pointerup', onInteraction, { capture: true, passive: true })
    doc.addEventListener('pointercancel', onInteraction, { capture: true, passive: true })
    doc.addEventListener('keydown', onInteraction, { capture: true, passive: true })
    doc.addEventListener('keyup', onInteraction, { capture: true, passive: true })
    // Native top-layer state (`showPopover`) is a property, not an authored attribute.
    doc.addEventListener('beforetoggle', onInteraction, { capture: true, passive: true })
    doc.addEventListener('toggle', onInteraction, { capture: true, passive: true })
    view?.addEventListener('hashchange', () => { bumpEpoch(); __allStamp++ }, { passive: true })
  } catch { }
  try {
    const f = doc.fonts
    if (f) {
      f.addEventListener?.('loadingdone', onFonts)
      // Only while the set is still loading. On a settled set `ready` resolves at once, and
      // that bump, with nothing changed, cost every element its first memo: a page's first
      // capture wires the document, an iframe's first capture wires the frame, and the NEXT
      // capture of anything saw a new environment epoch and ran the full pipeline (a seeded
      // element with a nested iframe was never served its seed). Pinned by
      // __tests__/core.burst.nestedIframe.test.js.
      if (f.status === 'loading') f.ready?.then(onFonts).catch(() => { })
    }
  } catch { }
}

/** The `:hover` chain each document/shadow root had at its last capture. */
const __lastHover = new WeakMap()

function invalidateHoverScope(scope, doc) {
  if (!scope?.querySelectorAll) return
  let now
  try { now = Array.from(scope.querySelectorAll(':hover')) } catch { return }
  const prev = __lastHover.get(scope) || []
  if (prev.length === now.length && prev.every((n, i) => n === now[i])) return
  __lastHover.set(scope, now)
  bumpEpoch()
  if (scope.nodeType === 11) {
    // Shadow selectors cannot escape this tree except through :host/::slotted. Stamp the
    // whole root and host; this also reaches a capture whose root itself lives in shadow DOM.
    if (scope.host) stampSubtree(scope.host)
    else nodeClock++
    for (const el of scope.querySelectorAll('*')) nodeStamp.set(el, nodeClock)
    return
  }
  const changed = prev.filter((n) => !now.includes(n)).concat(now.filter((n) => !prev.includes(n)))
  for (const el of changed) {
    if (!el.isConnected) continue
    if (canNarrow(doc)) invalidateAround(el)
    else { __allStamp++; return }
  }
}

/** Stamp what `:hover` restyled since the last capture. Hover produces no mutation record and
 * is deliberately sampled instead of wiring pointer movement. Passing roots keeps burst hits
 * scoped; full captures also inspect every connected shadow root already observed by snapdom.
 * @param {Document} doc
 * @param {ShadowRoot[]|null} [roots]
 */
export function invalidateHoverChanges(doc, roots = null) {
  if (!doc) return
  invalidateHoverScope(doc, doc)
  const scopes = roots || __shadowObservers
    .filter(({ root }) => root.host?.isConnected)
    .map(({ root }) => root)
  for (const root of scopes) invalidateHoverScope(root, doc)
}

/** Synchronously drains pending invalidation records. MutationObserver delivery is a
 *  microtask, so a <style> injected in the same tick as a capture would otherwise be
 *  read against the stale epoch — the scanned universe/pseudo-gates would miss its
 *  rules. Called once per capture (from the pseudo preflight's fingerprint recompute). */
export function flushStyleInvalidations() {
  setupInvalidationOnce()
  try {
    for (let i = __observers.length - 1; i >= 0; i--) {
      const { o, env, doc } = __observers[i]
      // A detached document — an <iframe> removed from the page — has a null defaultView and
      // can never paint again, so it has nothing left to invalidate. Drop it here rather than
      // paying for it on every future capture.
      if (doc !== document && !doc.defaultView) {
        try { o.disconnect() } catch { }
        __wiredDocs.delete(doc)
        if (__lastWiredDoc === doc) __lastWiredDoc = null
        __observers.splice(i, 1)
        continue
      }
      const r = o.takeRecords()
      if (!r.length) continue
      if (env) { if (hasExternalMutation(r)) { bumpEpoch(); __envEpoch++ } }
      else onDomRecords(r)
    }
    for (let i = __shadowObservers.length - 1; i >= 0; i--) {
      const { o, root } = __shadowObservers[i]
      if (!root.host || !root.host.isConnected) {
        try { o.disconnect() } catch { }
        shadowObserved.delete(root)
        __shadowObservers.splice(i, 1)
        continue
      }
      const r = o.takeRecords()
      if (r.length) onShadowRecords(r)
    }
  } catch { }
}

/** Deletes cached style snapshots under a root. Animated subtrees re-snapshot per diff
 *  frame: animations repaint without mutation records, so the epoch never bumps and the
 *  cache would freeze the first captured frame. */
export function invalidateSnapshotsUnder(root) {
  if (!root || root.nodeType !== 1) return
  snapshotCache.delete(root)
  try {
    const tw = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    while (tw.nextNode()) snapshotCache.delete(tw.currentNode)
  } catch { }
}

/** URL-bearing props that mean inlineBackgroundImages must visit the node. */
/**
 * Whether the background-inline pass has work on this element, per its cached style snapshot.
 * Unknown (no fresh snapshot — STYLE tags, SVG template descendants) → true, so callers fall
 * back to processing the node like before.
 * @param {Element} source
 * @returns {boolean}
 */
export function needsBackgroundInline(source) {
  const rec = snapshotCache.get(source)
  if (rec && snapshotIsCurrent(rec, source)) {
    const f = rec.snapshot && rec.snapshot.__needsBgInline
    if (f !== undefined) return f
  }
  return true
}

/**
 * The element's current style snapshot, or null when there is none to trust. The background
 * pass reads through this instead of the CSSOM: a prop present in the snapshot is the value
 * the capture already resolved, and a prop ABSENT from it was pruned by the property
 * universe — the page cannot touch it, so its computed value is the default and there is
 * nothing to copy. Nodes carrying the Firefox background-clip:text fallback are excluded:
 * their snapshot background props were deliberately swapped (applyBgClipTextFallback) and
 * the background pass must keep seeing the live values it was written against.
 * @param {Element} source
 * @returns {object|null}
 */
export function snapshotFor(source) {
  const rec = snapshotCache.get(source)
  if (!rec || !snapshotIsCurrent(rec, source)) return null
  const snap = rec.snapshot
  if (!snap || snap.__bgClipTextFix) return null
  return snap
}

/** Per-document memo of the scanned property universe, keyed on __epoch (see the rule-epoch
 *  note above getStyleEnvEpoch for why not something narrower).
 *  Exported so the base reset prunes itself with the SAME universe the snapshots use:
 *  a reset-stamped prop the class diff can no longer override (e.g. the resolved-black
 *  `-webkit-text-fill-color` overriding a white `color`) must not be emitted either. */
const universeCache = new WeakMap()
function scanFor(doc) {
  let rec = universeCache.get(doc)
  if (!rec || rec.epoch !== __epoch) {
    rec = { epoch: __epoch, ...scanAuthorStyles(doc) }
    universeCache.set(doc, rec)
  }
  return rec
}

const SHARE_PARTITION_PSEUDOS = new Set([
  'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type',
  'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type',
  'only-of-type', 'empty', 'has', 'not', 'is', 'where', 'dir', 'lang',
])

/** Filters the scan's potentially splitting selectors to subjects that can exist under root. */
function relevantShareGate(el, gate) {
  if (!gate.length) return []
  const present = new Set()
  const note = (n) => {
    present.add('t' + n.localName)
    if (n.id) present.add('i' + n.id)
    const cl = n.classList
    for (let i = 0; i < cl.length; i++) present.add('c' + cl[i])
    const attrs = n.attributes
    for (let i = 0; attrs && i < attrs.length; i++) {
      const attr = attrs[i]
      present.add('a' + attr.name)
      if (attr.name.startsWith('data-')) present.add('v' + attr.name + '\u0000' + attr.value)
    }
  }
  note(el)
  for (const n of el.querySelectorAll('*')) note(n)
  return gate.filter(({ key }) => key === null || present.has(key))
}

function shareGateMatches(el, gate) {
  if (!gate.length) return false
  const sel = gate.map((x) => x.sel).join(',')
  return el.matches(sel) || el.querySelector(sel) !== null
}

/** Whether every pseudo token in a splitting selector is represented by the fingerprint. */
function partitionableShareSelector(sel) {
  if (!sel || sel.includes('::')) return false
  const re = /:{1,2}([\w-]+)/g
  let m
  while ((m = re.exec(sel))) {
    if (!SHARE_PARTITION_PSEUDOS.has(m[1].toLowerCase())) return false
  }
  return true
}

/**
 * Share decision used by captureDOM. `selectors === null` is the historical whole-capture
 * fast path; a non-empty selector array means identical structural identities are further
 * partitioned by the exact match-status vector of these selectors. Any uncertainty returns
 * `{ share:false }`, preserving the released-v3 full-read behavior.
 * @param {Element} el capture root
 * @returns {{share: boolean, selectors: Array<{sel: string, key: string|null}>|null}}
 */
export function styleSharePlan(el) {
  try {
    const doc = el.ownerDocument || document
    const scan = scanFor(doc)
    const gate = scan.shareGate
    if (gate === null) return { share: false, selectors: null }
    if (!gate.length) return { share: true, selectors: null }
    const relevant = relevantShareGate(el, gate)
    if (!relevant.length || !shareGateMatches(el, relevant)) return { share: true, selectors: null }

    const part = scan.sharePartition
    if (!part || part.blocked) return { share: false, selectors: null }
    const probe = doc.createElement('div')
    for (const entry of relevant) {
      if (part.containerSels.has(entry.sel) || !partitionableShareSelector(entry.sel)) {
        return { share: false, selectors: null }
      }
      // Validate each selector independently too. The joined share gate is validated by
      // styleScan, but an individual failure must never silently collapse a fingerprint bit.
      try { probe.matches(entry.sel) } catch { return { share: false, selectors: null } }
    }
    return { share: true, selectors: relevant }
  } catch {
    return { share: false, selectors: null }
  }
}

// Per-element property-universe narrowing. The document scan says which properties can move
// at all; this layer asks which of those properties can move on THIS element. It is used only
// when identity sharing is off — sharing already removes most reads and is the simpler path.
const ELEMENT_UNIVERSE_RISK_TAGS = new Set(('input select textarea button option optgroup datalist output progress meter fieldset legend form label a area html body table thead tbody tfoot tr td th caption col colgroup img picture source video audio track canvas iframe embed object param map details summary dialog svg path rect circle ellipse line polyline polygon text tspan g defs use symbol marker mask clippath pattern lineargradient radialgradient stop filter foreignobject view switch hr').split(' '))
const ELEMENT_UNIVERSE_RISK_ANCESTORS = new Set([...ELEMENT_UNIVERSE_RISK_TAGS].filter((t) => t !== 'html' && t !== 'body'))
const ELEMENT_UNIVERSE_HINT_ATTRS = new Set(('dir lang align bgcolor background color face size nowrap valign hidden popover contenteditable start value type compact').split(' '))
const ELEMENT_UNIVERSE_INHERITED = new Set(('color font font-family font-size font-style font-weight font-variant font-stretch font-size-adjust font-kerning font-feature-settings font-variation-settings font-optical-sizing font-variant-caps font-variant-numeric font-variant-ligatures font-variant-east-asian font-variant-alternates font-variant-position line-height letter-spacing word-spacing text-align text-align-last text-indent text-transform text-shadow text-rendering direction unicode-bidi writing-mode text-orientation word-break overflow-wrap word-wrap hyphens tab-size white-space white-space-collapse text-wrap text-wrap-mode text-wrap-style text-spacing-trim text-autospace list-style list-style-type list-style-position list-style-image border-collapse border-spacing caption-side empty-cells quotes visibility cursor pointer-events -webkit-text-fill-color -webkit-text-stroke -webkit-text-stroke-width -webkit-text-stroke-color -webkit-font-smoothing image-rendering color-scheme paint-order caret-color accent-color text-emphasis text-emphasis-color text-emphasis-style text-combine-upright ruby-align ruby-position orphans widows speak scrollbar-width').split(' '))
const ELEMENT_UNIVERSE_MUST = new Set(('width height inline-size block-size min-width min-height max-width max-height top right bottom left transform-origin perspective-origin grid-template-columns grid-template-rows outline-color border-top-color border-right-color border-bottom-color border-left-color').split(' '))
const ELEMENT_UNIVERSE_GROUPS = [
  ['white-space', 'white-space-collapse', 'text-wrap-mode', 'text-wrap-style'],
  ['background-position', 'background-position-x', 'background-position-y'],
  ['overflow', 'overflow-x', 'overflow-y', 'overflow-block', 'overflow-inline'],
]
const elementUniverseStates = new WeakMap()
const elementUniverseBoxes = new WeakMap()
let elementUniversePeers = null
// R5-D tiered selector-program compilation. The linear interpreter has zero setup and wins on
// tiny sheets/captures. The subject-key index removes one rejection branch per keyed rule per
// eligible element, but compiling it costs O(all rules). Start linear and JIT only after the
// actually-paid reject work can amortize both a fixed setup floor and a pathological corpus with
// many unkeyed rules. Values are deliberately conservative relative to the measured crossover:
// 400 nodes crossed near 50 rules, while 10-node captures needed hundreds of rules to win.
const ELEMENT_RULE_INDEX_MIN_KEYED = 64
const ELEMENT_RULE_INDEX_WORK_FLOOR = 2048
const ELEMENT_RULE_INDEX_COMPILE_MULTIPLIER = 4
const ELEMENT_RULE_INDEX_KEYED_FRACTION_DENOM = 3 // >= ~33% of candidate rules must be key-prunable
// R5-SU composition router: after reducing R3's cold setup, the causal crossover is governed
// mainly by the number of DISTINCT first-seen share identities. Keep the first few misses on pure
// R2, then let later misses use R3. Hits never advance the counter.
const STYLE_SHARE_ELEMENT_UNIVERSE_MIN_MISSES = 5
// SU also exposes R3's selector interpreter. D can cheaply remove keyed rules, but every residual
// unkeyed rule still requires matches() on every narrowed identity. Adaptive DOE found the
// all-unkeyed wall-time crossover between ~250 and 300 residual rules on the 400-identity scene;
// 192 residual rules remained favorable across multiple total-rule corpora. Stay deliberately
// below the noisy crossover. Forced composition (`__styleShareElementUniverse:true`) bypasses
// this production safety gate so the semantic counterfactual remains testable.
const STYLE_SHARE_ELEMENT_UNIVERSE_MAX_UNKEYED_RULES = 192

function universePeers() {
  if (elementUniversePeers) return elementUniversePeers
  const peers = new Map()
  const add = (a, b) => {
    let row = peers.get(a)
    if (!row) peers.set(a, (row = []))
    if (a !== b && !row.includes(b)) row.push(b)
  }
  for (const [logical, physical] of LOGICAL_TO_PHYSICAL) add(logical, physical)
  for (const group of ELEMENT_UNIVERSE_GROUPS) {
    for (const a of group) for (const b of group) add(a, b)
  }
  elementUniversePeers = peers
  return peers
}

function elementUniverseStateFor(doc, scan) {
  let st = elementUniverseStates.get(doc)
  if (!st || st.scan !== scan) {
    st = {
      scan,
      ua: new Map(),
      missing: new Map(),
      ancestorUa: new Map(),
      initial: null,
      measured: 0,
      blocked: false,
      seen: new Set(),
      trigger: new Set(),
      queue: [],
      ruleIndex: null,
    }
    elementUniverseStates.set(doc, st)
  }
  return st
}

/**
 * CSS initial values needed by R3, restricted to THIS document's measured property universe.
 *
 * The old path called getDefaultStyleForTag('x-snapdom-universe'), whose generic contract
 * enumerates the browser's entire CSSStyleDeclaration (~hundreds of properties) plus fallback
 * names. That synthetic tag exists only for R3, so all of those properties outside `universe`
 * were pure cold-start work. Measure the same engine-specific `all:initial` reference, but only
 * for names R3 can actually read. The result is tied to the style scan/epoch via `st` and any
 * uncertainty still blocks narrowing rather than changing output.
 */
function measureUniverseInitialDefaults(doc, st, universe) {
  if (st.initial) return st.initial
  if (doc !== document) {
    st.blocked = true
    return null
  }
  const initial = new Map()
  let node = null
  try {
    let box = elementUniverseBoxes.get(doc)
    if (!box || !box.isConnected) {
      box = doc.createElement('div')
      markInternalNode(box)
      box.setAttribute('aria-hidden', 'true')
      box.style.cssText = 'all:initial;display:block;position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden'
      ;(doc.body || doc.documentElement).appendChild(box)
      elementUniverseBoxes.set(doc, box)
    }
    node = doc.createElement('x-snapdom-universe')
    markInternalNode(node)
    node.style.all = 'initial'
    box.appendChild(node)
    const style = getComputedStyle(node)
    for (const prop of universe) {
      if (!shouldIgnoreProp(prop)) initial.set(prop, style.getPropertyValue(prop))
    }
  } catch {
    st.blocked = true
    return null
  } finally {
    try { node?.remove() } catch {}
  }
  st.initial = initial
  return initial
}

/**
 * UA-default properties on an ANCESTOR can affect `el` only through inheritance. The original
 * R3 setup reused the target-element probe here, which built a complete SnapDOM default-style
 * map and read the whole document universe for <html>, <body>, and every distinct ancestor tag.
 * Those non-inherited values can never flow into the descendant snapshot, so that work was a
 * pure cold-start tax. Compare only inherited properties against the shared CSS-initial probe.
 * Any uncertainty still blocks R3, exactly like measureElementTagDefaults.
 */
function measureAncestorTagDefaults(doc, st, tag, universe) {
  let ua = st.ancestorUa.get(tag)
  if (ua) return ua
  if (st.measured >= 48 || doc !== document) {
    st.blocked = true
    return null
  }
  st.measured++
  ua = new Set()
  let node = null
  try {
    const initial = measureUniverseInitialDefaults(doc, st, universe)
    if (!initial || st.blocked) return null
    let box = elementUniverseBoxes.get(doc)
    if (!box || !box.isConnected) {
      box = doc.createElement('div')
      markInternalNode(box)
      box.setAttribute('aria-hidden', 'true')
      box.style.cssText = 'all:initial;display:block;position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden'
      ;(doc.body || doc.documentElement).appendChild(box)
      elementUniverseBoxes.set(doc, box)
    }
    node = doc.createElement(tag)
    box.appendChild(node)
    const style = getComputedStyle(node)
    for (const prop of ELEMENT_UNIVERSE_INHERITED) {
      if (!universe.has(prop) || shouldIgnoreProp(prop)) continue
      const value = style.getPropertyValue(prop)
      if (value && (!initial.has(prop) || value !== initial.get(prop))) ua.add(prop)
    }
  } catch {
    st.blocked = true
    return null
  } finally {
    try { node?.remove() } catch {}
  }
  st.ancestorUa.set(tag, ua)
  return ua
}

function measureElementTagDefaults(doc, st, tag, universe) {
  let ua = st.ua.get(tag)
  let missing = st.missing.get(tag)
  if (ua && missing) return { ua, missing }
  if (st.measured >= 48 || doc !== document) {
    st.blocked = true
    return null
  }
  st.measured++
  ua = new Set()
  missing = new Set()
  let node = null
  try {
    const initial = measureUniverseInitialDefaults(doc, st, universe)
    if (!initial || st.blocked) return null
    let box = elementUniverseBoxes.get(doc)
    if (!box || !box.isConnected) {
      box = doc.createElement('div')
      markInternalNode(box)
      box.setAttribute('aria-hidden', 'true')
      box.style.cssText = 'all:initial;display:block;position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden'
      ;(doc.body || doc.documentElement).appendChild(box)
      elementUniverseBoxes.set(doc, box)
    }
    node = doc.createElement(tag)
    box.appendChild(node)
    const style = getComputedStyle(node)
    const defaults = getDefaultStyleForTag(tag)
    for (const prop of universe) {
      if (shouldIgnoreProp(prop)) continue
      const value = style.getPropertyValue(prop)
      if (!value) continue
      if (!initial.has(prop) || value !== initial.get(prop)) ua.add(prop)
      if (!(prop in defaults)) missing.add(prop)
    }
  } catch {
    st.blocked = true
    return null
  } finally {
    try { node?.remove() } catch {}
  }
  st.ua.set(tag, ua)
  st.missing.set(tag, missing)
  return { ua, missing }
}

function subjectKeyMatches(el, key, useAttrValue = true) {
  if (key === null) return true
  const value = key.slice(1)
  if (key[0] === 't') return el.localName === value
  if (key[0] === 'c') return !!el.classList?.contains(value)
  if (key[0] === 'a') return el.hasAttribute?.(value) === true
  if (key[0] === 'v') {
    const cut = value.indexOf('\0')
    if (cut < 0) return true
    const name = value.slice(0, cut)
    return useAttrValue
      ? el.getAttribute?.(name) === value.slice(cut + 1)
      : el.hasAttribute?.(name) === true
  }
  return el.id === value
}

/** Compile R3 rules lazily, only if an element actually reaches per-element narrowing. R2/R4
 * identity-sharing captures never consume this index, so eagerly building it in styleScan would
 * turn a local R5-D win into a document-wide allocation tax. Each rule has exactly one necessary
 * subject key (or none); buckets are therefore disjoint and require no per-element dedup Set. */
function normalizedRuleIndexKey(key, useAttrValue) {
  if (!key || useAttrValue || key[0] !== 'v') return key
  const value = key.slice(1)
  const cut = value.indexOf('\0')
  return cut >= 0 ? 'a' + value.slice(0, cut) : key
}

function indexedAttrBucketSize(index, key) {
  const value = key.slice(1)
  if (key[0] === 'a') return index.byAttr.get(value)?.length || 0
  if (key[0] !== 'v') return Infinity
  const cut = value.indexOf('\0')
  if (cut < 0) return Infinity
  return index.byAttrValue.get(value.slice(0, cut))?.get(value.slice(cut + 1))?.length || 0
}

function indexedRuleBucketSize(index, key) {
  if (!key) return Infinity
  const value = key.slice(1)
  const type = key.charCodeAt(0)
  if (type === 99) return index.byClass.get(value)?.length || 0
  if (type === 105) return index.byId.get(value)?.length || 0
  if (type === 116) return index.byTag.get(value)?.length || 0
  return indexedAttrBucketSize(index, key)
}

function pushIndexedAttrRule(index, key, rule) {
  const value = key.slice(1)
  if (key[0] === 'a') {
    let bucket = index.byAttr.get(value)
    if (!bucket) index.byAttr.set(value, (bucket = []))
    bucket.push(rule)
    return
  }
  const cut = value.indexOf('\0')
  if (cut < 0) return
  const name = value.slice(0, cut)
  let values = index.byAttrValue.get(name)
  if (!values) index.byAttrValue.set(name, (values = new Map()))
  const exact = value.slice(cut + 1)
  let bucket = values.get(exact)
  if (!bucket) values.set(exact, (bucket = []))
  bucket.push(rule)
}

function pushIndexedRule(index, key, rule) {
  const type = key?.charCodeAt(0)
  if (type === 97 || type === 118) {
    pushIndexedAttrRule(index, key, rule)
    return
  }
  const value = key?.slice(1)
  const map = type === 116 ? index.byTag : type === 105 ? index.byId : type === 99 ? index.byClass : null
  if (!map) return
  let bucket = map.get(value)
  if (!bucket) map.set(value, (bucket = []))
  bucket.push(rule)
}

/**
 * Re-key only repeated class/id buckets whose rightmost compound proves that another direct
 * attribute condition could partition the bucket more finely. The D3 index itself is the
 * frequency table: singleton buckets are already optimal, so the common "many unique classes"
 * control path allocates no planner maps and reparses no selectors.
 */
function rekeySelectiveBuckets(index, map, prefix, useAttrValue, useCompoundKeys = false) {
  const sources = []

  // Snapshot ORIGINAL source membership before moving anything. D5 can move a class-primary rule
  // into another class bucket; mutating a Map while iterating it would otherwise let newly-created
  // destinations become new planning sources and make results depend on insertion order.
  for (const [value, bucket] of map) {
    if (bucket.length >= 2) sources.push({ value, bucket: bucket.slice() })
  }
  if (!sources.length) return

  const moves = new Map()
  const plannedArrivals = new Map()

  for (let s = 0; s < sources.length; s++) {
    const { value, bucket } = sources[s]
    const sourceSize = bucket.length

    let hasAlternativeSyntax = false
    for (let i = 0; i < sourceSize; i++) {
      const sel = bucket[i].sel
      if (sel.includes('[') || (useCompoundKeys &&
          (sel.includes('#') || (prefix === 'c' && sel.indexOf('.', sel.indexOf('.') + 1) >= 0)))) {
        hasAlternativeSyntax = true
        break
      }
    }
    if (!hasAlternativeSyntax) continue

    const primary = prefix + value
    // Full enumeration is deliberate. A logarithmic selector sample was faster to compile but
    // unsound as a planner: a useful minority alternative can live entirely between sampled
    // positions. Missing it after moving the rest can make the remaining primary bucket incomplete.
    const alternatives = new Array(sourceSize)
    const support = new Map()
    for (let i = 0; i < sourceSize; i++) {
      let keys
      if (useCompoundKeys) keys = collectSubjectAlternativeKeys(bucket[i].sel, primary, [])
      else {
        const attr = normalizedRuleIndexKey(subjectAlternativeAttributeKey(bucket[i].sel, primary), useAttrValue)
        keys = attr ? [attr] : []
      }
      for (let j = 0; j < keys.length; j++) keys[j] = normalizedRuleIndexKey(keys[j], useAttrValue)
      alternatives[i] = keys
      for (const key of keys) support.set(key, (support.get(key) || 0) + 1)
    }

    // Choose one necessary key per rule. Base destination sizes come from the untouched D3 index;
    // plannedArrivals carries cross-source collisions. We intentionally do NOT credit departures
    // from a destination that is itself an original source bucket, so estimates are conservative.
    const chosen = new Array(sourceSize)
    const localArrivals = new Map()
    for (let i = 0; i < sourceSize; i++) {
      const keys = alternatives[i]
      let best = null, bestCost = sourceSize
      for (let j = 0; j < keys.length; j++) {
        const key = keys[j]
        const cost = indexedRuleBucketSize(index, key) +
          (plannedArrivals.get(key) || 0) + (support.get(key) || 0)
        if (cost < bestCost || (cost === bestCost && best !== null && key < best)) {
          best = key
          bestCost = cost
        }
      }
      if (best) {
        chosen[i] = best
        localArrivals.set(best, (localArrivals.get(best) || 0) + 1)
      }
    }

    for (let i = 0; i < sourceSize; i++) {
      const alternative = chosen[i]
      if (!alternative) continue
      const finalCost = indexedRuleBucketSize(index, alternative) +
        (plannedArrivals.get(alternative) || 0) + (localArrivals.get(alternative) || 0)
      if (finalCost < sourceSize) moves.set(bucket[i], alternative)
    }
    for (const [key] of localArrivals) {
      let admitted = 0
      for (let i = 0; i < sourceSize; i++) if (moves.get(bucket[i]) === key) admitted++
      if (admitted) plannedArrivals.set(key, (plannedArrivals.get(key) || 0) + admitted)
    }
  }

  if (!moves.size) return

  // Apply in two phases. First remove moved ORIGINAL rules from all source buckets, then append
  // arrivals. A destination that is also an original source therefore cannot lose newly-arrived
  // rules when that source is compacted later.
  for (let s = 0; s < sources.length; s++) {
    const { value, bucket } = sources[s]
    let kept = null
    for (let i = 0; i < bucket.length; i++) {
      if (moves.has(bucket[i])) {
        if (!kept) kept = bucket.slice(0, i)
      } else if (kept) kept.push(bucket[i])
    }
    if (kept) {
      if (kept.length) map.set(value, kept)
      else map.delete(value)
    }
  }
  for (const [rule, key] of moves) pushIndexedRule(index, key, rule)
}
function mergeRuleProps(target, source) {
  const tp = target.props
  const sp = source.props
  for (let i = 0; i < sp.length; i++) {
    const prop = sp[i]
    let seen = false
    for (let j = 0; j < tp.length; j++) {
      if (tp[j] === prop) { seen = true; break }
    }
    if (!seen) tp.push(prop)
  }
}

/**
 * R5-D6 selector-program CSE. R3 asks one boolean question per rule: does THIS element match the
 * selector, and if so which property NAMES must survive the narrowed universe? For byte-identical
 * selector strings that predicate is literally the same browser `matches()` call. Collapse those
 * repeated interpreter entries to one selector plus the union of their property names.
 *
 * The first duplicate triggers the allocation. Unique buckets therefore pay one Map construction
 * but keep their original rule objects/arrays; duplicate buckets allocate only the merged records
 * that need a widened props array. This runs lazily after the D5 planner, so R2-only captures and
 * captures that never cross the rule-index router pay nothing.
 */
function coalesceSelectorBucket(bucket) {
  const n = bucket?.length || 0
  if (n < 2) return bucket
  const firstBySelector = new Map()
  let out = null
  for (let i = 0; i < n; i++) {
    const rule = bucket[i]
    const prior = firstBySelector.get(rule.sel)
    if (prior === undefined) {
      firstBySelector.set(rule.sel, i)
      if (out) out.push(rule)
      continue
    }
    if (!out) out = bucket.slice(0, i)
    // `prior` indexes the original prefix until the first duplicate; after compaction, find the
    // exact selector among the already-small output. This path runs only for actual duplicates.
    let target = null
    for (let j = 0; j < out.length; j++) {
      if (out[j].sel === rule.sel) { target = out[j]; break }
    }
    if (!target) continue
    // Never mutate styleScan's shared rule object/props array: other counterfactual indexes for
    // the same style epoch may still reference it. Clone lazily on the first merge for this sel.
    if (!target.__selectorCSE) {
      target = { sel: target.sel, key: target.key, props: target.props.slice(), __selectorCSE: true }
      for (let j = 0; j < out.length; j++) {
        if (out[j].sel === rule.sel) { out[j] = target; break }
      }
    }
    mergeRuleProps(target, rule)
  }
  return out || bucket
}

function coalesceSelectorIndex(index) {
  index.unkeyed = coalesceSelectorBucket(index.unkeyed)
  const coalesceMap = (map) => {
    for (const [key, bucket] of map) {
      const merged = coalesceSelectorBucket(bucket)
      if (merged !== bucket) map.set(key, merged)
    }
  }
  coalesceMap(index.byTag)
  coalesceMap(index.byId)
  coalesceMap(index.byClass)
  coalesceMap(index.byAttr)
  for (const values of index.byAttrValue.values()) coalesceMap(values)
}

/**
 * Cheap production admission scout for D6. A full CSE pass walks every final key bucket, which is
 * measurable cold overhead when every selector is unique. Sampling is safe here in a way it was
 * NOT safe for D4/D5 key planning: a false negative leaves the complete D5 program untouched; it
 * can only miss a speedup, never remove a candidate rule. A coarse-to-fine cardinality search
 * found K=1/K=4 production wins cleanly favorable. K=8 showed a positive forced-CSE result but
 * its production confirmations were unstable/null-biased, so it remains research-only rather
 * than being admitted by a release router. Production therefore requires heavy repetition:
 * <=5 distinct selector strings in thirty-two geometrically spread samples. The wider sample is
 * deliberate hardening against locally repetitive / globally high-cardinality sheets: an earlier
 * 16-point scout could be fooled by a sparse repeated selector landing exactly on its sample
 * positions, admitting a full CSE pass with essentially no matcher savings. False positives are
 * performance-only, not semantic, but the release router should still avoid that tax. Thirty-two
 * points preserves the measured K<=4 admission region, rejects K=8, and gives the protected path
 * an early exit as soon as a sixth distinct selector is observed. `true` on the internal option
 * still forces CSE for differential tests/benchmarks and future crossover work.
 */
function selectorCSEWorthTrying(rules) {
  const n = rules?.length || 0
  if (n < 2) return false
  const count = Math.min(32, n)
  const seen = new Set()
  for (let i = 0; i < count; i++) {
    const at = count === n ? i : Math.floor(i * (n - 1) / (count - 1))
    seen.add(rules[at].sel)
    if (seen.size > 5) return false
    // Even if every remaining sample is new, the final sample still satisfies the <=5 gate.
    if (seen.size + (count - i - 1) <= 5) return true
  }
  return seen.size <= 5
}

function compileElementRuleIndex(
  rules,
  useAttrValue = true,
  useKeySelectivity = true,
  useCompoundKeys = true,
  useSelectorCSE = true,
) {
  const index = {
    unkeyed: [], byTag: new Map(), byId: new Map(), byClass: new Map(), byAttr: new Map(),
    byAttrValue: new Map(),
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    const key = normalizedRuleIndexKey(rule.key, useAttrValue)
    if (key === null) {
      index.unkeyed.push(rule)
      continue
    }
    const type = key.charCodeAt(0)
    const value = key.slice(1)
    if (type === 118) { // v = exact data-* attribute value
      const cut = value.indexOf('\0')
      if (cut >= 0) {
        const name = value.slice(0, cut)
        let values = index.byAttrValue.get(name)
        if (!values) index.byAttrValue.set(name, (values = new Map()))
        const exact = value.slice(cut + 1)
        let bucket = values.get(exact)
        if (!bucket) values.set(exact, (bucket = []))
        bucket.push(rule)
        continue
      }
    }
    const map = type === 116 ? index.byTag : type === 105 ? index.byId :
      type === 97 ? index.byAttr : index.byClass
    let bucket = map.get(value)
    if (!bucket) map.set(value, (bucket = []))
    bucket.push(rule)
  }

  // Build the exact D3 index first, then use its real bucket lengths as D4's cost model. This
  // avoids a second global frequency table and makes singleton class/id corpora almost identical
  // to D3. Only repeated class/id buckets can improve by moving to an attribute condition.
  if (useKeySelectivity) {
    // ID-primary selectors cannot hide a class (class-first D1 priority would have selected it),
    // so keep the historical D4 exact-attribute planner there. Run it BEFORE the class planner so
    // D5 class -> ID moves are final and never become a second planning source.
    rekeySelectiveBuckets(index, index.byId, 'i', useAttrValue, false)
    rekeySelectiveBuckets(index, index.byClass, 'c', useAttrValue, useCompoundKeys)
  }
  if (useSelectorCSE) coalesceSelectorIndex(index)
  return index
}

/** Visit only selector rules whose compile-time necessary subject key exists on `el`.
 * `subjectRuleIndex()` places each rule in exactly one bucket, so tag/id/class/attribute buckets are
 * disjoint and no deduplication allocation is needed here. Returning false asks the caller to
 * bail to the full document universe. */
function visitIndexedElementRules(el, index, visit) {
  const walk = (rules) => {
    if (!rules) return true
    for (let i = 0; i < rules.length; i++) if (visit(rules[i]) === false) return false
    return true
  }
  if (!walk(index.unkeyed)) return false
  if (!walk(index.byTag.get(el.localName))) return false
  if (el.id && !walk(index.byId.get(el.id))) return false
  const classes = el.classList
  if (classes) {
    for (let i = 0; i < classes.length; i++) {
      if (!walk(index.byClass.get(classes[i]))) return false
    }
  }
  const attrs = (index.byAttr.size || index.byAttrValue.size) ? el.attributes : null
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i]
      if (!walk(index.byAttr.get(attr.name))) return false
      const values = index.byAttrValue.get(attr.name)
      if (values && !walk(values.get(attr.value))) return false
    }
  }
  return true
}

function matchesElementAllRule(el, rules) {
  if (!rules?.length) return false
  for (const rule of rules) {
    if (!subjectKeyMatches(el, rule.key)) continue
    try {
      if (el.matches(rule.sel)) return true
    } catch {
      return true
    }
  }
  return false
}

/**
 * A safe subset of the document property universe for one element. Any uncertainty returns
 * `universe` unchanged, so this function can only cost performance, never fidelity.
 */
function elementUniverseFor(el, style, options, universe, backgroundState = null, allowSharedUniverse = false) {
  // R2 and R3 were originally kept mutually exclusive. That is conservative but creates a
  // pathological high-entropy region: when every element has a distinct share identity, R2
  // produces no hits yet forces every first-seen identity through the full document universe.
  // R5 probes composition behind an internal flag. The share identity itself is unchanged;
  // only the first snapshot stored for that exact identity may use R3's already-conservative
  // property subset. Twins then reuse the same narrowed snapshot and the same used-value re-read
  // contract as before. Any uncertainty inside R3 still returns the full universe.
  if (!universe || !el ||
      (options?.__styleShare && !allowSharedUniverse) ||
      options?.__elementUniverse === false) return universe
  const doc = el.ownerDocument || document
  if (doc !== document || (el.getRootNode && el.getRootNode() !== doc)) return universe
  const tag = el.localName?.toLowerCase()
  if (!tag || ELEMENT_UNIVERSE_RISK_TAGS.has(tag) || el.shadowRoot || el.assignedSlot) return universe
  const inlineText = el.getAttribute?.('style') || ''
  if (inlineText && /(?:^|;)\s*all\s*:/i.test(inlineText)) return universe
  try {
    const wm = style.getPropertyValue('writing-mode')
    if (wm && wm !== 'horizontal-tb') return universe
    const dir = style.getPropertyValue('direction')
    if (dir && dir !== 'ltr') return universe
  } catch { return universe }

  const scan = scanFor(doc)
  if (!scan.elementRules || scan.elementUniverseBlocked || scan.hasAnimations) return universe
  const st = elementUniverseStateFor(doc, scan)
  if (st.blocked) return universe
  const seen = st.seen
  const trigger = st.trigger
  const queue = st.queue
  seen.clear(); trigger.clear(); queue.length = 0
  const selected = new Set()
  const push = (prop) => {
    if (!trigger.has(prop)) { trigger.add(prop); queue.push(prop) }
    if (universe.has(prop) && !shouldIgnoreProp(prop) && !seen.has(prop)) {
      seen.add(prop)
      selected.add(prop)
    }
  }
  const bail = () => {
    seen.clear(); trigger.clear(); queue.length = 0
    return universe
  }

  for (const prop of ELEMENT_UNIVERSE_MUST) push(prop)
  for (const prop of scan.elementDeclaredProps || []) if (ELEMENT_UNIVERSE_INHERITED.has(prop)) push(prop)
  for (const prop of scan.elementAlwaysProps || []) push(prop)
  // Downstream snapshot contract: background.js intentionally reuses the cached snapshot.
  // Under the old document universe, an absent prop meant the document could not observe it.
  // R3 narrows per element, so retain exactly the groups that the downstream consumer reads.
  // Targets still pass through `push`, hence only properties in the document universe cost a
  // CSSOM read. Mask layout is read for every flagged background/mask/border-image node;
  // background layout is read only when a real background is present.
  if (backgroundState?.needsInline) for (const prop of MASK_LAYOUT_PROPS) push(prop)
  if (backgroundState?.hasBackground) for (const prop of BG_LAYOUT_PROPS) push(prop)

  // Ancestor context: UA/presentational risks and inline inherited declarations.
  let a = el, depth = 0
  while (a && a.nodeType === 1 && depth++ < 1024) {
    const at = a.localName?.toLowerCase()
    if (a !== el && at && ELEMENT_UNIVERSE_RISK_ANCESTORS.has(at)) return bail()
    if (matchesElementAllRule(a, scan.elementAllRules)) return bail()
    const attrs = a.attributes
    if (attrs) for (let i = 0; i < attrs.length; i++) if (ELEMENT_UNIVERSE_HINT_ATTRS.has(attrs[i].name)) return bail()
    if (at && !at.includes('-')) {
      if (a === el) {
        const measured = measureElementTagDefaults(doc, st, at, universe)
        if (!measured || st.blocked) return bail()
        for (const prop of measured.ua) push(prop)
        for (const prop of measured.missing) push(prop)
      } else {
        const inheritedUa = measureAncestorTagDefaults(doc, st, at, universe)
        if (!inheritedUa || st.blocked) return bail()
        for (const prop of inheritedUa) push(prop)
      }
    }
    const inline = a.style
    if (inline?.length) {
      for (let i = 0; i < inline.length; i++) {
        const prop = inline[i]
        if (prop === 'all') return bail()
        if (a === el || ELEMENT_UNIVERSE_INHERITED.has(prop)) {
          push(prop)
          if (a === el && prop === 'display') push('grid-auto-flow')
          if (a === el && (prop === 'border-image' || prop === 'border-image-source')) {
            for (const dep of BORDER_AUX_PROPS) push(dep)
          }
        }
      }
    }
    if (a === doc.documentElement) break
    a = a.parentElement
  }

  const applyRule = (rule) => {
    if (!rule.props.length) return true
    let hit = false
    try { hit = el.matches(rule.sel) } catch { return false }
    if (hit) {
      for (const prop of rule.props) {
        push(prop)
        // WebKit reports grid-auto-flow:normal on SnapDOM's `all:initial` default probe but
        // row on a live grid. Official v3's document universe therefore emits `row` to undo
        // its own reset. Any authored display declaration may activate grid layout, so retain
        // this one dependent property rather than probing display on every narrowed element.
        if (prop === 'display') push('grid-auto-flow')
        if (prop === 'border-image' || prop === 'border-image-source') {
          for (const dep of BORDER_AUX_PROPS) push(dep)
        }
      }
    }
    return true
  }
  const indexMode = options?.__elementRuleIndex
  const attrValueMode = options?.__elementRuleAttrValueIndex !== false
  const keySelectivityMode = options?.__elementRuleKeySelectivity !== false
  const compoundKeyMode = options?.__elementRuleCompoundKeyPlanner !== false
  const selectorCSEMode = options?.__elementRuleSelectorCSE
  // In HTML quirks mode class/ID selector matching can use ASCII case-folding rules that are not
  // equivalent to classList.contains()/direct id equality. The index is only a dispatch hint, so
  // fail closed to the historical browser-matched linear interpreter instead of duplicating
  // quirks selector semantics here. Internal force flags never override this fidelity gate.
  const indexSemanticsSafe = (el.ownerDocument || document)?.compatMode === 'CSS1Compat'
  let useRuleIndex = indexSemanticsSafe && indexMode === true
  if (indexSemanticsSafe && !useRuleIndex && indexMode !== false) {
    const keyed = scan.elementKeyedRuleCount || 0
    // A large corpus is not sufficient by itself: when most rules are unkeyed the indexed
    // interpreter still walks nearly the whole rule list, so its Map/bucket overhead buys little.
    // The density sweep found 25.6% keyed inconclusive while 33.3% keyed was a replicated ~5%
    // win and 37.5%/50% improved further. Use the conservative one-third boundary without a
    // division in the hot path.
    if (keyed >= ELEMENT_RULE_INDEX_MIN_KEYED &&
        keyed * ELEMENT_RULE_INDEX_KEYED_FRACTION_DENOM >= scan.elementRules.length) {
      // Routing is capture-local even though the compiled index itself is style-epoch-local.
      // Persisting the work counter made repeated tiny captures eventually switch to indexed
      // lookup even when their own element×rule product was below the measured crossover.
      // `options` is the normalized per-capture context shared by every node in this capture.
      const paid = (options.__elementRuleIndexWork || 0) + keyed
      options.__elementRuleIndexWork = paid
      const compileGate = Math.max(
        ELEMENT_RULE_INDEX_WORK_FLOOR,
        scan.elementRules.length * ELEMENT_RULE_INDEX_COMPILE_MULTIPLIER,
      )
      if (paid >= compileGate) useRuleIndex = true
    }
  }
  if (!useRuleIndex) {
    for (const rule of scan.elementRules) {
      if (!subjectKeyMatches(el, rule.key, attrValueMode)) continue
      if (!applyRule(rule)) return bail()
    }
  } else {
    const baseSlot = keySelectivityMode
      ? (compoundKeyMode
          ? (attrValueMode ? 'ruleIndexCompoundSelective' : 'ruleIndexAttrNameCompoundSelective')
          : (attrValueMode ? 'ruleIndexSelective' : 'ruleIndexAttrNameSelective'))
      : (attrValueMode ? 'ruleIndex' : 'ruleIndexAttrName')
    let useSelectorCSE
    if (selectorCSEMode === true) useSelectorCSE = true
    else if (selectorCSEMode === false) useSelectorCSE = false
    else {
      // The admission decision is style-epoch-local, just like the compiled index. Sampling on
      // every element would turn the protected no-duplicate path into repeated Set allocation.
      if (st.selectorCSEUse === undefined) st.selectorCSEUse = selectorCSEWorthTrying(scan.elementRules)
      useSelectorCSE = st.selectorCSEUse
    }
    const slot = useSelectorCSE ? baseSlot + 'CSE' : baseSlot
    const ruleIndex = st[slot] || (st[slot] = compileElementRuleIndex(
      scan.elementRules,
      attrValueMode,
      keySelectivityMode,
      compoundKeyMode,
      useSelectorCSE,
    ))
    if (!visitIndexedElementRules(el, ruleIndex, applyRule)) return bail()
  }

  const peers = universePeers()
  for (let i = 0; i < queue.length; i++) {
    const extra = peers.get(queue[i])
    if (extra) for (const prop of extra) push(prop)
  }
  seen.clear(); trigger.clear(); queue.length = 0
  return selected.size ? selected : universe
}
/**
 * Whether the identity-share fast path is sound for THIS capture: no author selector that
 * can style two elements with identical tag + attributes + ancestor identity chain
 * differently (structural, sibling, state, :has — collected by styleScan) matches anything
 * under the capture root right now. A rule that matches nothing in the subtree at this
 * instant styles nobody the snapshot will read, so twins are identical by construction;
 * `.btn:hover` elsewhere on the page cannot split two table cells. One querySelector over
 * the joined gate, same shape as the pseudo pass's subtree question. Derived from the same
 * scan the property universe comes from; an unreadable scan or an unmatchable gate answers
 * "unsafe", which only costs the optimization.
 * Pinned by __tests__/module.styles.shareSubtreeGate.test.js.
 * @param {Element} el capture root
 * @returns {boolean}
 */
export function styleShareSafe(el) {
  const plan = styleSharePlan(el)
  return plan.share && plan.selectors === null
}

/**
 * The properties some author rule declares `!important`, or null when the scan is unreliable
 * or `el` lives in a shadow root. normalizeInlineStyleToComputed re-resolves only the inline
 * declarations a stylesheet can beat; null means re-resolve all of them.
 * @param {Element} el
 * @returns {Set<string>|null}
 */
export function importantPropsFor(el) {
  const doc = el.ownerDocument || document
  if (el.getRootNode && el.getRootNode() !== doc) return null
  return scanFor(doc).importantProps
}

/**
 * The properties the page's CSS can move off their UA default (styleScan.js), or null for
 * shadow-root content and an unreadable scan, which both mean full reads. The base reset and
 * diff.js read it too, so everything prunes with the same set the snapshots use.
 * @param {Element} el
 * @returns {Set<string>|null}
 */
export function universeFor(el) {
  const doc = el.ownerDocument || document
  // Shadow-root content: its own sheets aren't scanned — keep full reads there.
  if (el.getRootNode && el.getRootNode() !== doc) return null
  return scanFor(doc).universe
}

/** The property set a pseudo-element's snapshot reads (styleScan's pseudoUniverse); null
 *  (full read) for shadow content and an unreadable scan, like universeFor. */
export function pseudoUniverseFor(el) {
  const doc = el.ownerDocument || document
  if (el.getRootNode && el.getRootNode() !== doc) return null
  return scanFor(doc).pseudoUniverse
}

/** Per-kind selector gates for the pseudo probe (see scanAuthorStyles). Same memo and
 *  same shadow-root escape as universeFor: null gates → probe every node. */
const NULL_GATES = { before: null, after: null, firstLetter: null, marker: null, firstLine: null }
export function pseudoGatesFor(el) {
  const doc = el.ownerDocument || document
  if (el.getRootNode && el.getRootNode() !== doc) return NULL_GATES
  return scanFor(doc).pseudoGates
}

/**
 * The full computed-style read for one element: every property in `universe` (all of them
 * when null) plus the element's own inline props, with the fix-ups the snapshot needs. An
 * external url() becomes none, text-decoration and text-stroke are read by name because some
 * engines do not enumerate them, four zero borders collapse to `border: none` (#362), and
 * Firefox gets the background-clip:text fallback.
 * @param {CSSStyleDeclaration} style
 * @param {object} [options] - embedFonts adds the font-feature props; excludeStyleProps filters
 * @param {Element|null} [el] - for its inline style
 * @param {Set<string>|null} [universe] - from universeFor; null reads everything
 * @returns {Record<string, string>}
 */
function snapshotComputedStyleFull(style, options = {}, el = null, universe = null, backgroundState = null) {
  const out = {}
  const excludeStyleProps = options.excludeStyleProps
  const addProp = (prop) => {
    if (out[prop] !== undefined) return
    if (shouldIgnoreProp(prop)) return
    if (excludeStyleProps) {
      if (excludeStyleProps instanceof RegExp && excludeStyleProps.test(prop)) return
      if (typeof excludeStyleProps === 'function' && excludeStyleProps(prop)) return
    }
    let val = style.getPropertyValue(prop)
    if (!val) return
    if ((prop === 'background-image' || prop === 'content') && val.includes('url(') && !val.includes('data:')) {
      val = 'none'
    }
    out[prop] = val
  }
  if (universe) {
    // Pruned read: only properties the page's CSS (or this element's inline style) can
    // move off their UA defaults — anything else diffs empty downstream anyway.
    for (const prop of universe) addProp(prop)
    const inline = el && el.style
    if (inline && inline.length) {
      for (let i = 0; i < inline.length; i++) addProp(inline[i])
    }
  } else {
    for (let i = 0; i < style.length; i++) addProp(style[i])
  }
    // Ensure text-decoration props: some engines do not list them in the iteration.
  const EXTRA_TEXT_DECORATION_PROPS = [
    'text-decoration-line',
    'text-decoration-color',
    'text-decoration-style',
    'text-decoration-thickness',
    'text-underline-offset',
    'text-decoration-skip-ink'
  ]
  for (const prop of EXTRA_TEXT_DECORATION_PROPS) {
    if (out[prop]) continue
    try {
      const v = style.getPropertyValue(prop)
      if (v) out[prop] = v
    } catch {}
  }
  // #340: -webkit-text-stroke on Safari. Capture it even when the iteration omits it.
  const TEXT_STROKE_PROPS = [
    '-webkit-text-stroke',
    '-webkit-text-stroke-width',
    '-webkit-text-stroke-color',
    'paint-order'
  ]
  for (const prop of TEXT_STROKE_PROPS) {
    if (out[prop]) continue
    try {
      const v = style.getPropertyValue(prop)
      if (v) out[prop] = v
    } catch {}
  }
  if (options.embedFonts) {
    const EXTRA_FONT_PROPS = [
      'font-feature-settings',
      'font-variation-settings',
      'font-kerning',
      'font-variant',
      'font-variant-ligatures',
      'font-optical-sizing',
    ]
    for (const prop of EXTRA_FONT_PROPS) {
      if (out[prop]) continue
      try {
        const v = style.getPropertyValue(prop)
        if (v) out[prop] = v
      } catch { }
    }
  }
  // Keep visibility as visibility. Unlike opacity, it is inherited but a child may explicitly
  // restore `visibility: visible`; flattening a hidden ancestor to opacity:0 makes that legal,
  // painted descendant impossible to recover.
  // content-visibility:hidden skips the element's CONTENTS while still painting the element's
  // own box (background, border, padding) - verified against real Chromium. Carry the
  // declaration itself so the rasterizer applies those exact semantics: mapping it to
  // visibility:hidden would erase the box too, and a descendant could override it back, which
  // the real property does not allow. Read explicitly because content-visibility is not always
  // enumerated in the style.length iteration.
  try {
    const cv = out['content-visibility'] || style.getPropertyValue('content-visibility')
    if (cv === 'hidden') out['content-visibility'] = 'hidden'
  } catch { /* ignore */ }

  // Flag whether inlineBackgroundImages has any work on this node (bg/mask/border-image or a
  // background-color that needs its layout longhands for background-clip:text). Read from the
  // live declaration (not `out`) so excludeStyleProps or the url()→none rewrite can't hide it.
  // Stored non-enumerable so key generation/signature iteration never sees it.
  Object.defineProperty(out, '__needsBgInline', {
    value: backgroundState?.needsInline ?? computeBackgroundInlineState(style).needsInline,
    enumerable: false,
  })

  // #362: Tailwind's * { border: 0 solid } renders incorrectly in capture.
  // When all border widths are 0, normalize to border: none for unambiguous output.
  const bt = parseFloat(style.getPropertyValue('border-top-width') || 0) || 0
  const br = parseFloat(style.getPropertyValue('border-right-width') || 0) || 0
  const bb = parseFloat(style.getPropertyValue('border-bottom-width') || 0) || 0
  const bl = parseFloat(style.getPropertyValue('border-left-width') || 0) || 0
  if (bt === 0 && br === 0 && bb === 0 && bl === 0) {
    // If border-image is being used (even with zero border widths), do NOT force
    // the shorthand `border: none` because it can override the intended rendering.
    // (Decorative border-image + 0 widths is valid CSS in some setups.)
    const bis = (style.getPropertyValue('border-image-source') || '').trim()
    const hasBorderImage = bis && bis !== 'none'
    const BORDER_PROPS = [
      'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
      'border-width', 'border-style', 'border-color',
      'border-top-width', 'border-top-style', 'border-top-color',
      'border-right-width', 'border-right-style', 'border-right-color',
      'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
      'border-left-width', 'border-left-style', 'border-left-color',
      'border-block', 'border-block-width', 'border-block-style', 'border-block-color',
      'border-inline', 'border-inline-width', 'border-inline-style', 'border-inline-color',
      // The per-side logical longhands too, or they survive the normalization and re-declare
      // a zero-width solid border after the `border: none` emitted below.
      'border-block-start', 'border-block-start-width', 'border-block-start-style', 'border-block-start-color',
      'border-block-end', 'border-block-end-width', 'border-block-end-style', 'border-block-end-color',
      'border-inline-start', 'border-inline-start-width', 'border-inline-start-style', 'border-inline-start-color',
      'border-inline-end', 'border-inline-end-width', 'border-inline-end-style', 'border-inline-end-color',
    ]
    for (const p of BORDER_PROPS) delete out[p]
    if (!hasBorderImage) out['border'] = 'none'
  }

  applyBgClipTextFallback(out)

  return out
}
/**
 * Firefox cannot rasterize background-clip:text inside an SVG foreignObject image: the
 * background is dropped entirely, so gradient text whose own colour is transparent captures as
 * nothing at all (verified on v3: 0 painted pixels against Chromium's 1198 for the same span).
 * Approximate it with a plain text colour — the average of the gradient's stops — which loses
 * the gradient but keeps the words. Only fires when the text would otherwise be invisible.
 * Pinned by __tests__/module.styles.bgClipText.test.js.
 *
 * Imported from @frostin/snapdom (element-mirror).
 * @param {Record<string,string>} out mutable style snapshot
 */
function applyBgClipTextFallback(out) {
  if (!isFirefox()) return
  const clip = out['background-clip'] || out['-webkit-background-clip']
  if (!clip || !clip.includes('text')) return
  const transparent = (v) => v === 'transparent' || v === 'rgba(0, 0, 0, 0)'
  // -webkit-text-fill-color paints the glyphs when set; color is the fallback.
  const fill = out['-webkit-text-fill-color']
  if (!transparent(fill !== undefined ? fill : out['color'])) return
  const solid = bgClipTextFallbackColor(out['background-image'], out['background-color'])
  if (!solid) return
  if (transparent(out['color'])) out['color'] = solid
  if (fill !== undefined) out['-webkit-text-fill-color'] = solid
  out['background-image'] = 'none'
  out['background-color'] = 'transparent'
  delete out['background-clip']
  delete out['-webkit-background-clip']
  // Other passes re-inline the live values onto the clone over the class this snapshot
  // becomes (resolveCSSVars materializes the transparent colour, the authored inline-style
  // normalization re-inlines the gradient), so the fallback is also written inline with
  // !important; inlineAllStyles reads this marker. Non-enumerable: signature and key
  // iteration must not see it.
  Object.defineProperty(out, '__bgClipTextFix', { value: solid, enumerable: false })
}

/**
 * A single colour standing in for a clipped-to-text background: the channel average of every
 * visible rgb()/rgba() in the background-image (computed gradients serialize their stops that
 * way), else the background-color.
 * @param {string} [backgroundImage]
 * @param {string} [backgroundColor]
 * @returns {string|null}
 */
export function bgClipTextFallbackColor(backgroundImage, backgroundColor) {
  const collect = (value) => {
    const colors = []
    const re = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)/g
    let m
    while ((m = re.exec(value || ''))) {
      const raw = m[4]
      const alpha = raw === undefined ? 1 : parseFloat(raw) / (raw.endsWith('%') ? 100 : 1)
      if (alpha > 0.05) colors.push([+m[1], +m[2], +m[3]])
    }
    return colors
  }
  let colors = collect(backgroundImage)
  if (!colors.length) colors = collect(backgroundColor)
  if (!colors.length) return null
  const sum = [0, 0, 0]
  for (const [r, g, b] of colors) {
    sum[0] += r
    sum[1] += g
    sum[2] += b
  }
  return `rgb(${sum.map((c) => Math.round(c / colors.length)).join(', ')})`
}

/** ~10-read probe behind __needsBgInline (also run standalone for NO_DEFAULTS_TAGS,
 *  which skip the full snapshot but can still carry an external mask/border-image). */
function computeBackgroundInlineState(style) {
  const bgi = style.getPropertyValue('background-image')
  if (bgi && bgi !== 'none') return { needsInline: true, hasBackground: true }
  const bgc = style.getPropertyValue('background-color')
  if (bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent') {
    return { needsInline: true, hasBackground: true }
  }
  for (const p of BACKGROUND_INLINE_FLAG_PROPS) {
    const v = style.getPropertyValue(p)
    if (v && v !== 'none') {
      // #343 can hide a background url() in the shorthand even while background-image says
      // none. Only flagged mask/border-image nodes pay this extra read.
      const sh = style.getPropertyValue('background')
      const hasBackground = !!(sh && /url\s*\(|gradient\s*\(/i.test(sh))
      return { needsInline: true, hasBackground }
    }
  }
  // Preserve the historical #343 fallback exactly: without another inline-background trigger,
  // only a hidden url() in the shorthand schedules the post-pass. Normal gradients are
  // already visible through background-image above.
  const sh = style.getPropertyValue('background')
  const hasBackground = !!(sh && /url\s*\(/i.test(sh))
  return { needsInline: hasBackground, hasBackground }
}

function computeNeedsBgInline(style) {
  return computeBackgroundInlineState(style).needsInline
}

/**
 * Cheap "is this box sized by its own content?" check: any child element or non-whitespace
 * direct text node. O(1) amortized (firstElementChild short-circuits); never reads textContent
 * so it can't go O(n²) on deep trees.
 * @param {Element} el
 */
function hasRenderedContent(el) {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && /\S/.test(n.nodeValue || '')) return true
    // #454: an out-of-flow child doesn't size its parent — KaTeX's .hide-tail span
    // (width:100%, abspos svg inside) is sized by CSS, not content, so its width
    // must be kept verbatim instead of softened away.
    if (n.nodeType === 1) {
      const pos = getStyle(n).position
      if (pos !== 'absolute' && pos !== 'fixed') return true
    }
  }
  return false
}
/**
 * Whether the element's width is author-specified (a length/percentage) rather than derived from
 * its content or from the layout algorithm around it.
 *
 * `getComputedStyle().width` cannot answer this: it resolves to the USED width, so `auto` and
 * `width: 16px` both come back as `16px`. Typed OM reports the COMPUTED value, where `auto` stays
 * `auto` — that is the exact question, and it is available in Chromium and WebKit. Firefox has no
 * Typed OM, so there the answer is inferred from layout instead (see the two probes below).
 *
 * @param {Element} el
 * @param {CSSStyleDeclaration} cs live computed style of `el`
 * @param {boolean} isFlexItem
 */
function hasSpecifiedWidth(el, cs, isFlexItem) {
  try {
    if (typeof el.computedStyleMap === 'function') {
      const v = el.computedStyleMap().get('width')
      if (v != null) return !isContentWidthKeyword(String(v).trim().toLowerCase())
    }
  } catch { /* fall through to the layout probes */ }
  const inlineWidth = el.style && (el.style.width || el.style.inlineSize)
  if (inlineWidth && !isContentWidthKeyword(String(inlineWidth).trim().toLowerCase())) return true
  // A box that hugs its content is sized by it — `width: max-content` / `fit-content` land here
  // too, and those must keep softening. For a block-level box, also require that the used width
  // is not simply the available width (that is what plain `width: auto` gives).
  if (!contentNarrowerThanBox(el, cs)) return false
  return isFlexItem || usedWidthDiffersFromAvailable(el, cs)
}

/** Computed `width` values that still let the box be sized by its content or its container. */
const CONTENT_WIDTH_KEYWORDS = new Set([
  'auto', 'min-content', 'max-content', 'stretch', 'fill-available', '-webkit-fill-available',
])
function isContentWidthKeyword(value) {
  // fit-content(<length>) too: the box still shrinks around its content.
  return CONTENT_WIDTH_KEYWORDS.has(value) || value.startsWith('fit-content')
}

/**
 * Fallback probe for flex/grid items: an item sized by its own content is exactly as wide as that
 * content, so a content box wider than everything inside it means the width came from CSS.
 * @param {Element} el
 * @param {CSSStyleDeclaration} cs
 */
function contentNarrowerThanBox(el, cs) {
  const box = el.getBoundingClientRect().width -
    (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) -
    (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0)
  if (!(box > 0)) return false
  let left = Infinity, right = -Infinity, range = null
  for (let n = el.firstChild; n; n = n.nextSibling) {
    let r
    if (n.nodeType === 3) {
      if (!/\S/.test(n.nodeValue || '')) continue
      range = range || document.createRange()
      range.selectNode(n)
      r = range.getBoundingClientRect()
      if (!r.width && !r.height) continue
    } else if (n.nodeType === 1) {
      const s = getStyle(n)
      if (s.display === 'none' || s.position === 'absolute' || s.position === 'fixed') continue
      r = n.getBoundingClientRect()
    } else continue
    if (r.left < left) left = r.left
    if (r.right > right) right = r.right
  }
  if (right === -Infinity) return false
  return (right - left) < box - 0.5
}

/**
 * Fallback probe for block-level boxes in normal flow: with `width: auto` they fill the
 * containing block, so a used width that differs from the available width was authored.
 * @param {Element} el
 * @param {CSSStyleDeclaration} cs
 */
function usedWidthDiffersFromAvailable(el, cs) {
  const parent = el.parentElement
  if (!parent) return false
  const pcs = getStyle(parent)
  const available = parent.getBoundingClientRect().width -
    (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0) -
    (parseFloat(pcs.borderLeftWidth) || 0) - (parseFloat(pcs.borderRightWidth) || 0) -
    (parseFloat(cs.marginLeft) || 0) - (parseFloat(cs.marginRight) || 0)
  if (!(available > 0)) return false
  return Math.abs(el.getBoundingClientRect().width - available) > 0.5
}

const __snapshotSig = new WeakMap()
/** The snapshot's key into snapshotKeyCache, memoized per snapshot object. */
function styleSignature(snap) {
  let sig = __snapshotSig.get(snap)
  if (sig) return sig
  // Built in INSERTION order, not sorted. This string is only ever a key into
  // snapshotKeyCache — never rendered, serialized, or compared for ordering — and
  // snapshotComputedStyleFull fills every snapshot by walking the same property universe, so
  // two equal snapshots already come out in the same order. The sort was a per-element
  // reordering of an already-ordered list, paid on the COLD path that every one-shot capture
  // takes: Object.entries + sort + map + join over ~130 properties, once per element.
  // Measured on a 1500-node table, per-element cold cost: 118ms sorted -> 77ms here (-35%),
  // with the warm path unchanged.
  //
  // Use push + join, NOT `sig +=`. The concatenating form builds a cons-string that V8 has
  // to flatten the moment it is used as a Map key, which moved the cost rather than removing
  // it (warm went 21ms -> 30ms while cold improved). join produces a flat string directly.
  //
  // The separator is U+0001 rather than the old `:`/`;` because both of those occur inside
  // real property values (a data: URL, a quoted font-family), so the old format could in
  // principle collide two different snapshots onto one key. A control character cannot
  // appear in a computed value.
  //
  // The only cost of dropping the sort is that two elements whose INLINE style properties
  // were authored in a different order now miss each other in the key cache — one extra
  // getStyleKey call, never a wrong key. `__needsBgInline` is non-enumerable, so for...in
  // sees exactly what Object.entries saw.
  const parts = []
  for (const k in snap) parts.push(k, snap[k])
  sig = parts.join('\u0001')
  __snapshotSig.set(snap, sig)
  return sig
}

/**
 * `getSnapshot()` seeds a compact signature for shared twins before inlineAllStyles applies
 * the handful of node-local post-snapshot corrections. Keep that O(dynamic-props) fast path
 * valid without re-hashing the full snapshot: if a compact signature already exists, append
 * an injective mutation suffix. First-seen/full snapshots have no signature yet and therefore
 * need no repair — styleSignature() will observe their final values normally.
 */
function extendSnapshotSignature(snap, suffix) {
  const sig = __snapshotSig.get(snap)
  if (sig !== undefined) __snapshotSig.set(snap, sig + '\u0006' + suffix)
}
/** A cached snapshot is current while nothing document-wide happened (env epoch) and nothing
 *  a selector could follow to this node did (its stamp). */
function snapshotIsCurrent(rec, el) {
  return rec.env === __envEpoch && rec.stamp === stampOf(el, rec.hosts)
}

/**
 * Identity-share fast path (the per-element cold lever).
 *
 * A one-shot capture's dominant cost is the style snapshot: ~200 getPropertyValue reads per
 * node, measured at 56µs/node — 162ms of a 192ms capture on a 3000-node table. But most of
 * those nodes are structurally identical (same tag, same attributes, same ancestor chain),
 * and for such nodes the computed style can only differ in LAYOUT-derived values — the
 * properties CSSOM resolves to USED values. Measured across chromium/firefox/webkit with
 * identical-identity nodes whose boxes differ, the divergence set is: width/height (+ their
 * logical aliases), the box offsets, transform-origin and perspective-origin (box-derived),
 * margin/padding longhands (auto and % resolution), a grid container's track lists (`1fr 1fr`
 * reads as px per container — the deep-tree scene's grids took a deeper twin's columns and
 * laid out 18% of the pixels wrong), and the transform matrix (a % translate is resolved
 * against the box). So: read the full snapshot ONCE per identity, and per node re-read only
 * those.
 *
 * FIDELITY GATES, all conservative (any doubt → full reads):
 *  - document: no author selector that can split identical identities (structural position,
 *    sibling combinators, interaction/UA state, :has — styleShareSafe above), and no running
 *    animation/transition under the capture root (computed styles differ per frame). Decided
 *    once per capture in captureDOM → options.__styleShare.
 *  - element: never for form controls (UA styles their state without author CSS), never for
 *    the focused element (UA :focus-visible ring), never for shadow-root content (its sheets
 *    are outside the scan — universeFor already forces full reads there), and never for a
 *    shadow host or a slotted node, which that unscanned sheet styles through :host() and
 *    ::slotted(). Pinned by __tests__/regression.shadowHostStructural.test.js.
 *
 * The share map lives on the SESSION — one capture — so no cross-capture staleness is
 * possible; the per-element snapshotCache (cross-capture, stamp-guarded) sits in front
 * exactly as before.
 */
/* Which shared-snapshot props a twin must RE-READ, refined empirically on all three engines
 * (2026-09-01, twins with %-valued props under different-width parents):
 *  - ALWAYS: the geometry props whose getComputedStyle value is the USED value regardless of
 *    how they were authored — width/height, the box offsets (top/right/bottom/left and the
 *    inset-* logical longhands), transform-origin/perspective-origin.
 *  - NEVER: the min and max sizing longhands — their resolved value is the COMPUTED value ('10%' stays '10%',
 *    'auto' stays 'auto' on chromium, firefox AND webkit), and computed values are identical
 *    between identity twins by construction (same matched rules, same inherited inputs).
 *  - CONDITIONAL: the margin and padding longhands resolve %-values to used px, so they vary only when the
 *    document (or the identity's own inline style, identical across twins) actually gives
 *    the family an unstable value — styleScan flags marginUnstable/paddingUnstable. The grid
 *    track lists only on a grid container (elsewhere they are the specified value), and
 *    `transform` only when the identity has one (`none` cannot hide a % translate) — both
 *    decided from the identity's own read, so a table pays nothing for either. */
const LAYOUT_ALWAYS_RE = /^(width|height|inline-size|block-size|top|right|bottom|left|transform-origin|perspective-origin)$|^inset-/
const UNSTABLE_INLINE_RE = /(margin|padding)[a-z-]*\s*:[^;]*(%|\bauto\b|calc\(|var\()/i
const AUTO_MARGIN_INLINE_RE = /margin[a-z-]*\s*:[^;]*(\bauto\b|var\(|attr\(|\binherit\b|\brevert(?:-layer)?\b)/i
const AUTO_MARGIN_INLINE_ALL_RE = /(?:^|;)\s*all\s*:\s*(?:inherit|revert(?:-layer)?)(?:\s*!important)?\s*(?:;|$)/i
const UA_AUTO_MARGIN_TAGS = new Set(['DIALOG', 'HR'])

// Legacy HTML presentational hints live outside author stylesheets and inline CSS, so styleScan
// cannot prove them absent. `<table align="center">` maps to auto inline margins in Chromium and
// WebKit (and engines are free to implement the hint similarly elsewhere). Treat any table align
// hint conservatively: this path is rare, and a false positive only pays the historical Typed-OM
// probe while a false negative can freeze a used pixel margin and lose centering after clone work.
function hasPresentationalAutoMargin(el) {
  return el?.tagName === 'TABLE' && !!el.hasAttribute?.('align')
}
const SHARE_SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP', 'PROGRESS', 'METER', 'BUTTON', 'DATALIST'])

/** The capture's share state, made on first use: identity ids per node, the intern table,
 *  one snapshot record per identity. Lives on the session, so it dies with the capture. */
function shareStateOf(session, selectors = null, doc = document, useDataAttrIdentity = true) {
  let st = session.__styleShare
  if (!st || st.selectors !== selectors) {
    const scan = scanFor(doc)
    st = session.__styleShare = {
      ids: new WeakMap(), intern: new Map(), snaps: new Map(), rootSeen: false, selectors,
      dataAttrs: useDataAttrIdentity ? scan.styleIdentityDataAttrs : null,
      snapshotMisses: 0,
      routerMinMisses: 0,
      routerUniverseAllowed: undefined,
    }
  }
  return st
}

function shareSelectorFingerprint(el, selectors) {
  let out = ''
  for (let i = 0; i < selectors.length; i++) {
    const entry = selectors[i]
    const key = entry.key
    if (key !== null) {
      const type = key.charCodeAt(0)
      const value = key.slice(1)
      if (type === 116) { // t
        if (el.localName !== value) continue
      } else if (type === 99) { // c
        if (!el.classList || !el.classList.contains(value)) continue
      } else if (type === 97) { // a
        if (!el.hasAttribute?.(value)) continue
      } else if (type === 118) { // v = exact data-* value
        const cut = value.indexOf('\0')
        if (cut < 0 || el.getAttribute?.(value.slice(0, cut)) !== value.slice(cut + 1)) continue
      } else if (type === 105) { // i
        if (el.id !== value) continue
      } else {
        try {
          if (el.matches(entry.sel)) out += (out ? ',' : '') + i
        } catch { return null }
        continue
      }
    }
    let hit
    try { hit = el.matches(entry.sel) } catch { return null }
    if (hit) out += (out ? ',' : '') + i
  }
  return out
}

/** Interned identity id: parent's id + own tag + style-observable attributes + optional
 * selector vector. R4 may omit a data-* attribute from THIS CACHE KEY only when styleScan's
 * complete dependency index proves no selector or attr() declaration can observe it. The
 * cloned/output DOM is untouched. */
function identityFor(el, st, selectors = null) {
  let id = st.ids.get(el)
  if (id !== undefined) return id
  const parent = el.parentElement
  // The walk is top-down, so the ONE node whose parent was never walked is the capture root
  // itself (its parent lives outside the capture, a context every node here shares — a
  // constant marker keeps chains comparable). Any LATER node with an unwalked parent is a
  // structure this walk does not understand: refuse to share under it.
  let pid
  if (!parent) {
    pid = 'R'
  } else {
    pid = st.ids.get(parent)
    if (pid === undefined) {
      if (st.rootSeen) {
        st.ids.set(el, -1)
        return -1
      }
      pid = 'R'
    }
  }
  st.rootSeen = true
  if (pid === -1) {
    st.ids.set(el, -1)
    return -1
  }
  let attrs = ''
  const list = el.attributes
  if (list && list.length) {
    const dataAttrs = st.dataAttrs
    let inlineDataAttrs
    let first = ''
    let parts = null
    for (let i = 0; i < list.length; i++) {
      const attr = list[i]
      const name = attr.name
      if (dataAttrs !== null && name.startsWith('data-') && !dataAttrs.has(name)) {
        // Engine-owned markers participate in shadow/pseudo/internal pipeline contracts that
        // are not necessarily represented in the page's author stylesheet scan. Never elide
        // them from style identity, even if they happen to appear on a source node.
        if (name.startsWith('data-snapdom-') || name.startsWith('data-sd')) {
          const part = name + '=' + attr.value
          if (!first) first = part
          else if (parts) parts.push(part)
          else parts = [first, part]
          continue
        }
        if (inlineDataAttrs === undefined) inlineDataAttrs = scanInlineStyleDataAttrs(el.style)
        if (inlineDataAttrs !== null && !inlineDataAttrs.has(name)) continue
      }
      const part = name + '=' + attr.value
      if (!first) first = part
      else if (parts) parts.push(part)
      else parts = [first, part]
    }
    // The overwhelmingly common post-R4 case is zero/one style-observable attribute. Avoid
    // allocating an array for those nodes; only the multi-attribute case needs canonical
    // sorting to preserve sharing when equivalent DOM was authored in a different order.
    if (parts) { parts.sort(); attrs = parts.join('\u0001') }
    else attrs = first
  }
  let fp = ''
  if (selectors && selectors.length) {
    fp = shareSelectorFingerprint(el, selectors)
    if (fp === null) {
      st.ids.set(el, -1)
      return -1
    }
  }
  const key = pid + '|' + el.tagName + '|' + attrs + (selectors && selectors.length ? '\u0002' + fp : '')
  id = st.intern.get(key)
  if (id === undefined) {
    id = st.intern.size
    st.intern.set(key, id)
  }
  st.ids.set(el, id)
  return id
}

/** The identity's re-read list and base signature, decided once on its first twin (`el`,
 *  whose style attribute is the identity's — the attribute is part of the key) and kept on
 *  the share record: the
 *  always-geometry props, plus the margin/padding families only when the document-level
 *  scan or that inline style gives them an unstable value, the grid track lists on a grid
 *  container, and `transform` when the identity has one. The base signature covers the props
 *  twins NEVER re-read plus the re-read prop NAMES: a twin's full signature is base + its own
 *  re-read VALUES (+ the strip outcome), injective for the same reason the flat signature
 *  was — every name and value of the final snapshot is represented exactly once.
 *
 *  The list is the set of properties CSSOM resolves to USED values, and it was found by a
 *  defect: with the share on, the deep-tree scene rendered 18.6% of its pixels wrong because
 *  `grid-template-columns` reads as the used track list (`1fr 1fr` is `42px 388px` on one
 *  grid and `230px 840px` on its structural twin) and every grid took the first twin's
 *  columns. A probe of twins with different boxes on all three engines gave the full set.
 *  Building it on the first twin, and copying the snapshot once on the first hit, is what
 *  keeps the share free on a tree with no twins: per identity it cost the deep tree 27 ms of
 *  134, and twins spreading the identity's dictionary-mode object cost the 500-row table 6 ms.
 *  Pinned by __tests__/module.styles.identityShare.test.js.
 *  @param {{snap: object, rr: string[]|null, sig: string|null, h: boolean, b: boolean}} rec
 *  @param {Element} el the identity's first twin
 *  @returns {string[]} the re-read list, also stored on `rec.rr` */
function shareLists(rec, el) {
  // Re-copied once here, riders included: the identity's own object was built by keyed
  // stores (dictionary mode in V8) and every twin spreads it — off a spread-made copy the
  // 500-row table's twins clone 6 ms faster, and only identities WITH twins pay the copy.
  const src = rec.snap
  const stored = rec.snap = { ...src }
  Object.defineProperty(stored, '__needsBgInline', { value: src.__needsBgInline, enumerable: false })
  if (src.__bgClipTextFix !== undefined) {
    Object.defineProperty(stored, '__bgClipTextFix', { value: src.__bgClipTextFix, enumerable: false })
  }
  const scan = scanFor(el.ownerDocument || document)
  const attr = (el.getAttribute && el.getAttribute('style')) || ''
  const inlineUnstable = attr && UNSTABLE_INLINE_RE.test(attr)
  const rrM = !!scan.marginUnstable || (inlineUnstable && /margin/i.test(attr))
  const rrP = !!scan.paddingUnstable || (inlineUnstable && /padding/i.test(attr))
  const rrG = stored.display !== undefined && stored.display.includes('grid')
  const rrT = stored.transform !== undefined && stored.transform !== 'none'
  const rrList = []
  for (const k in stored) {
    if (LAYOUT_ALWAYS_RE.test(k) ||
        (rrG && (k === 'grid-template-columns' || k === 'grid-template-rows')) ||
        (rrT && k === 'transform') ||
        (rrM && k.charCodeAt(0) === 109 && k.startsWith('margin-')) ||
        (rrP && k.charCodeAt(0) === 112 && k.startsWith('padding-'))) rrList.push(k)
  }
  if (rec.h && !('height' in stored)) rrList.push('height')
  if (rec.b && !('block-size' in stored)) rrList.push('block-size')
  const rrSet = new Set(rrList)
  const staticParts = []
  for (const k in stored) { if (!rrSet.has(k)) staticParts.push(k, stored[k]) }
  rec.rr = rrList
  rec.sig = staticParts.join('\u0001') + '\u0002' + rrList.join('\u0001')
  return rrList
}

/**
 * A pseudo-element's snapshot, shared between identity twins the way the element's is. The
 * identity interned for `source` during the clone walk (same tag, attributes and ancestor
 * chain) means the same rules match its `::before` and its inherited inputs are a twin's,
 * so ONE pruned read per (identity, pseudo) and per twin only the used-value props
 * (shareLists — the element's own list, decided on the first twin). Falls back to the pruned
 * read whenever the element share is off for the capture (a splitting selector matching
 * under the root, animations, an unreadable scan, shadow content) or the walk refused this
 * node an identity. Deep tree with a `::before` on every leaf (1,936 pseudos), bare page:
 * pruned reads alone 272 ms; shared 190 ms; without the rule 125.
 * @param {Element} source
 * @param {string} pseudo '::before' | '::after'
 * @param {CSSStyleDeclaration} style getComputedStyle(source, pseudo)
 * Pinned by __tests__/module.pseudo.twinShare.test.js.
 * @param {Object} session the capture's sessionCache
 * @param {Object} options capture options (carries __styleShare)
 * @returns {Record<string, string>}
 */
export function pseudoSnapshotFor(source, pseudo, style, session, options) {
  const st = options && options.__styleShare ? session && session.__styleShare : null
  const id = st ? st.ids.get(source) : undefined
  // Same shadow-host and slotted escape as the element share (`:host(:nth-child(2))::before`).
  if (id === undefined || id === -1 || source.shadowRoot || source.assignedSlot) return snapshotComputedStyle(style, pseudoUniverseFor(source))
  const key = id + pseudo
  const snaps = st.pseudo || (st.pseudo = new Map())
  const rec = snaps.get(key)
  if (rec) {
    const snap = { ...rec.snap }
    const rr = rec.rr || shareLists(rec, source)
    for (let i = 0; i < rr.length; i++) {
      const v = style.getPropertyValue(rr[i])
      if (v) snap[rr[i]] = v
      else delete snap[rr[i]]
    }
    return snap
  }
  const snap = snapshotComputedStyle(style, pseudoUniverseFor(source))
  // By reference, copied on the first twin (shareLists), like the element share: a copy per
  // pseudo was paid on the deep tree for 1,936 identities that never had a twin. The one
  // write the pass makes afterwards (a flex-item min-width floor) depends on the host's
  // display, identical for twins.
  snaps.set(key, { snap, rr: null, sig: null, h: 'height' in snap, b: 'block-size' in snap })
  return snap
}

/**
 * The element's snapshot: the cached one while it is current, else a fresh full read, or on
 * an identity hit a copy of the twin's read with only the used-value props re-read here.
 * @param {Element} el
 * @param {CSSStyleDeclaration|null} [preStyle] - getComputedStyle(el), when the caller has it
 * @param {object} [options]
 * @param {{st: object, id: number}|null} [shareInfo] - the identity to share under, or null
 * @returns {Record<string, string>}
 */
function getSnapshot(el, preStyle = null, options = {}, shareInfo = null) {
  const rec = snapshotCache.get(el)
  // The snapshot content depends on embedFonts (extra font props) and excludeStyleProps
  // (skipped props), which no invalidation signal tracks. Capturing the same element twice
  // with different options must not reuse the snapshot (#348). Callback identity cannot
  // reveal changes to its closure, so function policies always take a fresh snapshot even
  // when the caller already bypassed result memoization.
  const ef = !!(options && options.embedFonts)
  const ex = (options && options.excludeStyleProps) || null
  if (typeof ex !== 'function' && rec && snapshotIsCurrent(rec, el) &&
      rec.embedFonts === ef && rec.excludeStyleProps === ex) return rec.snapshot
  const style = preStyle || getComputedStyle(el)
  let snap
  let dyn = null
  const shared = shareInfo && shareInfo.st.snaps.get(shareInfo.id)
  let allowSharedUniverse = false
  if (shareInfo) {
    const shareState = shareInfo.st
    const mode = options?.__styleShareElementUniverse
    if (mode === true) {
      allowSharedUniverse = !shared
    } else if (mode !== false) {
      // Parse/tame the experimental knob once per capture. Re-running Number()/isFinite()/floor
      // on every first-seen identity moves needless work into the exact miss-heavy path we are
      // optimizing.
      if (!shareState.routerMinMisses) {
        const configured = Number(options?.__styleShareElementUniverseMinMisses)
        shareState.routerMinMisses = Number.isFinite(configured) && configured > 0
          ? Math.max(1, Math.floor(configured))
          : STYLE_SHARE_ELEMENT_UNIVERSE_MIN_MISSES
      }
      if (!shared) {
        // Decide from PRIOR misses. With the production threshold of 5, the first five distinct
        // snapshots stay pure R2; only later misses can pay R3. That protects low-cardinality
        // sharing while recovering the high-entropy region without a whole-tree preflight.
        if (shareState.routerUniverseAllowed === undefined) {
          const scan = scanFor(el.ownerDocument || document)
          const totalRules = scan.elementRules?.length || 0
          const keyedRules = scan.elementKeyedRuleCount || 0
          shareState.routerUniverseAllowed = totalRules - keyedRules <=
            STYLE_SHARE_ELEMENT_UNIVERSE_MAX_UNKEYED_RULES
        }
        allowSharedUniverse = shareState.routerUniverseAllowed &&
          shareState.snapshotMisses >= shareState.routerMinMisses
        shareState.snapshotMisses++
      }
    }
  }
  if (shared) {
    // Identity hit: copy the shared full read, then re-read only the layout-varying props on
    // THIS node. The non-enumerable riders carry over: __bgClipTextFix derives from colors,
    // and __needsBgInline from the PRESENCE of url()/gradient/mask/border-image values —
    // all non-geometry computed values, identical between identity twins by construction
    // (same matched rules; animations disable the share). Recomputing the flag per twin was
    // 7 live reads a node for an answer the identity already holds.
    snap = { ...shared.snap }
    // Direct loop over the identity's re-read list (built on its first twin): the old form
    // walked all ~150 keys with a regex test per key, per twin (10.8ms of getSnapshot
    // self-time on the 500-row table, profiled). The values feed `dyn`, which composes this
    // twin's snapshotKeyCache signature from the identity's base signature — styleSignature
    // re-hashed the whole snapshot per twin for another 11ms otherwise.
    const rrList = shared.rr || shareLists(shared, el)
    dyn = []
    for (let i = 0; i < rrList.length; i++) {
      const p = rrList[i]
      const v = style.getPropertyValue(p)
      if (v) snap[p] = v
      else delete snap[p]
      dyn.push(v)
    }
    Object.defineProperty(snap, '__needsBgInline', { value: shared.snap.__needsBgInline, enumerable: false })
    if (shared.snap.__bgClipTextFix !== undefined) {
      Object.defineProperty(snap, '__bgClipTextFix', { value: shared.snap.__bgClipTextFix, enumerable: false })
    }
  } else {
    const docUniverse = universeFor(el)
    // This probe already existed inside snapshotComputedStyleFull. Compute it once up front so
    // R3 can preserve the exact downstream properties background.js will consume, then reuse
    // the result for the non-enumerable snapshot flag instead of paying the probe twice.
    const backgroundState = computeBackgroundInlineState(style)
    snap = snapshotComputedStyleFull(
      style,
      options,
      el,
      elementUniverseFor(el, style, options, docUniverse, backgroundState, allowSharedUniverse),
      backgroundState,
    )
    if (shareInfo) {
      // Stored by REFERENCE, with the riders it already carries: the copy that used to be
      // made here, plus a re-read list and a base signature per identity, cost 27 ms of a
      // 134 ms pipeline on a tree whose nodes are all unique (the deep-tree scene: 1,936
      // leaves, each with its own inline background) for lists no twin ever read. Two
      // passes mutate this object after it is stored, and both are deterministic for the
      // twins: the flex-item min-width floor writes the value every twin gets too, and
      // stripHeightForWrappers judges this node's OWN children, so it may delete height /
      // block-size that a twin keeps — the flags let shareLists put them back on the
      // re-read list, where the twin reads its own.
      shareInfo.st.snaps.set(shareInfo.id, { snap, rr: null, sig: null, h: 'height' in snap, b: 'block-size' in snap })
    }
  }
  // Chromium can report a zero used margin after a partial container layout even
  // though the box remains centered. Typed OM retains the resolved `auto` keyword;
  // carrying it lets the frozen parent/child dimensions reproduce that alignment.
  // Keep ordinary nonzero used margins unchanged, and respect excluded properties.
  let restoredAutoMargin = false
  if (typeof el.computedStyleMap === 'function') {
    let typed
    const gateAutoMargin = options?.__autoMarginProbeGate !== false
    let gateResolved = !gateAutoMargin
    let probeAutoMargin = true
    for (const prop of MARGIN_PROPS) {
      if (snap[prop] !== '0px') continue
      // Resolve the semantic admission proof lazily at the first margin Typed OM could
      // actually change. This keeps the historical false-counterfactual on its original
      // single loop, avoids any classifier work for R3 snapshots with no eligible margin,
      // and avoids a second eight-property pre-pass on the twin-heavy fast path.
      if (!gateResolved) {
        gateResolved = true
        const doc = el.ownerDocument || document
        const root = el.getRootNode?.()
        const outsideDocumentScan = root !== doc || !!el.shadowRoot || !!el.assignedSlot
        if (!outsideDocumentScan) {
          const scan = scanFor(doc)
          const inline = el.getAttribute?.('style') || ''
          probeAutoMargin = !!scan.marginMayBeAuto || !!scan.hasAnimations ||
            UA_AUTO_MARGIN_TAGS.has(el.tagName) || hasPresentationalAutoMargin(el) ||
            AUTO_MARGIN_INLINE_RE.test(inline) || AUTO_MARGIN_INLINE_ALL_RE.test(inline)
        }
      }
      // The proof is element-wide: if no source can produce an auto margin, no remaining
      // zero-margin property can benefit from a Typed-OM lookup either.
      if (!probeAutoMargin) break
      try {
        typed ||= el.computedStyleMap()
        if (typed.get(prop)?.toString() === 'auto') {
          snap[prop] = 'auto'
          restoredAutoMargin = true
        }
      } catch { /* Typed OM is optional; keep the computed style if unsupported. */ }
    }
  }
  stripHeightForWrappers(el, style, snap)
  if (dyn !== null) {
    if (restoredAutoMargin) dyn.push('\u0005', ...MARGIN_PROPS.map(prop => snap[prop]))
    // Seed the signature memo AFTER the strip: it deletes at most height/block-size, and two
    // twins with different strip outcomes must not collide onto one key.
    __snapshotSig.set(snap, shared.sig + '\u0002' + dyn.join('\u0001') +
      ('height' in snap ? '' : '\u0003') + ('block-size' in snap ? '' : '\u0004'))
  }
  const hosts = shadowHostsOf(el)
  snapshotCache.set(el, { env: __envEpoch, stamp: stampOf(el, hosts), hosts, snapshot: snap, embedFonts: ef, excludeStyleProps: ex })
  return snap
}

/** Turns whatever inlineAllStyles was given into `{ session, persist, options }`: a ready ctx
 *  as is, a session cache with one ctx memoized on it per options object, or nothing, which
 *  gets throwaway maps so a direct caller never touches the global session. */
function _resolveCtx(sessionOrCtx, opts) {
  if (sessionOrCtx && sessionOrCtx.session && sessionOrCtx.persist) return sessionOrCtx
  if (sessionOrCtx && (sessionOrCtx.styleMap || sessionOrCtx.styleCache || sessionOrCtx.nodeMap)) {
    // Amortize to one ctx allocation per capture: deepClone calls this per node with the
    // same sessionCache + options references.
    let ctx = sessionOrCtx.__ctx
    if (!ctx || sessionOrCtx.__ctxOpts !== opts) {
      ctx = {
        session: sessionOrCtx,
        persist: {
          snapshotKeyCache,
          defaultStyle: cache.defaultStyle,
          baseStyle: cache.baseStyle,
          image: cache.image,
          resource: cache.resource,
          background: cache.background,
        },
        options: opts || {},
      }
      sessionOrCtx.__ctx = ctx
      sessionOrCtx.__ctxOpts = opts
    }
    return ctx
  }

  return {
    // Direct callers without a session get isolated throwaway maps — never the global.
    session: { styleMap: new Map(), styleCache: new WeakMap(), nodeMap: new Map() },
    persist: {
      snapshotKeyCache,
      defaultStyle: cache.defaultStyle,
      baseStyle: cache.baseStyle,
      image: cache.image,
      resource: cache.resource,
      background: cache.background,
    },
    options: (sessionOrCtx || opts || {}),
  }
}

/** An inline value that resolves against something the foreignObject does not reproduce:
 *  a percentage, a font- or viewport-relative unit, calc()/var(), a keyword like auto. */
const CONTEXT_DEPENDENT_VALUE_RE =
  /%|[\d.](?:em|rem|ex|ch|cap|ic|lh|rlh|v[whib]|vmin|vmax|cq[whbi]|cqmin|cqmax)\b|\b(?:calc|var|min|max|clamp|env|attr)\(|\b(?:auto|inherit|initial|unset|revert|currentcolor|-webkit-fill-available|fit-content|min-content|max-content)\b/i

const isTextField = (el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
/**
 * Re-resolves the source's inline declarations through the cascade onto the clone.
 *
 * Three cases need it. Everything else is an absolute value copied onto itself, which the
 * clone's style attribute already holds.
 *  - A stylesheet `!important` must still beat an inline declaration inside the clone (#328).
 *  - `background` on text fields only: the selection highlight composes its layers on top
 *    of the longhands this writes on an input's clone. On every other node the shorthand is
 *    the same value, and re-resolving it cost the 500-row table 13.5k reads plus 13.5k
 *    writes for nothing.
 *  - Context-dependent values (`width:100%`, `1.2em`, `calc()`, `auto`) resolve against a
 *    containing block the foreignObject does not have.
 * The context test is one regex over the whole style attribute, on purpose: per longhand it
 * got 67.6 ms down to 63 where the single regex gets 49.7. A null important set (unreliable
 * scan) re-resolves everything. Pinned by __tests__/module.styles.inlineImportant.test.js.
 * @param {Element} source
 * @param {Element} clone
 * @param {CSSStyleDeclaration} computed - getComputedStyle(source)
 */
function normalizeInlineStyleToComputed(source, clone, computed) {
  if (!source.style || source.style.length === 0) return
  const important = importantPropsFor(source)
  const canSkip = important != null && !CONTEXT_DEPENDENT_VALUE_RE.test(source.getAttribute('style') || '')
  for (let i = 0; i < source.style.length; i++) {
    const prop = source.style[i]
    if (canSkip && !important.has(prop) && !(prop.startsWith('background') && isTextField(source))) continue
    const val = computed.getPropertyValue(prop)
    // A retained <style> can still contain an important ID selector. The live inline
    // !important wins it; dropping that priority here reverses the cascade in the clone.
    if (val) clone.style.setProperty(prop, val, source.style.getPropertyPriority(prop))
  }
}

/**
 * Snapshots the source's computed style and records the clone's style-class key on the
 * session's styleMap. deepClone calls it for every element in the capture.
 *
 * Per node: wire invalidation for the node's own document, re-resolve the inline style where
 * the cascade can differ (normalizeInlineStyleToComputed), pin `animation` off so a static
 * frame does not replay from its 0% keyframe, take or share the snapshot, floor a flex item's
 * min-width at 0 (#406), then key it. Soften-eligible boxes (softensWidth) fold tag, content
 * and flex-item state into the key and tally reconcileRisk for capture.js's warning.
 * `<style>` is skipped. NO_DEFAULTS_TAGS (SVG shapes) get an empty key and only the
 * background-inline flag. Pinned by __tests__/module.styles.test.js.
 * @param {Element} source
 * @param {Element} clone
 * @param {object} [sessionOrCtx] - the session cache (styleMap / styleCache / nodeMap), a
 *   ready ctx, or nothing for an isolated one-off call
 * @param {object} [opts] - capture options: cache, embedFonts, excludeStyleProps, __styleShare
 */
export function inlineAllStyles(source, clone, sessionOrCtx, opts) {
  if (source.tagName === 'STYLE') return

  const ctx = _resolveCtx(sessionOrCtx, opts)
  // Normalized upstream to 'soft' | 'disabled'; 'soft' is the only non-disabled value.
  const resetMode = (ctx.options && ctx.options.cache) || 'soft'

  // The node's OWN document. Capturing inside a same-origin iframe wired the parent's
  // observers and watched a document the captured element does not live in.
  if (resetMode !== 'disabled') setupInvalidationOnce(source.ownerDocument)

  prepareStyleCapture(ctx.session, resetMode)

  const { session, persist } = ctx

  if (!session.styleCache.has(source)) {
    // ROB-1: getComputedStyle() on detached nodes can return an empty or unstable
    // CSSStyleDeclaration in some environments. Wrap defensively so a stale/detached
    // element never throws and callers always receive a usable style object.
    let computed = null
    try { computed = getComputedStyle(source) } catch { /* detached / cross-origin */ }
    session.styleCache.set(source, computed || getComputedStyle((source.ownerDocument || document).documentElement))
  }
  const pre = session.styleCache.get(source)

  // Replace authored inline style with computed values so !important in stylesheets
  // correctly overrides inline styles in the clone (fixes #328)
  if (source.getAttribute?.('style')) {
    normalizeInlineStyleToComputed(source, clone, pre)
  }

  // A static snapshot must not animate. The generated style class already filters animation
  // props (shouldIgnoreProp), but `animation` can still reach the SVG through the normalized
  // inline style above or through `<style>` tags cloned inside the captured subtree; when the
  // SVG is rasterized the animation replays from its 0% keyframe. An entry animation whose
  // start frame hides the element (e.g. `from { opacity: 0 }`, or an off-screen `transform`)
  // therefore blanks it out even though the live element already finished animating. Pin
  // `animation` off with inline `!important` on the elements that actually have one; the
  // current opacity/transform captured in the snapshot below then renders as the frozen,
  // already-settled frame.
  const animName = pre.getPropertyValue('animation-name')
  if (clone && clone.style && animName && animName !== 'none') {
    clone.style.setProperty('animation', 'none', 'important')
  }

  const tag = source.tagName?.toLowerCase() || 'div'
  // NO_DEFAULTS_TAGS (SVG shapes/containers, head stuff) never get a style class —
  // getStyleKey returns '' and the empty key is dropped at emit. Skip the full universe
  // snapshot + signature they'd pay for nothing; their paint survives via clone.js's
  // SVG_PAINT_PROPS pass. Only the bg/mask flag probe runs (CSS masks DO apply to SVG
  // graphics elements) so needsBackgroundInline stays accurate.
  if (NO_DEFAULTS_TAGS.has(tag)) {
    const stub = {}
    Object.defineProperty(stub, '__needsBgInline', { value: computeNeedsBgInline(pre), enumerable: false })
    const hosts = shadowHostsOf(source)
    snapshotCache.set(source, {
      env: __envEpoch, stamp: stampOf(source, hosts), hosts, snapshot: stub,
      embedFonts: !!(ctx.options && ctx.options.embedFonts),
      excludeStyleProps: (ctx.options && ctx.options.excludeStyleProps) || null,
    })
    session.styleMap.set(clone, '')
    return
  }

  let shareInfo = null
  if (ctx.options && ctx.options.__styleShare && session.styleMap) {
    const selectors = ctx.options.__styleShareSelectors || null
    const st = shareStateOf(
      session,
      selectors,
      source.ownerDocument || document,
      ctx.options.__styleIdentityDataAttrs !== false,
    )
    const id = identityFor(source, st, selectors)
    const doc = source.ownerDocument || document
    const active = doc.activeElement
    // A shadow host and a slotted node are styled by a root sheet the scan never read:
    // `:host(:not(:first-child))` split three identical #488 groups and the twins painted
    // the first one's zero margin (the same rule inside ::slotted() splits slotted twins).
    const eligible = id !== -1 &&
      !SHARE_SKIP_TAGS.has(source.tagName) &&
      !(active && active !== doc.body && active !== doc.documentElement && active === source) &&
      (!source.getRootNode || source.getRootNode() === doc) &&
      !source.shadowRoot && !source.assignedSlot
    if (eligible) shareInfo = { st, id }
  }
  const snap = getSnapshot(source, pre, ctx.options, shareInfo)
  // Inline author declarations were normalized above from getComputedStyle too.
  // Override their zero margin (including logical shorthands) with the retained auto.
  if (source.getAttribute?.('style')) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const prop = `margin-${side}`
      if (snap[prop] === 'auto') clone.style.setProperty(prop, 'auto', 'important')
    }
  }

  // Firefox background-clip:text fallback (see applyBgClipTextFallback): the class carries the
  // substitute colour, but resolveCSSVars and the authored inline-style normalization re-inline
  // the live transparent colour and the gradient over any class. Inline !important outranks
  // them all.
  if (snap.__bgClipTextFix && clone && clone.style) {
    clone.style.setProperty('background-image', 'none', 'important')
    clone.style.setProperty('background-color', 'transparent', 'important')
    clone.style.setProperty('color', snap.__bgClipTextFix, 'important')
    clone.style.setProperty('-webkit-text-fill-color', snap.__bgClipTextFix, 'important')
  }

  const gutterMask = addScrollbarGutter(source, pre, snap)
  if (gutterMask) {
    // Encode the actual final values, not just the gutter width. Two twins can reach the same
    // gutter through different pre-gutter used widths, and only equal FINAL snapshots may share
    // a generated style key.
    let suffix = 'g' + gutterMask
    if (gutterMask & 1) suffix += '\u0001' + (snap.width ?? '') + '\u0001' + (snap['inline-size'] ?? '')
    if (gutterMask & 2) suffix += '\u0001' + (snap.height ?? '') + '\u0001' + (snap['block-size'] ?? '')
    extendSnapshotSignature(snap, suffix)
  }

  const flexItem = isFlexOrGridItem(source)

  // #406: foreignObject may resolve min-width:auto differently than normal DOM
  // for flex/grid items. Explicitly set min-width:0 on flex/grid items that have
  // the default auto value, so the generated CSS class includes it and we don't
  // need a blanket foreignObject *{min-width:0} rule (which breaks inline-flex+gap).
  if (flexItem) {
    const mw = pre.getPropertyValue('min-width')
    if (!mw || mw === 'auto' || mw === '0px') {
      if (snap['min-width'] !== '0px') {
        snap['min-width'] = '0px'
        extendSnapshotSignature(snap, 'm\u0001min-width\u00010px')
      }
    }
  }

  // getStyleKey only softens width for inline-sized / table / inline boxes, and only there does
  // its output depend on content/flex-item-ness. For every other node (the vast majority — divs,
  // headings, paragraphs…) skip that bookkeeping entirely so the hot path stays untouched.
  let sig = styleSignature(snap)
  let sizedByContent = true
  if (softensWidth(tag, (snap.display || '').toLowerCase())) {
    sizedByContent = hasRenderedContent(source)
    // #484: softening only reproduces the box when its `width` is auto. On a blockified box in
    // normal flow (`span{display:block;width:16px}`) the min-width floor cannot cap the stretch,
    // and a flex/grid item gets no floor at all (#406) — both lost the authored width. Treat an
    // author-specified width as "not sized by content" so it is kept verbatim.
    if (sizedByContent && softenNeedsAutoWidth(tag, snap, flexItem) &&
        hasSpecifiedWidth(source, pre, flexItem)) {
      sizedByContent = false
    }
    // Fold tag/content/flex into the cache key so soften-eligible elements with identical styles
    // but different shape don't collide on the shared snapshotKeyCache.
    sig = `${sig}|${tag}${sizedByContent ? '|c' : ''}${flexItem ? '|f' : ''}`
    // This is the exact condition getStyleKey uses to actually drop the width (the #429/#433/
    // #434 family): tally it so capture.js can suggest `reconcile: true` when it's never used —
    // cheap, since softensWidth/sizedByContent are already computed for this node regardless.
    // Nowrap/pre boxes stay frozen (#474), so they carry no re-wrap risk.
    const wsMode = snap['text-wrap-mode'] || snap['white-space'] || ''
    if (sizedByContent && wsMode !== 'nowrap' && wsMode !== 'pre') {
      session.reconcileRisk = (session.reconcileRisk || 0) + 1
    }
  }
  let key = persist.snapshotKeyCache.get(sig)
  if (key === undefined) {
    key = getStyleKey(snap, tag, sizedByContent, flexItem)
    // Bound at INSERTION: evicting only on an epoch bump left the Map unbounded for as long
    // as the page's styles held still. Map iterates in insertion order, so this is FIFO.
    if (persist.snapshotKeyCache.size >= MAX_SNAPSHOT_KEY_CACHE) {
      persist.snapshotKeyCache.delete(persist.snapshotKeyCache.keys().next().value)
    }
    persist.snapshotKeyCache.set(sig, key)
  }
  session.styleMap.set(clone, key)
}
/**
 * #498: on a content-box scroll container `getComputedStyle().width/height` return the box
 * MINUS its classic (non-overlay) scrollbars — the live element is that much bigger. Freezing
 * the bare value shrinks the box by the scrollbar size, the content no longer fits, and a
 * vertical scrollbar that does not exist in the live page appears in the capture (which in
 * turn steals width from the rows). Add the measured gutters back so the frozen box matches
 * the live one. Border-box values already include the scrollbars; overlay scrollbars
 * (macOS default) measure 0 and change nothing.
 * @param {Element} source
 * @param {CSSStyleDeclaration} pre
 * @param {Record<string,string>} snap
 */
export function addScrollbarGutter(source, pre, snap) {
  const ox = pre.getPropertyValue('overflow-x')
  const oy = pre.getPropertyValue('overflow-y')
  if ((ox === 'visible' || !ox) && (oy === 'visible' || !oy)) return 0
  if (pre.getPropertyValue('box-sizing') === 'border-box') return 0
  if (typeof source.clientWidth !== 'number' || !source.offsetWidth) return 0
  const px = (v) => parseFloat(v) || 0
  const vGutter = source.offsetWidth - source.clientWidth -
    px(pre.getPropertyValue('border-left-width')) - px(pre.getPropertyValue('border-right-width'))
  const hGutter = source.offsetHeight - source.clientHeight -
    px(pre.getPropertyValue('border-top-width')) - px(pre.getPropertyValue('border-bottom-width'))
  let changed = 0
  const bump = (prop, gutter) => {
    // `snap` is cross-capture cached before this node-local correction runs. Derive the
    // corrected value from the LIVE computed baseline, not from a previously corrected
    // cached snapshot, or an unchanged second capture compounds the same gutter again.
    // Keep the snapshot-presence check so excluded/pruned properties remain excluded.
    const captured = snap[prop]
    if (!captured || !captured.endsWith('px')) return false
    const live = pre.getPropertyValue(prop)
    const base = live && live.endsWith('px') ? live : captured
    const n = parseFloat(base)
    if (!Number.isFinite(n)) return false
    const next = `${Math.round((n + gutter) * 1000) / 1000}px`
    if (next === captured) return false
    snap[prop] = next
    return true
  }
  if (vGutter > 0.5) {
    const widthChanged = bump('width', vGutter)
    const inlineChanged = bump('inline-size', vGutter)
    if (widthChanged || inlineChanged) changed |= 1
  }
  if (hGutter > 0.5) {
    const heightChanged = bump('height', hGutter)
    const blockChanged = bump('block-size', hGutter)
    if (heightChanged || blockChanged) changed |= 2
  }
  return changed
}

/**
 * A box that paints or clips: a background, a vertical border or padding, or an overflow
 * other than visible.
 * @param {CSSStyleDeclaration} cs
 * @returns {boolean}
 */
function hasBox(cs) {
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true
  if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') return true
  if ((parseFloat(cs.borderTopWidth) || 0) > 0) return true
  if ((parseFloat(cs.borderBottomWidth) || 0) > 0) return true
  if ((parseFloat(cs.paddingTop) || 0) > 0) return true
  if ((parseFloat(cs.paddingBottom) || 0) > 0) return true
  const ob = cs.overflowBlock || cs.overflowY || 'visible'
  return ob !== 'visible'
}

/**
 * Flex/grid item (reads the parent's display, one getComputedStyle).
 * @param {Element} el
 */
function isFlexOrGridItem(el) {
  const p = el.parentElement
  if (!p) return false
  // getStyle memoizes in cache.computedStyle; raw getComputedStyle forced a fresh resolution
  // per node on every capture (even on snapshot-cache hits).
  const pd = getStyle(p).display || ''
  return pd.includes('flex') || pd.includes('grid')
}

/**
 * Is there in-flow content? Fast version:
 *  - A direct, non-empty text node -> true (triggers no layout).
 *  - An immediate <br> -> true.
 *  - Any in-flow element child -> true.
 *
 * Both questions are about THIS element's own flow, so neither `textContent` nor a
 * scrollHeight probe can answer them: `textContent` also sees text inside absolutely
 * positioned descendants, and scrollHeight is floored at clientHeight, so a wrapper whose
 * children are all out of flow still reports its own used height. Trusting either one made
 * stripHeightForWrappers drop the height of such a wrapper, which then collapsed to 0 inside
 * the foreignObject — every following section shifted up over it.
 * @param {Element} el
 */
function hasFlowFast(el) {
  // Only direct text nodes belong to this element's flow.
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true
  }
  const f = el.firstElementChild, l = el.lastElementChild
  if ((f && f.tagName === 'BR') || (l && l.tagName === 'BR')) return true

  // An element child contributes flow content only when it is itself in flow. getStyle
  // memoizes per node, and this runs only after the cheap text/<br> paths miss.
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    const s = getStyle(c)
    if (s.display === 'none') continue
    const pos = s.position
    if (pos !== 'absolute' && pos !== 'fixed') return true
  }
  return false
}

/**
 * Height this block would take with `height: auto`, measured from the live layout — or NaN
 * when nothing in flow could be measured.
 *
 * Only called once every other guard in stripHeightForWrappers has passed, so the element is
 * a plain block box with no vertical padding/border and `overflow: visible`: its content-box
 * top coincides with its border-box top, and the top/bottom margins of its first/last in-flow
 * children collapse straight through it. The auto height is therefore the distance from the
 * element's own top edge down to the lowest bottom edge among its in-flow contents.
 *
 * Out-of-flow (absolute/fixed) and floated children are skipped: neither contributes to the
 * auto height of a visible-overflow block. Direct text nodes are measured with a Range, which
 * reports real line boxes without touching the DOM.
 *
 * @param {Element} el
 * @returns {number}
 */
function autoContentHeight(el) {
  const top = el.getBoundingClientRect().top
  let bottom = -Infinity
  let range = null
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      if (!/\S/.test(n.nodeValue || '')) continue
      range = range || document.createRange()
      range.selectNode(n)
      const r = range.getBoundingClientRect()
      if (r.width || r.height) bottom = Math.max(bottom, r.bottom)
      continue
    }
    if (n.nodeType !== 1) continue
    const s = getStyle(n)
    if (s.display === 'none') continue
    const pos = s.position
    if (pos === 'absolute' || pos === 'fixed') continue
    if (s.float && s.float !== 'none') continue
    bottom = Math.max(bottom, n.getBoundingClientRect().bottom)
  }
  return bottom === -Infinity ? NaN : bottom - top
}

/**
 * Best-effort: drop height/block-size on transparent flow wrappers so margin collapsing
 * still works, without breaking KaTeX, Orbit, or layouts with an explicit height.
 * Pinned by __tests__/module.styles.stripHeightForWrappers.test.js, stylesheet-height and
 * abspos-wrapper.
 *
 * @param {Element} el
 * @param {CSSStyleDeclaration} cs
 * @param {Record<string, any>} snap
 */
function stripHeightForWrappers(el, cs, snap) {
  // 1) Respect an author inline height
  if (isHTMLEl(el) && el.style && el.style.height) return

  // 2) Only div/section/article/main/aside/header/footer/nav (no ol/ul/li: list layout)
  const tag = el.tagName && el.tagName.toLowerCase()
  const ALLOWED_TAGS = ['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav']
  if (!tag || !ALLOWED_TAGS.includes(tag)) return

  // 2c) aspect-ratio derives the height from the width; keep it
  if (cs.aspectRatio && cs.aspectRatio !== 'none' && cs.aspectRatio !== 'auto') return

  // 3) Orbit: leave the height alone when the element is a flex/grid container
  const disp = cs.display || ''
  if (disp.includes('flex') || disp.includes('grid')) return

  // 4) Positioned, transformed, painted, or a flex/grid item: leave it
  //
  // (The replaced-element guard lived here and was removed: it is unreachable.
  // The allow-list in (2) only admits div/section/article/main/aside/header/footer/nav,
  // and none of those can be an img/canvas/video/iframe/svg/object/embed: the check was
  // false by construction, not by luck.)

  const pos = cs.position
  if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') return
  if (cs.transform !== 'none') return
  if (hasBox(cs)) return
  if (isFlexOrGridItem(el)) return

  // 5) Leave hiding / accessibility wrappers alone (KaTeX, screen-reader hacks, and so on)
  const overflowX = cs.overflowX || cs.overflow || 'visible'
  const overflowY = cs.overflowY || cs.overflow || 'visible'
  if (overflowX !== 'visible' || overflowY !== 'visible') return

  const clip = cs.clip
  if (clip && clip !== 'auto' && clip !== 'rect(auto, auto, auto, auto)') return

  if (cs.visibility === 'hidden' || cs.opacity === '0') return

  // 6) Only wrappers with in-flow content of their own
  if (!hasFlowFast(el)) return

  // 6b) Last filter: only drop the height when the used height is what the element would
  // have with `height: auto`. If it differs, the author set it, wherever it came from
  // (stylesheet, <style>, CSSOM, inline attribute), and it has to be respected.
  //
  // This check used to read `el.scrollHeight`, which CANNOT answer that question:
  // scrollHeight returns the padding-box height when the content is shorter than the box,
  // so a `height: 400px` around one line of text gives scrollHeight === 400 === used
  // height, a difference of 0, and the height was dropped. It only caught fixed heights
  // SMALLER than the content (the rare case), never the usual one: the child collapsed to
  // its content height and the rest of the canvas came out blank.
  //
  // Deliberately last: by this point we know there is no vertical padding/border and no
  // overflow (hasBox), which is what makes the autoContentHeight measurement valid, and
  // only the few nodes that clear every guard pay for measuring.
  const usedH = parseFloat(cs.height)
  const autoH = autoContentHeight(el)
  const TOL = 2
  if (Number.isFinite(usedH) && Number.isFinite(autoH) && Math.abs(usedH - autoH) > TOL) return

  // 7) Now drop height and block-size from the snapshot
  delete snap.height
  delete snap['block-size']
}
