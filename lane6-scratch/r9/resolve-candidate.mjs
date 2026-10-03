#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { sha256File, stableJson, sha256Text } from './protocol.mjs'

const ROOT = process.cwd()
const ACTIVE_REL = 'lane6-scratch/r9/ACTIVE_CANDIDATE.json'
const ACTIVE_PATH = path.resolve(ROOT, ACTIVE_REL)
const R9_ROOT = path.resolve(ROOT, 'lane6-scratch/r9')
const CANDIDATE_ROOT = path.resolve(R9_ROOT, 'candidates')
const PLAN_PATH = path.resolve(R9_ROOT, 'resolved-plan.json')

function fail(message) {
  console.error(`R9 candidate resolution refused: ${message}`)
  process.exit(1)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) { fail(`${path.relative(ROOT, file)}: ${error.message}`) }
}

function inside(child, parent) {
  const rel = path.relative(parent, child)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function assertNumber(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(`${label} must be a finite number in [${min}, ${max}]`)
  }
}

function assertStringArray(value, label, allowed = null) {
  if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== 'string' || !x)) {
    fail(`${label} must be a non-empty string array`)
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`)
  if (allowed) {
    for (const x of value) if (!allowed.has(x)) fail(`${label} contains unsupported value ${x}`)
  }
}

function phaseCheck(phase, name) {
  if (!phase || typeof phase !== 'object') fail(`missing phases.${name}`)
  assertStringArray(phase.browsers, `phases.${name}.browsers`, new Set(['chromium', 'firefox', 'webkit']))
  assertNumber(phase.n, `phases.${name}.n`, 4, 100)
  assertNumber(phase.batch, `phases.${name}.batch`, 1, 10)
  assertNumber(phase.warmup, `phases.${name}.warmup`, 0, 20)
  assertNumber(phase.bootstrap, `phases.${name}.bootstrap`, 1000, 100000)
  assertNumber(phase.epsilon, `phases.${name}.epsilon`, 0.001, 0.20)
  assertNumber(phase.controlBand, `phases.${name}.controlBand`, 0.005, 0.20)
  assertNumber(phase.equivalenceBand, `phases.${name}.equivalenceBand`, 0.005, 0.20)
  assertNumber(phase.maxPairLogSd, `phases.${name}.maxPairLogSd`, 0.01, 0.50)
  assertNumber(phase.seed, `phases.${name}.seed`, 0, 0xffffffff)
  assertNumber(phase.replicates, `phases.${name}.replicates`, 1, 8)
}

if (!fs.existsSync(ACTIVE_PATH)) fail(`missing ${ACTIVE_REL}`)
const active = readJson(ACTIVE_PATH)
if (active.schema !== 'snapdom-r9-active-candidate-v1') fail('unsupported active-candidate schema')
if (typeof active.candidate !== 'string' || !active.candidate) fail('active candidate path missing')

const candidatePath = path.resolve(R9_ROOT, active.candidate)
if (!inside(candidatePath, CANDIDATE_ROOT)) fail('active candidate must resolve strictly inside lane6-scratch/r9/candidates')
if (!fs.existsSync(candidatePath)) fail(`candidate manifest not found: ${active.candidate}`)
const candidate = readJson(candidatePath)

if (candidate.schema !== 'snapdom-r9-candidate-v1') fail('unsupported candidate schema')
if (!/^[a-z0-9][a-z0-9._-]{2,80}$/.test(candidate.id || '')) fail('candidate.id is invalid')
if (!['bundle-diff', 'option-pair'].includes(candidate.mode)) fail('candidate.mode must be bundle-diff or option-pair')
if (!['standing', 'focus', 'pseudo'].includes(candidate.suite)) fail('candidate.suite must be standing, focus, or pseudo')
if (!['improvement', 'equivalence', 'explore'].includes(candidate.expect)) fail('candidate.expect invalid')
if (candidate.mode === 'bundle-diff' && !/^[0-9a-f]{40}$/i.test(candidate.baselineRef || '')) {
  fail('bundle-diff requires a full 40-hex baselineRef')
}
if (candidate.mode === 'option-pair' && candidate.baselineRef !== null) {
  fail('option-pair must use baselineRef=null because both arms are the same bundle')
}
if (!candidate.base || typeof candidate.base !== 'object' || Array.isArray(candidate.base)) fail('candidate.base must be an object')
if (!candidate.opt || typeof candidate.opt !== 'object' || Array.isArray(candidate.opt)) fail('candidate.opt must be an object')
if (!/^\d+\.\d+\.\d+$/.test(candidate.playwrightVersion || '')) fail('playwrightVersion must be exact x.y.z')

assertStringArray(candidate.primaryFixtures, 'primaryFixtures')
if (!Array.isArray(candidate.guardFixtures)) fail('guardFixtures must be an array')
if (!Array.isArray(candidate.knownNoOpFixtures)) fail('knownNoOpFixtures must be an array')
const allFixtures = [...candidate.primaryFixtures, ...candidate.guardFixtures]
if (new Set(allFixtures).size !== allFixtures.length) fail('primaryFixtures and guardFixtures overlap or contain duplicates')
for (const fixture of candidate.knownNoOpFixtures) {
  if (!allFixtures.includes(fixture)) fail(`knownNoOpFixture is not selected: ${fixture}`)
}

phaseCheck(candidate.phases?.scout, 'scout')
phaseCheck(candidate.phases?.confirm, 'confirm')
phaseCheck(candidate.phases?.engineGuard, 'engineGuard')
if (candidate.phases.scout.browsers.length !== 1 || candidate.phases.scout.browsers[0] !== 'chromium') {
  fail('scout must be exactly one Chromium runner')
}
if (candidate.phases.confirm.browsers.length !== 1 || candidate.phases.confirm.browsers[0] !== 'chromium') {
  fail('confirm must be Chromium-only; cross-engine evidence belongs in engineGuard')
}

const require = createRequire(import.meta.url)
const installedPlaywright = require('playwright/package.json').version
if (installedPlaywright !== candidate.playwrightVersion) {
  fail(`manifest pins Playwright ${candidate.playwrightVersion}, package resolves ${installedPlaywright}`)
}

const candidateRel = path.relative(ROOT, candidatePath).replaceAll('\\', '/')
const manifestSha256 = sha256File(candidatePath)
const activeSha256 = sha256File(ACTIVE_PATH)
const plan = {
  schema: 'snapdom-r9-resolved-plan-v1',
  candidateId: candidate.id,
  candidateManifest: candidateRel,
  candidateManifestSha256: manifestSha256,
  activeCandidateSha256: activeSha256,
  candidate,
  fixtureSelectionSha256: sha256Text(stableJson({
    primary: candidate.primaryFixtures,
    guards: candidate.guardFixtures,
    noops: candidate.knownNoOpFixtures,
  })),
}

fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2) + '\n')

const outputs = {
  candidate_id: candidate.id,
  candidate_manifest: candidateRel,
  candidate_manifest_sha256: manifestSha256,
  mode: candidate.mode,
  baseline_ref: candidate.baselineRef || '',
  suite: candidate.suite,
  expect: candidate.expect,
  playwright_version: candidate.playwrightVersion,
  confirm_replicates: String(candidate.phases.confirm.replicates),
  confirm_matrix: JSON.stringify(Array.from({ length: candidate.phases.confirm.replicates }, (_, i) => i)),
  engine_guard_matrix: JSON.stringify(candidate.phases.engineGuard.browsers),
  plan_path: path.relative(ROOT, PLAN_PATH).replaceAll('\\', '/'),
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''))
}

console.log(JSON.stringify({ resolved: true, ...outputs }, null, 2))
