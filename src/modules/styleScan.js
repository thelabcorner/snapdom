/**
 * Stylesheet-driven property universe.
 *
 * A page can only move a computed property away from its UA default through author CSS
 * (rules, inline styles, keyframes) or programmatic animation. Scanning the document's
 * stylesheets once yields the set of properties any rule can touch; the per-node style
 * snapshot then reads ONLY those plus a fixed always-list, instead of enumerating all
 * ~400 computed properties per node — the dominant cost of a capture (measured 8-9x
 * faster reads at 45 props, cross-engine).
 *
 * Correctness: a property outside the universe can't differ from the tag's UA default,
 * so the defaults-diff downstream would have dropped it anyway. Escape hatches:
 * - Any unreadable (cross-origin) stylesheet → null (callers fall back to full reads).
 * - Shadow-root content is snapshotted with full reads (its sheets aren't scanned).
 * - Element inline-style props are unioned in per node at snapshot time.
 * - Web Animations API keyframe props are unioned in (CSS animations come from rules).
 * @module styleScan
 */

/** Properties always read regardless of what the page's CSS mentions: layout and text
 *  essentials, plus everything presentational HTML attributes (width=, bgcolor=, dir=,
 *  align=…) can set without appearing in any stylesheet. Longhands, matching what
 *  computed-style enumeration lists (the defaults cache diffs per longhand). */
export const ALWAYS_PROPS = [
  // box / layout
  'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear', 'z-index',
  'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow-x', 'overflow-y', 'visibility', 'opacity', 'content-visibility', 'vertical-align',
  // border
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  // flex / grid containers and items
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self',
  'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
  // text / font
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'text-align',
  'text-transform', 'text-indent', 'text-overflow', 'text-shadow', 'direction', 'unicode-bidi',
  // These can be inherited from an inline-styled ancestor outside the capture, without
  // any stylesheet declaration for the scanner to find.
  'writing-mode', 'text-orientation',
  'word-break', 'overflow-wrap', 'tab-size',
  'list-style-type', 'list-style-position', 'list-style-image',
  'counter-reset', 'counter-increment', 'counter-set',
  // visual
  'background-color', 'background-image', 'background-size', 'background-position',
  'background-repeat', 'background-clip', 'background-origin', 'background-attachment',
  'box-shadow', 'outline-width', 'outline-style', 'outline-color', 'outline-offset',
  'transform', 'transform-origin', 'rotate', 'scale', 'translate',
  'filter', 'mix-blend-mode', 'clip-path', 'object-fit', 'object-position',
  // tables
  'border-collapse', 'border-spacing', 'table-layout', 'caption-side', 'empty-cells',
]

// What a pseudo-element's snapshot needs to read. A `::before` has no inline style and no
// presentational attributes, so a NON-inherited property can only leave its UA default
// through a rule whose selector names the pseudo (collected per scan as `pseudoProps`);
// an inherited one only through the element, whose own snapshot already reads the universe.
// The box props are the ones getStyleKey and the pseudo pass read back (softening, the
// min-width floor). Deep tree with a ::before per leaf: ~130 reads per pseudo → ~45.
const INHERITED_PROPS = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
  'font-kerning', 'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing',
  'word-spacing', 'white-space', 'text-align', 'text-align-last', 'text-indent', 'text-transform',
  'text-shadow', 'text-rendering', 'direction', 'unicode-bidi', 'word-break', 'overflow-wrap',
  'writing-mode', 'text-orientation',
  'hyphens', 'tab-size', 'visibility', 'list-style-type', 'list-style-position', 'list-style-image',
  'border-collapse', 'border-spacing', 'caption-side', 'empty-cells', 'quotes',
  'color-scheme', '-webkit-text-fill-color', '-webkit-font-smoothing', 'image-rendering',
]
// Not listed although inherited: caret-color (no caret on a pseudo) and the text-stroke pair.
// A stroke set on the ELEMENT reaches the pseudo span by inheritance inside the foreignObject
// (the span is the element clone's child), and one set on the pseudo is in pseudoProps. Read
// by name they made the pseudo's snapshot depend on whether the DOCUMENT universe happened to
// contain them — snapdom's own injected class CSS in a test page did — and two captures of
// the same pseudo keyed differently.
const PSEUDO_BOX_PROPS = ['display', 'width', 'height', 'min-width', 'min-height']
const PSEUDO_ELEMENT_SEL_RE = /::?(?:before|after|first-letter|first-line|marker)/

/** Rule budget for one scan. Past it the scan answers unreliable, and every reader falls
 *  back to full reads. */
const MAX_SCAN_RULES = 20000

/** Margin/padding values that can make two identity twins resolve DIFFERENTLY: their
 *  getComputedStyle value is the USED value (per-cent margins resolve against the parent's
 *  used width — verified identical behavior on chromium/firefox/webkit), so a %-, auto-,
 *  calc()- or var()-valued declaration anywhere in the document forces the identity-share
 *  hit path to keep re-reading that family per node. Fixed lengths (px/em/rem) compute
 *  identically for twins by construction — same matched rules, same inherited inputs. */
