# snapDOM v3 R14 — Safari shadow-safe SVG header specialization

## The remaining R12 cost

R12's canonical SVG scale optimization saved 58.4% of the measured public
export path in one hosted Chromium case and 18.5% in Firefox, but only ~4.7%
in WebKit (within noise). Investigation found that Safari's scaled `toImg`
path always decoded an image-rich SVG, ran `fixSafariShadows`, and re-encoded
the whole SVG even when it contained no actual shadow requiring a rewrite.
WebKit's genuine shadow-orientation fix must **never** be bypassed by a
simple, broad, or unknown-input heuristic.

## Algorithm

The historical Safari rewrite is guarded by this exact regex on decoded SVG:
`/(?:box-shadow|text-shadow)\s*:[^;"}]*px/i`.
If it does not match, `fixSafariShadows` returns the original SVG bytes.

R14's `definitelyNoEncodedSafariShadows` scans the canonical percent-encoded
SVG data URL without ever decoding the multi-megabyte body. Tokens are
`box-shadow`, `text-shadow`, `px`, and the encoded versions of the exact
three historical exclusion delimiters: `;`, `"`, `}`. A shadow token
followed by a `px` token inside one such region is *possibly* a real shadow
and must force the original path. A missing such pair proves the historical
regex cannot match; this may reject some harmless CSS but cannot safely
accept true shadowed CSS.

Noncanonical percent escapes for letters and hyphens also veto the fast
path. For shadow-free URL inputs, `resizeEncodedSafariSvg` rewrites only
the canonical opening SVG tag, with the exact historical aspect-ratio
reference, scale/width/height rounding and replacement order.
Noncanonical URLs, atypical headers and CSS uncertainties retain the
legacy full SVG decode/rewrite/encode pipeline.

## Evidence/acceptance

- 4,000 seeded adversarial CSS/markup cases: no case in which the encoded
  scanner claimed safe while the independent original decoded-SVG regex
  would run a rewrite.
- Differential URL comparisons cover independent combinations of scale,
  width, height, fractional dimensions, viewBox meta and multi-megabyte
  mixed Unicode/metadata resources.
- The existing Safari shadow-orientation test with `box-shadow:0 12px...`
  remains a hard browser-level gate; shadows must paint below, not above.
- A new browser integration test uses a shadow-free image-rich vector and
  compares the exported URL exactly against the old full document encoding,
  then checks decoded pixels.
- Hosted Chromium/Firefox/WebKit each compile and test; a pinned pre-R14
  R12 checkout provides the separate baseline bundle. Alternating repeated
  public `toSvg({scale:2})` exports measure the impact only after capture.
- The representative large capture is independently checked for the
  shadow-free precondition so a benchmark cannot accidentally spend all its
  time on the legacy branch.

## Falsifiers and limitations

- Any shadow-pixel mismatch, URL byte mismatch, crop/format regression,
  unexpected PNG fallback, or failed build vetoes acceptance.
- The prefix rewrite assumes the canonical SVG-URL transport actually
  emitted by snapDOM. External noncanonical encodings take a fallback
  where detectable; this is not a general-purpose SVG text optimizer.
- A real shadowed SVG must retain Safari's mature orientation/shadow
  emulation, including capability probes and the natural-size raster rule.
- The shadow scanner is O(input bytes), although it can be much cheaper
  than full decode AND full re-encode; performance must be demonstrated,
  not inferred from operation counts.
- No isolated operation ratio may be represented as a whole capture/export
  speedup; WebKit end-to-end exporter timing is the target metric.