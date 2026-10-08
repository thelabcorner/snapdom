#!/usr/bin/env node
/**
 * R11 AS-BLOB cross-engine FIDELITY acceptance: aggregate.
 *
 * Reads one engine document per engine and produces THE acceptance verdict. It contains no browser
 * code and no timing: it is a pure decision over frozen evidence, which is what makes it possible
 * to prove the gate itself under `node --test` without a browser anywhere in sight.
 *
 * Fail-closed rules, all enforced by fidelity-lib.mjs and all covered by the contract suite:
 *  - fewer than three engine documents is INCOMPLETE_EVIDENCE, never a pass;
 *  - any missing cell, missing self-null context or missing parity evidence fails that engine;
 *  - any provenance field that does not match prepared.json fails the engine;
 *  - exit status is non-zero for every state except FIDELITY_ACCEPTED.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ENGINES,
  acceptanceMatrix,
  acceptanceVerdict,
  assertHostedOnly,
  sha256,
} from './fidelity-lib.mjs'

const ROOT = process.cwd()
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '='
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

assertHostedOnly(process.env)

const PREPARED_PATH = path.resolve(ROOT, arg('prepared', 'lane6-scratch/r11/prepared.json'))
const INPUT_DIR = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r11/aggregate-input'))
const OUT = path.resolve(ROOT, arg('out', 'lane6-scratch/r11/summary.json'))
const EXPECTED_ENGINES = arg('expected-engines', ENGINES.join(','))

if (!fs.existsSync(PREPARED_PATH)) throw new Error('prepared.json missing: ' + PREPARED_PATH)
const prepared = JSON.parse(fs.readFileSync(PREPARED_PATH, 'utf8'))

const expected = EXPECTED_ENGINES.split(',').map((x) => x.trim()).filter(Boolean)
if (JSON.stringify(expected) !== JSON.stringify([...ENGINES])) {
  throw new Error('--expected-engines must be exactly ' + ENGINES.join(','))
}
if (!fs.existsSync(INPUT_DIR)) throw new Error('aggregate input dir missing: ' + INPUT_DIR)

// ---- collect engine documents: exactly one per engine, never silently merged ----
// The download pattern nests one directory per engine artifact, so the walk is two levels deep and
// anything it cannot place is reported rather than skipped.
const located = new Map()
const stray = []
const walk = (dir, depth) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < 2) walk(full, depth + 1)
      continue
    }
    const match = /^engine-(.+)\.json$/.exec(entry.name)
    if (!match) {
      if (entry.name.endsWith('.json')) stray.push(path.relative(INPUT_DIR, full).replaceAll('\\', '/'))
      continue
    }
    const engine = match[1]
    if (!ENGINES.includes(engine)) {
      stray.push(path.relative(INPUT_DIR, full).replaceAll('\\', '/'))
      continue
    }
    if (!located.has(engine)) located.set(engine, [])
    located.get(engine).push(full)
  }
}
walk(INPUT_DIR, 0)

const engineDocuments = {}
const unreadable = []
const duplicates = []
for (const engine of ENGINES) {
  const files = located.get(engine) ?? []
  if (files.length > 1) duplicates.push(engine + ' (' + files.length + ' artifacts)')
  if (!files.length) {
    unreadable.push(engine)
    continue
  }
  try {
    engineDocuments[engine] = JSON.parse(fs.readFileSync(files[0], 'utf8'))
  } catch (error) {
    unreadable.push(engine + ' (unparseable: ' + error.message + ')')
  }
}

const summary = acceptanceVerdict({ prepared, engineDocuments })
summary.generatedAt = new Date().toISOString()
summary.preparedSha256 = sha256(fs.readFileSync(PREPARED_PATH))
summary.inputDir = path.relative(ROOT, INPUT_DIR).replaceAll('\\', '/')
summary.observedEngines = [...located.keys()]
summary.missingEngines = unreadable
summary.duplicateEngines = duplicates
summary.strayFiles = stray
summary.matrix = acceptanceMatrix(summary)
summary.evidence = Object.fromEntries(
  Object.entries(engineDocuments).map(([engine, doc]) => [engine, {
    provenance: doc.provenance ?? null,
    cells: Object.keys(doc.cells ?? {}),
  }]),
)
if (duplicates.length) summary.problems.push('duplicate engine artifacts: ' + duplicates.join(', '))

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')

const width = Math.max(...summary.cellIds.map((id) => id.length))
const lines = [
  'R11 AS-BLOB cross-engine fidelity acceptance',
  'candidate ' + summary.provenance?.candidateGitSha,
  'baseline  ' + summary.provenance?.baselineGitSha,
  'engines   ' + summary.engineIds.join(', '),
  '',
  ('cell'.padEnd(width) + '  ' + summary.engineIds.map((e) => e.padEnd(9)).join('  ')),
]
for (const cellId of summary.cellIds) {
  lines.push(
    cellId.padEnd(width) + '  ' +
    summary.engineIds.map((e) => String(summary.matrix[cellId][e]).padEnd(9)).join('  '),
  )
}
lines.push('')
lines.push('state: ' + summary.state)
for (const problem of summary.problems.slice(0, 40)) lines.push('  - ' + problem)
if (summary.problems.length > 40) lines.push('  … ' + (summary.problems.length - 40) + ' more')
lines.push('performanceClaim: ' + summary.performanceClaim)
console.log(lines.join('\n'))
console.log('artifact ' + path.relative(ROOT, OUT).replaceAll('\\', '/'))

if (summary.state !== 'FIDELITY_ACCEPTED') {
  console.error('[r11] fidelity acceptance FAILED: ' + summary.state)
  process.exitCode = 1
}