const UNSTABLE_LAYOUT_VALUE_RE = /%|\bauto\b|calc\(|var\(/i

/** The pseudo-elements the per-node probe in pseudo.js resolves. The same rule walk that
 *  builds the property universe collects, per kind, the selectors able to generate that
 *  pseudo — so the probe can be gated by one `el.matches()` instead of three
 *  getComputedStyle resolutions per node. */
const PSEUDO_KINDS = {
  before: /::?before\b/, after: /::?after\b/, firstLetter: /::?first-letter\b/,
  // marker/firstLine aren't probed per node — matching elements get a scoped CSS rule
  // (markers re-render natively in the foreignObject; first-line re-fragments there).
  marker: /::marker\b/, firstLine: /::?first-line\b/,
}
const PSEUDO_STRIP = /::?(?:before|after|first-letter|first-line|marker)\b/g

/** Strips pseudo-element tokens from a selector list so it can feed `el.matches()`.
 *  A part that was ONLY the pseudo (`::before {}`) becomes `*` (pseudo-elements are not
 *  allowed inside :is()/:where(), so top-level empty parts are the only ones possible). */
function stripPseudo(selectorText) {
  const s = selectorText.replace(PSEUDO_STRIP, '').trim()
  if (!s) return '*'
  return s.replace(/(^|,)(\s*)(?=,|$)/g, '$1$2*')
}

// R4 style-identity dependency index. Only data-* attributes are relaxed, and only when the
// complete stylesheet scan proves CSS cannot observe them. The scanner below intentionally
// understands CSS escapes instead of treating ANY escaped selector as globally unsafe. That
// distinction matters on utility-CSS pages: Tailwind-style class selectors routinely contain
// backslashes next to ordinary attribute selectors, and the old blanket veto disabled R4 for
// the whole document even when the escaped token was unrelated to data-*.

/** Decode CSS identifier/string escapes sufficiently for dependency names. CSS Syntax allows
 * 1-6 hex digits plus one optional whitespace terminator, or a single escaped code point. We
 * never feed the decoded text back to the browser; it is only used to conservatively recognize
 * names such as `\\64 ata-metric` -> `data-metric`. */
function decodeCssEscapes(text) {
  if (!text || !text.includes('\\')) return text || ''
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== '\\') { out += c; continue }
    if (++i >= text.length) break
    const n = text[i]
    if (/[0-9a-fA-F]/.test(n)) {
      let hex = n
      let count = 1
      while (count < 6 && i + 1 < text.length && /[0-9a-fA-F]/.test(text[i + 1])) {
        hex += text[++i]
        count++
      }
      let cp = parseInt(hex, 16)
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd
      out += String.fromCodePoint(cp)
      if (i + 1 < text.length && /[\t\n\f\r ]/.test(text[i + 1])) {
        if (text[i + 1] === '\r' && text[i + 2] === '\n') i++
        i++
      }
      continue
    }
    // A backslash-newline continuation contributes no code point.
    if (n === '\n' || n === '\f') continue
    if (n === '\r') { if (text[i + 1] === '\n') i++; continue }
    out += n
  }
  return out
}

