# AS-BLOB v2 — hosted benchmark design and remaining falsifiers

Owner: asset-frontier. Worktree: `Documents/GitHub/snapdom-v3-r10-asset-frontier`, branch
`perf/v3-r10-asset-frontier`, parent `c523ddb`.

**Nothing in this document has been timed.** No browser ran on this branch. Every number below is
either a count the code already computes deterministically, or a threshold the harness proposes.
The claims are scoped accordingly, and §6 lists what would still have to be measured.

## 1. The claim, stated so it can be wrong

AS-BLOB retains the `Blob` that `snapFetch` produced alongside the data URL it memoizes in
`cache.image`, so a repeat capture can hand `compress`'s worker the bytes by reference instead of
a base64 string it must structured-clone and decode again.

**Scope: repeat, cache-soft captures whose geometry changes the compress memo key.** Nothing
else. Specifically it claims nothing when:

| Condition | Why there is no saving |
|---|---|
| Repeat capture at the same `scale` AND same `dpr` | `cache.compress` answers from its memo on an exact source match, before any decode. `__assetRoutes.memo` counts it. |
| Payload under `WORKER_MIN_PAYLOAD_CHARS` (64 KiB of base64) | Takes the main thread by design; below it the worker loses. No Blob is retained. |
| `compress: false` | `compressCloneAssets` returns before any decode. No Blob is retained. |
| Worker route closed (no `Worker`/`OffscreenCanvas`, or a CSP that forbids blob workers) | Falls to the main thread. No Blob is retained, and any already retained is purged. |
| Cold capture | The fetch already had the Blob and already attached it. |

This is **not** a global speed claim. On a cold capture, a same-geometry repeat, or a page of
icons, AS-BLOB is a no-op by construction, and the arms for those must show no delta.

## 2. How the counters are read — and why they are not on the result

`result.assets` was written and then cut. A measurement surface is not a reason to widen
`CaptureResult`: `types/snapdom.d.ts` and `src/api/snapdom.js` are byte-identical to `c523ddb` in
this branch, and that is a deliberate acceptance condition.

The tallies live on `options.__assetRoutes` — internal, set by `compressCloneAssets`, deleted at the
top of each `captureDOM` alongside the other `__compression*` scratch fields. The harness reaches
them with a caller-local plugin:

```js
const routeReader = {
  name: 'r10-route-reader',
  afterRender(context) { window.__routes = { ...(context.__assetRoutes || {}) } },
}
const r = await snapdom(el, { cache: 'soft', burst: false, plugins: [routeReader], scale, dpr })
```

`afterRender(context)` runs after the clone is serialized (`src/engines/svg.js`), so the tallies
are final. The plugin reads and returns, mutating nothing, so arm A1 and arm A2 differ only in
geometry. This path is what `assets-bench.mjs` uses and it is the only supported way to observe
the routes.

## 3. Fixtures

No binary fixture is committed. Each fresh runner generates two deterministic valid PNGs in pure
Node **before any browser is launched or timed**, and the raw artifact records dimensions, encoded
bytes, data-URL character count and SHA-256:

- `large` — 1200×800 deterministic high-entropy RGBA. Its encoded data URL is asserted to be more
  than 10× `WORKER_MIN_PAYLOAD_CHARS`, so the worker/Blob route is unquestionably eligible.
- `small` — 96×96 deterministic compressible checker. Its encoded data URL is asserted below the
  worker threshold, so no worker route may execute.

The tests generate the fixtures too, so threshold membership is a contract rather than an assumption
about a checked-in JPEG. Each benchmark page contains exactly **one** fixture, making every route
counter attributable to that fixture.

## 4. Paired conditions and acquisition

`cache: 'soft'`, `burst: false`, `compress: true` and `embedFonts: false` are explicit on every
capture. Baseline is exact `c523ddb6e141846d55af1c8f315f65babbc32a7e`; candidate is the exact
workflow head containing AS-BLOB v2.

