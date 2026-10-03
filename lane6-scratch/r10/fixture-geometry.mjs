// R10-ANIM1 hosted fixture geometry — SINGLE SOURCE OF TRUTH.
//
// d919614 and the first v2 fix both shipped fixtures whose role and whose DOM disagreed: the
// `descendant-of-root` fixture animated a node appended to the capture root AFTER the corpus, so the
// queried rows were that node's SIBLINGS, not its descendants. v2 released them — correctly — and the
// fixture's "saved === 0" contract rejected a correct implementation.
//
// The fix is structural rather than editorial: the tree lives HERE, as an explicit parent-edge plan,
// and both consumers read it.
//
//   probe-r10-anim-scope.mjs     injects the plan into the page and builds the real DOM from it
//   check-r10-fixture-contract.mjs  builds a mock DOM from it and holds every role against the
//                                    independent spec oracle, with no browser at all
//
// If a role and its geometry ever disagree again, the contract check fails before any runner spends
// a minute on it.
//
// CHANNEL TAXONOMY — why not every falsifier may be gated on saved === 0
// ------------------------------------------------------------------------
// The element universe blocks on POSITION (is this node at or below an animated node). That is
// coarser than the spec requires, and for some fixtures it is coarser on purpose:
//
//   inherited     the animated property inherits, so descendants' computed values really do move.
//                 Blocking is MANDATORY. Admissible as a zero-savings falsifier.
//   unresolvable  an animation already present in the DOCUMENT animation list has no usable
//                 element target (or is rooted outside that document). If reachable, the lane must fail closed.
//   scannerBlind  a shadow-tree animation is intentionally OUTSIDE document.getAnimations(); it is a boundary
//                 canary for the scanner, not an ANIM1 falsifier. Historical/candidate must remain identical.
//   nonInherited  the animated property does not inherit, so the spec permits releasing the
//                 descendants even though this lane blocks them by position. A tighter
//                 implementation would be RIGHT to release. NOT admissible as a contract: it would
//                 convert a legitimate future improvement into a red build.
//
// Anything on the nonInherited channel is therefore reported but NOT gated. This is the general form
// of the coordinator's second point about anim-self-60, which animated `opacity` on the capture root:
// root opacity changes no descendant's computed style, so demanding saved === 0 there was demanding
// conservatism, not correctness. It now animates `color`, and paddingLeft (nonInherited) is demoted
// to a reported-only conservative fixture.

export const BASE_CSS = '.row{display:block;padding:2px;color:#334155}'

export const CHANNELS = new Set(['inherited', 'unresolvable', 'scannerBlind', 'nonInherited', 'none'])

/** Rows are the queried corpus in every fixture. They are what the counters actually measure. */
function rowNames(nodes) {
  return Array.from({ length: nodes }, (_, i) => 'n' + i)
}

/**
 * Explicit parent-edge plan for one fixture. Emitted in dependency order, so a consumer can build the
 * DOM in a single forward pass.
 *
 * Shape for the ordinary case:
 *   #document > html > body > host > root > n0..n{n-1}
 * `host` is the capture root's parent and lives OUTSIDE the capture, which is what makes the sibling
 * geometry possible.
 *
 * @param {object} fx
 * @returns {{edges: Array<[string,string|null]>, target: string|null, queried: string[], shadowInner: string|null, docElement: string}}
 */
export function fixturePlan(fx) {
  const edges = [
    ['html', null],
    ['body', 'html'],
    ['host', 'body'],
    ['root', 'host'],
  ]
  const rows = rowNames(fx.nodes)
  let target = null
  let shadowInner = null

  switch (fx.where) {
    case 'sibling': {
      // A sibling of the capture root, in a DISJOINT subtree. Nothing inside the capture is at or
      // below it, so every queried row is genuinely released. This is the opportunity.
      edges.push(['anim', 'host'])
      target = 'anim'
      for (const name of rows) edges.push([name, 'root'])
      break
    }
    case 'ancestor': {
      // The capture root's own parent. Every queried row is strictly below it.
      target = 'host'
      for (const name of rows) edges.push([name, 'root'])
      break
    }
    case 'intermediateAncestor': {
      // A descendant of the capture root that CONTAINS the whole corpus. The rows must be MOVED
      // under it, not appended beside it — that is the bug this shape exists to prevent. Rows end up
      // strictly below an animated node, so zero release is genuinely required.
      edges.push(['wrap', 'root'])
      for (const name of rows) edges.push([name, 'wrap'])
      target = 'wrap'
      break
    }
    case 'self': {
      target = 'root'
      for (const name of rows) edges.push([name, 'root'])
      break
    }
    case 'subtree': {
      // An animated node at the far end of the corpus. It moves itself and its descendants, never a
      // SIBLING, so every other row is released: a partial release, and the truncation prepass still
      // blocks because the target is inside the captured subtree.
      for (const name of rows) edges.push([name, 'root'])
      target = rows[rows.length - 1]
      break
    }
    case 'shadow': {
      // ShadowRoot has its own getAnimations() scope. The document scanner does not enumerate this
      // animation at all, so this fixture is a scanner-boundary canary rather than an ANIM1 target.
      edges.push(['shadowHost', 'root'])
      for (const name of rows) edges.push([name, 'root'])
      shadowInner = 'animInner'
      target = shadowInner
      break
    }
    case 'none': {
      for (const name of rows) edges.push([name, 'root'])
      break
    }
    default:
      throw new Error('unknown fixture geometry: ' + fx.where)
  }
  return { edges, target, queried: rows, shadowInner, docElement: 'html' }
}