const CSS_WS_RE = /[\t\n\f\r ]/
const ATTR_FUNCTION_RE = /(?:^|[^-_a-zA-Z0-9])attr\s*\(/i

/** Return the final source index consumed by one CSS escape starting at `i`. CSS hex escapes
 * consume 1-6 hex digits plus one optional whitespace terminator. Keeping this tiny tokenizer
 * primitive shared matters: every selector-scanning fast path must agree on where syntax
 * boundaries actually are or an escaped punctuation character can become a false key. */
function skipCssEscape(text, i) {
  if (++i >= text.length) return i
  if (/[0-9a-fA-F]/.test(text[i])) {
    let count = 1
    while (count < 6 && i + 1 < text.length && /[0-9a-fA-F]/.test(text[i + 1])) { i++; count++ }
    if (i + 1 < text.length && CSS_WS_RE.test(text[i + 1])) {
      if (text[i + 1] === '\r' && text[i + 2] === '\n') i++
      i++
    }
  }
  return i
}

/** Return the closing slash index for a CSS comment starting at `i`. */
function skipCssComment(text, i) {
  if (text[i] !== '/' || text[i + 1] !== '*') return i
  const end = text.indexOf('*/', i + 2)
  return end < 0 ? text.length - 1 : end + 1
}

function mayContainAttrFunction(text) {
  if (!text) return false
  if (ATTR_FUNCTION_RE.test(text)) return true
  return text.includes('\\') && ATTR_FUNCTION_RE.test(decodeCssEscapes(text))
}

/** Collect data-* attribute NAMES from attribute selectors. This walks only unescaped `[` tokens,
 * so escaped brackets in utility class names do not become false selectors. We only parse the
 * leading qualified attribute name; the value/operator is irrelevant to style observability. */
function collectSelectorDataAttrs(selector, state) {
  if (!selector || !selector.includes('[')) return
  const n = selector.length
  let quote = null
  for (let i = 0; i < n;) {
    const c = selector[i]
    if (c === '\\') { i = skipCssEscape(selector, i) + 1; continue }
    if (quote) { if (c === quote) quote = null; i++; continue }
    if (c === '"' || c === "'") { quote = c; i++; continue }
    if (c !== '[') { i++; continue }

    i++
    while (i < n && CSS_WS_RE.test(selector[i])) i++
    let token = ''
    let target = ''
    while (i < n) {
      const x = selector[i]
      if (x === '\\') {
        const start = i
        i = skipCssEscape(selector, i)
        token += selector.slice(start, i + 1)
        i++
        continue
      }
      if (x === '|' && selector[i + 1] !== '=') {
        // Namespace prefix (`ns|data-x`, `*|data-x`, or `|data-x`). Only the local name
        // controls the DOM attribute dependency.
        token = ''
        i++
        while (i < n && CSS_WS_RE.test(selector[i])) i++
        continue
      }
      if (x === ']' || CSS_WS_RE.test(x) || x === '=' ||
          ((x === '~' || x === '|' || x === '^' || x === '$' || x === '*') && selector[i + 1] === '=')) {
        target = token
        break
      }
      token += x
      i++
    }
    if (!target) target = token
    const name = decodeCssEscapes(target).toLowerCase()
    if (name.startsWith('data-')) state.dataAttrDeps.add(name)

    // Skip the rest of this attribute selector, respecting quoted values and escapes, so a
    // literal "[data-x]" inside a value cannot be mistaken for another selector dependency.
    let innerQuote = null
    while (i < n) {
      const x = selector[i]
      if (x === '\\') { i = skipCssEscape(selector, i) + 1; continue }
      if (innerQuote) { if (x === innerQuote) innerQuote = null; i++; continue }
      if (x === '"' || x === "'") { innerQuote = x; i++; continue }
      if (x === ']') { i++; break }
      i++
    }
  }
}

/** Collect the first argument of attr() functions from one declaration value. Decoding first
 * makes escaped function/attribute names visible (`\\61 ttr(\\64 ata-x)`). A malformed attr()
 * that survives CSSOM but cannot yield a name fails closed for R4. */
function collectValueDataAttrs(value, state) {
  if (!value) return
  const decoded = decodeCssEscapes(value)
  const re = /(?:^|[^-_a-zA-Z0-9])attr\s*\(/ig
  while (re.exec(decoded)) {
    let i = re.lastIndex
    while (i < decoded.length && CSS_WS_RE.test(decoded[i])) i++
    const name = (decoded.slice(i).match(/^[-_a-zA-Z][-_a-zA-Z0-9]*/) || [])[0]
    if (!name) {
      state.dataAttrIdentityBlocked = true
      return
    }
    const lowerName = name.toLowerCase()
    if (lowerName.startsWith('data-')) state.dataAttrDeps.add(lowerName)
  }
}

/** Data-* names observed by one inline CSSStyleDeclaration through attr(). Empty means the
 * inline style cannot observe data-*; null means the syntax could not be proven safe and the
 * caller must keep every data-* attribute in its identity. Exported for R4's per-element key:
 * inline declarations are not part of document.styleSheets, so the document scan alone is
 * insufficient proof. */
export function scanInlineStyleDataAttrs(style) {
  if (!style || !style.length) return EMPTY_DATA_ATTRS
  const cssText = style.cssText || ''
  if (!mayContainAttrFunction(cssText)) return EMPTY_DATA_ATTRS
  const state = { dataAttrDeps: new Set(), dataAttrIdentityBlocked: false }
  for (let i = 0; i < style.length; i++) {
    collectValueDataAttrs(style.getPropertyValue(style[i]), state)
    if (state.dataAttrIdentityBlocked) return null
  }
  return state.dataAttrDeps
}

const EMPTY_DATA_ATTRS = new Set()

/** Walks a CSSRuleList adding every set property name to `universe` and every
 *  pseudo-generating selector to `pseudoSels`.
 *  Returns false when an unreadable sheet or the rule budget makes the scan unreliable. */
function scanRules(rules, universe, pseudoSels, state) {
  for (let i = 0; i < rules.length; i++) {
    if (--state.budget < 0) return false
    const rule = rules[i]
    const ruleName = rule.constructor?.name || ''
    // @scope's root/limit selectors live in the at-rule prelude, not selectorText. A data-*
    // dependency there can change which descendant rules apply, so it belongs in R4's style
    // identity dependency set just like an ancestor selector. Scan only the prelude, never the
    // nested rule bodies (those are visited recursively below).
    if (ruleName === 'CSSScopeRule' && typeof rule.cssText === 'string') {
      const brace = rule.cssText.indexOf('{')
      const prelude = brace < 0 ? rule.cssText : rule.cssText.slice(0, brace)
      if (prelude.includes('[')) collectSelectorDataAttrs(prelude, state)
    }
    // A structural fingerprint cannot safely model these document/global channels.
    // Keep the ordinary style universe usable, but force the partitioned share path
    // to fall back to the historical full-read behavior.
    if (ruleName === 'CSSCounterStyleRule' || ruleName === 'CSSScopeRule' ||
        ruleName === 'CSSStartingStyleRule' || ruleName === 'CSSViewTransitionRule') {
      state.sharePartitionBlocked = true
    }
    const style = rule.style
    let hasAll = false
    if (style) {
      const cssText = style.cssText || ''
      const styleMayHaveAttr = mayContainAttrFunction(cssText)
      // CSSOM may expand the `all` shorthand into longhands instead of exposing `all`
      // through style[i]. Detect the authored shorthand explicitly as well. It is tracked
      // per selector below so an unrelated reset rule does not disable narrowing globally.
      try {
        hasAll = !!style.getPropertyValue('all') || /(?:^|;)\s*all\s*:/i.test(cssText)
      } catch {
        state.elementUniverseBlocked = true
      }
      const pseudoRule = !!rule.selectorText && PSEUDO_ELEMENT_SEL_RE.test(rule.selectorText)
      for (let j = 0; j < style.length; j++) {
        const prop = style[j]
        let propValue
        const readValue = () => propValue ??= style.getPropertyValue(prop)
        // attr(data-x) observes the source attribute value even when no selector names it.
        // Only declarations that could contain attr() pay the value scan. Backslashes are
        // included because the function name itself may be escaped.
        if (styleMayHaveAttr) collectValueDataAttrs(readValue(), state)
        universe.add(prop)
        if (pseudoRule) state.pseudoProps.add(prop)
        if (style.getPropertyPriority(prop)) state.importantProps.add(prop)
        if (prop === 'counter-reset' || prop === 'counter-increment' || prop === 'counter-set' ||
            (prop === 'content' && /\bcounters?\s*\(/i.test(readValue()))) {
          state.sharePartitionBlocked = true
        }
        if (prop.length > 5 && (prop[0] === 'm' || prop[0] === 'p')) {
          const fam = prop.startsWith('margin') ? 'marginUnstable'
            : prop.startsWith('padding') ? 'paddingUnstable' : null
          if (fam && !state[fam] && UNSTABLE_LAYOUT_VALUE_RE.test(readValue())) {
            state[fam] = true
          }
        }
      }
    }
    let sel = rule.selectorText
    // Attribute selectors anywhere in the selector, including inside :has(), :is(), :not(),
    // and ancestor compounds, make the named data attribute style-observable.
    if (sel && sel.includes('[')) collectSelectorDataAttrs(sel, state)
    // `:has()` is the one selector whose reach a DOM mutation cannot be walked back from — it
    // restyles ancestors AND, combined with a combinator, their other descendants. A document
    // that uses it keeps document-wide style invalidation (see nodeStamp in styles.js).
    if (sel && sel.includes(':has(')) state.usesHas = true
    // CSS nesting: `& .feat::before` is not a matches()-able selector, and matches()
    // RETURNS FALSE for it instead of throwing — so an unresolved & would silently gate
    // every node out and delete the pseudo. Resolve & against the enclosing style rule,
    // walking past grouping rules (@media/@supports have no selectorText). Hoisted above
    // the share gate, which feeds querySelector and would be silenced the same way.
    if (sel && sel.includes('&')) {
      for (let p = rule.parentRule; p && sel.includes('&'); p = p.parentRule) {
        if (p.selectorText) sel = sel.replace(/&/g, `:is(${p.selectorText})`)
      }
    }
    // Retain one selector -> declared-properties index for the per-element universe.
    // Pseudo-element selectors do not style the host element. Unresolved nesting is kept
    // conservatively as an always-relevant property set rather than trusted by matches().
    if (sel && style && style.length) {
      const props = []
      if (!hasAll) {
        for (let j = 0; j < style.length; j++) {
          const prop = style[j]
          if (prop !== 'all') props.push(prop)
        }
      }
      for (const part of splitTopLevel(sel, ',')) {
        const one = part.trim()
        if (!one || PSEUDO_ELEMENT_SEL_RE.test(one)) continue
        if (hasAll) {
          if (one.includes('&')) state.elementUniverseBlocked = true
          else state.elementAllRules.push({ sel: one, key: subjectKeyOf(one) })
          continue
        }
        if (props.length) {
          for (const prop of props) state.elementDeclaredProps.add(prop)
          if (one.includes('&')) {
            for (const prop of props) state.elementAlwaysProps.add(prop)
          } else {
            const key = subjectKeyOf(one)
            if (key !== null) state.elementKeyedRuleCount++
            state.elementRules.push({ sel: one, key, props })
          }
        }
      }
    }
    // Selectors that can style two elements with IDENTICAL tag + attributes + ancestor chain
    // DIFFERENTLY: structural position, sibling relationships, interaction/UA state, and
    // :has() (content-dependent). Collected, not flagged: whether one of them can split a
    // pair of twins is a question about the CAPTURED SUBTREE at capture time
    // (styleShareSafe in styles.js asks it with one querySelector), not about the document.
    // A document-wide flag turned the fast path off on every real page — `.btn:hover` or
    // `.faq p + p` in the host CSS, matching nothing inside the captured table, cost a 500-row
    // capture 536k computed-style reads instead of 77k. A substring test, deliberately
    // conservative: a false positive only adds a selector to the gate.
    // A rule inside @container styles by the CONTAINER's size, which twins under
    // different-width parents do not share (measured: the narrow twin's colour painted onto
    // the wide one), so every selector in there joins the gate too.
    if (sel && (state.inContainer || SHARE_UNSAFE_RE.test(sel) || sel.includes('+') || sel.includes('~'))) {
      for (const part of splitTopLevel(sel, ',')) {
        const one = part.trim()
        if (one && (state.inContainer || SHARE_UNSAFE_RE.test(one) || one.includes('+') || one.includes('~'))) {
          state.shareUnsafeSels.add(one)
          if (state.inContainer) state.shareContainerSels.add(one)
        }
      }
    }
    if (sel && sel.includes(':')) {
      for (const kind in PSEUDO_KINDS) {
        if (PSEUDO_KINDS[kind].test(sel)) pseudoSels[kind].push(stripPseudo(sel))
      }
    }
    if (rule.styleSheet) { // @import
      if (!scanSheet(rule.styleSheet, universe, pseudoSels, state)) return false
    } else if (rule.cssRules && rule.cssRules.length) { // @media/@supports/@keyframes/…
      // constructor.name instead of instanceof: a rule from an iframe document belongs to
      // that window's CSSContainerRule, so the parent realm's constructor never claims it.
      const container = rule.constructor?.name === 'CSSContainerRule'
      if (container) state.inContainer++
      const ok = scanRules(rule.cssRules, universe, pseudoSels, state)
      if (container) state.inContainer--
      if (!ok) return false
    }
  }
  return true
}

/** One sheet through scanRules. False on a cross-origin sheet, whose cssRules getter throws. */
function scanSheet(sheet, universe, pseudoSels, state) {
  let rules
  try { rules = sheet.cssRules } catch { return false } // cross-origin
  if (!rules) return false
  return scanRules(rules, universe, pseudoSels, state)
}

/** Splits `sel` on `sep` outside parentheses, brackets, comments, escapes, and quotes. */
function splitTopLevel(sel, sep) {
  const out = []
  let depth = 0, quote = null, start = 0
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]
    if (c === '\\') { i = skipCssEscape(sel, i); continue }
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === '\'') quote = c
    else if (c === '/' && sel[i + 1] === '*') i = skipCssComment(sel, i)
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && c === sep) { out.push(sel.slice(start, i)); start = i + 1 }
  }
  out.push(sel.slice(start))
  return out
}

