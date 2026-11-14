#!/usr/bin/env node
// The harbormaster's bookkeeping, as code: contract checks and the token ledger.
// A script gives the same answer every time and costs one Bash call, where doing
// this by hand costs tokens and can round up.
//
//   node run-check.mjs brief <run-dir>          check brief.json against the run's size
//   node run-check.mjs plan <run-dir> [cycle]   check cycles/<n>/plan.json the same way
//                                               and, when it passes, write each task's brief
//   node run-check.mjs start <run-dir> --agent dev-T1 --role dev [--task T1]
//                                               put an agent on deck, and print its brief
//   node run-check.mjs finish <run-dir> --agent dev-T1 --role dev [--task T1]
//        [--state done|blocked|dead] [--model sonnet] [--tokens N] [--tools N] [--ms N]
//        [--fix-of T1] [--handoff -]            take it off deck, record what it used, file
//                                               the handoff it returned (on stdin), and
//                                               print which tasks are now ready. A second
//                                               call for the same agent only adds figures
//   node run-check.mjs verdicts <run-dir> [cycle]
//                                               merge the test reports into state.json and
//                                               print what still fails, and who owns it
//   node run-check.mjs record <run-dir> ...     finish's usage flags alone
//   node run-check.mjs usage <run-dir> [--line] print the usage section for report.md,
//                                               or one line for PROJECT-REPORT.md
//   node run-check.mjs checks <run-dir> <file>  run every browser check, output to file
//
// brief and plan exit 1 and list every problem when the artifact is rejected.
//
// A figure the notification did not give is left out of `record` and stored as
// null. It is never estimated.
//
// No dependencies: this file is copied into ~/.claude/shipyard and run from there.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZES = {
  lite: { criteria: 8, browser: 1, tasks: 2 },
  standard: { criteria: 12, browser: 3, tasks: 5 },
  full: { criteria: 30, browser: null, tasks: 10 },
}
const CHECKS = ['unit', 'api', 'command', 'browser']
const MODELS = ['sonnet', 'opus']

const die = (message) => {
  console.error(`run-check: ${message}`)
  process.exit(1)
}
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    die(`cannot read ${path}: ${err.message}`)
  }
}
const readOptional = (path, fallback) => (existsSync(path) ? readJson(path) : fallback)
/** Written whole or not at all, so a reader never sees half a file. */
const writeJson = (path, value) => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}
const num = (n) => Number(n).toLocaleString('en-US')
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const repoOf = (runDir) => resolve(runDir, '..', '..', '..')
const cycleDir = (runDir, state, cycle) => join(runDir, 'cycles', String(cycle ?? state.cycle ?? 1))

/**
 * Several agents can return in one harbormaster turn, so two of these can run at
 * once. A directory is the lock, because creating one either succeeds or fails.
 */
function locked(runDir, change) {
  const lock = join(runDir, '.state-lock')
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let age = 0
      try { age = Date.now() - statSync(lock).mtimeMs } catch { continue }
      // A holder that died left its lock behind. No change here takes ten seconds.
      if (age > 10_000 || tries > 400) { try { rmdirSync(lock) } catch {} continue }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  try {
    return change()
  } finally {
    try { rmdirSync(lock) } catch {}
  }
}

/** Reads state.json, lets `change` edit it, and writes it back, one caller at a time. */
function updateState(runDir, change) {
  return locked(runDir, () => {
    const path = join(runDir, 'state.json')
    const state = readJson(path)
    const result = change(state)
    writeJson(path, state)
    return result
  })
}

/** Redraws the live view. A view that fails to draw never stops a run. */
function render(runDir) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'render-report.mjs')
  if (existsSync(script)) spawnSync('node', [script, runDir], { stdio: 'ignore', timeout: 20_000 })
}

function sizeOf(state) {
  const limits = SIZES[state.size]
  if (!limits) die(`state.json needs a size of ${Object.keys(SIZES).join(', ')} (found ${JSON.stringify(state.size)})`)
  return limits
}

function verdict(what, problems) {
  if (problems.length === 0) {
    console.log(`${what}: ok`)
    return
  }
  console.error(`${what}: rejected`)
  for (const p of problems) console.error(`- ${p}`)
  process.exit(1)
}

