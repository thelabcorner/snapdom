// Runner-level statistics for F4. Extracted from the calibrated R9 self-null aggregation so the
// two lanes cannot drift apart, and kept free of I/O so the contracts can test the arithmetic
// without a browser, a network or a runner.
//
// The unit of observation is ONE LOG POINT PER FRESH RUNNER. Per-call and per-block rows never
// cross a VM boundary: pooling them would treat one runner's 24 blocks as 24 independent
// observations and shrink the interval by the square root of the replicate count, which is the
// single easiest way to manufacture a 1% claim out of a 5% instrument.

export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function variance(xs) {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
}

export function sd(xs) {
  return Math.sqrt(variance(xs))
}

export function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const T975 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093,
  20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042,
}

export function t975(df) {
  return T975[Math.min(30, Math.max(1, df))] ?? 1.96
}

export function pct(logRatio) {
  return (Math.exp(logRatio) - 1) * 100
}

/** Student-t 95% interval over one log point per runner. */
export function runnerCi(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('runnerCi needs at least two runner log points')
  }
  if (points.some((x) => !Number.isFinite(x))) {
    throw new Error('runnerCi refuses a non-finite runner log point')
  }
  const m = mean(points)
  const s = sd(points)
  const se = s / Math.sqrt(points.length)
  const h = t975(points.length - 1) * se
  return {
    n: points.length,
    logPoint: m,
    pct: pct(m),
    runnerSdLog: s,
    seLog: se,
    logCi95: [m - h, m + h],
    ci95: [pct(m - h), pct(m + h)],
  }
}

/** DerSimonian-Laird style heterogeneity, exactly as the R9 calibration computed it: the
 *  between-runner variance left after subtracting the average within-run variance. */
export function heterogeneity(points, withinVars) {
  if (points.length !== withinVars.length) {
    throw new Error('heterogeneity needs one within-run variance per runner')
  }
  const runnerVar = variance(points)
  const tau2 = Math.max(0, runnerVar - mean(withinVars))
  const weights = withinVars.map((v) => 1 / Math.max(v, 1e-12))
  const wsum = weights.reduce((a, b) => a + b, 0)
  const fixed = points.reduce((a, x, i) => a + x * weights[i], 0) / wsum
  const Q = points.reduce((a, x, i) => a + weights[i] * (x - fixed) ** 2, 0)
  const df = points.length - 1
  return { Q, df, I2: Q > 0 ? Math.max(0, (Q - df) / Q) : 0, tau2, tauLog: Math.sqrt(tau2) }
}

/** The outer envelope check: a NULL quantity is admissible only when its point estimate AND both
 *  confidence-interval endpoints stay inside the band. Taking the endpoints is the point — a
 *  centred null with a wide interval is exactly the shape an envelope is meant to catch. */
export function envelopeBreachesPct(quantity, bandPct) {
  const values = [quantity.pct, ...(quantity.ci95 || [])]
  return values.map((v) => Math.abs(v)).reduce((worst, v) => Math.max(worst, v), 0) - bandPct
}

export function withinEnvelope(quantity, bandPct) {
  return envelopeBreachesPct(quantity, bandPct) <= 0
}