/** Direct subject attributes are necessary match conditions. Bucket keys use simple lowercase
 * names without namespace prefixes.
 * For exact, case-sensitive `data-*` equality strengthen presence (`a<name>`) to exact value
 * (`v<name>\0<value>`). We deliberately keep the value route data-* only: unlike many HTML
 * enumerated attributes, custom data values are case-sensitive by default. Functional-pseudo
 * arguments are ignored because `[x]` inside :not/:is/:where/:has is not necessarily required. */
function directSubjectAttributeKey(subject) {
  let paren = 0, quote = null
  for (let i = 0; i < subject.length; i++) {
    const c = subject[i]
    if (c === '\\') { i = skipCssEscape(subject, i); continue }
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '/' && subject[i + 1] === '*') { i = skipCssComment(subject, i); continue }
    if (c === '(') { paren++; continue }
    if (c === ')') { if (paren) paren--; continue }
    if (paren || c !== '[') continue

    let j = i + 1
    while (j < subject.length && CSS_WS_RE.test(subject[j])) j++
    let raw = '', namespaced = false
    while (j < subject.length) {
      const x = subject[j]
      if (x === '\\') {
        const start = j
        j = skipCssEscape(subject, j)
        raw += subject.slice(start, j + 1)
        j++
        continue
      }
      if (x === '|' && subject[j + 1] !== '=') { namespaced = true; break }
      if (x === ']' || CSS_WS_RE.test(x) || x === '=' ||
          ((x === '~' || x === '|' || x === '^' || x === '$' || x === '*') && subject[j + 1] === '=')) break
      raw += x
      j++
    }
    if (!namespaced && raw) {
      const name = decodeCssEscapes(raw)
      // Lowercase-only is a deliberate cross-namespace safety restriction. It is correct for
      // HTML and exact for lowercase SVG/XML attrs, while uppercase/case-sensitive names simply
      // stay on the historical unkeyed path.
      if (name === name.toLowerCase() && /^[-_a-z][-_a-z0-9]*$/.test(name)) {
        const presenceKey = 'a' + name
        while (j < subject.length && CSS_WS_RE.test(subject[j])) j++
        if (name.startsWith('data-') && subject[j] === '=') {
          j++
          while (j < subject.length && CSS_WS_RE.test(subject[j])) j++
          let rawValue = '', valid = true
          const q = subject[j] === '"' || subject[j] === "'" ? subject[j++] : null
          if (q) {
            let closed = false
            for (; j < subject.length; j++) {
              const x = subject[j]
              if (x === q) { closed = true; j++; break }
              if (x === '\\') {
                const start = j
                j = skipCssEscape(subject, j)
                rawValue += subject.slice(start, j + 1)
                continue
              }
              rawValue += x
            }
            if (!closed) valid = false
          } else {
            for (; j < subject.length && !CSS_WS_RE.test(subject[j]) && subject[j] !== ']'; j++) {
              if (subject[j] === '\\') {
                const start = j
                j = skipCssEscape(subject, j)
                rawValue += subject.slice(start, j + 1)
              } else rawValue += subject[j]
            }
            if (!rawValue) valid = false
          }
          while (j < subject.length && CSS_WS_RE.test(subject[j])) j++
          // Any explicit matching modifier (i/s/future syntax) stays on name-only bucketing.
          // That keeps value keys independent of engine-specific folding semantics.
          if (valid && subject[j] === ']') return 'v' + name + '\0' + decodeCssEscapes(rawValue)
        }
        return presenceKey
      }
    }

    // Skip this complete attribute selector before looking for another direct one. This avoids
    // interpreting a literal `[` inside a quoted attribute value as a second selector.
    let innerQuote = null
    for (; i < subject.length; i++) {
      const x = subject[i]
      if (x === '\\') { i = skipCssEscape(subject, i); continue }
      if (innerQuote) { if (x === innerQuote) innerQuote = null; continue }
      if (x === '"' || x === "'") { innerQuote = x; continue }
      if (x === ']') break
    }
  }
  return null
}

