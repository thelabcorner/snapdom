# R8-D1 decision-quality experiment — exact invocation

Candidate: `dist/snapdom.mjs` (D1 = document-level auto-margin proof caching)
Historical arm: `__autoMarginDocProofCache=false`
Candidate arm: `__autoMarginDocProofCache=true` (production default)

Both arms load the SAME bundle; only the internal counterfactual differs, so the crossover
measures D1's marginal effect with everything else held constant.

## Local (homelab / workstation, only when the ambient gate passes)

```
node lane6-scratch/r5/run-with-timing-gate.mjs -- \
  node lane6-scratch/r5/bench-r7-option-pair-controlled.mjs \
  --candidate=dist/snapdom.mjs \
  --base=__autoMarginDocProofCache=false \
  --opt=__autoMarginDocProofCache=true \
  --out=r8-d1-controlled.json \
  --label=R8-D1 \
  --browser=chromium --n=20 --batch=3 --warmup=3 --bootstrap=12000 --epsilon=0.02
```

## Public-fork Actions (authoritative venue)

The `r7-timing.yml` workflow already exposes an `option-pair` bench choice with a free-form
`extra` input, so no workflow change is required. Dispatch with:

```
bench  = option-pair
browser = chromium
n      = 20
batch  = 3
extra  = --base=__autoMarginDocProofCache=false --opt=__autoMarginDocProofCache=true --out=r8-d1-controlled.json --label=R8-D1
```

## Acceptance (pre-registered, unchanged from the campaign contract)

- exact raw parity in both crossover arms
- independent historical/historical null whose 95% CI spans zero
- max CoV < 15%
- candidate 95% CI upper bound < -2.0% to claim a win
- candidate 95% CI lower bound > +2.0% => regression => REJECT
- ambient gate must PASS; a blocked run consumes no timing and is a non-result

## Status

Oracles: PASS (36/36 cross-engine exact raw parity; 216/216 regression surface).
Timing: NOT YET RUN.
Promotion: NOT CLAIMED. D1 remains unpromoted until the above clears on the public fork.