function checkBrief(runDir) {
  const state = readJson(join(runDir, 'state.json'))
  const limits = sizeOf(state)
  const brief = readJson(join(runDir, 'brief.json'))
  const criteria = brief.acceptanceCriteria
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return verdict('brief', ['acceptanceCriteria must be a non-empty array of { id, statement, check }'])
  }

  const problems = []
  if (criteria.length > limits.criteria) {
    problems.push(`${criteria.length} criteria is over the ${state.size} cap of ${limits.criteria}`)
  }
  const seen = new Set()
  for (const c of criteria) {
    const id = c.id ?? '(no id)'
    if (!c.id) problems.push('a criterion has no id')
    if (seen.has(c.id)) problems.push(`duplicate criterion id ${c.id}`)
    seen.add(c.id)
    if (!c.statement) problems.push(`${id} has no statement`)
    if (!CHECKS.includes(c.check)) problems.push(`${id} needs check set to one of ${CHECKS.join(', ')}`)
    if (/\b\d[\d,]*\s+(?:\w+\s+)?tests\b/i.test(c.statement ?? '')) {
      problems.push(`${id} pins a test count; say the existing tests still pass, and let the exit code prove it`)
    }
  }
  const browser = criteria.filter(c => c.check === 'browser').length
  if (limits.browser !== null && browser > limits.browser) {
    problems.push(`${browser} browser criteria is over the ${state.size} cap of ${limits.browser}; group width and flow checks that can share a pass`)
  }
  verdict('brief', problems)
}

function checkPlan(runDir, cycleArg) {
  const state = readJson(join(runDir, 'state.json'))
  const limits = sizeOf(state)
  const cycle = cycleArg ?? state.cycle ?? 1
  const brief = readJson(join(runDir, 'brief.json'))
  const plan = readJson(join(runDir, 'cycles', String(cycle), 'plan.json'))
  const tasks = plan.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) return verdict('plan', ['tasks must be a non-empty array'])

  const problems = []
  if (tasks.length > limits.tasks) {
    problems.push(`${tasks.length} tasks is over the ${state.size} cap of ${limits.tasks}; merge tasks, since each extra one is another agent starting cold`)
  }

  const byId = new Map()
  for (const t of tasks) {
    if (!t.id) { problems.push('a task has no id'); continue }
    if (byId.has(t.id)) problems.push(`duplicate task id ${t.id}`)
    byId.set(t.id, t)
    if (!t.goal) problems.push(`${t.id} has no goal`)
    for (const field of ['ownsFiles', 'dependsOn', 'criteriaIds']) {
      if (!Array.isArray(t[field])) problems.push(`${t.id} needs a ${field} array`)
    }
    for (const file of Array.isArray(t.ownsFiles) ? t.ownsFiles : []) {
      if (/^(\.\/)?\.shipyard(\/|$)/.test(file)) problems.push(`${t.id} owns ${file}; a dev must not write .shipyard/, because testers write the checks that judge its work`)
    }
    if (t.model !== undefined && !MODELS.includes(t.model)) problems.push(`${t.id} has model ${t.model}; use ${MODELS.join(' or ')}`)
  }
  if (problems.length > 0) return verdict('plan', problems)

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) problems.push(`${t.id} depends on ${dep}, which does not exist`)
    }
  }

  const served = new Set(tasks.flatMap(t => t.criteriaIds))
  const known = new Set((brief.acceptanceCriteria ?? []).map(c => c.id))
  for (const id of known) if (!served.has(id)) problems.push(`no task serves ${id}`)
  for (const id of served) if (!known.has(id)) problems.push(`a task serves ${id}, which is not in the brief`)

  // Everything each task runs after, transitively. A task reached while it is
  // still being walked is a dependency cycle.
  const before = new Map()
  const walking = new Set()
  const ancestors = (id) => {
    if (before.has(id)) return before.get(id)
    if (walking.has(id)) {
      problems.push(`dependency cycle through ${id}`)
      return new Set()
    }
    walking.add(id)
    const all = new Set()
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue
      all.add(dep)
      for (const a of ancestors(dep)) all.add(a)
    }
    walking.delete(id)
    before.set(id, all)
    return all
  }
  tasks.forEach(t => ancestors(t.id))

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const [a, b] = [tasks[i], tasks[j]]
      if (ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue
      const shared = a.ownsFiles.filter(f => b.ownsFiles.includes(f))
      if (shared.length > 0) problems.push(`${a.id} and ${b.id} can run at once but both own ${shared.join(', ')}`)
    }
  }
  verdict('plan', problems)
  writeBriefs(runDir, state, cycle, brief, tasks)
}