| condition | fixture | CSP | timed geometry | role |
|---|---|---|---|---|
| `large-same` | large | none | constant scale=1,dpr=1 | null: after warmup the compress memo must answer |
| `large-scale` | large | none | seven unique scale targets | claim path: image cache warm, compress memo miss, Blob worker expected |
| `large-dpr` | large | none | seven unique dpr targets | same claim through density |
| `small-scale` | small | none | seven unique scale targets | negative control: payload too small for any worker route |
| `large-csp` | large | `worker-src 'none'` | seven unique scale targets | negative control: worker construction blocked, main fallback required |

Each condition begins with two unmeasured scale=1,dpr=1 captures. Unique scale/dpr values are used for
claim arms so every measured sample changes the compress memo key while keeping the **image** cache
warm; repeating scale=2 seven times would only measure the first miss and six compress-memo hits.

### Timing

Baseline and candidate live in separate pages/contexts of the **same Chromium process**. Every
measured pair is crossed AB/BA by `replicate + condition + sample` parity. The runner artifact
retains all seven raw pairs and exports one mean log(candidate/baseline) point per condition.
Aggregation consumes exactly one point per fresh VM.

### Route gates

Candidate route counters are read only through the local `afterRender(context)` plugin. Baseline
must expose no counter object. The harness fails when:

- `large-same` does not terminate at `memo`;
- either claim condition fails to execute `workerBlob > 0`, or executes `workerString`;
- `small-scale` executes any worker route;
- `large-csp` executes any worker route or fails to execute `main > 0`.

The CSP page permits its own external module/style/image resources and denies **only** workers:
`worker-src 'none'`. This avoids the old prototype's invalid negative control, whose default-src
policy could block the benchmark page itself.

### Route gates, asserted not eyeballed

The tallies are counted on the branch that actually ran. `workerBlob`/`workerString` are
incremented **after a `postMessage` that landed**, inside `workerDownsample`, past the memo hit,
the inflight share, the container-header probe, the size threshold and the worker-availability
check. A `postMessage` that *throws* is not credited: it falls through to the main thread and is
counted in `main`, because no worker ran. Counting Blob *presence* on the clone would credit the
Blob route for images that never reached a worker.

The harness fails, rather than reports, when:

- the `afterRender` plugin never published `__assetRoutes`;
- a `small` raster reports `workerBlob !== 0 || workerString !== 0`;
- `worker-src 'none'` still reports a worker route;
- `worker-src 'none'` with a large raster reports `main === 0` (the route closed but nothing took
  over, which would mean the gate broke the capture rather than rerouting it).

## 5. RSS, the settle gate, and the retention cap

### 5a. The 64 MiB cap is a hypothesis, not a policy

`MAX_IMAGE_BLOB_BYTES` is exported so this harness can record it in its provenance block and so the
value can be moved without hunting for a literal. **No measurement supports it.** It is a guess
that bounds obvious abuse and it must not be defended as correct.

The run's provenance records `retentionCapBytes` **and** `retentionCapStatus: "HYPOTHESIS"`. Read
the printed table before defending the number: if the claim arms (A2/A3) sit well above the null
arms (A1/B1/C1), the cap is too high and must be **lowered and re-run** before this ships.
Lowering costs nothing but the saving, because a dropped Blob leaves its data URL in place — so
the cap is the safe dial to turn when the RSS column disagrees with the timing column.

### 5b. Measuring it

Blobs are not JS-heap objects, so **`performance.memory` is not used at all**. RSS is measured from
Linux `/proc` over the entire Chromium process tree:

1. each side/condition launches a fresh `chromium.launchServer()`;
2. the BrowserServer root PID is mandatory;
3. `/proc/<pid>/task/<pid>/children` is walked recursively;
4. `VmRSS` is summed across the live tree;
5. **pre-capture** RSS settles after the page/source image is loaded but before snapDOM runs;
6. two unmeasured warm captures run, which is when AS-BLOB first retains the Blob;
7. **post-warmup** RSS settles; `postWarmup - preCapture` is the primary retention increment;
8. the seven unique-geometry captures run;
9. **post-sweep** RSS settles; this yields a secondary incremental sweep cost and total cost.

