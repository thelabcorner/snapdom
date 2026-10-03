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

Two, both committed, both on one page so a single capture exercises both gates:

- `lane6-scratch/r10/fixtures/fixture-large.jpg` — 2400x1600. Inlined it is well past 64 KiB of
  base64, so its Blob is retained and the worker route is reachable.
- `lane6-scratch/r10/fixtures/fixture-small.png` — 96x96, a few hundred bytes. Far under the
  threshold: **no Blob may be retained for it**, and `__assetRoutes.workerBlob` must stay 0.

The small fixture makes the red team's "small images retain zero blobs" requirement observable end
to end rather than only at the cache. They are fixtures, not product assets.

## 4. Arms

`cache: 'soft'` is passed explicitly on every arm so the matrix cannot drift onto a future
default. `burst: false`, so every capture runs the full asset phase — a burst memo serve skips
`compressCloneAssets` entirely and would make the arm measure nothing.

| # | fixture | CSP | geometry | What it decides |
|---|---|---|---|---|
| A1 | large | none | `scale 1` x3, `dpr 1` | **null arm.** Memo answers every capture. Must show no delta. |
| A2 | large | none | `scale 1` then `scale 2` | **the claim.** Memo key changes, Blob route becomes reachable. |
| A3 | large | none | `scale 1`, `dpr 1` then `dpr 2` | Same, via density rather than `scale`. |
| B1 | small | none | `scale 1` then `scale 2` | Must show no delta: no Blob is retained, so geometry cannot matter. |
| C1 | large | `worker-src 'none'` | `scale 1` then `scale 2` | Worker route closed. `workerBlob === 0`, `main > 0`, and **no delta** — retention is gated off. |
| C2 | large | none | `scale 1` then `scale 2`, `compress: false` | Same: `compress` off retains nothing and takes no route. |
| D | large | none | `cache: 'disabled'` | Parity with C2. Proves the gate, not the budget, disables retention. |

Each arm: `WARMUP` unmeasured captures, an RSS settle gate, then `REPEATS` measured captures per
geometry step. Report the **median**, never a mean — one scheduler spike should not define an arm.
Compare A2/A3 against A1; compare B1 against A2 for the small-raster null.

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

Blobs are not JS-heap objects: they live in the browser's blob store, so `performance.memory`
under-reports what retention actually costs. Chromium's `usedJSHeapSize` is the only figure
available from page script. Treat it as a **lower bound** and say so.

- Sample `performance.memory.usedJSHeapSize` every 250 ms.
- Settled = at least `RSS_SETTLE_SAMPLES` (3) consecutive samples within `RSS_SETTLE_DELTA`
  (2 MiB) of their predecessor, up to 120 samples (30 s) before giving up.
- Report `rssAfter - rssBefore` per arm; require A1/B1/C1 deltas to be statistically
  indistinguishable from each other. Only A2/A3 should sit higher.
- **Chromium only.** Firefox has no `performance.memory`, and WebKit's numbers are not comparable
  across versions. This arm is chromium-exclusive and reported as such.

The settle gate matters more here than usual: an arm that samples heap while the previous arm's
decodes are still outstanding will attribute another arm's garbage to this one.

The harness prints `median ms`, `settled RSS delta` and the last capture's route tally side by
side, so route reachability and cost are reviewable in one table.

## 6. What is proven without a browser, and what is not

**Proven here** (`npm run test:asset-proof`, 21 assertions, `node --test`, no Playwright):

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
| The worker route is actually **reached** on A2 | Needs a real capture and a real `postMessage` | §4 A2: `__assetRoutes.workerBlob > 0` |
| The saving is real | Needs a clock | §4, medians over `REPEATS` |
| Retention does not regress RSS | Needs a browser heap and blob store | §5 |
| Pixels are unchanged | Needs a browser | Visual suite, `REQUIRE_VISUAL=1 BROWSER=all` |
| CSP `worker-src 'none'` really closes the route | Needs a real CSP | §4 C1 |
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