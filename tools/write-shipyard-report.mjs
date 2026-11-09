#!/usr/bin/env node
// Writes the Shipyard report contract for one run: shipyard-report.json in the run
// directory. Harbor Pilot reads this file and refuses to guess without it.
//
//   node tools/write-shipyard-report.mjs <target>/.shipyard/runs/<run-id>
//
// Everything comes from run artifacts and git, except what only the harbormaster
// knows, which it must record in report-notes.json:
//
//   { "plan_changes": [ { "change": "", "why": "" } ], "notes": [ "" ] }
//
// Empty arrays are fine, but the file must exist, so that "nothing changed" is a
// statement somebody made rather than a step somebody skipped.
//
// No dependencies: this file is copied into ~/.claude/shipyard and run from there.
// tools/harbor.mjs is the reader, and its reportProblems() is the contract's check.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fail = (message) => {
  console.error(`write-shipyard-report: ${message}`)
  process.exit(1)
}

const runDir = process.argv[2]
if (!runDir) fail('usage: write-shipyard-report.mjs <run-dir>')
if (!existsSync(runDir)) fail(`no such run directory: ${runDir}`)

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    fail(`cannot read ${what} at ${path}: ${err.message}`)
  }
}
const readOptionalJson = (path) => (existsSync(path) ? readJson(path, path) : null)

const state = readJson(join(runDir, 'state.json'), 'state.json')
if (!state.branch) fail('state.json has no branch')
if (!state.baseCommit) fail('state.json has no baseCommit')

const notesPath = join(runDir, 'report-notes.json')
if (!existsSync(notesPath)) {
  fail(`${notesPath} is missing. Write it first: {"plan_changes": [{"change": "", "why": ""}], "notes": [""]}. Empty arrays are fine.`)
}
const recorded = readJson(notesPath, 'report-notes.json')
if (!Array.isArray(recorded.plan_changes) || !Array.isArray(recorded.notes)) {
  fail('report-notes.json needs plan_changes and notes arrays')
}

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
})
const root = git(runDir, 'rev-parse', '--show-toplevel').trim()

// .shipyard/ is committed to the branch as evidence, but it is not part of the change.
const statuses = git(root, 'diff', '--no-renames', '--name-status', '-z', `${state.baseCommit}...HEAD`, '--', '.', ':(exclude).shipyard')
  .split('\0').filter(Boolean)
const files_changed = []
for (let i = 0; i + 1 < statuses.length; i += 2) {
  const status = statuses[i] === 'A' ? 'added' : statuses[i] === 'D' ? 'deleted' : 'modified'
  files_changed.push({ path: statuses[i + 1], status })
}

/** Testers write criteria keyed by id, or sometimes as a list of { id, verdict, evidence }. */
function criteriaById(report, name) {
  const { criteria } = report
  if (!Array.isArray(criteria)) return criteria
  return Object.fromEntries(criteria.map((entry) => {
    if (!entry?.id) fail(`${name} lists a criterion with no id`)
    const { id, ...result } = entry
    return [id, result]
  }))
}

/**
 * The testers' last word on each criterion, in the highest cycle with a report.
 * Reports are read in order, because a re-test lists only what it settled.
 */
function latestTestReport() {
  const cyclesDir = join(runDir, 'cycles')
  if (!existsSync(cyclesDir)) return null
  const cycles = readdirSync(cyclesDir).filter(n => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a)
  for (const cycle of cycles) {
    const dir = join(cyclesDir, String(cycle))
    const reports = readdirSync(dir)
      .map(name => /^test-report(?:-(browser)|-fix(\d+))?\.json$/.exec(name))
      .filter(Boolean)
      .map(m => ({ name: m[0], order: m[2] ? 1 + Number(m[2]) : m[1] ? 1 : 0 }))
      .sort((a, b) => a.order - b.order)
    if (reports.length > 0) {
      return { criteria: Object.assign({}, ...reports.map(r => criteriaById(readJson(join(dir, r.name), r.name), r.name))) }
    }
  }
  return null
}

const brief = readOptionalJson(join(runDir, 'brief.json'))
const statementOf = (id) => {
  const criterion = (brief?.acceptanceCriteria ?? []).find(c => c.id === id)
  return criterion?.statement ?? criterion?.text ?? criterion?.criterion ?? null
}

const testReport = latestTestReport()
if (!testReport) console.error('write-shipyard-report: warning: no test report found, so tests is empty')
const tests = Object.entries(testReport?.criteria ?? {}).map(([id, result]) => {
  const verdict = typeof result === 'string' ? result : result?.verdict
  const evidence = typeof result === 'object' ? result?.evidence : undefined
  const statement = statementOf(id)
  // The contract has only pass and fail. Anything that did not pass counts as a fail,
  // with the tester's own word kept beside it.
  const kept = verdict === 'pass' || verdict === 'fail' ? evidence : `verdict: ${verdict}. ${evidence ?? ''}`.trim()
  return {
    name: statement ? `${id}: ${statement}` : id,
    status: verdict === 'pass' ? 'pass' : 'fail',
    ...(kept ? { evidence: kept } : {}),
  }
})

const plan = [state.request, brief?.goal ? `Goal: ${brief.goal}` : null].filter(Boolean).join('\n\n')
if (!plan) fail('state.json has no request and brief.json has no goal')

const report = {
  version: 1,
  plan,
  plan_changes: recorded.plan_changes,
  files_changed,
  tests,
  branch: state.branch,
  base: state.baseCommit,
  notes: recorded.notes,
}

const out = join(runDir, 'shipyard-report.json')
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(out)
