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

export function uploadSteps(doc) {
  const found = []
  for (const job of Object.values(jobs(doc))) {
    for (const step of steps(job)) {
      if (String(step?.uses || '').startsWith('actions/upload-artifact')) found.push(step)
    }
  }
  return found
}

export function downloadSteps(doc) {
  const found = []
  for (const job of Object.values(jobs(doc))) {
    for (const step of steps(job)) {
      if (String(step?.uses || '').startsWith('actions/download-artifact')) found.push(step)
    }
  }
  return found
}

// ---- the artifact layout contract ------------------------------------------------------------------
//
// actions/upload-artifact roots an artifact at the LEAST COMMON ANCESTOR of its `path:` search
// paths, and both actions/download-artifact and `gh run download` extract the archive CONTENTS into
// the destination directory. So a consumer that spells an entry with the producer's own prefix is
// looking one directory too deep and silently finds nothing.
//
// That is not hypothetical. Hosted run 37146183681 prepared successfully and ran all eight chromium
// cells green, and the stage still collected 0/8 decisions: the cell artifact stores
// `decisions/f4-chromium-r0.json` at its root, while the harvest looked for
// `lane6-scratch/r10-shadow/decisions/f4-chromium-r0.json` underneath the download directory. The
// prepared artifact worked because its consumer `path:` happened to equal its LCA, which is exactly
// why the asymmetry survived a reading of the workflow.
//
// Everything below reconstructs that root from the workflow's own text, so the producer half and the
// consumer half of the contract can be asserted against each other with no runner and no network.

const GLOB_MAGIC = /[*?[\]{}()]/

/**
 * Canonical form of a workflow string: every variable slot collapses to one token, so a YAML
 * `${{ matrix.replicate }}` and a shell `${r}` compare as the same thing. Without this, matching a
 * producer template against a consumer command would be string archaeology.
 */
export function canonical(text) {
  return String(text)
    .replace(/\$\{\{\s*matrix\.entry\.engine\s*\}\}|\$\{e\}|\$\{engine\}/g, '{{engine}}')
    .replace(/\$\{\{\s*(?:matrix\.)?(?:entry\.)?replicate\s*\}\}|\$\{r\}|\$\{replicate\}/g, '{{replicate}}')
    .replace(/\$\{\{\s*github\.run_id\s*\}\}|\$\{GITHUB_RUN_ID\}|\$GITHUB_RUN_ID|\$\{runId\}/g, '{{run_id}}')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

/** Repo-relative search paths from an upload-artifact step's `path:` list. */
export function uploadSearchPaths(step) {
  const raw = String(step?.with?.path ?? '')
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => canonical(line))
}

/** A trailing slash is how this workflow declares a directory search path. */
export function isDirectoryEntry(entry) {
  return /\/\s*$/.test(String(entry))
}

/** Longest common directory of two repo-relative paths; '.' is the workspace root. */
export function lca(a, b) {
  if (a === '.') return b
  if (b === '.') return a
  const as = a.split('/')
  const bs = b.split('/')
  const out = []
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) break
    out.push(as[i])
  }
  return out.join('/') || '.'
}

/**
 * The artifact root upload-artifact derives from ONE search path: a glob is rooted at its fixed
 * prefix, anything else at the directory that contains it. Limitation, stated so a future edit does
 * not mistake it for a full glob implementation: an extensionless literal that happens to be a
 * directory is read here as a file, which only changes the derived root when it is mixed with
 * entries from a shallower directory.
 */
export function searchRoot(entry, directory = false) {
  const clean = canonical(entry)
  if (directory) return clean || '.'
  if (GLOB_MAGIC.test(clean)) {
    const parts = clean.split('/')
    const at = parts.findIndex((part) => GLOB_MAGIC.test(part))
    return parts.slice(0, at).join('/') || '.'
  }
  const at = clean.lastIndexOf('/')
  return at < 0 ? '.' : clean.slice(0, at)
}

/**
 * The layout a download will see: { root, files, directories }. `root` is the LCA of the search
 * paths, `files` are the entries as they appear inside the archive, and `directories` are the search
 * paths declared as directories, whose contents therefore cannot be listed statically.
 */
