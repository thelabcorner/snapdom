/**
 * Run independent async jobs with at most `ceiling` active, admitting the next one as
 * soon as any finishes. Matches Promise.allSettled's per-item error isolation, without
 * fixed batch head-of-line waits or allocating an array/promise for every item.
 *
 * `visit` receives stable input indices (caller controls DOM order). Errors in one
 * image/fallback do not prevent unrelated images from completing.
 */
export async function runBoundedSettled(count, visit, ceiling = 6) {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('invalid work count')
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new RangeError('invalid concurrency ceiling')
  let cursor = 0
  const consume = async () => {
    for (;;) {
      const index = cursor++
      if (index >= count) return
      try { await visit(index) } catch { /* independent asset: Promise.allSettled semantics */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, ceiling) }, consume))
}