/**
 * One file per task holding everything its dev needs, so the harbormaster hands
 * over a path instead of retyping the manager's words into a prompt.
 */
function writeBriefs(runDir, state, cycle, brief, tasks) {
  const dir = join(cycleDir(runDir, state, cycle), 'tasks')
  mkdirSync(dir, { recursive: true })
  const repo = repoOf(runDir)
  const mapPath = join(runDir, 'codebase-map.json')
  const map = existsSync(mapPath) ? readOptional(mapPath, {}) : null
  // A task id seen in an earlier cycle starts again here: only this cycle's work counts.
  const begun = new Set(tasks.filter(t => existsSync(join(dir, `${t.id}.json`))).map(t => t.id))
  for (const t of tasks) {
    writeJson(join(dir, `${t.id}.json`), {
      ...t,
      criteria: (brief.acceptanceCriteria ?? []).filter(c => t.criteriaIds.includes(c.id)),
      testCommand: map?.testCommand ?? map?.tests?.testCommand ?? null,
      codebaseMap: map ? relative(repo, mapPath) : null,
    })
  }
  updateState(runDir, (s) => {
    s.tasks = Object.fromEntries(tasks.map(t => [t.id, (begun.has(t.id) && s.tasks?.[t.id]) || 'todo']))
  })
  console.log(`briefs: ${relative(repo, dir)}/<task-id>.json`)
}

function flags(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) die(`unexpected argument ${args[i]}`)
    out[args[i].slice(2)] = args[i + 1]
    i++
  }
  return out
}

/** Absent or "null" stays null. Anything else must be a real count. */
function count(value, name) {
  if (value === undefined || value === 'null') return null
  if (!/^\d+$/.test(value)) die(`--${name} must be a whole number, or be left out when unknown (got ${value})`)
  return Number(value)
}

const totalOf = (usage) => usage.reduce((sum, u) => sum + (u.tokens ?? 0), 0)

function budgetLine(state) {
  const total = totalOf(state.usage ?? [])
  const budget = state.budgetTokens
  if (!budget) return `run tokens: ${num(total)} (no budget set)`
  const line = `${num(total)} of a ${num(budget)} budget, counting this run's agents only, not the account's usage meter`
  return total >= budget ? `OVER BUDGET: ${line}` : `run tokens: ${line}`
}

function usageEntry(f) {
  if (!f.agent || !f.role) die('needs --agent and --role')
  const entry = {
    agent: f.agent,
    role: f.role,
    model: f.model ?? null,
    tokens: count(f.tokens, 'tokens'),
    toolUses: count(f.tools, 'tools'),
    durationMs: count(f.ms, 'ms'),
  }
  if (f['fix-of']) entry.fixOf = f['fix-of']
  return entry
}

function record(runDir, args) {
  const entry = usageEntry(flags(args))
  console.log(updateState(runDir, (state) => {
    state.usage = [...(state.usage ?? []), entry]
    return budgetLine(state)
  }))
}

const planTasks = (runDir, state) => readOptional(join(cycleDir(runDir, state), 'plan.json'), {}).tasks ?? []

/** Tasks nobody has started whose dependencies are all done. */
function readyTasks(state, tasks) {
  const at = state.tasks ?? {}
  return tasks.filter(t => (at[t.id] ?? 'todo') === 'todo' && (t.dependsOn ?? []).every(d => at[d] === 'done')).map(t => t.id)
}

function start(runDir, args) {
  const f = flags(args)
  if (!f.agent || !f.role) die('start needs --agent and --role')
  const state = updateState(runDir, (s) => {
    s.active = [...(s.active ?? []).filter(a => a.id !== f.agent), { id: f.agent, role: f.role, task: f.task ?? f['fix-of'] ?? null, since: now() }]
    if (f.task) s.tasks = { ...s.tasks, [f.task]: 'running' }
    return s
  })
  if (f.task) {
    // What the tasks before this one really built, which can differ from the plan.
    const path = join(cycleDir(runDir, state), 'tasks', `${f.task}.json`)
    if (existsSync(path)) {
      const brief = readJson(path)
      const done = readOptional(join(cycleDir(runDir, state), 'handoff.json'), {}).tasks ?? {}
      const from = (brief.dependsOn ?? []).filter(d => done[d]).map(d => ({ task: d, commit: done[d].commit, built: done[d].built }))
      if (from.length > 0) writeJson(path, { ...brief, from })
      console.log(`brief: ${relative(repoOf(runDir), path)}`)
    }
  }
  render(runDir)
}

