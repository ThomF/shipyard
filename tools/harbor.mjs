#!/usr/bin/env node
// The plain-code half of Harbor Pilot. The /harbor session does the reading and
// writing; this script is everything that must not depend on a model getting it right:
// checking the report, gathering the context, copying exact lines from the commit,
// and checking the finished guide against the branch.
//
//   harbor.mjs prepare [--run <id>] [--force]   write the context for a guide
//   harbor.mjs render [--run <id>]              turn the session's JSON into REVIEW_GUIDE.md
//   harbor.mjs ask-prepare [--run <id>]         question on stdin; write the context for it
//   harbor.mjs ask-append [--run <id>]          add the session's answer to the Q&A log
//   harbor.mjs verify [--run <id>]              check every snippet against the branch
//
// No dependencies: this file is copied to ~/.claude/shipyard and run from there.
// HARBOR.md is the manual the session follows, and describes the JSON it writes.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

const REPORT_FILE = 'shipyard-report.json'
const GUIDE_FILE = 'REVIEW_GUIDE.md'
const WORK_DIR = '.harbor'
const TARGET_MS = 2 * 60 * 1000
/** Past this a diff stops being readable context; lockfiles are the usual case. */
const MAX_DIFF_LINES = 800
const MAX_FILE_LINES = 800
const MAX_CONTEXT_CHARS = 600_000
const MAX_PLUMBING_LINES = 60
const NO_QUESTIONS = '_No questions yet._'
const SECTIONS = [
  '1. What this build does', '2. File map', '3. The walkthrough', '4. Plumbing, collapsed',
  '5. Look here first', '6. Before you approve', '7. Q&A log',
]

/** A stop with something to say, as opposed to a bug. */
class Stop extends Error {}

const flat = (text) => String(text).replace(/\s+/g, ' ').trim()
const bullets = (items) => items.map(item => `  ${item}`).join('\n')

// ---------------------------------------------------------------- git

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

function repoRoot() {
  try {
    return git(process.cwd(), 'rev-parse', '--show-toplevel').trim()
  } catch {
    throw new Stop(`${process.cwd()} is not inside a git repository.`)
  }
}

function resolveCommit(root, ref) {
  try {
    return git(root, 'rev-parse', '--verify', `${ref}^{commit}`).trim()
  } catch {
    throw new Stop(`Cannot find "${ref}" in this repository.`)
  }
}

/** Shipyard commits its run artifacts to the branch. They are not part of the change. */
function changedFiles(root, base, head) {
  const scope = ['--', '.', ':(exclude).shipyard']
  const range = `${base}...${head}`
  const statuses = git(root, 'diff', '--no-renames', '--name-status', '-z', range, ...scope).split('\0').filter(Boolean)
  const binary = new Set()
  for (const row of git(root, 'diff', '--no-renames', '--numstat', '-z', range, ...scope).split('\0')) {
    const [added, removed, path] = row.split('\t')
    if (added === '-' && removed === '-' && path) binary.add(path)
  }
  const files = []
  for (let i = 0; i + 1 < statuses.length; i += 2) {
    const status = statuses[i] === 'A' ? 'added' : statuses[i] === 'D' ? 'deleted' : 'modified'
    files.push({ path: statuses[i + 1], status, binary: binary.has(statuses[i + 1]) })
  }
  return files
}