function subjectTailOf(sel) {
  let depth = 0, quote = null, cut = 0
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]
    if (c === '\\') {
      // A combinator-looking code point can be part of an escaped identifier, and a hex escape
      // may consume one whitespace terminator. Neither is a compound boundary. D1's original
      // scanner did not skip escapes here, which could turn a legal utility-class selector into
      // a bogus tag key and incorrectly suppress the rule.
      i = skipCssEscape(sel, i)
      continue
    }
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === '\'') quote = c
    else if (c === '/' && sel[i + 1] === '*') i = skipCssComment(sel, i)
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) cut = i + 1
  }
  return sel.slice(cut)
}

function subjectCompoundOf(subject) {
  // Drop functional/attribute arguments: a class inside a functional pseudo or attribute selector
  // is not itself a condition on the subject.
  // Escaped delimiters are identifier code points, not syntax. Treating one as an attribute
  // opener can truncate the subject and manufacture a bogus class key, turning a performance
  // hint into a fidelity bug.
  let compound = '', d = 0, quote = null
  for (let i = 0; i < subject.length; i++) {
    const c = subject[i]
    if (c === '\\') {
      if (d === 0) compound += c
      const end = skipCssEscape(subject, i)
      if (d === 0) compound += subject.slice(i + 1, end + 1)
      i = end
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      if (d === 0) compound += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      if (d === 0) compound += c
      continue
    }
    if (c === '/' && subject[i + 1] === '*') {
      i = skipCssComment(subject, i)
      continue
    }
    if (c === '(' || c === '[') d++
    else if (c === ')' || c === ']') { if (d) d-- }
    else if (d === 0) compound += c
  }
  return compound
}

