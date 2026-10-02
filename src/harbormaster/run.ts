import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runPaths, assertGitRepo } from '../state/paths.js'
import { initState, writeState, type RunState } from '../state/store.js'
import { isEmptyTarget } from '../stages/survey.js'
import { BriefSchema, CodebaseMapSchema, PlanSchema, type Brief, type CodebaseMap, type Plan } from '../schemas/index.js'

export type RunDeps = {
  target: string
  idea: string
  runId: string
  createdAt: string
  intake: () => Promise<{ brief: Brief; costUsd: number } | { dead: string }>
  survey: (brief: Brief) => Promise<{ map: CodebaseMap; costUsd: number } | { dead: string }>
  plan: (brief: Brief, map: CodebaseMap) => Promise<{ plan: Plan; spec: string; costUsd: number } | { dead: string }>
}

export type RunOutcome =
  | { ok: true; state: RunState; planPath: string }
  | { ok: false; state: RunState; reason: string }

async function readIfPresent<T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

const EMPTY_MAP: CodebaseMap = {
  structure: '', language: '', framework: null, testCommand: null, conventions: [], relevantModules: [],
}

export async function runThroughPlan(deps: RunDeps): Promise<RunOutcome> {
  await assertGitRepo(deps.target)

  const paths = runPaths(deps.target, deps.runId)
  await mkdir(paths.agentsDir, { recursive: true })
  await mkdir(paths.cycleDir(1), { recursive: true })

  const state = initState({
    runId: deps.runId, target: deps.target, idea: deps.idea, createdAt: deps.createdAt,
  })

  const fail = async (reason: string): Promise<RunOutcome> => {
    state.verdict = 'failed'
    await writeState(paths.state, state)
    return { ok: false, state, reason }
  }

  // --- intake ---
  state.stage = 'intake'
  await writeState(paths.state, state)
  let brief = await readIfPresent(paths.brief, BriefSchema)
  if (!brief) {
    const r = await deps.intake()
    if ('dead' in r) return fail(r.dead)
    brief = r.brief
    state.totalCostUsd += r.costUsd
    await writeFile(paths.brief, JSON.stringify(brief, null, 2))
  }
  state.completedStages.push('intake')

  // --- survey ---
  state.stage = 'survey'
  await writeState(paths.state, state)
  let map = await readIfPresent(paths.codebaseMap, CodebaseMapSchema)
  if (!map) {
    if (await isEmptyTarget(deps.target)) {
      map = EMPTY_MAP
    } else {
      const r = await deps.survey(brief)
      if ('dead' in r) return fail(r.dead)
      map = r.map
      state.totalCostUsd += r.costUsd
    }
    await writeFile(paths.codebaseMap, JSON.stringify(map, null, 2))
  }
  state.completedStages.push('survey')

  // --- plan ---
  state.stage = 'plan'
  await writeState(paths.state, state)
  const planPath = join(paths.cycleDir(state.cycle), 'plan.json')
  let plan = await readIfPresent(planPath, PlanSchema)
  if (!plan) {
    const r = await deps.plan(brief, map)
    if ('dead' in r) return fail(r.dead)
    plan = r.plan
    state.totalCostUsd += r.costUsd
    await writeFile(planPath, JSON.stringify(plan, null, 2))
    await writeFile(join(paths.cycleDir(state.cycle), 'spec.md'), r.spec)
  }
  state.completedStages.push('plan')

  state.stage = 'build'
  await writeState(paths.state, state)
  return { ok: true, state, planPath }
}
