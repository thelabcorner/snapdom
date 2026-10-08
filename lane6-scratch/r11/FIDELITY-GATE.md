# AS-BLOB — cross-engine FIDELITY acceptance gate (R11)

Mechanism candidate: `d391556b80be7a6d97bc4834d2ce6e24137515b2`
Frozen baseline: `c523ddb6e141846d55af1c8f315f65babbc32a7e`
Measurement branch: `perf/v3-r11-fidelity-gate`
Workflow: `.github/workflows/r11-fidelity.yml`

**Browser execution is GitHub-Actions-only.** There is no local mode, and `assertHostedOnly()` has
no override: setting `SNAPDOM_ALLOW_LOCAL_FIDELITY=1` is itself an error. Local work on this branch is
browser-free contracts, algebra and orchestration only.

## 1. What this gate decides, and what it refuses to decide

It decides one question per engine: **does `d391556` produce the same output bytes and the same
rendered pixels as `c523ddb` on Chromium, Firefox and WebKit?**

It refuses to decide anything about speed. There is no clock read, no elapsed-time field and no
effect size anywhere in `fidelity-lib.mjs`, `fidelity-run.mjs`, `fidelity-aggregate.mjs` or
`prepare.mjs`, and a contract test asserts the absence of each of those tokens in all of them. The
confirmed Chromium result — large-scale capture −55.64% CI [−58.23,−52.89], large-width −57.01%
CI [−57.80,−56.20], same-geometry null −0.59% CI [−2.55,+1.41], small null +2.41% CI [−3.09,+8.23],
CSP null +0.55% CI [−8.74,+10.78] — is **not** evidence about Firefox or WebKit and is never
consulted here. Every artifact this gate writes carries `performanceClaim: false`.

## 2. Why a separate gate rather than the timing harness

The timing harness has a single arm per question and a pooled aggregate over six replicas. Parity
needs something it cannot provide:

- **Three engines, not one.** The mechanism's win depends on `Worker` + `OffscreenCanvas` +
  `postMessage` semantics. Those differ per engine and none of them is Chromium's behaviour by
  assumption.
- **Exactness, not an interval.** A timing gate asks whether an effect is distinguishable from
  noise. A fidelity gate asks whether two outputs are the same object. Those want different
  statistics, and reusing the timing statistics would hide exactly the failure this gate exists to
  find.
- **A route ledger, not a latency.** The interesting surfaces are which branch ran, not how long it
  took.

## 3. Frozen provenance

`prepare.mjs` writes one file that the gate is allowed to believe. Nothing else is admissible.

| frozen item | value / rule |
|---|---|
| `measurementGitSha` | this harness's commit, deliberately **not** the mechanism |
| `candidateGitSha` | exact `d391556b80be7a6d97bc4834d2ce6e24137515b2` |
| `baselineGitSha` | exact `c523ddb6e141846d55af1c8f315f65babbc32a7e` |
| bundle digests | SHA-256 of each compiled `dist/snapdom.mjs`, compiled from its own exact checkout |
| fixture digests | SHA-256, byte length, dimensions and data-URL character count per fixture |
| mechanism constants | `WORKER_MIN_PAYLOAD_CHARS`, `MAX_IMAGE_BLOB_BYTES`, read from `src/core/cache.js` |
| harness manifest | SHA-256 of the workflow, all four harness scripts and the vendored r10 helper library |
| cell matrix | SHA-256 plus the ordered cell id list |
| `rawInlineLimit` | 256 KiB, so the runner cannot quietly switch to digest-only comparison |
| runtimes | exact Node and Playwright versions |

Three independent checks keep it honest:

1. **Before anything runs**, the `contracts` job proves production `src/`, `types/`, `packages/`,
   `esbuild.config.mjs`, `package.json` and `package-lock.json` are byte-identical to `d391556`
   against the measurement head. A harness commit can never redefine the candidate.
2. **Before a browser opens**, `fidelity-run.mjs` re-verifies both bundle digests, the whole harness
   manifest, every fixture digest, the mechanism constants, the cell matrix, the raw inline limit and
   the Playwright version.
3. **Before a verdict is reported**, `fidelity-aggregate.mjs` re-checks each engine's provenance
   against `prepared.json` again.

## 4. Fixtures

