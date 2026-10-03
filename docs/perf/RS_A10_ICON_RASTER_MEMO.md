# RS-A10 — icon glyph rasterization memo: audit and NO-GO

- **Base:** `c523ddb6e141846d55af1c8f315f65babbc32a7e` (`perf(r9): add hosted-only self-null calibration`)
- **Branch:** `perf/v3-r10-icon-memo` · worktree `Documents/GitHub/snapdom-v3-r10-icon-memo`
- **Verdict:** **NO-GO.** No memo ships. `src/` is byte-identical to the base on this branch.
- **Browser evidence:** none yet. The probe is GitHub-Actions-only by protocol and has not been run.

---

## 1. The claim under audit

`materialIconToImage` (`src/modules/iconFonts.js:262`) and `iconToImage`
(`src/modules/fonts.js:41`) rasterize one glyph each by drawing it on a canvas in the live
document. Per call, both perform:

| # | Cost | ligature path | pseudo path |
|---|---|---|---|
| 1 | `document.fonts` await | `load()` + `ready` (`iconFonts.js:228`) | `ready` only (`fonts.js:45`) |
| 2 | live-DOM append | `iconFonts.js:300` | `fonts.js:60` |
| 3 | **forced synchronous layout** | `iconFonts.js:301` | `fonts.js:62` |
| 4 | live-DOM removal | `iconFonts.js:304` | `fonts.js:65` |
| 5 | **PNG encode** | `iconFonts.js:319` | `fonts.js:80` |

Step 3 is a full-document reflow taken immediately after step 2 dirtied the tree. Neither
function memoizes, and both callers loop **serially** — `ligatureIconToImage` at
`iconFonts.js:366`, the pseudo pass at `pseudo.js:955` — so N icons pay N of all five.

The claim under audit: repeated glyphs in one capture can share one rasterization, collapsing
N to (distinct keys).

## 2. The candidate key

Specified, pure, and browser-free in `lane6-scratch/r10/icon-key-spec.mjs`:

```
{ text, familyMeasure, canvasFont, color, dpr, fontEpoch }
```

Built from the exact strings the draw sites assign — `canvasFontString` is the same helper both
`ctx.font` assignments go through, so the key cannot describe a rasterization the code would not
perform. `familyMeasure` and `canvasFont` are derived from `resolveLigatureTarget`, the pure
decision half of `ensureLigatureCanvasFont` (`iconFonts.js:155`), split out so the key *could* be
computed before the first await.

Deliberately **not** fields: `fontFeatureSettings` / `fontVariantLigatures` (hard-coded to
`'liga' 1` / `normal` on the span, never set on the canvas), and the raw `variation` /
`className` strings (a canvas font string has no `font-variation-settings`, so they matter only
through which static face is chosen — and that is already folded into `canvasFont`).

## 3. Measurement inputs and raster inputs are different sets, and they are coupled

- **Raster inputs** (what fixes `dataUrl`): text, `ctx.font`, `fillStyle`, dpr, `canvas.width/height`,
  font state at draw time.
- **Measurement inputs** (what fixes `width`/`height`): the above **plus** every metric-affecting
  property of a live `<span>` in the host document that the icon path never sets or reads.

They are **coupled, not independent**: `canvas.width = ceil(rect.width) * dpr`
(`iconFonts.js:307`). The measurement is an input to the raster bytes.

A cached `{dataUrl, width, height}` is therefore reusable only when **both** sets match — and the
measurement set cannot be derived from the key.

## 4. The measuring span, property by property

Both spans are a bare `<span>` (no class, id, or attribute) appended to `document.body`, then
measured with `getBoundingClientRect()`.

**Closed — hard-coded inline, identical for every node:** `position: absolute`,
`visibility: hidden`, `white-space: nowrap`, `line-height: 1`, `margin: 0`, `padding: 0`;
plus `left: -99999px`, `font-feature-settings`, `font-variant-ligatures` (ligature path only).
*Even these are not strictly closed: an author `!important` declaration beats an inline
non-important one.*

**Closed — per-node and in the key:** `font-family`, `font-weight`, `font-size`, `font-style`
(pseudo path), `color`.

**Open — not set inline, inherited from the live document, varies per capture:**