/** Lines exactly as committed. Never the working tree, which may have moved on. */
function readLines(root, commit, path) {
  let text
  try {
    text = git(root, 'show', `${commit}:${path}`)
  } catch {
    return null
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** New-side line ranges a file's diff touches, merging ranges within 3 lines of each other. */
function changedRanges(root, base, head, path) {
  const diff = git(root, 'diff', '--no-renames', '-U0', `${base}...${head}`, '--', path)
  const ranges = []
  for (const match of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (count === 0) continue
    const last = ranges[ranges.length - 1]
    if (last && start - last.end <= 3) last.end = start + count - 1
    else ranges.push({ start, end: start + count - 1 })
  }
  return ranges
}

/** A file's diff with new-side line numbers, so the session can cite lines without counting. */
function numberedDiff(root, base, head, path) {
  const raw = git(root, 'diff', '--no-renames', `${base}...${head}`, '--', path).split('\n')
  if (raw[raw.length - 1] === '') raw.pop()
  const out = []
  let next = null
  for (const line of raw) {
    const hunk = /^@@ -\S+ \+(\d+)/.exec(line)
    if (hunk) {
      next = Number(hunk[1])
      out.push(line)
    } else if (next === null || line.startsWith('\\')) {
      out.push(line)
    } else if (line.startsWith('-')) {
      out.push(`${' '.repeat(6)} ${line}`)
    } else {
      out.push(`${String(next++).padStart(6)} ${line}`)
    }
  }
  if (out.length <= MAX_DIFF_LINES) return out.join('\n')
  return `${out.slice(0, MAX_DIFF_LINES).join('\n')}\n[${out.length - MAX_DIFF_LINES} more diff lines left out of this context]`
}

const numbered = (lines) => lines.map((line, i) => `${String(i + 1).padStart(6)}  ${line}`).join('\n')

// ---------------------------------------------------------------- the report

function reportProblems(r) {
  const text = (v) => typeof v === 'string' && v.length > 0
  const list = (v, name) => (Array.isArray(v) ? [] : [`${name} must be an array`])
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return ['the report must be a JSON object']
  const problems = []
  if (r.version !== 1) problems.push('version must be 1')
  for (const field of ['plan', 'branch', 'base']) if (!text(r[field])) problems.push(`${field} must be a non-empty string`)
  problems.push(...list(r.plan_changes, 'plan_changes'), ...list(r.files_changed, 'files_changed'), ...list(r.tests, 'tests'), ...list(r.notes, 'notes'))
  if (problems.length > 0) return problems
  r.plan_changes.forEach((c, i) => { if (!text(c?.change) || !text(c?.why)) problems.push(`plan_changes.${i} needs change and why`) })
  r.files_changed.forEach((f, i) => { if (!text(f?.path) || !['added', 'modified', 'deleted'].includes(f?.status)) problems.push(`files_changed.${i} needs a path and an added, modified, or deleted status`) })
  r.tests.forEach((t, i) => { if (!text(t?.name) || !['pass', 'fail'].includes(t?.status)) problems.push(`tests.${i} needs a name and a pass or fail status`) })
  r.notes.forEach((n, i) => { if (typeof n !== 'string') problems.push(`notes.${i} must be a string`) })
  return problems
}

function loadReport(path) {
  if (!existsSync(path)) throw new Stop(`No Shipyard report at ${path}.`)
  let report
  try {
    report = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Stop(`The Shipyard report at ${path} is not valid JSON: ${err.message}`)
  }
  const problems = reportProblems(report)
  if (problems.length > 0) throw new Stop(`The Shipyard report at ${path} is malformed:\n${bullets(problems)}`)
  return report
}

/**
 * The run to work on: the one named, or the newest whose report is for this branch.
 * A malformed report met on the way stops the search, since it may be the one we want.
 */
function findRun(root, runId) {
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const dir = join(root, '.shipyard', 'runs')
  if (runId) {
    const report = loadReport(join(dir, runId, REPORT_FILE))
    if (report.branch !== branch) {
      throw new Stop(`Run ${runId} is for branch ${report.branch}, but ${branch} is checked out. Check out ${report.branch} first.`)
    }
    return { runId, runDir: join(dir, runId), report }
  }
  const ids = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse()
    : []
  if (ids.length === 0) throw new Stop(`No Shipyard runs in ${dir}. Run /shipyard first.`)
  for (const id of ids) {
    const path = join(dir, id, REPORT_FILE)
    if (!existsSync(path)) continue
    const report = loadReport(path)
    if (report.branch === branch) return { runId: id, runDir: join(dir, id), report }
  }
  throw new Stop(
    `No Shipyard report for branch ${branch}. Looked in ${ids.length} run(s) under ${dir}. ` +
    `Check out the build's branch, or check that the run wrote ${REPORT_FILE}.`,
  )
}

// ---------------------------------------------------------------- rendering

const LANGUAGES = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.svelte': 'svelte', '.vue': 'vue', '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.rb': 'ruby', '.java': 'java', '.sql': 'sql', '.json': 'json', '.css': 'css',
  '.html': 'html', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'bash',
}

/** The only way code enters a guide: exact lines, labelled with where they came from. */
function renderSnippet(path, start, end, source) {
  const code = source.slice(start - 1, end)
  const longest = Math.max(0, ...code.map(line => /^`+/.exec(line)?.[0].length ?? 0))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`**\`${path}:${start}-${end}\`**`, '', `${fence}${LANGUAGES[extname(path).toLowerCase()] ?? ''}`, ...code, fence].join('\n')
}

function rangeProblem(path, start, end, source) {
  if (source === null) return `${path} is not a readable file on the branch.`
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > source.length) {
    return `${path}:${start}-${end} is outside the file (${source.length} lines).`
  }
  return null
}

function outputShapeProblems(o) {
  const text = (v) => typeof v === 'string' && v.trim().length > 0
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return ['the output must be a JSON object']
  const problems = []
  if (!text(o.summary)) problems.push('summary must be a non-empty string')
  for (const field of ['files', 'steps', 'lookHereFirst', 'beforeYouApprove']) {
    if (!Array.isArray(o[field])) problems.push(`${field} must be an array`)
  }
  if (problems.length > 0) return problems
  o.files.forEach((f, i) => { if (!text(f?.path) || !['logic', 'plumbing'].includes(f?.group) || !text(f?.purpose)) problems.push(`files.${i} needs path, group (logic or plumbing), and purpose`) })
  o.steps.forEach((s, i) => { for (const k of ['title', 'path', 'does', 'handsTo', 'onFailure']) if (!text(s?.[k])) problems.push(`steps.${i}.${k} must be a non-empty string`) })
  o.lookHereFirst.forEach((s, i) => { if (!/^S\d+$/.test(s?.step ?? '') || !Number.isInteger(s?.line) || !text(s?.why)) problems.push(`lookHereFirst.${i} needs step (like S3), line, and why`) })
  o.beforeYouApprove.forEach((q, i) => { if (!text(q)) problems.push(`beforeYouApprove.${i} must be a non-empty string`) })
  if (o.lookHereFirst.length > 5) problems.push('lookHereFirst has more than 5 entries')
  if (o.steps.length > 0 && o.lookHereFirst.length === 0) problems.push('lookHereFirst is empty')
  if (o.beforeYouApprove.length < 3 || o.beforeYouApprove.length > 5) problems.push('beforeYouApprove needs 3 to 5 questions')
  return problems
}

/** Anything cited that is not real stops the guide. */
function citationProblems(output, files, source) {
  const problems = []
  const live = new Set(files.filter(f => f.status !== 'deleted' && !f.binary).map(f => f.path))
  output.steps.forEach((step, i) => {
    const id = `S${i + 1}`
    if (!live.has(step.path)) {
      problems.push(`${id} cites ${step.path}, which is not a changed text file on the branch.`)
      return
    }
    const problem = rangeProblem(step.path, step.startLine, step.endLine, source(step.path))
    if (problem) problems.push(`${id}: ${problem}`)
  })
  for (const spot of output.lookHereFirst) {
    const step = output.steps[Number(spot.step.slice(1)) - 1]
    if (!step) problems.push(`lookHereFirst cites ${spot.step}, which does not exist.`)
    else if (spot.line < step.startLine || spot.line > step.endLine) {
      problems.push(`lookHereFirst cites ${spot.step} line ${spot.line}, outside ${step.startLine}-${step.endLine}.`)
    }
  }
  return problems
}

function plumbingBody(root, base, head, file, source) {
  if (file.status === 'deleted') return '_Deleted in this build, so there is no code on the branch._'
  if (file.binary || !source) return '_Binary file._'
  const ranges = changedRanges(root, base, head, file.path)
  if (ranges.length === 0) return '_This build only removed lines here._'
  const blocks = []
  let left = MAX_PLUMBING_LINES
  let hidden = 0
  for (const { start, end } of ranges) {
    const size = end - start + 1
    if (left <= 0) {
      hidden += size
      continue
    }
    const shown = Math.min(size, left)
    blocks.push(renderSnippet(file.path, start, start + shown - 1, source))
    left -= shown
    hidden += size - shown
  }
  if (hidden > 0) blocks.push(`_${hidden} more changed lines not shown. Run \`git diff ${base.slice(0, 8)}...${head.slice(0, 8)} -- ${file.path}\`._`)
  return blocks.join('\n\n')
}

/** Where the report and the diff disagree. The diff is what the guide uses. */
function reportMismatch(report, files) {
  const said = new Map(report.files_changed.map(f => [f.path, f.status]))
  const out = []
  for (const f of files) {
    if (!said.has(f.path)) out.push(`\`${f.path}\` is in the diff but not in the report.`)
    else if (said.get(f.path) !== f.status) out.push(`\`${f.path}\` is ${f.status} in the diff but ${said.get(f.path)} in the report.`)
    said.delete(f.path)
  }
  for (const path of said.keys()) out.push(`\`${path}\` is in the report but not in the diff.`)
  return out
}

function renderGuide({ root, run, base, head, files, output }) {
  const source = (path) => readLines(root, head, path)
  const changed = new Set(files.map(f => f.path))

  // A file with a walkthrough step is logic whatever it was called. A file left out of
  // the map is shown as left out rather than quietly given a purpose.
  const stepped = new Set(output.steps.map(s => s.path))
  const said = new Map()
  for (const f of output.files) if (changed.has(f.path) && !said.has(f.path)) said.set(f.path, f)
  const classified = files.map(file => {
    const entry = said.get(file.path)
    return {
      file,
      group: stepped.has(file.path) ? 'logic' : entry?.group ?? 'plumbing',
      purpose: entry ? flat(entry.purpose) : 'Not classified. Check this one yourself.',
    }
  })
  const logic = classified.filter(c => c.group === 'logic')
  const plumbing = classified.filter(c => c.group === 'plumbing')
  const mapRows = (rows) => rows.length === 0 ? '_None._' : rows.map(c => `- \`${c.file.path}\` (${c.file.status}): ${c.purpose}`).join('\n')

  const changes = run.report.plan_changes.length === 0
    ? 'The report records no changes from the plan.'
    : `**Changed from the plan:**\n\n${run.report.plan_changes.map(c => `- ${flat(c.change)} Why: ${flat(c.why)}`).join('\n')}`
  const mismatch = reportMismatch(run.report, files)
  const mismatchText = mismatch.length === 0 ? '' : `\n\n**The report and the diff disagree.** This guide follows the diff.\n\n${mismatch.map(m => `- ${m}`).join('\n')}`

  const steps = output.steps.map((step, i) => [
    `### S${i + 1}: ${flat(step.title)}`,
    '',
    renderSnippet(step.path, step.startLine, step.endLine, source(step.path)),
    '',
    `- **What it does:** ${flat(step.does)}`,
    `- **Hands to the next step:** ${flat(step.handsTo)}`,
    `- **When it fails:** ${flat(step.onFailure)}`,
  ].join('\n'))
  const unwalked = logic.filter(c => !stepped.has(c.file.path) && c.file.status !== 'deleted')
  if (unwalked.length > 0) steps.push(`**Logic files not in this walkthrough:** ${unwalked.map(c => `\`${c.file.path}\``).join(', ')}`)

  const plumbingBlocks = plumbing.map(c => [
    '<details>',
    `<summary><code>${c.file.path}</code>: ${c.purpose}</summary>`,
    '',
    plumbingBody(root, base, head, c.file, source(c.file.path)),
    '',
    '</details>',
  ].join('\n'))

  const spots = output.lookHereFirst.map(spot => {
    const step = output.steps[Number(spot.step.slice(1)) - 1]
    return `- **${spot.step}, line ${spot.line}** (\`${step.path}:${spot.line}\`): ${flat(spot.why)}`
  })

  return [
    `<!-- harbor-guide run=${run.runId} branch=${run.report.branch} base=${base} head=${head} -->`,
    `# Review guide: ${run.report.branch}`,
    `## 1. What this build does\n\n${flat(output.summary)}\n\n${changes}${mismatchText}`,
    `## 2. File map\n\n### Logic\n\n${mapRows(logic)}\n\n### Plumbing\n\n${mapRows(plumbing)}`,
    `## 3. The walkthrough\n\n${steps.join('\n\n') || '_This build has no logic code to walk through._'}`,
    `## 4. Plumbing, collapsed\n\n${plumbingBlocks.join('\n\n') || '_None._'}`,
    `## 5. Look here first\n\n${spots.join('\n') || '_Nothing to point at._'}`,
    `## 6. Before you approve\n\n${output.beforeYouApprove.map(q => `- ${flat(q)}`).join('\n')}`,
    `## 7. Q&A log\n\n${NO_QUESTIONS}`,
  ].join('\n\n') + '\n'
}