const HANDOFF_KEYS = ['STATUS', 'COMMIT', 'TESTS', 'BUILT', 'RUN', 'UNSURE']

/**
 * Reads the block a dev ends its message with. Keys are upper case at the start of
 * a line; a key's value runs until the next key. Returns null when there is none.
 */
function parseHandoff(text) {
  const key = new RegExp(`^[\\s>*_\`#-]*(${HANDOFF_KEYS.join('|')})[*_\`]*:[*_\`]*\\s*(.*)$`)
  const found = {}
  let current = null
  for (const line of text.split('\n')) {
    const m = key.exec(line)
    if (m) {
      current = m[1]
      found[current] = m[2] ? [m[2]] : []
    } else if (current && line.trim()) {
      found[current].push(line.trim())
    }
  }
  if (!found.STATUS) return null
  const value = (k) => (found[k] ?? []).join('\n').trim() || null
  const clean = (v) => v.trim().replace(/^[`'"]+|[`'"]+$/g, '')
  const tests = (found.TESTS ?? [])
    .map(l => l.replace(/^[-*]\s*/, '').split('|').map(clean))
    .filter(p => p.length >= 2 && p[0] && p[1])
    .flatMap(([ids, file, ...name]) => ids.split(/[,\s]+/).filter(Boolean).map(id => ({ id, file, name: name.join(' | ') || null })))
  return {
    status: /^blocked/i.test(value('STATUS') ?? '') ? 'blocked' : 'done',
    commit: value('COMMIT'),
    built: value('BUILT'),
    run: value('RUN'),
    unsure: /^(none|nothing|n\/a|-)\.?$/i.test(value('UNSURE') ?? 'none') ? null : value('UNSURE'),
    tests,
  }
}

/** Files one agent's handoff where the next agent reads it. */
function fileHandoff(runDir, state, f, text) {
  const parsed = parseHandoff(text)
  const task = f.task ?? f['fix-of']
  if (!task) return parsed
  locked(runDir, () => {
    const path = join(cycleDir(runDir, state), 'handoff.json')
    const all = readOptional(path, {})
    all.tasks ??= {}
    all.tests ??= {}
    if (parsed) {
      const { tests, ...rest } = parsed
      // A fix keeps what the task's dev said and replaces only what it restates.
      const kept = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null))
      all.tasks[task] = { ...all.tasks[task], ...kept, agent: f.agent }
      for (const t of tests) {
        all.tests[t.id] = [...(all.tests[t.id] ?? []).filter(e => e.task !== task || e.file !== t.file), { task, file: t.file, name: t.name }]
      }
    } else {
      all.tasks[task] = { ...all.tasks[task], agent: f.agent, raw: text.trim().slice(0, 1500) }
    }
    mkdirSync(dirname(path), { recursive: true })
    writeJson(path, all)
    if (parsed?.unsure) {
      const notesPath = join(runDir, 'report-notes.json')
      const notes = readOptional(notesPath, {})
      notes.plan_changes ??= []
      notes.notes = [...(notes.notes ?? []), `${f.agent}: ${parsed.unsure}`]
      notes.observations ??= []
      writeJson(notesPath, notes)
    }
  })
  return parsed
}

const MAX_DEATHS = 3

