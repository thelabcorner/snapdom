# AS-BLOB v2 — hosted evidence protocol

Mechanism candidate: `d391556b80be7a6d97bc4834d2ce6e24137515b2`
Frozen baseline: `c523ddb6e141846d55af1c8f315f65babbc32a7e`
Measurement branch: `perf/v3-r10-asset-frontier`

**Browser/performance work is GitHub-Actions-only.** Local work on this branch is limited to source
proofs, static contracts, algebra and orchestration. The measurement head is intentionally distinct
from the mechanism SHA: harness edits must never silently redefine the candidate.

## 1. Mechanism and scoped claim

AS-BLOB retains the `Blob` returned by `snapFetch` beside the memoized image data URL. On a
**repeat capture whose geometry changes the compression cache key**, the candidate can post the Blob
to the compression worker instead of structured-cloning a multi-megabyte base64 string and making
the worker decode that string back to bytes.

The claim is deliberately narrow:

- repeat capture;
- `cache: 'soft'`, `burst: false`, `compress: true`;
- source image cache already warm;
- compression geometry changes, so `cache.compress` misses;
- payload is at least `WORKER_MIN_PAYLOAD_CHARS`;
- worker route is healthy.

Expected no-op regimes:

- same-geometry repeat: compression memo returns before a worker;
- small payload: below worker threshold;
- `compress:false`;
- worker route unavailable / CSP-blocked;
- cold capture: the fetch already owns the Blob, so retention itself is not the claimed saving.

The 64 MiB `MAX_IMAGE_BLOB_BYTES` cap is a **hypothesis**, not accepted policy.

## 2. Immutable scientific identity

The hosted workflow records three independent identities:

- **measurementGitSha** — the harness/workflow commit;
- **candidateGitSha** — exact `d391556...`;
- **baselineGitSha** — exact `c523ddb...`.

The root checkout is the measurement head. Candidate and baseline are compiled from separate exact
sub-checkouts. The prepare job also verifies that all product/build inputs in the measurement head
remain byte-equivalent to the frozen candidate mechanism before any benchmark is admitted.

`prepared.json` freezes:

- bundle SHA-256s;
- Node and Playwright versions;
- mechanism constants;
- runner count = 6;
- paired timing samples = 8;
- warmups = 2;
- measurement-file SHA-256 manifest;
- GitHub run identity.

Every runner revalidates those identities, and the aggregate refuses missing, duplicated,
identity-mismatched or non-finite preregistered evidence.

## 3. Deterministic fixtures

No binary benchmark asset is committed.

Each fresh runner generates, before any browser launch/timing:

- **large** — 1200×800 deterministic high-entropy RGBA PNG; its data URL is asserted to exceed the
  worker threshold by more than 10×;
- **small** — 96×96 deterministic compressible PNG; asserted below the worker threshold.

Raw runner artifacts record dimensions, encoded bytes, data-URL character count and SHA-256.
Each page contains one image, so one capture must terminate in exactly one asset route.

## 4. Conditions

All captures explicitly use `cache:'soft'`, `burst:false`, `compress:true`,
`embedFonts:false`.

| condition | fixture | geometry | role |
|---|---|---|---|
| `large-same` | large | scale=1, dpr=1 | timing null; compression memo after warmup |
| `large-scale` | large | 8 unique scale targets, 1.15×…1.71× | primary claim path |
| `large-width` | large | 8 unique width targets, 1.10×…1.52× | second claim path through `options.width/rootWidth` |
| `small-scale` | small | 8 unique scale targets | below-threshold negative control |
| `large-csp` | large | 8 unique scale targets | matched worker-negative control |

`large-width` replaces the original `large-dpr` arm. The old DPR and scale arms were algebraically
the same effective density (`scale*dpr`) and therefore duplicated the same worker workload.

The CSP page permits the same script/style/image behavior as the normal page, including inline
styles, and changes only the intended worker permission: `worker-src 'none'`.

## 5. Timing acquisition

Baseline and candidate use separate pages/contexts in the **same hosted Chromium process**.

Each condition:

1. creates pages in crossed order;
2. performs two unmeasured warm captures per side;
3. measures 8 paired captures;
4. alternates AB/BA so every runner is exactly 4 candidate-first / 4 baseline-first.

The runner effect is an order-stratified mean:

```
L = 1/2 * (mean(log(C/B) | candidate first) +
           mean(log(C/B) | baseline first))
```

The artifact also records `orderBiasLog` as a first-position diagnostic.

### Primary vs secondary timer

The page records three timings from the same capture:

- **captureMs** — `snapdom(...)` through capture/compression completion (**primary**);
- **renderMs** — `result.toCanvas()`;
- **totalMs** — capture + canvas (**secondary end-to-end**).

This prevents symmetric canvas rasterization from diluting the mechanism-level estimand while
retaining the user-visible end-to-end effect.

## 6. Independent route proof

Candidate internal counters are read through a caller-local `afterRender(context)` plugin and never
added to the public CaptureResult API.

Additionally, **both candidate and frozen baseline pages instrument the browser Worker API before
their bundle imports**. Per-capture telemetry records:

- Worker construction attempts;
- successful construction;
- `postMessage`;
- worker messages;
- worker errors.

That closes the largest confound in the first hosted run: baseline `c523ddb` has no
`__assetRoutes`, so a silent baseline worker fallback could otherwise make the candidate look
artificially faster.

For one-image pages the candidate must terminate in exactly one route:

- same-geometry measured sample: `memo=1`;
- claim sample: `workerBlob=1`, `workerString=0`, `main=0`;
- small negative: `main=1`;
- CSP negative: `main=1`.

Claim captures for **both baseline and candidate** must independently show one worker post, one
worker response and zero worker errors. A post that lands but later times out/falls back no longer
passes the claim gate.

Warmup is also asserted:

- warmup #1 proves the expected worker/main route;
- warmup #2 proves the compression memo is actually warm.

## 7. Native-memory acquisition

JavaScript heap is not used as a proxy for Blob/native memory.

Each side/condition gets a **fresh Chromium BrowserServer process tree**. The long-lived timing
browser is closed before memory acquisition begins.

Three settled states are measured:

1. **initial** — page and source image loaded, before any snapDOM capture;
2. **warmed** — after the two matched warm captures; this is where candidate Blob retention exists;
3. **final** — after the unique-geometry sweep.

Primary memory effect per side:

```
retention growth = PSS(warmed) - PSS(initial)
```

Per-runner candidate effect:

```
candidate retention growth - baseline retention growth
```

### PSS, not summed VmRSS

The primary metric is summed `Pss:` from `/proc/<pid>/smaps_rollup` across the Chromium process
tree. PSS apportions shared pages instead of counting each mapping in full.

Diagnostics retained alongside PSS:

- summed `VmRSS`;
- summed `RssAnon + RssShmem`;
- process count;
- exact sorted `pid:starttime` identity set.

A settle window is accepted only when:

- the exact process identity set stays unchanged;
- the PSS range across the window is ≤1 MiB;
- five consecutive transitions at 500 ms intervals satisfy the window;
- sampling completes within the bounded 60-sample envelope.

Missing root process, incomplete procfs memory identity, missing PSS, process-tree churn that never
settles, or a vanished root fail closed.

Secondary memory diagnostics:

- post-warm sweep delta;
- total initial→final delta.

### Matched memory control

`large-csp` is the workload-matched retention-free control. The aggregate additionally reports,
for each claim arm, the runner-level difference-in-differences:

```
(C-B retention PSS)_claim - (C-B retention PSS)_large-csp
```

This is diagnostic evidence for the retained-Blob memory cost; it is **not** a post-hoc correction
to timing.

`large-same` is a timing null, **not a memory null**: the first candidate capture still retains the
large Blob even though later captures hit the compression memo.

## 8. First hosted evidence — historical run `37098613822`

Measurement head: `cc8beb7e95cdb3c7883cd56f0467a45a8912a151`
Candidate mechanism: exact `d391556...`
Baseline: exact `c523ddb...`
Fresh Chromium runners: 6/6 complete.

This first run used the earlier VmRSS memory implementation and did **not** independently instrument
the baseline worker route, so its timing result is strong hypothesis evidence but not final
promotion evidence; its memory result is superseded by the PSS confirmation protocol above.

Runner-level timing:

| condition | capture effect | 95% runner CI | end-to-end effect | 95% runner CI |
|---|---:|---:|---:|---:|
| `large-same` | +0.99% | [-0.76,+2.77]% | +0.56% | [-1.37,+2.52]% |
| `large-scale` | **-57.36%** | **[-59.38,-55.25]%** | **-48.20%** | **[-50.45,-45.84]%** |
| `large-dpr` (now retired duplicate) | **-56.58%** | **[-56.89,-56.28]%** | **-46.77%** | **[-47.25,-46.29]%** |
| `small-scale` | +0.22% | [-5.83,+6.66]% | +0.08% | [-5.66,+6.17]% |
| `large-csp` | +2.45% | [-7.25,+13.17]% | +1.15% | [-7.14,+10.17]% |

The large claim-path effect is orders of magnitude beyond the same-geometry and small-payload nulls.
The confirmation run exists to close the remaining baseline-route and native-memory confounds—not
because the first timing signal was marginal.

Historical VmRSS retention point estimates were near zero on `large-scale`, but that methodology
double-counted shared Chromium mappings and is **not used to certify the cap**.

## 9. Browser-free proof surface

Current local work executes no browser.

The contract suite proves, among other things:

- deterministic fixture threshold membership;
- Blob retention gate and byte-budget authority;
- sidecar purge semantics;
- candidate/baseline/measurement identity separation;
- retry-stable artifacts;
- exact 4/4 AB/BA balance;
- distinct scale and width geometry paths;
- procfs status/PSS/start-time parsing;
- process-tree PSS aggregation;
- root disappearance fails closed;
- PID/process-set churn cannot masquerade as stable memory;
- monotone PSS drift times out fail-closed;
- one complete point per preregistered runner;
- wrong measurement identity, fixture drift, missing/non-finite timing or memory evidence all produce
  `INCOMPLETE_EVIDENCE`.

## 10. Remaining hosted falsifiers

The confirmation run must still answer:

1. Does the frozen baseline independently execute and complete its worker route on every claim sample?
2. Does the candidate independently execute and complete the Blob worker route with no main fallback?
3. Does the large timing effect reproduce under exact route telemetry and the width-branch claim?
4. Do null/control timing intervals remain compatible with no material effect?
5. What is the PSS cost of retained Blobs, including the matched `large-csp` difference-in-differences?
6. Does the 64 MiB cap need to be lowered before any production merge?
7. Do existing hosted cross-browser fidelity suites remain exact after the mechanism is integrated?

No promotion threshold is invented after seeing the data. The R10 experiment remains evidence
collection; production admission stays subordinate to the R9 fail-closed governor and fidelity
requirements.