Generated deterministically; no binary asset is committed. `makeDeterministicPng`, `sha256`,
`dataUrlCharsForBytes` and `geometrySweep` are imported from the r10 harness rather than restated, so
this gate and the confirmed timing experiment agree by construction. The vendored copy of
`lane6-scratch/r10/asset-bench-lib.mjs` is the measurement branch's file byte for byte, pinned by a
digest contract so it cannot drift into a second definition.

| fixture | size | bytes | data-URL chars | role |
|---|---:|---:|---:|---|
| `large` | 1200×800 | 3 285 103 | 4 380 144 | above the worker threshold by >10× |
| `small` | 96×96 | 1 021 | 1 384 | below `WORKER_MIN_PAYLOAD_CHARS` by design |
| `evictA` / `evictB` | 4100×2800 | 39 275 711 each | 52 367 616 | overshoot the 64 MiB retention cap together |
| `fallback` | 64×64 | 4 261 | 5 685 | the payload a failed fetch falls back to |

`evictA + evictB = 78 551 422` bytes against a `MAX_IMAGE_BLOB_BYTES` of `67 108 864`: adding the
second overshoots by ~11 MB, and dropping one lands at 39 275 711, ~25 MB under the cap. Both facts
are asserted in `prepare.mjs` and in the contract suite, because a fixture that quietly stopped
reaching the cap would turn the eviction cell into a green no-op.

## 5. Cell matrix

Fourteen cells, one per semantic surface AS-BLOB touches. Every cell runs on all three engines, in
two independent self-null contexts, on one page per side.

| cell | surface AS-BLOB touches | candidate route | worker payload (baseline → candidate) |
|---|---|---|---|
| `large-first-capture` | cold capture, worker route reached | `workerBlob=1` | Blob → Blob |
| `large-repeat-same` | cache-soft repeat, **same** geometry | `memo=1` | none → none |
| `large-repeat-scale` | repeat, changing scale (measured sweep) | `workerBlob=1` | string → Blob |
| `large-repeat-width` | repeat, changing width (measured sweep) | `workerBlob=1` | string → Blob |
| `small-first-capture` | raster below `WORKER_MIN_PAYLOAD_CHARS` | `main=1` | none → none |
| `small-repeat-scale` | below-threshold repeat, changed geometry | `main=1` | none → none |
| `compress-off-large` | `compress:false` — retention gate input false | all zero | none → none |
| `worker-missing` | `Worker` absent **before module execution** | `main=1` | none → none |
| `offscreen-missing` | `OffscreenCanvas` absent **before module execution** | `main=1` | none → none |
| `csp-worker-none` | CSP `worker-src 'none'` fallback | CSP denial, then `main=1` | denied → denied |
| `cache-disabled` | `cache:'disabled'` resets every persistent map | `workerBlob=1` | Blob → Blob |
| `budget-eviction` | byte-budget sweep, sidecar dropped, data URL persists | Blob **and** string | none → none |
| `image-fetch-error` | fetch fails → sized placeholder | all zero | none → none |
| `image-fetch-fallback` | fetch fails, `fallbackURL` succeeds | all zero | none → none |

### Why the repeat arms differ between the sides

`c523ddb` memoizes the data URL only, so on a repeat capture whose geometry misses `cache.compress`
it posts the base64 string. `d391556` keeps the Blob beside it and posts the Blob. That difference is
the mechanism, so the matrix names it explicitly per side (`telemetryBySide`) instead of asserting one
shared shape — a shared shape would have failed the frozen baseline for a correct reason.

Route counters are candidate-only, because `options.__assetRoutes` does not exist in `c523ddb`. Route
*behaviour* is asserted on both sides through `window.Worker` instrumentation installed before either
bundle import. That surface is a property of the platform, so both bundles can be held to it, and it
is what stops a silent baseline fallback from being misread as candidate parity.

### Why the two absence cells need an init script

`compressWorkerRouteSupported()` asks whether `Worker` and `OffscreenCanvas` exist, and
`images.js` consults it on the **first** capture, before any worker has been spawned. Once the
module has evaluated, that answer is fixed. The emulated absence is therefore established with
`context.addInitScript()`, which Playwright runs before any page script and therefore before module
evaluation, using `delete` rather than an assignment to `undefined` because the check is
`typeof Worker !== 'undefined'`.

### Why the eviction cell asserts a split

A swept Blob cannot be observed directly — `cache.image` is not exported, and inventing an export
would widen the public surface for a benchmark. It is observable through what the worker is posted:
a retained sidecar arrives as a `Blob`, a swept one arrives as the base64 string. The cell therefore
requires `workerBlob >= 1 && workerString >= 1` in one capture. Which image lost its sidecar is the
sweep's FIFO order to decide; that the split exists, while both data URLs survive into the output, is
the semantic claim.