function finish(runDir, args) {
  const f = flags(args)
  const entry = usageEntry(f)
  const wanted = f.state ?? 'done'
  if (!['done', 'blocked', 'dead'].includes(wanted)) die(`--state must be done, blocked or dead (got ${wanted})`)
  const text = f.handoff === '-' ? readFileSync(0, 'utf8') : ''
  const before = readJson(join(runDir, 'state.json'))

  // An agent's report can arrive before its figures do. The harbormaster finishes
  // it on the report, so that nothing waits, and calls again when the figures come.
  // That second call only fills them in. A death or a handoff is always news.
  const onDeck = (before.active ?? []).some(a => a.id === f.agent)
  if (!onDeck && wanted !== 'dead' && !text.trim() && (before.usage ?? []).some(u => u.agent === f.agent)) {
    console.log(updateState(runDir, (s) => {
      const row = s.usage.findLast(u => u.agent === f.agent)
      for (const k of ['model', 'tokens', 'toolUses', 'durationMs']) row[k] ??= entry[k]
      return `${f.agent} was already finished: figures filled in, nothing else changed\n${budgetLine(s)}`
    }))
    render(runDir)
    return
  }
  const handoff = text.trim() ? fileHandoff(runDir, before, f, text) : null
  const lines = []

  const state = updateState(runDir, (s) => {
    s.usage = [...(s.usage ?? []), entry]
    s.active = (s.active ?? []).filter(a => a.id !== f.agent)
    if (wanted === 'dead') {
      s.deaths = [...(s.deaths ?? []), { agent: f.agent, task: f.task ?? null, at: now() }]
    }
    if (f.task) {
      const deaths = (s.deaths ?? []).filter(d => d.task === f.task).length
      let to = wanted === 'done' && handoff?.status === 'blocked' ? 'blocked' : wanted
      if (to === 'dead') {
        to = deaths >= MAX_DEATHS ? 'blocked' : 'todo'
        lines.push(to === 'blocked'
          ? `${f.task} blocked: death ${deaths} of ${MAX_DEATHS}, escalate it at the next triage`
          : `${f.task} died (${deaths} of ${MAX_DEATHS}): respawn it with a handoff note${entry.model === 'sonnet' ? ', on opus' : ''}`)
      } else {
        const named = handoff ? `${handoff.tests.length} test(s) named` : 'no handoff block'
        lines.push(`${f.task} ${to}${handoff?.commit ? ` (${handoff.commit})` : ''}, ${named}`)
      }
      s.tasks = { ...s.tasks, [f.task]: to }
    }
    return s
  })

  if (text.trim() && !handoff) lines.push('handoff: no STATUS block found, so the message was saved as written')
  if (handoff?.unsure) lines.push('unsure: added to report-notes.json')

  const tasks = planTasks(runDir, state)
  if (tasks.length > 0 && (f.task || f['fix-of'])) {
    const at = state.tasks ?? {}
    const ready = readyTasks(state, tasks)
    const running = tasks.filter(t => at[t.id] === 'running').map(t => t.id)
    const blocked = tasks.filter(t => at[t.id] === 'blocked').map(t => t.id)
    if (ready.length) lines.push(`ready: ${ready.join(' ')}`)
    if (running.length) lines.push(`running: ${running.join(' ')}`)
    if (blocked.length) lines.push(`blocked: ${blocked.join(' ')}`)
    if (tasks.every(t => at[t.id] === 'done')) lines.push(`build complete: all ${tasks.length} task(s) done`)
  }

  // Separation of duties, checked rather than trusted. A dev still on deck has
  // files half written, so the check waits for a tester that runs alone.
  if (/tester/.test(f.role) && !(state.active ?? []).some(a => a.role === 'dev')) {
    const r = spawnSync('git', ['status', '--porcelain', '--', '.', ':(exclude).shipyard'], { cwd: repoOf(runDir), encoding: 'utf8' })
    const changed = (r.stdout ?? '').split('\n').filter(Boolean)
    if (r.status === 0) lines.push(changed.length ? `TREE MODIFIED outside .shipyard/: ${changed.slice(0, 10).join(', ')}` : 'tree clean')
  }

  lines.push(budgetLine(state))
  console.log(lines.join('\n'))
  render(runDir)
}

/** Testers write criteria keyed by id, or sometimes as a list of { id, verdict, evidence }. */
function criteriaById(report) {
  const { criteria } = report ?? {}
  if (!Array.isArray(criteria)) return criteria ?? {}
  return Object.fromEntries(criteria.filter(c => c?.id).map(({ id, ...result }) => [id, result]))
}

/**
 * The testers' last word on each criterion, written into state.json. Reports are
 * read in order, because a re-test lists only what it settled. Prints only what the
 * harbormaster must act on, so it never has to read a report.
 */