export const FIXTURES = [
  // ---- OPPORTUNITY: no queried row is at or below the animated node ----
  { name: 'anim-sibling-60', nodes: 60, where: 'sibling', channel: 'nonInherited', role: 'opportunity', keys: [{ opacity: '0.2' }, { opacity: '0.9' }] },
  { name: 'anim-sibling-entropy-120', nodes: 120, where: 'sibling', channel: 'nonInherited', role: 'opportunity', keys: [{ transform: 'translateX(0px)' }, { transform: 'translateX(40px)' }] },
  { name: 'anim-sibling-inherited-60', nodes: 60, where: 'sibling', channel: 'inherited', role: 'opportunity', keys: [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }] },
  { name: 'anim-subtree-partial-60', nodes: 60, where: 'subtree', channel: 'nonInherited', role: 'partial', keys: [{ opacity: '0.4' }, { opacity: '1' }] },

  // ---- FALSIFIERS: every queried row is at or below the animated node, on a channel where
  //      blocking is MANDATORY rather than merely conservative ----
  { name: 'anim-ancestor-60', nodes: 60, where: 'ancestor', channel: 'inherited', role: 'falsifier', keys: [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }] },
  {
    name: 'anim-ancestor-customprop-60', nodes: 60, where: 'ancestor', channel: 'inherited', role: 'falsifier',
    keys: [{ '--tone': 'rgb(1,2,3)' }, { '--tone': 'rgb(200,10,10)' }],
    extraCss: '@property --tone{syntax:"<color>";inherits:true;initial-value:#000}.row{color:var(--tone)}',
  },
  { name: 'anim-intermediate-ancestor-60', nodes: 60, where: 'intermediateAncestor', channel: 'inherited', role: 'falsifier', keys: [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }] },
  // `color` on the capture root, NOT `opacity`: root opacity changes no descendant's computed style,
  // so a saved reading here would have been a legitimate release rather than a regression.
  { name: 'anim-self-60', nodes: 60, where: 'self', channel: 'inherited', role: 'falsifier', keys: [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }] },
  {
    name: 'anim-shadow-60', nodes: 60, where: 'shadow', channel: 'scannerBlind', role: 'scannerBlind',
    keys: [{ opacity: '0.2' }, { opacity: '0.9' }],
    note: 'Document.getAnimations() and ShadowRoot.getAnimations() are separate scopes. ANIM1 is document-scoped; this canary must remain a zero-delta non-participant until shadow scanning is deliberately expanded.',
  },

  // ---- CONSERVATIVE: blocked by this lane's position test, but the spec permits a release.
  //      Reported for visibility; NOT gated, so a tighter future lane is not turned into a red build.
  {
    name: 'anim-ancestor-noninherited-60', nodes: 60, where: 'ancestor', channel: 'nonInherited', role: 'conservative',
    keys: [{ paddingLeft: '0px' }, { paddingLeft: '24px' }],
    note: "paddingLeft does not inherit, so descendants' computed values are unaffected. This lane blocks anyway because the element universe also reads LAYOUT-derived used values (getComputedStyle width/height resolve to used values), which an ancestor's padding does move. Desirable, not mandatory.",
  },
  {
    name: 'anim-root-opacity-60', nodes: 60, where: 'self', channel: 'nonInherited', role: 'conservative',
    keys: [{ opacity: '0.4' }, { opacity: '1' }],
    note: 'root opacity is non-inherited and compositing-only. Blocking the corpus is pure conservatism by position. Reported, never gated.',
  },

  // ---- CONTROL: no live animation. Guards against cost added to the clean path. ----
  { name: 'anim-none-60', nodes: 60, where: 'none', channel: 'none', role: 'control', keys: null },
]

/** Whether CI may hold a fixture to saved === 0. See the channel taxonomy above. */
export function isGatedFalsifier(fx) {
  return fx.role === 'falsifier'
}