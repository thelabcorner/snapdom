/**
 * Browser-free structural contract for the R9 hosted topology challenge workflow and policy.
 *
 * This is a TEXTUAL/STRUCTURAL audit, not a YAML parse: the repository has no YAML dependency and
 * adding one to guard a benchmark harness would be the wrong trade. Every rule here is a property
 * that must survive edits to the workflow file, and each one exists because breaking it silently
 * would produce evidence that looks valid and is not.
 *
 * The rules that matter most:
 *   - artifact identity is keyed on `github.run_id`, never `github.run_attempt`, so a re-run of one
 *     cell OVERWRITES its own evidence instead of producing a second, competing copy of the same
 *     matrix cell;
 *   - every third-party action is pinned to a 40-hex commit;
 *   - the checkout is the exact measured SHA and the workflow asserts it;
 *   - the closeout cannot promote, merge or push.
 */

const SHA_RE = /\b[0-9a-f]{40}\b/

export function auditWorkflow(text) {
  const problems = []
  const lines = text.split(/\r?\n/)
  const trimmed = lines.map(l => l.trim())

  const add = (m) => problems.push(m)

  if (!/^name:\s*\S/m.test(text)) add('workflow has no name')
  if (!/permissions:\s*\n\s+contents:\s*read/.test(text)) add('workflow must request contents: read only')
  if (/contents:\s*write/.test(text)) add('workflow must not request write permissions')

  const runsOn = trimmed.filter(l => l.startsWith('runs-on:')).map(l => l.slice('runs-on:'.length).trim())
  if (!runsOn.length) add('no runs-on declaration: hosted-only provenance is unprovable')
  for (const r of runsOn) {
    if (r !== 'ubuntu-24.04') add(`non-pinned runner label: ${r}`)
  }
  if (/self-hosted/i.test(text)) add('self-hosted runners are not admitted')

  if (!/fetch-depth:\s*1/.test(text)) add('checkout must pin fetch-depth: 1')
  if (!/ref:\s*\$\{\{\s*env\.CANDIDATE_SHA\s*\}\}/.test(text)) add('checkout must use the exact measured SHA')
  if (!/git rev-parse HEAD/.test(text)) add('workflow must assert the checked-out HEAD equals the measured SHA')

  const uses = trimmed.filter(l => l.startsWith('uses:')).map(l => l.slice('uses:'.length).trim())
  if (!uses.length) add('no actions pinned')
  for (const u of uses) {
    if (!u.includes('@')) { add(`unpinned action: ${u}`); continue }
    if (!SHA_RE.test(u.slice(u.lastIndexOf('@') + 1))) add(`action is not pinned to a 40-hex commit: ${u}`)
  }

  // Retry-stable per-cell evidence.
  if (/github\.run_attempt/.test(text)) {
    add('run_attempt appears in the workflow: cell evidence must be keyed on run_id so a retry overwrites its own cell')
  }
  if (!/github\.run_id/.test(text)) add('artifact identity must be keyed on github.run_id')
  const artifactNames = [...text.matchAll(/name:\s*(r9-tc-[^\n]*)/g)].map(m => m[1])
  if (!artifactNames.length) add('no r9-tc-* artifact names found')
  for (const n of artifactNames) {
    if (!n.includes('github.run_id')) add(`artifact name is not keyed on run_id: ${n}`)
  }
  const uploadBlocks = [...text.matchAll(/^[ \t]*uses:\s*actions\/upload-artifact@.*$/gm)]
  for (const m of uploadBlocks) {
    // Bound the scan at the next step so the check does not depend on YAML formatting width.
    const rest = text.slice(m.index)
    const nextStep = rest.slice(1).search(/^[ \t]*- name:/m)
    const step = nextStep < 0 ? rest : rest.slice(0, nextStep + 1)
    if (!/overwrite:\s*true/.test(step)) add('an upload-artifact step does not set overwrite: true, so a cell retry cannot replace its own evidence')
  }
  if (!/pattern:\s*r9-tc-sample-\*-\$\{\{\s*github\.run_id\s*\}\}/.test(text)) {
    add('closeout must download the per-cell samples by a run_id-keyed pattern')
  }

  if (!/fail-fast:\s*false/.test(text)) add('matrix jobs must set fail-fast: false so one blocked cell cannot cancel the others')
  if (!/max-parallel:/.test(text)) add('matrix concurrency must be explicitly capped')
  if (!/cancel-in-progress:\s*false/.test(text)) add('concurrency must not cancel in progress: a cancelled cell is missing evidence')

  for (const job of text.matchAll(/timeout-minutes:\s*(\d+)/g)) {
    if (Number(job[1]) < 30) add(`job timeout too small for this workload: ${job[1]}`)
  }
  if (!/timeout-minutes:/.test(text)) add('no job timeout declared')

  if (!/npx playwright install --with-deps chromium/.test(text)) add('the challenge must pin and install chromium explicitly')
  if (/playwright install[^\n]*firefox|playwright install[^\n]*webkit/.test(text)) {
    add('the challenge is chromium-only by preregistration; installing other engines widens the matrix without a preregistered question')
  }

  if (!/node lane6-scratch\/r9-calibration\/challenge\/aggregate\.mjs/.test(text)) add('closeout must run the challenge aggregate')
  if (!/node --test/.test(text)) add('the browser-free algebra must run in CI before any runner is spent')
  if (!/node --test[^\n]*challenge\/algebra\/topology-challenge\.test\.mjs/.test(text)) {
    add('the challenge-specific browser-free contract test must run in CI before any runner is spent')
  }

  // Settle then ambient gate, both wrapping the harness, in that order. Only an EXECUTED `node ...`
  // line counts: a bare path in the `paths:` filter must not be able to satisfy the rule. The last
  // such line is the one that runs, so ordering is decided on the actual commands.
  const lastRunLine = (needle) => {
    const hits = [...text.matchAll(new RegExp(`^[^\\n]*node[^\\n]*${needle}[^\\n]*$`, 'gm'))]
    return hits.length ? hits[hits.length - 1].index : -1
  }
  const settleAt = lastRunLine('r9-calibration/settle\\.mjs')
  const gateAt = lastRunLine('run-with-timing-gate\\.mjs')
  const benchAt = lastRunLine('challenge/run\\.mjs')
  if (settleAt < 0) add('adaptive post-install settle phase is missing')
  if (gateAt < 0) add('ambient CPU gate is missing')
  if (benchAt < 0) add('challenge runner is missing')
  if (settleAt >= 0 && gateAt >= 0 && settleAt > gateAt) add('settle must precede the ambient gate')
  if (gateAt >= 0 && benchAt >= 0 && gateAt > benchAt) add('the ambient gate must wrap the benchmark, not follow it')

  // No step may write to the repository. This is a check on COMMANDS, not on prose: the challenge
  // legitimately has to talk about promotion policy without being able to act on it.
  for (const line of lines) {
    if (/^\s*(git\s+(push|merge|commit|apply|am)\b|gh\s+(pr|release|repo|workflow)\b)/.test(line)) {
      add(`repository write command in the workflow: ${line.trim()}`)
    }
  }

  return { problems, lines: lines.length }
}