function verdicts(runDir, cycleArg) {
  const before = readJson(join(runDir, 'state.json'))
  const dir = cycleDir(runDir, before, cycleArg)
  const reports = (existsSync(dir) ? readdirSync(dir) : [])
    .map(name => /^test-report(?:-(browser)|-fix(\d+))?\.json$/.exec(name))
    .filter(Boolean)
    .map(m => ({ name: m[0], order: m[2] ? 1 + Number(m[2]) : m[1] ? 1 : 0 }))
    .sort((a, b) => a.order - b.order)
    .map(r => readJson(join(dir, r.name)))
  if (reports.length === 0) die(`no test report in ${dir}`)

  const results = Object.assign({}, ...reports.map(criteriaById))
  const criteria = readOptional(join(runDir, 'brief.json'), {}).acceptanceCriteria ?? []
  const ids = criteria.length ? criteria.map(c => c.id) : Object.keys(results)
  const verdictOf = (id) => {
    const r = results[id]
    const v = typeof r === 'string' ? r : r?.verdict
    return v === 'pass' || v === 'fail' ? v : 'untested'
  }
  updateState(runDir, (s) => {
    s.criteria = { ...s.criteria, ...Object.fromEntries(ids.map(id => [id, verdictOf(id)])) }
  })

  const seen = reports.flatMap(r => (Array.isArray(r.observations) ? r.observations : [])).filter(o => o?.what)
  let added = 0
  if (seen.length > 0) {
    locked(runDir, () => {
      const notesPath = join(runDir, 'report-notes.json')
      const notes = readOptional(notesPath, {})
      notes.plan_changes ??= []
      notes.notes ??= []
      notes.observations ??= []
      for (const o of seen) {
        if (notes.observations.some(n => n.what === o.what)) continue
        notes.observations.push(o)
        added++
      }
      writeJson(notesPath, notes)
    })
  }

  const tasks = planTasks(runDir, before)
  const open = ids.filter(id => verdictOf(id) !== 'pass')
  const lines = [open.length ? `criteria: ${ids.length - open.length}/${ids.length} pass` : `ALL PASS: ${ids.length}/${ids.length}`]
  const owners = new Map()
  for (const id of open) {
    const owning = tasks.filter(t => (t.criteriaIds ?? []).includes(id)).map(t => t.id)
    owners.set(id, owning)
    const tag = criteria.find(c => c.id === id)?.check
    const r = results[id]
    const evidence = r === undefined ? 'no tester reported on it' : String((typeof r === 'object' ? r?.evidence : '') ?? '').replace(/\s+/g, ' ').slice(0, 300)
    lines.push(`${verdictOf(id)} ${id}${tag ? ` (${tag})` : ''}${owning.length ? ` owner ${owning.join(',')}` : ''}: ${evidence}`)
  }
  // One of the three conditions for a direct fix. The other two are a judgement.
  const single = [...new Set([...owners.values()].filter(o => o.length === 1).map(o => o[0]))]
  if (open.length > 0 && single.length > 0 && [...owners.values()].every(o => o.length === 1)) {
    lines.push(`one owner each: ${single.join(' ')} (a direct fix is allowed if this is the first round and the evidence names the cause)`)
  }
  const high = seen.filter(o => /high/i.test(o.severity ?? ''))
  if (added) lines.push(`observations: ${added} added to report-notes.json${high.length ? `, ${high.length} high severity` : ''}`)
  for (const o of high) lines.push(`high: ${String(o.what).replace(/\s+/g, ' ').slice(0, 200)}`)
  console.log(lines.join('\n'))
  render(runDir)
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n')
}

/** Fix agents per dev task for each model, over every run beside this one. */
function acrossRuns(runDir) {
  const runsDir = dirname(runDir)
  const models = new Map()
  let runs = 0
  for (const name of readdirSync(runsDir)) {
    const file = join(runsDir, name, 'state.json')
    if (!existsSync(file)) continue
    let usage
    try {
      usage = JSON.parse(readFileSync(file, 'utf8')).usage
    } catch {
      continue // One unreadable old run must not stop this report.
    }
    const devs = (usage ?? []).filter(u => u.role === 'dev')
    if (devs.length === 0) continue
    runs++
    const row = (model) => {
      const key = model ?? 'unknown'
      if (!models.has(key)) models.set(key, { tasks: 0, fixes: 0, tokens: 0 })
      return models.get(key)
    }
    for (const u of devs) {
      // A fix counts against the model that wrote the task, which is the point of
      // the comparison: a cheap dev that needs more fixes may not be cheaper.
      const origin = u.fixOf ? devs.find(d => d.agent === `dev-${u.fixOf}` && !d.fixOf) : u
      const model = (origin ?? u).model
      if (u.fixOf) row(model).fixes++
      else row(model).tasks++
      row(model).tokens += u.tokens ?? 0
    }
  }
  return { runs, models }
}