There is **no fallback** on non-Linux, missing `/proc`, missing BrowserServer PID, or a failure to
settle. Each memory side gets a fresh Chromium process so one module's retained Blob cannot
contaminate the other's RSS. Side order is crossed by runner/condition parity.

The six fresh-runner aggregate reports Student-t intervals for timing log ratios, the primary
`candidate warmup increment - baseline warmup increment`, the post-warm sweep difference, and the
total pre-capture→post-sweep difference. The 64 MiB retention cap remains a hypothesis regardless of
whether a single runner looks favorable.

## 6. What is proven without a browser, and what is not

**Proven browser-free:** 24 mechanism assertions in `npm run test:asset-proof` plus 15 R10 experiment/workflow/aggregate contracts (`node --test`), with no Playwright launch:

- the worker threshold has exactly one definition, shared by compress and the retention gate;
- a small payload retains **zero** blob bytes, even when told the worker could take it;
- `compress: false` and a closed worker route both retain zero blob bytes;
- the byte budget is **authoritative** — a swept Blob is returned as `undefined`, and a Blob added
  over budget is stored gone *and* reported gone, so the two can never disagree;
- the sweep is oldest-first, keeps every data URL, skips entries that already lost their Blob, and
  does not let a repeat capture re-pin its own payload;
- `cache: 'disabled'` clears payloads and Blobs together;
- `compressWorkerRouteSupported()` answers **immediately** with no construction, and is false
  unless *both* `Worker` and `OffscreenCanvas` exist — so a page without either retains nothing
  from its first capture;
- `dropRetainedImageBlobs()` clears every sidecar, reports its count, keeps all data URLs, and is
  idempotent. This is the CSP-first-capture path: `disableWorkers()` calls it the instant a
  construction fails, so dead native memory is not left behind waiting for a budget sweep that may
  never come.

**Not proven, and the reason:**

| Open | Why it cannot close here | Where it closes |
|---|---|---|
| The worker route is actually **reached** on `large-scale` / `large-dpr` | Needs a real capture and a real `postMessage` | §4 claim conditions: `__assetRoutes.workerBlob > 0` |
| The saving is real | Needs a clock | §4, paired AB/BA runner log-points across 6 fresh VMs |
| Retention does not regress RSS | Needs hosted Chromium native/process memory | §5 process-tree VmRSS |
| Pixels are unchanged | Needs a browser | Visual suite, `REQUIRE_VISUAL=1 BROWSER=all` |
| CSP `worker-src 'none'` really closes the route | Needs a real CSP | §4 `large-csp` |
| **The 64 MiB cap is the right value** | **No evidence either way** | **§5a: lower it if the RSS column says so** |
| A thrown `postMessage` lands in `main`, not `worker*` | `compress.js` is not importable by `node --test` (utils/css.js uses extensionless specifiers), so the counter's position relative to the `try` cannot be pinned without a bundler or a browser | A hosted arm, or a unit test with a stubbed `Worker` |
| The `64 KiB` worker threshold is still the right value | A sweep is a separate campaign | Not in scope |

## 7. Why retention is gated off rather than fed to the main thread

The alternative to arm C1's gate was to make the main-thread decode consume the Blob too. That
means replacing `new Image()` + `decode()` with `createImageBitmap(blob)` in `loadImage` — a
different decode path, with its own color-space and premultiplication behaviour, whose pixel
equivalence cannot be established without a browser. Fidelity is the project's second
non-negotiable and outranks a memory saving that only applies where the worker route is already
unavailable. The gate is a boolean read with no pixel surface. Recorded so a later change can
revisit it with a browser in hand.

## 8. Relationship to the rejected AS-SPLIT

`scripts/as-split-eviction-proof.mjs` (committed in `a470c65`) is the executed falsification of
giving the assembled `@font-face` CSS its own cache map: 12 avoided payload fetches over 400
captures, 12 over the next 200. The churn is self-limiting because a refetched payload re-inserts
at the FIFO tail. That mechanism stays rejected; this one replaces it.