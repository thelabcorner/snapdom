// Workflow inspection for the F4 contracts. The staged workflow is the measurement protocol as
// far as the runner is concerned, so its shape is asserted here rather than reviewed by eye: the
// cross-engine guard must be gated on the chromium stage's machine state, artifact names must be
// run_id-keyed, and the settle must precede the ambient gate in every timed cell.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// eslint-disable-next-line n/no-missing-require
const yaml = require('js-yaml')

export const WORKFLOW_REL = '.github/workflows/r10-f4-wall.yml'

export function readWorkflow(root) {
  const abs = path.resolve(root, WORKFLOW_REL)
  return yaml.load(fs.readFileSync(abs, 'utf8'))
}

export function jobs(doc) {
  return doc.jobs || {}
}

export function steps(job) {
  return job?.steps || []
}

export function stepNames(job) {
  return steps(job).map((s) => s.name || '').filter(Boolean)
}

export function findStep(job, fragment) {
  return steps(job).find((s) => String(s.name || '').includes(fragment)) || null
}

export function stepIndex(job, fragment) {
  return stepNames(job).findIndex((name) => name.includes(fragment))
}

/** Every `uses:`/`run:` text in the whole workflow, lowercased, for substring assertions. */
export function allText(doc) {
  const parts = []
  for (const job of Object.values(jobs(doc))) {
    for (const step of steps(job)) {
      if (step.uses) parts.push(String(step.uses))
      if (step.run) parts.push(String(step.run))
      if (step.if) parts.push(String(step.if))
      if (step.with) parts.push(JSON.stringify(step.with))
    }
  }
  return parts.join('\n').toLowerCase()
}

/** Artifact names the workflow declares, recovered from the `${{ }}` templates. */
export function declaredArtifactNames(doc) {
  const found = []
  for (const job of Object.values(jobs(doc))) {
    for (const step of steps(job)) {
      const name = step?.with?.name
      if (typeof name === 'string') found.push(name)
    }
  }
  return found
}

export function artifactUses(doc) {
  const found = []
  for (const job of Object.values(jobs(doc))) {
    for (const step of steps(job)) {
      if (String(step?.uses || '').startsWith('actions/upload-artifact')) found.push(step)
      if (String(step?.uses || '').startsWith('actions/download-artifact')) found.push(step)
    }
  }
  return found
}