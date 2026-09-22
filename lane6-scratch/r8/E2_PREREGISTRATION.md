# R8-E2: occurrence-count admission (isolated spike)

Parent: certified SO1+FP1 integration `58b97b0`. Branch: `perf/v3-r8-p1-breakeven`.

E1 first admitted at occurrence **4**, not 3. Its unique-style quad control regressed
+4.16% CI [2.93, 5.37]. E2 counts occurrences explicitly (`seen: 1`, then increment)
and admits at **5**. This is a bounded hypothesis, not a proof of amortization: past
repetitions do not reveal future reuse. Five-only and six-only unique-style controls
must accompany the quad kill cell so that moving the regression cannot pass unnoticed.

The two internal flags are opt-in: `__styleSharePseudoOverlay: true` and
`__styleSharePseudoKeyCache: true`. Both false (or omitted) retain the R7 copy path,
including eager share-list signature construction and historical `getStyleKey`.
The 16-miss circuit breaker and identity-local recovery are retained from E1.

## Gates registered before timing

1. Chromium/Firefox/WebKit exact raw-byte parity, with independently exercised flags,
   explicit no-allocation checks through occurrence 4, actual cache seeding at 5 and
   a hit at 6. Include empty riders, min-width signature repair, flex/grid/percent,
   state veto, CSSOM invalidation, shadow content, breaker recovery and a fresh capture.
2. Compare candidate/default and candidate/opt-in outputs with a separately compiled
   certified R7 bundle. Hash both inputs; do not use a renamed candidate as the base.
3. Full public-fork decision run, Chromium, N=20 per crossover layout, batch=3,
   warmup=3, 12000 seeded bootstrap draws, epsilon=2%. Preserve every raw sample.
   Same-bundle option-only candidate comparison plus full-copy null; retain a
   certified-bundle comparison to expose common-mode changes.
4. Required workloads: E1's 14 cells (repeat/mixed/pair/unique-pair/unique-triple/
   unique-quad/entropy/before-only/flex/percent/state-veto/no-pseudo/breaker-tail)
   plus unique-five and unique-six controls. No adaptive workload deletion.
5. A win needs exact parity, ambient gate PASS, null CI spanning zero, CoV <15%,
   and candidate CI entirely below -2%. Clean regressions reject the candidate;
   inconclusive protected cells cannot be described as certified non-regression.
   No reruns of rejected E1 and no promotion based on ungated workstation timing.

Status: implementation/oracle work in progress; no E2 performance claim.
