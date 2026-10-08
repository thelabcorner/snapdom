# R23 — balanced same-source null for ancestor memo native-memory confirmation

## Motivation

R22's preregistered 12-host run selected an image-homogeneous 8-host cohort and measured candidate-vs-baseline post-sweep process PSS **-0.56 MiB**, CI [-1.30,+0.30]. However its *same-source* A/A control, evaluated ONLY as first baseline browser then second baseline browser, showed +2.13 MiB, CI [+0.76,+4.06]. That positive null is evidence of temporal/positional or environmental bias, NOT evidence of an R20 memory leak. R22 remains unmodified and is labeled EVIDENCE_ONLY.

## New preregistered protocol

- Immutable oracle `cac07a4108086718bc9511663346e1b9fcf4e226`; unchanged R20 source `f1259ab411890f8c0a10d5a35b83ef5ec5c56e04`; test-only R23 branch.
- Twelve fresh independent GitHub-hosted Ubuntu-24.04 Chromium VMs; each reports `ImageOS` and `ImageVersion`.
- Exactly two baseline/candidate matched process-family pairs in balanced AB/BA order, plus **two baseline/baseline pairs with artificial labels X/Y in opposite XY and YX orders**.
- First null pair XY executes *before* both treatment pairs; second null pair YX executes *after* them. Thus a monotonic first-to-second browser process bias changes sign and should cancel in the average null contrast. This is a paired design, not an assertion that all environmental drift is removed.
- Each browser process family runs the same deterministic DOM, 4 warm captures, GC-settled PSS, then 32 explicitly style-invalidated captures and post-sweep GC-settled PSS.
- Every paired comparison requires exact SHA-256 of SVG output at checkpoints. Candidate CSS ancestor memo must be exercised on all sampled captures; baseline null has no memo mechanism.
- Native memory: full Chromium descendant process-tree PSS including workers and GPU/renderer children, plus renderer PSS and warmed-to-swept delta.
- Only after all twelve host artifacts have passed integrity checks, choose the largest image-only cohort (lexical tie break), require >=6 hosts, and report all excluded hosts. **No cross-image pooling, no early host/stratum selection based on memory effects.**
- One runner-level AB/BA averaged treatment point and one runner-level XY/YX averaged null point per host. Use 20,000 fixed-seed host-cluster bootstrap draws for 95% intervals.
- Fail on incomplete cohort, missing or unbalanced null orders, source-hash mismatch, nonfinite samples, telemetry absence, or invalid null statistics.
- An A/A null 95% CI excluding zero or with uncertainty exceeding treatment signal leaves memory **UNACCEPTED**. A null crossing zero also does not establish automatic acceptance; production memory-budget and real-page acceptance remain open.
- No changes to `src/`; no automatic merging/promotion. This is the independent repair of R22's positional-noise blocker.

## Success criterion

A completed R23 acceptance run with exact source fidelity, all 12 artifacts, a homogeneous >=6-runner cohort, and a balanced null centered around zero would make the process-PSS results substantially more interpretable. It cannot by itself prove whole-library memory dominance or cross-engine fidelity; R21 has separate validated browser evidence. A residual systematic null or wide CI demands further experimental design, not relaxing the gate.