`letter-spacing` · `word-spacing` · `text-transform` · `font-stretch` · `font-size-adjust` ·
`font-kerning` · `font-optical-sizing` · `text-indent` · `direction` · `writing-mode` ·
`font-variant-numeric` · `font-variant-east-asian` · `font-variant-caps` · `text-rendering` ·
font-face availability / `unicode-range` (only *this lane's* `document.fonts.add` is observed,
never a host webfont finishing).

**Open — matched onto the bare span by an author selector:** `display`, and *any* rule whose
selector can match `span` — the span has no class, id, or attribute, so `span {}`, `* {}` and
`body > span {}` all match.

**Open — not properties of the span at all:** `transform` / `zoom` on any ancestor.

The full table, as data, is `AMBIENT_MEASUREMENT_INPUTS` in the spec module — recorded as data so
the claim is falsifiable by adding a row.

## 5. Why this is NO-GO rather than merely unproven

Two rows are independently fatal to the "just key on the span's computed style" repair:

1. **`transform` / `zoom` on an ancestor.** `getBoundingClientRect()` returns coordinates in the
   visual space **after** ancestor transforms, so `body { transform: scale(2) }` doubles both
   reported dimensions. This is not a property *of the span*, so no span-derived key can contain
   it — not a whole-computed-style serialization, not any allow-list.
2. **Whether any author rule matches the bare span is undecidable.** It requires reading every
   stylesheet, and `cssRules()` throws on a cross-origin sheet, `@layer`/`::where()` nest
   arbitrarily, `!important` beats the inline styles, and a sheet can be inserted between two
   icons in the same capture.

Capture scope does not rescue this, and asserting it would have been the hand-wave: a host page
toggling a class on `body` between icon 3 and icon 4 changes the inherited values **within one
capture, under one store, at one font epoch**. The tests assert that aliasing directly
(`aliases two icons in the SAME capture, which is what defeats capture scope`).

The same unobservable class is already recorded against `getStyleEnvEpoch`, which deliberately
ignores `adoptedStyleSheets`, `<link>` load completion and CSSOM `insertRule`.

## 6. Repairs considered

| Repair | Outcome |
|---|---|
| 1. Key on the span's computed style | Covers the inherited and selected rows. **Cannot** cover the ancestor rows — they act on the returned coordinates, not on the span. |
| 2. Append to a snapdom-owned host with `all: initial` | Neutralizes inheritance and `body > span` rules, but `!important` still wins, and the host cannot escape a transform on `document.body`: `getBoundingClientRect` is post-transform wherever the span lives. |
| 3. Key on the measured rect | **Sound** — closes the measurement by construction, and is the only memo that is correct. But it requires the rect, so the forced layout — the dominant of the five costs — stays, and only the PNG encode is skipped. |
| 4. Require the host page to assert a canonical environment | The residual is not expressible as a key at any price, so this is an opt-in footgun that would still need the assertion to be trusted. Declined. |

**What remains sound but insufficient:** repair 3. It saves one of five costs — the cheapest,
against a forced layout on a document the capture does not control. Declined.

## 7. Repeated-glyph claim and the all-distinct control

| Fixture | Nodes | Distinct keys | Ceiling (avoidable) | Role |
|---|---:|---:|---:|---|
| `icon-repeat-120` | 120 | 1 | 119 | the claim |
| `icon-repeat-12x10` | 120 | 12 | 108 | partial repeats, realistic |
| `icon-distinct-120` | 120 | 120 | **0** | all-distinct, zero-ceiling control |
| `no-icon-120` | 120 | 0 | — | no-op control: probe adds nothing |

A memo may skip at most `draws − distinctKeys` of each cost; it can never skip the first draw of
any key. The all-distinct control is what makes a win on the repeated fixture attributable to
**deduplication** rather than to having done less work in general.

Counters are taken **from outside the library** — the probe wraps
`Element.prototype.getBoundingClientRect`, `HTMLCanvasElement.prototype.toDataURL` and
`FontFaceSet.prototype.load`, so no instrumentation had to ship in `src/`. `getBoundingClientRect`
is counted only for the measuring span's signature (a bare `SPAN`, `position:absolute`,
`visibility:hidden`), so unrelated capture layout is not misattributed.

**Warm-offline self-containment oracle.** The fixture declares its face as `"Material Icons"`
(legacy, non-variable) on loopback, so `resolveLigatureTarget` returns the as-is target, no static
face is requested, and `fonts.gstatic.com` is never touched. After warmup the page is taken
**offline**; the lane then requires the offline output to be byte-identical to the warm online run
(FNV-1a digest + length) *and* the counters to be identical. A timing difference therefore cannot
be attributed to the network.

