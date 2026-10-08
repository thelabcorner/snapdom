# snapDOM v3 R13 — oversized SVG raster clamp without full payload recoding

## Frozen parent and principle

R13 is an independent experimental branch based on the R12 public-export
candidate at `cac07a4108086718bc9511663346e1b9fcf4e226`. R12 already
specializes the normal toSvg/toImg scale path. R13 targets a **different**
exporter boundary: `toCanvas`, when non-Safari browsers receive a canonical
SVG data URL whose width/height exceeds their raster decode limits.

The historical raster clamp: inspect the opening header cheaply, then decode
the entire SVG URL to text, clamp only the root element's width/height, and
re-encode the entire URL. With large embedded images, that is O(total SVG
bytes) twice for a change contained in a small prefix.

The R13 `clampEncodedSvgHeader` inspects/decompresses only a bounded
encoded header, applies the **same** floor-based dimensions and replacement
patterns as the original clamp, and leaves the asset-rich suffix unchanged.
Unlike R12's scale path, it also reproduces the original session warning and
console warning. The old code remains the unconditional fallback when any
precondition cannot be proved.

## Requirements and mandatory rejection conditions

- Exact encoded URL identity against independent historical algorithm.
- Exact canvas dimensions and RGBA pixel parity on Chromium and Firefox.
- WebKit must retain the original Safari shadow/decode route.
- Crop windows always use their existing transform route, because the crop
  changes the viewBox and can make a formerly oversized full capture small.
- Missing, nonfinite, relative, tiny and noncanonical SVG headers must not
  engage the fast path.
- A no-op route below raster limits stays unchanged.
- No timing claim from static counter deltas. Use independent pinned bundles
  on GitHub-hosted browser runners and report per-engine observations.
- A real oversized-capture fixture must carry an embedded large PNG to
  expose and measure the high-payload case; raw parity guards that fixture.

## Implemented tests and experiments

- Node differential oracle: `scripts/r13-svg-clamp.node.test.mjs` covers
  24 independent combinations of widths, heights, UTF-8 content, embedded
  image data and multi-megabyte payload, plus path vetoes.
- Hosted browser harness: `scripts/r13-raster-clamp-browser.mjs` produces a
  large random PNG and a 32768px-wide live DOM target, captures identically
  with baseline and candidate, then times public `toCanvas()` calls with
  alternating order. All output pixel hashes must match exactly.
- Existing Chromium/Firefox 16384px raster-limits integration fixture is
  executed too; the WebKit skip is preserved.
- Explicit crop fallback is tested for matching pixels, never silently
  reclassified as a new optimized route.

## Caveats and successors

- The non-Safari raster decode cap here is 32767 per side, subject to an
  independent area limit. The same geometry and clamp arithmetic must stay
  unchanged; forcing a smaller cap to engage the fast path is not valid.
- The benchmark compares canvas export, not the cost of the initial
  `snapdom()` source capture. The elapsed time may still be dominated by
  SVG image decoding or rasterization.
- If R13 is useful, investigate how canonical SVG provenance can be
  represented explicitly and how to avoid repeated late decoding across
  multiple exporters, without introducing tainted canvases.