export function artifactLayout(step) {
  const rawPaths = String(step?.with?.path ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  const searchPaths = rawPaths.map((entry) => canonical(entry))
  const roots = rawPaths.map((entry) => searchRoot(entry, isDirectoryEntry(entry)))
  const root = roots.reduce((acc, entry) => lca(acc, entry), '.')
  const files = []
  const directories = []
  for (let i = 0; i < searchPaths.length; i++) {
    const clean = searchPaths[i]
    const target = isDirectoryEntry(rawPaths[i]) ? directories : files
    target.push(root === '.' || !clean.startsWith(root + '/') ? clean : clean.slice(root.length + 1))
  }
  return { root, searchPaths, files, directories }
}

/** Does this artifact actually carry `entry`, spelled relative to its root? */
export function layoutContains(layout, entry) {
  const e = canonical(entry)
  return layout.files.includes(e) || layout.directories.some((d) => e === d || e.startsWith(d + '/'))
}

/** Every producer in the workflow: its job, its name template and its reconstructed layout. */
export function producerLayouts(doc) {
  const out = []
  for (const [job, owner] of Object.entries(jobs(doc))) {
    for (const step of steps(owner)) {
      if (!String(step?.uses || '').startsWith('actions/upload-artifact')) continue
      out.push({
        job,
        step: step.name,
        name: String(step?.with?.name ?? ''),
        with: step.with || {},
        ...artifactLayout(step),
      })
    }
  }
  return out
}

/** The producer whose name template matches `name`, or null. */
export function producerFor(doc, name) {
  const want = canonical(name)
  return producerLayouts(doc).find((p) => canonical(p.name) === want) || null
}

/**
 * Every `gh run download` consumer in the workflow, per job: the artifact names and destination
 * directories it fetches, and the archive-relative entries it then reads out of them. Downloads and
 * reads are matched per job rather than per step because a job is allowed to fetch in one step and
 * copy in the next, which is exactly what the closeout does.
 */
export function harvestPlan(doc) {
  const out = []
  for (const [job, owner] of Object.entries(jobs(doc))) {
    const downloads = []
    const entries = []
    const copyTargets = []
    for (const step of steps(owner)) {
      const run = String(step?.run || '')
      if (!run) continue
      // Join shell continuations so a multi-line `gh run download` reads as one command.
      const flat = run.replace(/\\[ \t]*\r?\n/g, ' ').replace(/\\\r?\n/g, ' ')
      for (const command of flat.split(/[\n;]/)) {
        if (!/gh\s+run\s+download/.test(command)) continue
        const hit = command.match(/--name\s+"([^"]+)"[\s\S]*?--dir\s+"([^"]+)"/)
        if (!hit) continue
        downloads.push({ step: step.name, artifact: hit[1], dir: hit[2], command: command.trim() })
      }
      for (const hit of flat.matchAll(/\bsrc="([^"]+)"/g)) entries.push({ step: step.name, src: hit[1] })
      for (const hit of flat.matchAll(/\bcp\s+"\$src"\s+"([^"]+)"/g)) copyTargets.push(hit[1])
    }
    if (downloads.length || entries.length) out.push({ job, downloads, entries, copyTargets })
  }
  return out
}

/** Strip a harvested download directory from a `src="..."` reference, leaving the archive entry. */
export function entryUnder(src, dir) {
  const s = canonical(src)
  const d = canonical(dir)
  return s.startsWith(d + '/') ? s.slice(d.length + 1) : null
}

/** The download directory a `src="..."` reference was harvested into, or null when unresolvable. */
export function harvestDirFor(plan, src) {
  const longest = plan.downloads
    .map((d) => canonical(d.dir))
    .filter((d) => canonical(src).startsWith(d + '/'))
    .sort((a, b) => b.length - a.length)[0]
  return longest || null
}

/**
 * Resolve one `src="..."` reference to the artifact it was harvested from and the archive-relative
 * entry it names, or null when no download in the job covers it. This is the pairing the artifact
 * layout contract is checked on.
 */
export function harvestSource(plan, src) {
  const dir = harvestDirFor(plan, src)
  if (!dir) return null
  const download = plan.downloads.find((d) => canonical(d.dir) === dir)
  const entry = entryUnder(src, dir)
  if (!download || !entry) return null
  return { download, dir, entry: canonical(entry) }
}