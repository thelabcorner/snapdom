/**
 * Option normalization. `createContext` turns the caller's option bag into the one context
 * object every stage and every plugin hook reads. Defaults, aliases and the compiled exclusion
 * policy are decided here and nowhere else, so a new option is added here first.
 * @module context
 */

/**
 * @typedef {"soft"|"disabled"} CachePolicy
 * 'soft' is the structural default; the legacy 'auto' and 'full' strings map to it.
 */

import { normalizeCachePolicy } from './cache.js'
import { compileIconFontMatchers } from '../modules/iconFonts.js'
import { isTag } from '../utils/helpers.js'

/** Formats a caller can name in `format` (or legacy `type`). Shared with the export
 *  normalizer in snapdom.js — the same set decides the alias there. */
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'jpg', 'webp', 'svg'])

/**
 * Build the normalized capture context from the caller's options.
 *
 * Every field below has a default, so downstream code never tests for undefined. Options
 * marked internal are read by tests and benchmarks and are not public API.
 * @param {Object} [options={}]
 * @param {boolean} [options.debug=false]
 * @param {number}  [options.scale=1]
 * @param {string|((el: Element) => boolean)|Array<string|((el: Element) => boolean)>} [options.exclude] - Selectors and/or predicates (true = exclude), evaluated before filter
 * @param {'hide'|'remove'} [options.excludeMode='hide'] - 'hide' leaves a spacer of the node's box, 'remove' drops it
 * @param {(el: Element) => boolean} [options.filter] - Independent keep predicate: truthy keeps, falsy omits
 * @param {'hide'|'remove'} [options.filterMode='hide'] - How nodes rejected only by filter leave
 * @param {boolean|'auto'} [options.embedFonts='auto'] - 'auto' embeds only webfonts the element uses
 * @param {string|string[]} [options.iconFonts] - extra families treated as icon fonts (never embedded)
 * @param {string[]} [options.localFonts]
 * @param {string[]|undefined} [options.excludeFonts]
 * @param {string[]} [options.fontStylesheetDomains] - extra domains to fetch cross-origin CSS from (#309)
 * @param {string|function} [options.fallbackURL]
 * @param {string}  [options.useProxy]
 * @param {number|null} [options.width]
 * @param {number|null} [options.height]
 * @param {"png"|"jpg"|"jpeg"|"webp"|"svg"} [options.format='png'] - 'jpg' resolves to 'jpeg'
 * @param {"png"|"jpg"|"jpeg"|"webp"|"svg"} [options.type] - deprecated alias for format
 * @param {number}  [options.quality=0.92]
 * @param {number}  [options.dpr=devicePixelRatio]
 * @param {string|null} [options.backgroundColor] - defaults to white for jpeg and webp exports
 * @param {string}  [options.filename='snapDOM']
 * @param {unknown} [options.cache] - `'disabled'` (or `false`) empties every persistent cache before the capture, a debug/test escape hatch. Anything else is the default: caching is structural, not a knob (the legacy 'soft'/'auto'/'full' strings all mean this).
 * @param {HTMLCanvasElement} [options.canvas] - Draw the canvas export into this canvas instead of a new one
 * @param {boolean} [options.captureSelection=false] - Render the user's live text selection into the capture
 * @param {boolean} [options.placeholders=true] - cross-origin iframes get a striped placeholder; false gives an invisible spacer
 * @param {boolean} [options.outerTransforms=true]
 * @param {boolean|'subtree'} [options.outerShadows=false]
 * @param {boolean} [options.reconcile=false] - measure the clone in-document and pin diverging boxes
 * @param {boolean} [options.burst] - force the memo on or off; unset memoizes from the first capture (burst.js)
 * @param {'html-in-canvas'} [options.engine] - experimental: the canvas-place-element engine (engines/htmlInCanvas.js)
 * @param {boolean} [options.invalidate=false] - one fresh capture plus style-cache invalidation for changes with no browser signal (notably CSSOM edits)
 * @param {"viewport"|{x:number,y:number,width:number,height:number}|null} [options.clip] - Capture only a region: 'viewport' (what the user currently sees) or a page-coordinate rect. Offscreen subtrees are pruned before styling/inlining, so this is faster than a full capture.
 * @param {RegExp|((prop: string) => boolean)} [options.excludeStyleProps] - Skip props when snapshotting (#348). e.g. /^--/ to exclude CSS vars
 * @param {boolean} [options.compress=true] - Downsample inlined raster images to their visible resolution (display box × scale × dpr), preserving the source codec. `false` is internal, for benchmarks that measure the uncompressed pipeline.
 * @param {boolean} [options.resolvePicturePlaceholders=true] - v2 compat, undocumented in v3
 * @returns {Object} the context; also carries the compiled `shouldExclude` and the internal `__iconMatchers`, `__explicitFormat`, `__styleShare`
 */