## 6. What "parity" means here

**Raw output.** Exact. Records at or below 256 KiB travel as real bytes and are compared byte for
byte; larger ones — a `compress:false` capture of the large fixture carries a multi-megabyte `data:`
URL inside its SVG — are compared by frozen SHA-256 plus UTF-8 byte length. Both raws present means a
byte comparison, and a disagreement between the bytes and their reported digests is itself a failure.

**Rendered pixels.** Exact: byte equality over the whole RGBA buffer at equal dimensions. No
tolerance, no sampling, no hashing. AS-BLOB changes which payload the worker receives, and both
payloads come from the same `resp.blob()` in `snapFetch`, so a pixel change is not something this
mechanism can cause.

The repository's existing snapdiff convention — `threshold: 0.1`, `failureRatio: 0.005` from
`__tests__/visual.demos.shared.js`, and the per-channel `tol = 40` from
`__tests__/visual.fidelity.livedom.test.js` — is implemented as the `strict` tier and **reported for
every cell**, but no cell admits it. A near-miss is therefore visible in the summary instead of
being either hidden behind exact parity or promoted into an admission.

**Data-URL persistence.** Every image must be inlined as a `data:` URL on both sides at every step.
That is what makes "the sidecar was dropped but the payload survived" observable.

## 7. Self-null

Each cell runs twice per side, in two fresh contexts with fresh module instances and fresh caches.
Both sides must produce identical raw digests across the two contexts. An engine that cannot
reproduce its own output twice cannot adjudicate anyone else's, and a flaky engine would otherwise
be able to manufacture a difference that is really nondeterminism — or hide a real one behind a
coincidence.

## 8. Fail-closed rules

| situation | state | exit |
|---|---|---|
| all engines, all cells, provenance matched | `FIDELITY_ACCEPTED` | 0 |
| fewer than three engine artifacts | `INCOMPLETE_EVIDENCE` | non-zero |
| a cell, a step, a self-null context or a parity record missing | `FIDELITY_FAILURE` for that engine | non-zero |
| any provenance field differs from `prepared.json` | `FIDELITY_FAILURE` | non-zero |
| raw digests differ, rendered bytes differ, a strict-only match, a route shape off, a worker payload of the wrong kind or size, an unexpected engine, an unknown cell, a changed cell matrix, an unparseable artifact, a duplicated artifact | `FIDELITY_FAILURE` | non-zero |

The acceptance matrix is emitted with one row per cell and one column per engine, and an unproven cell
is printed as `INCOMPLETE_EVIDENCE` rather than omitted, so the table has no holes to read past.

## 9. Reused authoritative coverage

The engine job additionally runs this repository's own suites against the candidate mechanism, on
that engine, rather than reimplementing them: `visual.fidelity.crossengine`,
`compress.syncfallback`, `compress.cacheIdentity`, `modules.images`,
`modules.images.dataUrlPassthrough`, `exporters.rasterize.routes`, `regression.imageSelection` and
`utils.clone.blobConcurrency`. Those already encode what cross-engine fidelity means here and what the
image and compression seams must keep doing, so a red result in that step is attributable to the
mechanism rather than to this gate. `npm run test:asset-proof` — the browser-free retention,
byte-budget, purge and capability proof — runs in the `contracts` job, so a retention regression fails
on the runner rather than only on a machine that happens to have browsers.

## 10. Known limits

- **`MAX_IMAGE_BLOB_BYTES` is still a hypothesis.** This gate does not certify it. The eviction cell
  proves the sweep *reaches* the cap and that a swept sidecar costs no fidelity; it does not argue
  that 64 MiB is the right number.
- **Antialiasing is never compared across engines.** Chromium output is compared with Chromium
  output, Firefox with Firefox, WebKit with WebKit. Cross-engine pixel equality is a different claim
  and is not made.
- **The evictions cell is the expensive one.** ~78 MB of fixture bytes per page load, four loads per
  engine. It is isolated in its own cell and runs sequentially so its memory cannot destabilise the
  other thirteen.
- **Route counters are candidate-only.** Baseline route behaviour is proven through Worker telemetry
  instead, which is stronger evidence about the platform but is not a substitute for the counter on
  the side that has it.