Enforced fail-closed by `lane6-scratch/r10/validate-ceiling.mjs`.

## 8. Amdahl

No numbers exist yet, and none are invented here. The probe has not been run: it is
hosted-only by protocol (`assertHostedBrowser`, `lane6-scratch/r9/protocol.mjs:48`) and there is
no local browser. `lane6-scratch/r10/summarize.mjs` derives, per engine, from fixtures the lane
already runs:

```
perIconCost   = (T_distinct − T_none) / 120
memoableShare = (T_repeat − T_none) / T_repeat
idealSpeedup  = 1 / (1 − memoableShare)          # an infinitely fast icon path
```

`idealSpeedup` is a **ceiling on the whole idea**, not an estimate of it. The sound alternative
(repair 3) removes only the PNG encode, which is the smaller of the two engine costs, so its
realisable share is strictly below that number — and is deliberately not measured, rather than
measured and quietly reported as the memo's value.

## 9. GHA matrix

`.github/workflows/r10-icon-ceiling.yml` — diagnostic, and structurally unable to emit a claim
(`--expect=explore`).

| Job | Runs on | Matrix | Purpose |
|---|---|---|---|
| `browserfree` | `ubuntu-24.04` | — | `npm run test:icon-key`; asserts `src/` carries no audit changes |
| `prepare` | `ubuntu-24.04` | — | compile, freeze bundle, assert the loopback face exists |
| `measure` | `ubuntu-24.04` | `{chromium, firefox, webkit}` × replicates `[0,1,2,3]`, `max-parallel: 4` | measure the ceiling, then enforce the gates |
| `closeout` | `ubuntu-24.04` | — | cross-engine Amdahl, fail-closed |

12 measurements. Two inherited defects are corrected here, both recorded from the R9 campaign:

- `concurrency` is per-PR/per-ref with `cancel-in-progress: true`. A static group makes every
  branch contend for one queue in which GitHub cancels what exceeds the pending limit, and a
  cancelled run leaves no artifact and no summary line — indistinguishable from a blocked gate.
- The browser is installed via `env: BROWSER` expanded as `"${BROWSER:-chromium}"`. The sibling
  workflow's `npx playwright install --with-deps ${{ inputs.browser }}` expands to an **empty
  argument** on `pull_request` (`inputs.*` is only populated by `workflow_dispatch`) and installs
  every engine.

The offline step is gated on `SUITE === 'icon'` only: cutting the network on the other lanes
would perturb evidence that already has claims resting on it.

## 10. What would change the verdict

Not a better key. Any of:

- A measurement that does not consult the live document — e.g. metrics from an off-document
  layout, or per-glyph advance widths taken from `FontFace` APIs rather than a DOM span. This
  removes the ambient coupling at the source and is the only real path to the full saving.
- A snapdom-owned measurement subtree plus a guarantee that no ancestor transform applies, with
  the `!important` and cross-origin-stylesheet holes closed. Narrow, and it changes measured
  output for pages that already transform `body`.

## 11. RS-A3, preserved separately

The font-eviction defect (an evicted `cache.resource` payload leaving a live remote `url()`) is a
**different defect class** — asset-cache FIFO pressure in `inlineUrlsInCssBlock`
(`src/modules/fonts.js:453`), which reads from `cache.resource` or refetches — and it is already
pinned by `__tests__/module.fonts.evictedResource.test.js`. It is deliberately **untouched** here:
this branch changes no `src/` line at all, so nothing about RS-A3's status moves.

## 12. Artifacts

| Path | What |
|---|---|
| `lane6-scratch/r10/icon-key-spec.mjs` | the key, `resolveLigatureTarget`, and `AMBIENT_MEASUREMENT_INPUTS` as data |
| `lane6-scratch/r10/rejected-integration/` | the reverted memo attempt, kept as the record of what was tried |
| `__tests__/module.iconRaster.key.test.js` | 41 browser-free tests: closed surface, the aliasing, the three repairs |
| `vitest.icon-key.config.js` · `npm run test:icon-key` | the browser-free lane |
| `lane6-scratch/r9/bench-r9-controlled.mjs` | `icon` suite + page probe + warm-offline oracle |
| `lane6-scratch/r10/validate-ceiling.mjs` · `summarize.mjs` | fail-closed gates and cross-engine Amdahl |