export function auditPolicy(policy) {
  const problems = []
  const add = (m) => problems.push(m)
  if (policy.schema !== 'snapdom-r9-hosted-topology-challenge-v1') add('policy schema mismatch')
  if (!policy.repository) add('policy must pin the repository identity')
  if (!/^\d+\.\d+\.\d+$/.test(policy.playwrightVersion || '')) add('Playwright must be an exact x.y.z')
  if (!/^v?\d+\.\d+\.\d+$/.test(policy.nodeVersion || '')) add('Node must be an exact version')

  const chromium = policy.replicates?.chromium
  const floor = policy.minimumFreshRunners ?? 8
  if (!Number.isInteger(chromium) || chromium < floor) {
    add(`chromium replicates must be an integer >= ${floor} fresh runners, got ${chromium}`)
  }

  const required = ['light-20cards', 'cards400-safe', 'cards400-non-neutral']
  for (const f of required) if (!policy.fixtures?.includes(f)) add(`focus fixture missing from the policy: ${f}`)

  if (!Array.isArray(policy.lanes) || policy.lanes.length !== 6) add('policy must declare exactly the six preregistered lanes')
  if (new Set(policy.lanes || []).size !== (policy.lanes || []).length) add('duplicate lane in the policy')

  const pc = policy.positiveControl || {}
  if (pc.expectedSign !== 'positive') add('positive-control expected sign must be preregistered as positive')
  if (pc.predictedMagnitudePct !== null) add('the positive-control magnitude must stay null: a calibrated number here would be an invented threshold')
  if (!/additive/i.test(pc.expectedEffectClass || '')) add('the positive-control effect class must be preregistered as additive')
  if (!Array.isArray(pc.doses) || pc.doses.length !== 2) add('the positive control must declare exactly two predeclared doses')
  else {
    const [lo, hi] = pc.doses
    if (!(lo.iterations > 0 && hi.iterations > lo.iterations)) add('dose work counts must be positive and increasing')
    if (hi.iterations !== lo.iterations * 4) add('the two doses must be a fixed 4x apart in work units so the ratio is predeclared')
    for (const d of pc.doses) {
      if (!Number.isInteger(d.iterations)) add(`dose ${d.name} iterations must be an integer work count`)
    }
  }

  if (!policy.settle || typeof policy.settle !== 'object') add('policy must carry its own settle configuration')

  for (const [name, profile] of Object.entries(policy.sampling || {})) {
    if (!profile || typeof profile !== 'object') { add(`sampling profile ${name} missing`); continue }
    if (!Number.isInteger(profile.warmup) || profile.warmup < 0) add(`sampling.${name}.warmup invalid`)
    for (const lane of policy.lanes || []) {
      const blocks = profile.blocks?.[lane]
      const batch = profile.batch?.[lane]
      if (!Number.isInteger(blocks) || blocks < 1) add(`sampling.${name}.blocks.${lane} invalid`)
      if (!Number.isInteger(batch) || batch < 1) add(`sampling.${name}.batch.${lane} invalid`)
    }
  }

  return { problems }
}