function usageReport(runDir, args) {
  const state = readJson(join(runDir, 'state.json'))
  const usage = state.usage ?? []
  const total = totalOf(usage)
  const unknown = usage.filter(u => u.tokens === null || u.tokens === undefined).length
  const hasHarbormaster = usage.some(u => u.role === 'harbormaster')
  const scope = hasHarbormaster ? 'harbormaster included' : "harbormaster's own tokens not included"
  const size = state.size ?? 'unsized'

  if (args.includes('--line')) {
    const gaps = unknown ? `, ${unknown} without a figure` : ''
    console.log(`Tokens: ${num(total)} across ${usage.length} agents (size ${size}, ${scope}${gaps}).`)
    return
  }

  const roles = new Map()
  for (const u of usage) {
    const r = roles.get(u.role) ?? { agents: 0, tokens: 0 }
    r.agents++
    r.tokens += u.tokens ?? 0
    roles.set(u.role, r)
  }
  const share = (n) => (total ? `${Math.round(n / total * 100)}%` : '-')
  const out = [
    '## Token use',
    '',
    `Size: ${size}. Reported total: ${num(total)} tokens across ${usage.length} agents.`,
    '',
    table(['Role', 'Agents', 'Tokens', 'Share'],
      [...roles].sort((a, b) => b[1].tokens - a[1].tokens).map(([role, r]) => [role, r.agents, num(r.tokens), share(r.tokens)])),
    '',
    table(['Agent', 'Model', 'Tokens', 'Tool uses', 'Seconds'],
      usage.map(u => [
        u.fixOf ? `${u.agent} (fix of ${u.fixOf})` : u.agent,
        u.model ?? '-',
        u.tokens == null ? 'unavailable' : num(u.tokens),
        u.toolUses ?? '-',
        u.durationMs == null ? '-' : Math.round(u.durationMs / 1000),
      ])),
    '',
    hasHarbormaster ? 'The harbormaster is included above.' : "The harbormaster's own tokens are not included: no figure was available.",
  ]
  if (unknown) out.push(`${unknown} agent(s) reported no figure and count as 0 in the totals, so the real total is higher.`)
  if (state.budgetTokens) out.push(`Budget: ${budgetLine(state)}.`)

  const { runs, models } = acrossRuns(runDir)
  if (models.size > 0) {
    out.push('', `### Dev models across ${runs} run(s)`, '',
      table(['Model', 'Tasks', 'Fix agents', 'Fixes per task', 'Tokens'],
        [...models].map(([model, m]) => [model, m.tasks, m.fixes, m.tasks ? (m.fixes / m.tasks).toFixed(2) : '-', num(m.tokens)])))
  }
  console.log(out.join('\n'))
}

/**
 * Runs every browser check from the repo root. Only the summary goes to stdout, so
 * the harbormaster's context stays small. browser.mjs is the older single-file form.
 */
function runChecks(runDir, outFile) {
  if (!outFile) die('checks needs an output file')
  const repo = repoOf(runDir)
  const dir = join(repo, '.shipyard', 'checks')
  const files = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.check.mjs') || f === 'browser.mjs').sort()
    : []
  writeFileSync(outFile, '')
  if (files.length === 0) {
    console.log('no browser checks')
    return
  }
  let failed = 0
  for (const f of files) {
    const r = spawnSync('node', [join(dir, f)], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 })
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`
    appendFileSync(outFile, `== ${f}\n${output}\n`)
    if (r.status === 0) {
      console.log(`ok ${f}`)
    } else {
      failed++
      const fails = output.split('\n').filter(l => l.startsWith('FAIL ')).slice(0, 10)
      console.log(`FAILED ${f}${fails.length ? `: ${fails.join(', ')}` : ''}`)
    }
  }
  if (failed > 0) process.exit(1)
}

const [command, runDir, ...rest] = process.argv.slice(2)
if (!command || !runDir) die('usage: run-check.mjs brief|plan|start|finish|verdicts|record|usage|checks <run-dir> [...]')
if (!existsSync(runDir)) die(`no such run directory: ${runDir}`)

if (command === 'brief') checkBrief(runDir)
else if (command === 'plan') checkPlan(runDir, rest[0])
else if (command === 'start') start(runDir, rest)
else if (command === 'finish') finish(runDir, rest)
else if (command === 'verdicts') verdicts(runDir, rest[0])
else if (command === 'record') record(runDir, rest)
else if (command === 'usage') usageReport(runDir, rest)
else if (command === 'checks') runChecks(runDir, rest[0])
else die(`unknown command ${command} in ${basename(process.argv[1])}`)
