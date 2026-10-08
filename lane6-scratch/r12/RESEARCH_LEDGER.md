# snapDOM v3 R12 — exact-output SVG header rewrite

## Context and provenance

- R11's AS-BLOB candidate is frozen at `d391556b80be7a6d97bc4834d2ce6e24137515b2`.
- R11's 14-cell Chromium/Firefox/WebKit acceptance first passed in Actions run
  `37738858455`, on `ada5dd38`; the encoded missing-image guard was strengthened
  in `f513db53`. R12 branches independently from `f513db53`.
- R12 candidate branch: `perf/v3-r12-svg-header-fastpath`, initial GitHub commit
  `5bb9b28361caeb54f644c4612b646fee0dc2f868`.
- **Primary metric boundary:** `src/exporters/toImg.js`'s `scale !== 1` path
  when neither width nor height is explicitly supplied. Not the capture phase,
  not the PNG encoder, not the whole `toSvg` exporter, not all browsers/pages.

## Mechanism

Before R12, a scaled SVG image export called `decodeURIComponent` on the
complete serialized SVG, replaced two attributes in the opening `<svg>` tag,
then called `encodeURIComponent` on the complete SVG again. A multi-megabyte
embedded image changed **none of those bytes**. The two full-length transforms
were accidental work.

`src/exporters/svgHeaderFast.js` handles the canonical SVG URL emitted by
snapDOM. It identifies the encoded opening tag in a bounded prefix, decodes
**only that prefix**, applies the original width/height rounding and regex
substitutions, re-encodes the prefix, and shares the original untouched tail.
An unusual header, noncanonical prefix, missing/invalid dimensions or an
oversized header stays on the original codepath.

This is not a different encoding format or a lossy approximation: on the
specialized route, the whole returned data URL must be **exactly equal** to
the legacy full decode/re-encode result. Tests intentionally compare strings
byte-for-byte. An allocation/CPU optimization cannot excuse changed pixels.

## Local microbenchmark (not a browser speed claim)

Node 22-class runtime on the Windows development workstation. Nine
iterations per payload, median; alternate implementation timings obtained
inside one process. The payload is synthetic SVG metadata with percent-encoded
characters; all outputs were checked for equality. The test is gated behind
`SNAPDOM_HEADER_BENCH` because it allocates large strings.

| Approximate SVG body | Old median | Header-only median | Isolated ratio |
|---|---:|---:|---:|
| 1 MiB | 5.6145 ms | 0.0161 ms | 349x |
| 8 MiB | 46.6958 ms | 0.0631 ms | 740x |
| 32 MiB | 201.4211 ms | 0.0634 ms | 3177x |

All values are LOCAL MICROBENCHMARK MEASUREMENTS. Browser-hosted integration
and per-browser microbenchmarks are separate jobs. A full export can still be
dominated by SVG-as-image decoding, rasterization, image loading and data-URL
copying. This table does **not** demonstrate a 3177x end-to-end improvement.

## Adversarial correctness matrix

1. Canonical SVG prefix, varying attribute order, integers/fractional geometry,
   and five different scale factors.
2. Embedded base64-image syntax, percent-sensitive characters, XML entities,
   non-ASCII characters and astral Unicode scalars.
3. Noncanonical percent escaping, invalid widths, missing dimensions,
   nonfinite scale and oversized headers must return the legacy fallback.
4. Integrated `toImg`/ `toSvg` uses exact old re-encoding as an independent
   comparator; checks that the final image is decoded, has the scaled natural
   dimensions and paints the same RGBA values.
5. Public GitHub-hosted Chromium/Firefox/WebKit matrix must pass with
   `npm ci`, lint, typecheck, compile, the targeted Vitest tests, raw-byte
   equality and a pixel-equality oracle.
6. The `scripts/r12-svg-header-browser.mjs` benchmark is GitHub Actions
   only, runs both algorithms in alternating order on the **same** browser VM,
   and does not use a package-wide speed claim.

## Negative controls and falsifiers

- Small SVGs can be dominated by the extra fast-path guard: measure rather
  than assume a universal win.
- `toRaw()` never calls the scale exporter, so it must remain unchanged.
- Browser image decode can dominate and erase the per-operation timing win.
- WebKit's Safari shadow-rewrite path is intentionally unchanged in this
  round: it needs more than two SVG-header substitutions.
- Any pixel mismatch, raw-byte mismatch, new lint/type failure, or a new
  cross-browser integration regression vetoes promotion.
- A custom data URL with a canonical header but noncanonical encodings *later*
  in the tail is not guaranteed to retain the historical canonicalization
  side effect. This helper is intended for snapDOM's own canonical SVG URLs.
  A follow-up should explicitly mark/prove internal provenance if the same
  implementation is ever exposed to arbitrary callers.

## Next experiments

1. End-to-end `snapdom(...).toSvg({scale:2})` vs old code under independent
   GitHub-hosted runners, including asset-rich multi-MiB real DOM capture.
2. Reuse the same prefix-only editing technique for over-limit SVG header
   clamping in `toCanvas`, but keep WebKit shadows and crop viewBox semantics
   as explicit separate veto gates.
3. Determine whether Safari shadow-free scaled exports can avoid a full SVG
   decode, without losing the shadow rewrite when style syntax is adversarial.
4. Explore lazy materialization of the outer SVG data URL: the SVG engine
   currently serializes and percent-encodes eagerly even when a caller wants
   pixels. A real optimization must retain `toRaw()` and plugin hook semantics,
   browser canvas origin cleanliness, and bounded resource lifetime; a `blob:`
   URL substitution is specifically forbidden by Chromium's foreignObject
   canvas-taint behavior.