#!/usr/bin/env node
// The harbormaster's bookkeeping, as code: contract checks and the token ledger.
// A script gives the same answer every time and costs one Bash call, where doing
// this by hand costs tokens and can round up.
//
//   node run-check.mjs brief <run-dir>          check brief.json against the run's size
//   node run-check.mjs plan <run-dir> [cycle]   check cycles/<n>/plan.json the same way
//   node run-check.mjs record <run-dir> --agent dev-T1 --role dev [--model sonnet]
//        [--tokens N] [--tools N] [--ms N] [--fix-of T1]
//                                               add one agent to state.json's usage
//   node run-check.mjs usage <run-dir> [--line] print the usage section for report.md,
//                                               or one line for PROJECT-REPORT.md
//
// brief and plan exit 1 and list every problem when the artifact is rejected.
//
// A figure the notification did not give is left out of `record` and stored as
// null. It is never estimated.
//
// No dependencies: this file is copied into ~/.claude/shipyard and run from there.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
const num = (n) => Number(n).toLocaleString('en-US')

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

function record(runDir, args) {
  const f = flags(args)
  if (!f.agent || !f.role) die('record needs --agent and --role')
  const path = join(runDir, 'state.json')
  const state = readJson(path)
  const entry = {
    agent: f.agent,
    role: f.role,
    model: f.model ?? null,
    tokens: count(f.tokens, 'tokens'),
    toolUses: count(f.tools, 'tools'),
    durationMs: count(f.ms, 'ms'),
  }
  if (f['fix-of']) entry.fixOf = f['fix-of']
  state.usage = [...(state.usage ?? []), entry]
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
  console.log(budgetLine(state))
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

const [command, runDir, ...rest] = process.argv.slice(2)
if (!command || !runDir) die('usage: run-check.mjs brief|plan|record|usage <run-dir> [...]')
if (!existsSync(runDir)) die(`no such run directory: ${runDir}`)

if (command === 'brief') checkBrief(runDir)
else if (command === 'plan') checkPlan(runDir, rest[0])
else if (command === 'record') record(runDir, rest)
else if (command === 'usage') usageReport(runDir, rest)
else die(`unknown command ${command} in ${basename(process.argv[1])}`)
