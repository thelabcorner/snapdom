// Adaptive post-install settle, as pure policy so the loop can be tested without waiting for it.
//
// Why it exists: `playwright install --with-deps` spikes CPU and disk on the runner, and the
// ambient gate samples immediately afterwards. A blocked gate that was really just an install
// still burns a full cell of public runner minutes and records INCOMPLETE evidence, which is
// indistinguishable in the artifact from a genuinely busy machine.
//
// Shape, preregistered: three consecutive samples, one second apart, each at or under 20%
// utilisation, up to a 30 second ceiling. Adaptive means it returns the moment the window is
// clean rather than always burning the full ceiling. The 20% figure is the same peak threshold the
// ambient gate already applies, so settle and gate agree about what "quiet" means.

export function createSettlePlan(policy) {
  const s = policy.settle
  if (!Number.isInteger(s.samples) || s.samples < 1) throw new Error('settle.samples must be a positive integer')
  if (!Number.isInteger(s.intervalMs) || s.intervalMs < 1) throw new Error('settle.intervalMs must be a positive integer')
  if (!(s.maxUtilizationPct > 0)) throw new Error('settle.maxUtilizationPct must be positive')
  if (!(s.maxWaitMs >= s.intervalMs * s.samples)) throw new Error('settle.maxWaitMs cannot be shorter than one window')
  return {
    window: s.samples,
    intervalMs: s.intervalMs,
    cap: s.maxUtilizationPct,
    maxWaitMs: s.maxWaitMs,
    maxSamples: Math.floor(s.maxWaitMs / s.intervalMs),
  }
}

/** Settled once the most recent `window` samples are ALL at or under the cap. */
export function evaluateSettle(samples, plan) {
  if (samples.length < plan.window) {
    return { settled: false, reason: 'WINDOW_INCOMPLETE', window: samples.slice(-plan.window) }
  }
  const window = samples.slice(-plan.window)
  const peak = Math.max(...window)
  return peak <= plan.cap
    ? { settled: true, reason: 'SETTLED', peak, window }
    : { settled: false, reason: 'BUSY', peak, window }
}

export function shouldStop({ elapsedMs, samples, plan }) {
  if (elapsedMs >= plan.maxWaitMs) return { stop: true, reason: 'MAX_WAIT_REACHED', settled: false }
  const verdict = evaluateSettle(samples, plan)
  if (verdict.settled) return { stop: true, reason: 'SETTLED', settled: true, peak: verdict.peak }
  return { stop: false, reason: verdict.reason, settled: false }
}