// ---------------------------------------------------------------- checking a guide

function parseHeader(guide) {
  const m = /^<!-- harbor-guide run=(\S+) branch=(\S+) base=(\S+) head=(\S+) -->/.exec(guide)
  return m ? { run: m[1], branch: m[2], base: m[3], head: m[4] } : null
}

/**
 * Checks a finished guide against the branch: all seven sections in order, and every
 * code block labelled with a path and range and equal to those lines. Reads the guide
 * as text, so it also catches hand edits and later appends.
 */
function verifyGuide(root, guide) {
  const header = parseHeader(guide)
  if (!header) return { snippets: 0, errors: ['The guide has no harbor-guide header line.'] }
  const errors = []
  const lines = guide.split('\n')

  const positions = SECTIONS.map(s => lines.indexOf(`## ${s}`))
  SECTIONS.forEach((s, i) => { if (positions[i] === -1) errors.push(`Missing section "${s}".`) })
  const found = positions.filter(p => p !== -1)
  if (found.some((p, i) => i > 0 && p < found[i - 1])) errors.push('Sections are out of order.')

  const LABEL = /^\*\*`(.+):(\d+)-(\d+)`\*\*$/
  const FENCE = /^(`{3,})/
  let snippets = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const label = LABEL.exec(line)
    if (FENCE.test(line)) errors.push(`Line ${i + 1}: code block with no path and line range above it.`)
    else if (!label) continue

    // Find the block: the label's fence, or the unlabelled one just reported, so that
    // its contents are not scanned as if they were guide text.
    let open = i
    if (label) {
      open = i + 1
      while (lines[open] === '') open++
    }
    const fence = FENCE.exec(lines[open] ?? '')?.[1]
    if (!fence) {
      errors.push(`Line ${i + 1}: ${line} is not followed by a code block.`)
      continue
    }
    let close = open + 1
    while (close < lines.length && lines[close] !== fence) close++
    if (close >= lines.length) {
      errors.push(`Line ${open + 1}: code block is never closed.`)
      break
    }
    const body = lines.slice(open + 1, close)
    i = close
    if (!label) continue

    snippets++
    const [, path, startText, endText] = label
    const start = Number(startText)
    const end = Number(endText)
    const source = readLines(root, header.head, path)
    if (source === null) errors.push(`${path}:${start}-${end}: file is not on the branch at ${header.head.slice(0, 8)}.`)
    else if (start < 1 || end < start || end > source.length) errors.push(`${path}:${start}-${end}: range is outside the file (${source.length} lines).`)
    else if (source.slice(start - 1, end).join('\n') !== body.join('\n')) errors.push(`${path}:${start}-${end}: snippet does not match the branch.`)
  }
  return { snippets, errors }
}

// ---------------------------------------------------------------- working files

const workDir = (run) => join(run.runDir, WORK_DIR)

/** The guide and working files stay out of the branch and out of git status, so the next build's clean-tree check passes. */
function excludeFromGit(root) {
  const path = resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude').trim())
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const missing = ['.shipyard/runs/*/REVIEW_GUIDE*.md', `.shipyard/runs/*/${WORK_DIR}/`].filter(p => !existing.includes(p))
  if (missing.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${missing.join('\n')}\n`)
}

function readOutput(path, makeItWith) {
  if (!existsSync(path)) throw new Stop(`${path} does not exist. ${makeItWith}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Stop(`${path} is not valid JSON: ${err.message}`)
  }
}

// ---------------------------------------------------------------- commands

function prepare(root, run, force) {
  const guidePath = join(run.runDir, GUIDE_FILE)
  if (existsSync(guidePath) && !force) {
    throw new Stop(`${guidePath} already exists and may hold your Q&A log. Use --force to set it aside and rebuild.`)
  }
  const base = resolveCommit(root, run.report.base)
  const head = resolveCommit(root, 'HEAD')
  const files = changedFiles(root, base, head)
  if (files.length === 0) throw new Stop(`No changes between ${run.report.base} and HEAD.`)

  // Line numbers come from the commit, and this keeps a reader's editor showing the same ones.
  const dirty = git(root, 'status', '--porcelain', '--', ...files.map(f => f.path)).trim()
  if (dirty) throw new Stop(`These changed files have uncommitted edits. Commit or stash them first:\n${dirty}`)

  const diffs = files.map(f => `### ${f.path} (${f.status})\n\n${numberedDiff(root, base, head, f.path)}`)
  const parts = [
    `# Shipyard report\n\n${JSON.stringify(run.report, null, 2)}`,
    `# Changed files\n\n${files.map(f => `- ${f.path} (${f.status}${f.binary ? ', binary' : ''})`).join('\n')}`,
    `# The diff\n\nThe number on each line is its line number in the file on the branch. Removed lines have no number.\n\n${diffs.join('\n\n')}`,
  ]
  // An added file is already whole in the diff. For the rest, surrounding code goes in
  // while it fits; a file left out can still be cited from the lines its diff shows.
  let room = MAX_CONTEXT_CHARS - parts.join('\n\n').length
  const whole = []
  for (const f of files) {
    if (f.status !== 'modified' || f.binary) continue
    const source = readLines(root, head, f.path)
    if (!source || source.length > MAX_FILE_LINES) continue
    const block = `### ${f.path}\n\n${numbered(source)}`
    if (block.length > room) continue
    whole.push(block)
    room -= block.length
  }
  if (whole.length > 0) parts.push(`# Modified files in full, with line numbers\n\n${whole.join('\n\n')}`)

  const work = workDir(run)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  excludeFromGit(root)
  const context = join(work, 'guide-context.md')
  writeFileSync(context, parts.join('\n\n'))
  writeFileSync(join(work, 'guide-meta.json'), JSON.stringify({ base, head, startedAt: Date.now() }))
  console.log(`context: ${context}`)
  console.log(`write your JSON to: ${join(work, 'guide-output.json')}`)
}

function render(root, run) {
  const work = workDir(run)
  const metaPath = join(work, 'guide-meta.json')
  if (!existsSync(metaPath)) throw new Stop(`Nothing prepared for run ${run.runId}. Run prepare first.`)
  const { base, head, startedAt } = JSON.parse(readFileSync(metaPath, 'utf8'))
  if (resolveCommit(root, 'HEAD') !== head) throw new Stop('HEAD has moved since prepare, so the line numbers are stale. Run prepare again.')

  const output = readOutput(join(work, 'guide-output.json'), 'Write it first.')
  const shape = outputShapeProblems(output)
  if (shape.length > 0) throw new Stop(`guide-output.json has problems, so no guide was written:\n${bullets(shape)}`)
  const files = changedFiles(root, base, head)
  const cited = citationProblems(output, files, path => readLines(root, head, path))
  if (cited.length > 0) throw new Stop(`guide-output.json cites code that does not exist, so no guide was written:\n${bullets(cited)}`)

  const guide = renderGuide({ root, run, base, head, files, output })
  const { snippets, errors } = verifyGuide(root, guide)
  if (errors.length > 0) throw new Stop(`The guide failed its check against the branch, so it was not written:\n${bullets(errors)}`)

  const guidePath = join(run.runDir, GUIDE_FILE)
  if (existsSync(guidePath)) renameSync(guidePath, join(run.runDir, `REVIEW_GUIDE.${new Date().toISOString().replace(/[:.]/g, '-')}.md`))
  writeFileSync(guidePath, guide)

  const ms = Date.now() - startedAt
  console.log(guidePath)
  console.log(`${snippets} snippets match the branch. Took ${Math.round(ms / 1000)}s.`)
  if (ms > TARGET_MS) console.log('That is past the 2 minute target.')
}

/** Each walkthrough step's file, read from the guide itself. */
function stepFiles(guide) {
  const steps = new Map()
  for (const m of guide.matchAll(/^### (S\d+):.*\n\n\*\*`(.+):\d+-\d+`\*\*$/gm)) steps.set(m[1], m[2])
  return steps
}

/** The files a question touches: the steps it names, plus changed files it names. */
function filesForQuestion(question, guide, files) {
  const steps = stepFiles(guide)
  const touched = new Set()
  for (const m of question.matchAll(/\bS\d+\b/g)) {
    const path = steps.get(m[0])
    if (!path) throw new Stop(`The guide has no step ${m[0]}. It has ${[...steps.keys()].join(', ') || 'no steps'}.`)
    touched.add(path)
  }
  for (const f of files) {
    if (f.status !== 'deleted' && (question.includes(f.path) || question.includes(basename(f.path)))) touched.add(f.path)
  }
  return [...touched]
}

function loadGuide(run) {
  const guidePath = join(run.runDir, GUIDE_FILE)
  if (!existsSync(guidePath)) throw new Stop(`No guide at ${guidePath}. Run /harbor first.`)
  const guide = readFileSync(guidePath, 'utf8')
  const header = parseHeader(guide)
  if (!header) throw new Stop(`${guidePath} has no harbor-guide header line, so I cannot tell which commit it describes.`)
  return { guidePath, guide, header }
}

function askPrepare(root, run) {
  const question = flat(readFileSync(0, 'utf8'))
  if (!question) throw new Stop('No question given. Ask about a step, a file, or a line.')
  const { guide, header } = loadGuide(run)

  // Answers come from the commit the guide describes, so its step numbers and lines still hold.
  const files = changedFiles(root, header.base, header.head)
  const touched = filesForQuestion(question, guide, files)
  const diffs = files.map(f => `### ${f.path} (${f.status})\n\n${numberedDiff(root, header.base, header.head, f.path)}`)
  const sources = touched.map(path => `### ${path}\n\n${numbered(readLines(root, header.head, path) ?? [])}`)
  const context = [
    `# The review guide\n\n${guide}`,
    `# The diff\n\nThe number on each line is its line number in the file on the branch.\n\n${diffs.join('\n\n')}`,
    `# Files this question touches, with line numbers\n\n${sources.join('\n\n') || 'None named. Work from the guide and the diff.'}`,
    `# The question\n\n${question}`,
  ].join('\n\n')

  const work = workDir(run)
  mkdirSync(work, { recursive: true })
  excludeFromGit(root)
  rmSync(join(work, 'answer-output.json'), { force: true })
  writeFileSync(join(work, 'question.txt'), question)
  const path = join(work, 'ask-context.md')
  writeFileSync(path, context)
  console.log(`context: ${path}`)
  console.log(`write your JSON to: ${join(work, 'answer-output.json')}`)
}

function askAppend(root, run) {
  const { guidePath, guide, header } = loadGuide(run)
  const work = workDir(run)
  const questionPath = join(work, 'question.txt')
  if (!existsSync(questionPath)) throw new Stop('No question prepared. Run ask-prepare first.')
  const question = readFileSync(questionPath, 'utf8')
  const answer = readOutput(join(work, 'answer-output.json'), 'Write it first.')

  const problems = []
  if (typeof answer?.answer !== 'string' || !answer.answer.trim()) problems.push('answer must be a non-empty string')
  if (!Array.isArray(answer?.quotes)) problems.push('quotes must be an array')
  if (problems.length > 0) throw new Stop(`answer-output.json has problems, so it was not logged:\n${bullets(problems)}`)

  const files = changedFiles(root, header.base, header.head)
  const live = new Set(files.filter(f => f.status !== 'deleted' && !f.binary).map(f => f.path))
  const source = (path) => readLines(root, header.head, path)
  for (const q of answer.quotes) {
    const problem = live.has(q?.path)
      ? rangeProblem(q.path, q.startLine, q.endLine, source(q.path))
      : `${q?.path} is not a changed text file in this build.`
    if (problem) problems.push(problem)
  }
  const check = typeof answer.checkYourself === 'string' ? flat(answer.checkYourself) : ''
  if (answer.quotes.length === 0 && !check) problems.push('The answer quotes no lines and names nothing to check.')
  if (problems.length > 0) throw new Stop(`answer-output.json cites code that does not exist, so it was not logged:\n${bullets(problems)}`)

  const n = [...guide.matchAll(/^### Q\d+:/gm)].length + 1
  const parts = [`### Q${n}: ${question}`, flat(answer.answer)]
  for (const q of answer.quotes) parts.push(renderSnippet(q.path, q.startLine, q.endLine, source(q.path)))
  if (check) parts.push(`**Not sure. Check this yourself:** ${check}`)
  const entry = parts.join('\n\n')

  const placeholder = `\n${NO_QUESTIONS}\n`
  writeFileSync(guidePath, guide.endsWith(placeholder)
    ? `${guide.slice(0, -placeholder.length)}\n${entry}\n`
    : `${guide.trimEnd()}\n\n${entry}\n`)
  rmSync(questionPath, { force: true })

  console.log(entry)
  if (resolveCommit(root, 'HEAD') !== header.head) {
    console.log('\nHEAD has moved since this guide was built. This answer describes the commit in the guide.')
  }
}

function verify(root, run) {
  const { guide } = loadGuide(run)
  const { snippets, errors } = verifyGuide(root, guide)
  if (errors.length > 0) throw new Stop(errors.join('\n'))
  console.log(`${snippets} snippets match the branch. All seven sections are present.`)
}

// ---------------------------------------------------------------- main

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const commands = ['prepare', 'render', 'ask-prepare', 'ask-append', 'verify']
  if (!commands.includes(command)) throw new Stop(`usage: harbor.mjs <${commands.join('|')}> [--run <id>] [--force]`)
  const runAt = rest.indexOf('--run')
  if (runAt !== -1 && !rest[runAt + 1]) throw new Stop('--run needs a run id.')
  const root = repoRoot()
  const run = findRun(root, runAt === -1 ? undefined : rest[runAt + 1])
  if (command === 'prepare') prepare(root, run, rest.includes('--force'))
  if (command === 'render') render(root, run)
  if (command === 'ask-prepare') askPrepare(root, run)
  if (command === 'ask-append') askAppend(root, run)
  if (command === 'verify') verify(root, run)
}

try {
  main()
} catch (err) {
  if (!(err instanceof Stop)) throw err
  console.error(err.message)
  process.exit(1)
}
