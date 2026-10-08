#!/usr/bin/env node
/**
 * R11 AS-BLOB cross-engine FIDELITY acceptance: provenance freeze.
 *
 * Everything the hosted gate is allowed to believe is written here, once, from the exact inputs the
 * job checked out. A runner re-verifies every line of it before it opens a browser, and the
 * aggregate re-verifies the runners against it again, so a verdict can never rest on a bundle, a
 * fixture, a harness file, a threshold or a cell matrix that moved after admission.
 *
 * What is frozen:
 *  - three independent git identities: measurement head, exact candidate d391556, exact baseline
 *    c523ddb. The measurement head is this harness's commit and is deliberately NOT the mechanism;
 *  - the SHA-256 and byte length of both compiled bundles;
 *  - the SHA-256, byte length and geometry of every deterministic fixture, plus the assertion that
 *    the eviction pair really overshoots MAX_IMAGE_BLOB_BYTES and lands under it after one drop;
 *  - the mechanism constants read from src/core/cache.js at the measurement head, which is the same
 *    source the candidate bundle was compiled from;
 *  - a SHA-256 manifest of every harness file, including this one;
 *  - the cell matrix digest and the ordered cell id list;
 *  - the raw-output inline limit, so the runner cannot quietly switch to digest-only comparison;
 *  - Node and Playwright versions.
 *
 * No browser is launched here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  BASELINE_SHA,
  CANDIDATE_SHA,
  CELL_IDS,
  CELLS,
  ENGINES,
  FIXTURES,
  PIXEL_CONVENTIONS,
  PREPARED_SCHEMA,
  SELF_NULL_CONTEXTS,
  assertHostedOnly,
  cellMatrixSha256,
  dataUrlCharsForBytes,
  fixtureBytes,
  sha256,
} from './fidelity-lib.mjs'
import { MAX_IMAGE_BLOB_BYTES, WORKER_MIN_PAYLOAD_CHARS } from '../../src/core/cache.js'

// No browser is launched here, but provenance for a hosted-only gate is only meaningful where the
// gate runs: freezing it locally would let a local prepared.json be mistaken for an admitted one.
assertHostedOnly(process.env)

const ROOT = process.cwd()
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '='
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const baselineRel = arg('baseline', 'lane6-scratch/r11/bundles/baseline.mjs')
const candidateRel = arg('candidate', 'lane6-scratch/r11/bundles/candidate.mjs')
const outRel = arg('out', 'lane6-scratch/r11/prepared.json')
const baselinePath = path.resolve(ROOT, baselineRel)
const candidatePath = path.resolve(ROOT, candidateRel)
const outPath = path.resolve(ROOT, outRel)

for (const file of [baselinePath, candidatePath]) {
  if (!fs.existsSync(file)) throw new Error('prepared bundle missing: ' + path.relative(ROOT, file))
}

const measurementGitSha = process.env.SNAPDOM_MEASUREMENT_GIT_SHA || process.env.GITHUB_SHA || ''
const candidateGitSha = process.env.SNAPDOM_CANDIDATE_GIT_SHA || CANDIDATE_SHA
const baselineGitSha = process.env.SNAPDOM_BASELINE_GIT_SHA || BASELINE_SHA
for (const [label, value] of Object.entries({ measurementGitSha, candidateGitSha, baselineGitSha })) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('exact ' + label + ' missing: ' + JSON.stringify(value))
}
if (candidateGitSha !== CANDIDATE_SHA) throw new Error('candidate SHA is not the frozen d391556')
if (baselineGitSha !== BASELINE_SHA) throw new Error('baseline SHA is not the frozen c523ddb')

const measurementFiles = [
  '.github/workflows/r11-fidelity.yml',
  'lane6-scratch/r11/fidelity-lib.mjs',
  'lane6-scratch/r11/fidelity-run.mjs',
  'lane6-scratch/r11/fidelity-aggregate.mjs',
  'lane6-scratch/r11/prepare.mjs',
  'lane6-scratch/r10/asset-bench-lib.mjs',
]
const fileIdentity = {}
for (const rel of measurementFiles) {
  const abs = path.resolve(ROOT, rel)
  if (!fs.existsSync(abs)) throw new Error('harness file missing: ' + rel)
  fileIdentity[rel] = sha256(fs.readFileSync(abs))
}

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version

const rawInlineLimit = 256 * 1024

// ---- fixtures: generated, hashed, and their threshold membership asserted ----
const fixtures = {}
for (const name of Object.keys(FIXTURES)) {
  const bytes = fixtureBytes(name)
  const spec = FIXTURES[name]
  fixtures[name] = {
    width: spec.width,
    height: spec.height,
    seed: spec.seed,
    entropy: spec.entropy,
    box: spec.box,
    bytes: bytes.length,
    dataUrlChars: dataUrlCharsForBytes(bytes.length),
    sha256: sha256(bytes),
  }
}
const evictA = fixtures.evictA.bytes
const evictB = fixtures.evictB.bytes
if (!(evictA + evictB > MAX_IMAGE_BLOB_BYTES)) {
  throw new Error(
    'eviction fixtures no longer overshoot MAX_IMAGE_BLOB_BYTES: ' + (evictA + evictB) +
    ' vs ' + MAX_IMAGE_BLOB_BYTES,
  )
}
if (!(evictA + evictB - Math.max(evictA, evictB) <= MAX_IMAGE_BLOB_BYTES)) {
  throw new Error('dropping one eviction fixture does not land under the retention budget')
}
if (!(fixtures.large.dataUrlChars > WORKER_MIN_PAYLOAD_CHARS * 10)) {
  throw new Error('the large fixture no longer clears the worker threshold by 10x')
}
if (!(fixtures.small.dataUrlChars < WORKER_MIN_PAYLOAD_CHARS)) {
  throw new Error('the small fixture is no longer below the worker threshold')
}

const doc = {
  schema: PREPARED_SCHEMA,
  generatedAt: new Date().toISOString(),
  measurementGitSha,
  candidateGitSha,
  baselineGitSha,
  playwrightVersion,
  nodeVersion: process.version,
  engines: [...ENGINES],
  selfNullContexts: [...SELF_NULL_CONTEXTS],
  candidate: {
    path: candidateRel.replaceAll('\\', '/'),
    sha256: sha256(fs.readFileSync(candidatePath)),
    bytes: fs.statSync(candidatePath).size,
  },
  baseline: {
    path: baselineRel.replaceAll('\\', '/'),
    sha256: sha256(fs.readFileSync(baselinePath)),
    bytes: fs.statSync(baselinePath).size,
  },
  mechanism: {
    workerMinPayloadChars: WORKER_MIN_PAYLOAD_CHARS,
    maxImageBlobBytes: MAX_IMAGE_BLOB_BYTES,
    retentionCapStatus: 'HYPOTHESIS',
    routeCounterSurface: 'options.__assetRoutes, read by a caller-local afterRender plugin; candidate only, absent from ' + baselineGitSha.slice(0, 7),
  },
  acquisition: {
    sidesPerCell: 2,
    contextsPerSide: [...SELF_NULL_CONTEXTS],
    rawInlineLimit,
    rawComparison: 'byte equality when both raws are inline, else frozen SHA-256 plus UTF-8 byte length',
    pixelComparison: 'byte equality over the whole RGBA buffer at equal dimensions',
    pixelConventions: PIXEL_CONVENTIONS,
    pixelRequiredTier: PIXEL_CONVENTIONS.defaultTier,
    onePagePerSide: true,
    timingMeasured: false,
  },
  cellMatrixSha256: cellMatrixSha256(),
  cellIds: [...CELL_IDS],
  cells: CELLS.map((cell) => ({
    id: cell.id,
    surface: cell.surface,
    images: [...cell.images],
    cache: cell.cache,
    compress: cell.compress,
    csp: cell.csp ?? 'none',
    emulate: cell.emulate ?? null,
    steps: cellPageSpecLength(cell),
  })),
  fixtures,
  measurementFiles: fileIdentity,
  github: {
    repository: process.env.GITHUB_REPOSITORY || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
  },
}

function cellPageSpecLength(cell) {
  // Kept local rather than importing cellPageSpec, so prepared.json records the step COUNT and
  // labels a reader can check by eye, not a duplicated copy of the whole page description.
  return cell.repeat?.kind === 'none' ? 1 : 1 + (cell.repeat.count ?? 1)
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n')
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, [
    'candidate_bundle_sha256=' + doc.candidate.sha256,
    'baseline_bundle_sha256=' + doc.baseline.sha256,
    'cell_matrix_sha256=' + doc.cellMatrixSha256,
    'playwright_version=' + doc.playwrightVersion,
  ].join('\n') + '\n')
}
console.log(JSON.stringify({
  schema: doc.schema,
  measurementGitSha: doc.measurementGitSha,
  candidateGitSha: doc.candidateGitSha,
  baselineGitSha: doc.baselineGitSha,
  candidateBundleSha256: doc.candidate.sha256,
  baselineBundleSha256: doc.baseline.sha256,
  cellMatrixSha256: doc.cellMatrixSha256,
  cellCount: doc.cellIds.length,
  engines: doc.engines,
  rawInlineLimit,
  performanceClaim: false,
}, null, 2))
