# R12 ImageBitmap source-identity cache — native memory audit

Mechanism candidate (immutable): `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b`.
R10 AS-BLOB baseline: `d391556b80be7a6d97bc4834d2ce6e24137515b2`.

**Purpose:** quantify incremental OS-native proportional set memory (PSS), not JS heap.
Exact R10 assets-bench runs fresh Chromium BrowserServers per condition/side, uses
CDP process inventory, /proc/<pid>/smaps_rollup for PSS, stable PID:starttime and
settled windows. Six independent runners, matched AB/BA timing, warmup
retention, unique-geometry sweep and CSP negative-control difference-in-differences.

R12 has bounded 4MiB decoded ImageBitmap resources per worker, but **that accounting
is not an OS PSS limit**. Performance against AS-BLOB was measured separately on six
hosted Chromium VMs in run 37739851567, with -29.28% repeat-scale and -25.64%
repeat-width capture effects. Treat these as separate experiments.

Do not promote source until both process-set PSS and 3-engine R12 fidelity pass.