export function createContext(options = {}) {
  const rawTypeFormat = typeof options.type === 'string' && IMAGE_FORMATS.has(options.type.toLowerCase())
    ? options.type.toLowerCase()
    : null
  let resolvedFormat = options.format ?? rawTypeFormat ?? 'png'
  if (resolvedFormat === 'jpg') resolvedFormat = 'jpeg'
  // Did the CALLER name a format, or is this the default? `format` is always set, so the
  // difference is otherwise unrecoverable downstream — and toBlob needs it: it defaults to
  // the raw vector unless a codec was asked for, and `snapdom.toBlob(el, {format:'png'})`
  // asks at CAPTURE time (the static helpers forward options there, not to the exporter).
  const explicitFormat = options.format != null ? resolvedFormat : (rawTypeFormat === 'jpg' ? 'jpeg' : rawTypeFormat)
  /** @type {CachePolicy} */
  const cachePolicy = normalizeCachePolicy(options.cache)

  // Exclude and filter are independent policies with independent layout modes. Exclude
  // wins when both match: the clone stops at the first omission, as it did in v2.
  // Split exclude selectors/predicates once so the per-node loop need not dispatch types.
  const excludeRaw = options.exclude == null ? [] : (Array.isArray(options.exclude) ? options.exclude : [options.exclude])
  const excludeSelectors = []
  const excludePredicates = []
  for (const e of excludeRaw) {
    if (typeof e === 'string') excludeSelectors.push(e)
    else if (typeof e === 'function') excludePredicates.push(e)
    else if (e != null) console.warn('[snapdom] Ignored invalid exclude entry (expected selector string or predicate):', e)
  }
  const excludeMode = options.excludeMode ?? 'hide'

  // Semantic exporters must omit anything either policy hides/removes from the image.
  // Read the context at call time so beforeSnap changes use the same policy as deepClone.
  const shouldExclude = (el) => {
    if (!el || el.nodeType !== 1) return false
    if (el.getAttribute('data-capture') === 'exclude') return true
    for (const sel of Array.isArray(context.exclude) ? context.exclude : []) {
      try { if (el.matches(sel)) return true } catch { /* invalid selector: deepClone warns */ }
    }
    for (const pred of Array.isArray(context.excludePredicates) ? context.excludePredicates : []) {
      try { if (pred(el)) return true } catch { /* deepClone warns */ }
    }
    if (typeof context.filter === 'function') {
      try { if (!context.filter(el)) return true } catch { /* deepClone warns */ }
    }
    return false
  }

  const context = {
    // Debug & perf
    debug: options.debug ?? false,
    scale: options.scale ?? 1,

    // Independent omission policies; exclusion takes precedence over filter.
    exclude: excludeSelectors,
    excludePredicates: excludePredicates.length ? excludePredicates : null,
    excludeMode,
    filter: options.filter ?? null,
    filterMode: options.filterMode ?? 'hide',
    /** @type {(el: Element) => boolean} true when the capture drops or blanks this node. */
    shouldExclude,

    // Placeholders
    placeholders: options.placeholders !== false, // default true

    // Render the user's live text selection into the capture: selected runs of text are
    // wrapped in the styles the browser paints them with (authored ::selection where a rule
    // matches, the UA highlight colour where none does). Opt-in — a screenshot taken while
    // the user happens to have text selected should look selected only when asked.
    captureSelection: options.captureSelection ?? false,

    // Canvas exporter target. A caller looping captures (a live mirror) otherwise pays a
    // full-canvas copy per frame moving the pixels off a throwaway canvas onto its own.
    // Anything that is not a canvas is ignored, so the exporter always has one to draw into.
    // isTag, not instanceof: a canvas from an iframe document belongs to that window's
    // HTMLCanvasElement (#494). Pinned by `__tests__/core.context.test.js`.
    canvas: isTag(options.canvas, 'canvas') ? options.canvas : null,

    // Fonts
    // 'auto' (default): embed webfonts only when the element actually uses families the
    // document declares — svg-as-image is an isolated document that can't see page fonts,
    // so skipping the embed on webfont text is silent infidelity; system-font pages skip
    // the whole phase at zero cost. true/false remain explicit overrides.
    embedFonts: options.embedFonts ?? 'auto',
    iconFonts: Array.isArray(options.iconFonts) ? options.iconFonts
      : (options.iconFonts ? [options.iconFonts] : []),
    // Compiled here, once, and passed explicitly to every isIconFont call: this used to be
    // a module-level array each capture overwrote, so concurrent captures with different
    // lists read each other's matchers.
    __iconMatchers: compileIconFontMatchers(options.iconFonts),
    localFonts: Array.isArray(options.localFonts) ? options.localFonts : [],
    excludeFonts: options.excludeFonts ?? undefined,
    fontStylesheetDomains: Array.isArray(options.fontStylesheetDomains) ? options.fontStylesheetDomains : [],
    fallbackURL: options.fallbackURL ?? undefined,

    /** @type {CachePolicy} */
    cache: cachePolicy,
    // Internal: identity-share override (undefined = decide per capture in captureDOM).
    __styleShare: options.__styleShare,
    // Internal focus-partition counterfactual: false restores the historical behavior where a
    // relevant matching focus-state selector vetoes structural sharing for the whole capture.
    __styleShareFocusPartition: options.__styleShareFocusPartition,
    // Internal test/benchmark control: false keeps the historical document-level property
    // universe while leaving the DOM, CSS and every other capture option unchanged.
    __elementUniverse: options.__elementUniverse,
    // Internal R4 counterfactual: false preserves every data-* attribute in the style-share
    // identity while leaving R2 sharing, R3 narrowing, DOM/CSS and rendering untouched.
    __styleIdentityDataAttrs: options.__styleIdentityDataAttrs,
    // Internal R5-D counterfactual/benchmark override: false forces R3's historical linear
    // rule scan; true forces the compiled subject-key index; undefined uses the tiered router.
    __elementRuleIndex: options.__elementRuleIndex,
    // Internal R5-D3 counterfactual: false collapses exact data-* value keys back to the D2
    // attribute-name condition while preserving the same selector scan and capture semantics.
    __elementRuleAttrValueIndex: options.__elementRuleAttrValueIndex,
    // Internal R5-D4 counterfactual: false preserves D3's fixed bucket-key priority. The default
    // lets index compilation choose the least-populated necessary subject key; the full selector
    // is still checked by matches(), so only candidate dispatch changes.
    __elementRuleKeySelectivity: options.__elementRuleKeySelectivity,
    // Internal R5-D5 counterfactual: false limits D4 planning to its exact-attribute alternative.
    // Default behavior also considers additional direct class/ID conditions in the subject
    // compound while preserving browser matches() as the final semantic oracle.
    __elementRuleCompoundKeyPlanner: options.__elementRuleCompoundKeyPlanner,
    // Internal R5-D6 control: false preserves one R3 interpreter entry per CSS rule; true forces
    // exact-selector CSE; undefined uses the cheap production repetition scout. CSE runs only
    // after candidate indexing/planning and unions declared property names for byte-identical
    // selector strings. Browser matches() remains the semantic oracle.
    __elementRuleSelectorCSE: options.__elementRuleSelectorCSE,
    // Internal R5-SM2 counterfactual: production gates Typed-OM auto-margin restoration on a
    // conservative stylesheet/inline/UA dependency proof. False forces the historical
    // per-node probe for differential tests/benchmarks.
    __autoMarginProbeGate: options.__autoMarginProbeGate,
    // Internal R8-D1 counterfactual: the document-level half of the SM2 auto-margin proof
    // (author margin values that can compute to `auto`, running animations) is invariant per
    // capture and may be cached on the session instead of re-read per node. False restores the
    // historical per-node document scan for differential tests/benchmarks.
    __autoMarginDocProofCache: options.__autoMarginDocProofCache,
    __contentVisibilityStyleSeed: options.__contentVisibilityStyleSeed,
    __lineClampStyleSeed: options.__lineClampStyleSeed,
    // Internal R7-LCG1 counterfactual. Production skips the live truncation walk only when the
    // complete document scan plus an immediate subtree inline/shadow census proves that neither
    // line-clamp nor text-overflow can apply. False restores the unconditional historical pass.
    __lineClampPassGate: options.__lineClampPassGate,
    __parentStyleReuse: options.__parentStyleReuse,
    __backdropStyleReuse: options.__backdropStyleReuse,
    __pseudoHostStyleReuse: options.__pseudoHostStyleReuse,
    // Internal R7-PQU1 counterfactual: production admits UA <q> before/after pseudos with a
    // local tag-name check and leaves browser matches() to author selectors only. False
    // reconstructs the historical `authorGate,q` selector for same-build causal probes.
    __pseudoUAQuoteGate: options.__pseudoUAQuoteGate,
    // Internal R7-ANIMR1 counterfactual. Share-safe structural twins reuse the first identity
    // occurrence's computed animation-name rider; false restores one live read per element.
    __animationNameShare: options.__animationNameShare,
    // Internal R7-TXT2 research arm. On a conservative neutral-tag class, synthesize the six
    // default text-decoration fallback values from the already-captured color instead of six
    // named CSSOM reads. Default remains historical until exact parity is fully certified.
    __snapshotDecorationSynthesis: options.__snapshotDecorationSynthesis,
    // Internal R7-OFF1 counterfactual. Production re-reads shared-snapshot offsets only when
    // stylesheet/inline evidence can make their used value geometry-dependent. False restores
    // the historical unconditional top/right/bottom/left/inset-* rider set.
    __styleShareInsetValueGate: options.__styleShareInsetValueGate,
    // Internal R8-P1 counterfactuals. Repeated pseudo identities can switch from full snapshot
    // spreads to copy-on-write overlays and reuse generated style keys by compact signature, but
    // only after repetition is proven. False restores either historical leg independently.
    __styleSharePseudoOverlay: options.__styleSharePseudoOverlay,
    __styleSharePseudoKeyCache: options.__styleSharePseudoKeyCache,
    // Internal R7-SO1 counterfactual: default/true stores identity twins as a tiny
    // own-property overlay whose prototype is the immutable shared snapshot; false forces the
    // historical full object spread for byte/timing counterfactuals.
    __styleShareSnapshotOverlay: options.__styleShareSnapshotOverlay,
    // Internal R7-GR1 counterfactual. Reuse exact gutter inputs already present in this node's
    // style snapshot; false restores the historical duplicate live CSSOM reads.
    __gutterSnapshotReuse: options.__gutterSnapshotReuse,
    // Internal R7-MW1 counterfactual. `min-width` is mandatory in the element snapshot universe;
    // flex/grid correction may reuse that exact same-capture value when present. False restores
    // the historical duplicate live read, and excluded/missing snapshots always fall back.
    __minWidthSnapshotReuse: options.__minWidthSnapshotReuse,
    // Internal R7-BGS1 counterfactual. The late background pass first probes source longhands;
    // if none can carry an image it skips the otherwise-inert URL shorthand/alias loop. False
    // restores the historical unconditional URL_PROPS walk.
    __backgroundUrlSentinel: options.__backgroundUrlSentinel,
    // Internal R7-BGS2 counterfactual. Production narrows BGS1's late source sentinel to the
    // source properties this engine can actually expose (plus compatibility aliases proven by
    // the engine family). False restores BGS1's complete seven-source probe set.
    __backgroundSourceBasis: options.__backgroundSourceBasis,
    // Internal R7-BGSNAP1 counterfactual. Background inlining may retain a same-capture style
    // snapshot across font-only environment epochs when its source/style stamp is unchanged and
    // no relevant declaration can depend on font metrics. False restores full-env invalidation.
    __backgroundFontEpochReuse: options.__backgroundFontEpochReuse,
    // Internal R7-MASKLAY1 research arm. Explicit true gates mask-layout copying on the late
    // source sentinel plus snapshot representation proof. Default remains historical because
    // the hardened mechanism produced no standing browser-call reduction.
    __maskLayoutSourceGate: options.__maskLayoutSourceGate,
    // Internal R7-MASKDEF1 counterfactual. In the font-relaxed BGSNAP1 overlay path, when the
    // complete scan proves the document and node have no mask channel, per-tag initial mask
    // layout values are captured once and reused instead of live-read per node. False restores
    // the historical per-node live reads.
    __maskLayoutInitialDefaults: options.__maskLayoutInitialDefaults,
    // Internal R7-BGSTATE1 counterfactual. Unique neutral HTML elements can skip the roughly
    // ten-read background/mask/border-image admission probe only when the complete author scan
    // and this node's inline/shadow state prove none of those non-inherited families can apply.
    // False restores the historical probe unconditionally.
    __backgroundStateProbeGate: options.__backgroundStateProbeGate,
    __svgDefsStyleReuse: options.__svgDefsStyleReuse,
    __imageStyleReuse: options.__imageStyleReuse,
    __svgPaintStyleReuse: options.__svgPaintStyleReuse,
    // Internal R7-BRST1 counterfactual. Production derives the burst scroll-watch set from
    // exact overflow semantics already observed during capture, avoiding whole-tree
    // scrollWidth/clientWidth/scrollHeight/clientHeight discovery. False restores the
    // historical geometry census for deterministic A/B probes.
    __burstSemanticScrollTracking: options.__burstSemanticScrollTracking,
    // Internal R7-BRST2 counterfactual for clone scroll-compensation admission.
    __wrapScrolledSemanticGate: options.__wrapScrolledSemanticGate,
    // Internal R7-BRST3 counterfactual: first-capture scroll baseline comes from the exact
    // source observations made while cloning instead of a broad pre-capture offset scan.
    __burstCaptureScrollBaseline: options.__burstCaptureScrollBaseline,
    // Internal R7-BSAFE1 counterfactual. Production lets an already-established burst state
    // enter the transactional validator without re-running the expensive per-node frame-source
    // classifier up front. The validator still performs one structural shadow-root census on
    // every hit, and re-runs the complete historical classifier after any observed mutation or
    // newly attached open shadow root. False restores the historical API-entry full scan.
    __burstRetainedSafetyFastPath: options.__burstRetainedSafetyFastPath,
    // Internal R7-BSAFE2 counterfactual. A clean established memo may inspect the retained
    // element census for newly attached open shadow roots instead of issuing a fresh whole-tree
    // selector query. Dirty state or a newly found root falls back to the full BSAFE1 census.
    __burstRetainedShadowProbe: options.__burstRetainedShadowProbe,
    // Internal R5 composition control. `true` forces R3's per-element property universe on
    // every first-seen R2/R4 identity, `false` pins the historical R2-only counterfactual,
    // and `undefined` uses the adaptive production router. Identity hits still reuse the
    // stored snapshot and re-read the existing used-value list.
    __styleShareElementUniverse: options.__styleShareElementUniverse,
    // Internal R5 tuning knob for the adaptive composition router. Production behavior uses
    // the module default; tests/benchmarks can move the first-seen-identity crossover without
    // source edits. A value of N means the first N DISTINCT share misses stay on pure R2 and
    // only later misses may use R3. Identity hits do not advance the counter.
    __styleShareElementUniverseMinMisses: options.__styleShareElementUniverseMinMisses,

    // Network
    useProxy: typeof options.useProxy === 'string' ? options.useProxy : '',

    // Output
    width: options.width ?? null,
    height: options.height ?? null,
    format: resolvedFormat,
    __explicitFormat: explicitFormat,
    // `format` is canonical; expose the deprecated alias with the same normalized value so
    // plugin hooks never receive a contradictory { format, type } pair.
    type: resolvedFormat,
    quality: options.quality ?? 0.92,
    dpr: options.dpr ?? (window.devicePixelRatio || 1),
    backgroundColor:
      options.backgroundColor ?? (['jpeg', 'webp'].includes(resolvedFormat) ? '#ffffff' : null),
    filename: options.filename ?? 'snapDOM',

    // Root transform / shadow handling
    outerTransforms: options.outerTransforms ?? true,
    outerShadows: options.outerShadows ?? false,

    // Layout reconciliation: measure the styled clone in-document and pin diverging boxes
    // to their live size. Opt-in (adds one in-document layout of the clone).
    reconcile: options.reconcile ?? false,

    // Burst memoization is default engine behavior (engages from the first capture, see
    // src/core/burst.js). true/false remain INTERNAL-ONLY escapes (tests/benchmarks need
    // deterministic full-pipeline runs), not public API.
    burst: options.burst,

    // EXPERIMENTAL: 'html-in-canvas' opts into the WICG canvas-place-element engine when the browser
    // supports it (see src/engines/htmlInCanvas.js); anything else uses the svg pipeline.
    engine: options.engine,
    // Forces one fresh capture and clears lower style caches — for application
    // changes with no browser signal, notably programmatic CSSOM edits. Frame sources bypass.
    invalidate: options.invalidate ?? false,

    // Internal: the nested capture rasterizeIframe takes of a frame's documentElement, pinned
    // to the frame's viewport (utils/clone.helpers.js). The svg engine reads it instead of
    // expanding a root capture to scrollHeight; never public.
    __pinned: options.__pinned === true,

    // Region capture: 'viewport' or {x,y,width,height} in page coordinates
    clip: options.clip ?? null,

    // Perceptual image downsampling — always-on engine behavior (fidelity-neutral: codecs
    // preserved, output adopted only when smaller). `compress: false` is INTERNAL-ONLY
    // (benchmarks/tests measuring the uncompressed pipeline), not public API.
    compress: options.compress !== false,

    // #348: exclude style props from snapshot (reduces cost when :root has thousands of CSS vars)
    excludeStyleProps: options.excludeStyleProps ?? null,

    // Lazy <picture>/data-src placeholders resolve on the CLONE (freezeImgSrcset).
    // Accepted for v2 compat, undocumented in v3 (the engine just does the right thing).
    resolvePicturePlaceholders: options.resolvePicturePlaceholders !== false,

    // Plugins (reservado)
    // plugins: normalizePlugins(...),
  }
  return context
}