function simpleSubjectIdent(m) {
  if (!m) return null
  if (/\\[0-9a-fA-F]/.test(m)) return null // hex escape: not worth decoding, stay a candidate
  return m.replace(/\\(.)/g, '$1')
}

/** A necessary condition for `sel` to match an element, as a cheap subtree-presence key. Prefer
 * the first class, then id, direct attribute, or the tag of the RIGHTMOST subject compound.
 * null = no usable key, always a candidate. */
function subjectKeyOf(sel) {
  const subject = subjectTailOf(sel)
  const compound = subjectCompoundOf(subject)
  const cls = simpleSubjectIdent((compound.match(/\.((?:\\.|[\w-])+)/) || [])[1])
  if (cls) return 'c' + cls
  const id = simpleSubjectIdent((compound.match(/#((?:\\.|[\w-])+)/) || [])[1])
  if (id) return 'i' + id
  const attr = directSubjectAttributeKey(subject)
  if (attr) return attr
  const tag = (compound.match(/^([a-zA-Z][\w-]*)/) || [])[1]
  return tag ? 't' + tag.toLowerCase() : null
}

/** R5-D4's measured residual is specifically a class/id key hiding a more selective direct
 * exact-data attribute key. Expose only that alternative here; the scalar API avoids an array per
 * rule during index compilation and deliberately avoids a generic selector planner. */
export function subjectAlternativeAttributeKey(sel, primary = null) {
  const subject = subjectTailOf(sel)
  const key = directSubjectAttributeKey(subject)
  return key && key !== primary ? key : null
}

/** One matches()/querySelector-ready selector list from collected parts: '' when there are
 *  none, null when the joined result cannot be trusted. A & that survived resolution
 *  (top-level nesting) parses but can never match — worse than no gate, so null. */
function joinGate(probe, parts) {
  if (!parts.length) return ''
  if (parts.some((p) => p.includes('&'))) return null
  const sel = parts.join(',')
  try { probe.matches(sel); return sel } catch { return null }
}

/** Joins collected per-kind selectors into one matches()-ready string, validating the
 *  combined result once (an unparsable selector → null → callers probe every node).
 *  `q` is always included for before/after: UA open/close-quote pseudos have no author rule. */
function composePseudoGates(doc, pseudoSels) {
  const probe = doc.createElement('div')
  const gates = {}
  for (const kind in pseudoSels) {
    const parts = pseudoSels[kind]
    if (kind === 'before' || kind === 'after') parts.push('q')
    gates[kind] = joinGate(probe, parts)
  }
  return gates
}

/** See the share-gate note at the selector visitor. Pseudo-ELEMENTS are absent on purpose:
 *  ::before/::after do not change the HOST element's computed style. `:link` is included
 *  (href-less anchors differ) but `:visited` need not be — getComputedStyle deliberately
 *  answers with unvisited values for privacy, so it cannot split identical elements. */
const SHARE_UNSAFE_RE = /:(nth-|first-child|last-child|only-|first-of-type|last-of-type|empty|hover|focus|active|target|checked|indeterminate|disabled|enabled|read-only|read-write|placeholder-shown|autofill|valid|invalid|user-valid|user-invalid|in-range|out-of-range|required|optional|default|link|any-link|scope|defined|modal|fullscreen|picture-in-picture|playing|paused|dir\(|lang\(|has\()/

/**
 * Scans the document's author styles once: every sheet, the adopted sheets, WAAPI keyframes.
 * Pure; styles.js memoizes it per document and style epoch (scanFor).
 *
 * Everything in the result rides the same rule walk, so none of it costs a second pass:
 * - `universe`: the properties any rule can touch, plus ALWAYS_PROPS. Null when the scan
 *   cannot be trusted (a cross-origin sheet, the rule budget blown), and then every other
 *   field takes its unreliable value as well.
 * - `pseudoUniverse`: what a pseudo-element's snapshot reads (PSEUDO_BOX_PROPS, the inherited
 *   props the universe holds, the props pseudo rules declare).
 * - `pseudoGates`: per kind, one selector for `el.matches()`. '' means no rule, skip every
 *   node; null means unreliable, probe every node.
 * - `usesHas`: some rule uses `:has()`, which turns per-node stamp narrowing off. True when
 *   unreliable.
 * - `shareGate`: the selectors that can split identity twins, each with its subject key for
 *   styleShareSafe's presence index. Null when one cannot be matched (share off).
 * - `sharePartition`: metadata for the narrower fingerprinted-share path. Null on an
 *   unreliable scan; `blocked` covers global channels that cannot be represented by a
 *   per-element selector fingerprint, and `containerSels` identifies selectors whose result
 *   depends on container size rather than element structure alone.
 * - `marginUnstable` / `paddingUnstable`: a %, auto, calc() or var() value in that family
 *   anywhere, so twins re-read it.
 * - `importantProps`: every property some rule declares `!important`.
 * - `styleIdentityDataAttrs`: data-* names observable by selectors/attr(), or null when the
 *   scan cannot prove observability completely. Used only to relax style-sharing identity.
 * - `elementRules` / `elementKeyedRuleCount` / `elementDeclaredProps` / `elementAlwaysProps`:
 *   selector-indexed declarations plus the number carrying a cheap necessary subject key.
 *   declarations used by the per-element property-universe fast path. They are null on an
 *   unreliable scan; `elementAllRules` carries selector-scoped `all` resets,
 *   `elementUniverseBlocked` is reserved for unresolvable reset/nesting cases, and
 *   `hasAnimations` covers live CSS/WAAPI animation state.
 * Pinned by __tests__/module.styleScan.test.js.
 * @param {Document} doc
 * @returns {{universe: Set<string>|null, pseudoUniverse: Set<string>|null, pseudoGates: {before: string|null, after: string|null, firstLetter: string|null, marker: string|null, firstLine: string|null}, usesHas: boolean, shareGate: Array<{sel: string, key: string|null}>|null, sharePartition: {blocked: boolean, containerSels: Set<string>}|null, styleIdentityDataAttrs: Set<string>|null, marginUnstable: boolean, paddingUnstable: boolean, importantProps: Set<string>|null, elementRules: Array<{sel:string,key:string|null,props:string[]}>|null, elementKeyedRuleCount: number, elementAllRules: Array<{sel:string,key:string|null}>|null, elementDeclaredProps: Set<string>|null, elementAlwaysProps: Set<string>|null, elementUniverseBlocked: boolean, hasAnimations: boolean}}
 */
export function scanAuthorStyles(doc) {
  // usesHas true on the unreliable path: a scan that could not read every rule cannot promise
  // the document has no `:has()`, and the narrowing must only run on a promise.
  const unreliable = {
    universe: null, pseudoUniverse: null, usesHas: true, shareGate: null, sharePartition: null,
    styleIdentityDataAttrs: null,
    marginUnstable: true, paddingUnstable: true, importantProps: null,
    pseudoGates: { before: null, after: null, firstLetter: null, marker: null, firstLine: null },
    elementRules: null, elementKeyedRuleCount: 0, elementAllRules: null, elementDeclaredProps: null, elementAlwaysProps: null,
    elementUniverseBlocked: true, hasAnimations: true,
  }
  try {
    const universe = new Set(ALWAYS_PROPS)
    const pseudoSels = { before: [], after: [], firstLetter: [], marker: [], firstLine: [] }
    const state = {
      budget: MAX_SCAN_RULES,
      usesHas: false,
      shareUnsafeSels: new Set(),
      shareContainerSels: new Set(),
      sharePartitionBlocked: false,
      dataAttrDeps: new Set(),
      dataAttrIdentityBlocked: false,
      inContainer: 0,
      marginUnstable: false,
      paddingUnstable: false,
      importantProps: new Set(),
      pseudoProps: new Set(),
      elementRules: [], elementKeyedRuleCount: 0, elementAllRules: [], elementDeclaredProps: new Set(), elementAlwaysProps: new Set(),
      elementUniverseBlocked: false, hasAnimations: false,
    }
    for (const sheet of doc.styleSheets) {
      if (!scanSheet(sheet, universe, pseudoSels, state)) return unreliable
    }
    const adopted = /** @type {any} */ (doc).adoptedStyleSheets
    if (Array.isArray(adopted)) {
      for (const sheet of adopted) {
        if (!scanSheet(sheet, universe, pseudoSels, state)) return unreliable
      }
    }
    // Programmatic (WAAPI) animations don't live in stylesheets — union their keyframe props.
    if (typeof doc.getAnimations === 'function') {
      const animations = doc.getAnimations()
      state.hasAnimations = animations.length > 0
      for (const anim of animations) {
        const frames = anim.effect?.getKeyframes?.() || []
        for (const frame of frames) {
          for (const key of Object.keys(frame)) {
            if (key === 'offset' || key === 'easing' || key === 'composite' || key === 'computedOffset') continue
            universe.add(key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))
          }
        }
      }
    }
    // shareGate: null = a splitting selector the engine cannot match against (share off),
    // else the indexed list styleShareSafe filters by subtree presence and queries with.
    const shareSels = Array.from(state.shareUnsafeSels)
    const shareGate = joinGate(doc.createElement('div'), shareSels) === null
      ? null
      : shareSels.map((sel) => ({ sel, key: subjectKeyOf(sel) }))
    const pseudoUniverse = new Set(PSEUDO_BOX_PROPS)
    for (const p of INHERITED_PROPS) if (universe.has(p)) pseudoUniverse.add(p)
    for (const p of state.pseudoProps) pseudoUniverse.add(p)
    return {
      universe,
      pseudoUniverse,
      pseudoGates: composePseudoGates(doc, pseudoSels),
      usesHas: state.usesHas,
      shareGate,
      sharePartition: { blocked: state.sharePartitionBlocked, containerSels: state.shareContainerSels },
      styleIdentityDataAttrs: state.dataAttrIdentityBlocked ? null : state.dataAttrDeps,
      marginUnstable: state.marginUnstable,
      paddingUnstable: state.paddingUnstable,
      importantProps: state.importantProps,
      elementRules: state.elementRules,
      elementKeyedRuleCount: state.elementKeyedRuleCount,
      elementAllRules: state.elementAllRules,
      elementDeclaredProps: state.elementDeclaredProps,
      elementAlwaysProps: state.elementAlwaysProps,
      elementUniverseBlocked: state.elementUniverseBlocked,
      hasAnimations: state.hasAnimations,
    }
  } catch {
    return unreliable
  }
}
