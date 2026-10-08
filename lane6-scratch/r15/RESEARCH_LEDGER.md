# R15 — SVG image reuse beyond HTML img

**Status:** isolated candidate; no timing, fidelity or memory result accepted without hosted measurements.
**Parent:** frozen measured R12 worker-bitmap scout `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b`.
**Scope:** one branch, one production module, SVG <image> inlining only. Leave R12 PSS/fidelity, R13 raster clamp and R14 Safari worktrees unchanged.

## Mechanism and original bottleneck
`inlineImages` caches successful HTML `<img>` fetches between captures, but
`processSvgImage` at the bottom of the very same module always calls
`snapFetch(href, { as: 'dataURL' })` again. Repeated chart/graph exports with
external SVG `<image>` nodes therefore re-fetch, convert Blob to a multi-MB
base64 string using FileReader and allocate a second serialized inlined source
even when the absolute source URL has not changed.

`snapFetch` already coalesces matching **in-flight** requests. The novel saving
is explicitly **cross-capture**: reuse its successful result through the
existing bounded `cache.image` rather than invent another cache.
The existing `cache:'disabled'` purge remains authoritative.

## Safety constraints
- The key must be the original exact absolute HTTP(S) URL. Relative sources
  can change meaning under differing document bases; do not cache them.
- Proxy-dependent bytes are never keyed by ordinary source URL: preserve the
  `snapFetch` path when `useProxy` is enabled.
- Never cache error responses, non-data strings, blob: or data: sources.
- Preserve xlink:href removal and no-placeholder SVG failure semantics.
- Reuse an existing HTML image memo entry without rewriting/erasing its Blob
  sidecar; normal bounded FIFO eviction may still occur.
- No cross-capture reuse when `cache:'disabled'` clears cache.image.
- This caches bytes only, not DOM or ImageBitmap; don't claim a decode savings.

## Measurements required before promotion
1. Lint, TS, compile and baseline asset contracts; Chromium, Firefox and
   WebKit browser unit contract suites for cache, fallback and xlink behavior.
2. On GitHub Actions compare exact frozen parent and the candidate using
   no external network: locally hosted deterministic images served with
   controllable latency. Include same-URL hot repeats, 100+ unique-source
   churn, mixed HTML img + SVG image, proxy and disabled-cache controls.
3. Measure **end-to-end capture**, not just isolated fetch calls, alongside
   exact output data and rendered pixel hashes. Include two fixture sizes
   and at least six independent hosted runners with balanced order.
4. Acquire renderer/process PSS across stable repeated captures and high-cardinality
   unique URLs. A faster repeat at the cost of uncontrolled dataURL memory
   retention is not Pareto dominance.
5. A run failing the evidence suite or unmeasured source mutation is a reject,
   not a speedup. If image retention competes against valuable photo Blobs,
   research URL scope / budget instead of silently growing the cache.

## Falsifiers
- Significant speed gain only in synthetic fetch-latency fixture but no
  win at low latency or realistic chart workloads.
- Extra retained bytes or cache churn harming warm HTML photo captures.
- Mismatched output hashes (including proxy / relative / fallback cases).
- No speed improvement once network cache serves assets at wire speed.
