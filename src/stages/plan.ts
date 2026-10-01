import type { Plan, Brief, CodebaseMap } from '../schemas/index.js'
import type { AgentOutcome } from '../agents/spawn.js'
import { buildPlanPrompt } from '../prompts/plan.js'

/** Transitive dependency closure for one task. */
function ancestors(plan: Plan, id: string, seen = new Set<string>()): Set<string> {
  const task = plan.tasks.find(t => t.id === id)
  if (!task) return seen
  for (const dep of task.dependsOn) {
    if (seen.has(dep)) continue
    seen.add(dep)
    ancestors(plan, dep, seen)
  }
  return seen
}

function hasCycle(plan: Plan): boolean {
  return plan.tasks.some(t => ancestors(plan, t.id).has(t.id))
}

export function validatePlan(plan: Plan, criterionIds: string[]): string[] {
  const problems: string[] = []
  const ids = plan.tasks.map(t => t.id)

  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (duplicates.length > 0) problems.push(`duplicate task ids: ${duplicates.join(', ')}`)

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.includes(dep)) problems.push(`task ${task.id} depends on unknown task ${dep}`)
    }
    for (const cid of task.criteriaIds) {
      if (!criterionIds.includes(cid)) problems.push(`task ${task.id} references unknown criterion ${cid}`)
    }
  }

  if (hasCycle(plan)) {
    problems.push('the task graph contains a dependency cycle')
    return problems // ancestor checks below are meaningless on a cyclic graph
  }

  for (const cid of criterionIds) {
    if (!plan.tasks.some(t => t.criteriaIds.includes(cid))) {
      problems.push(`no task serves acceptance criterion ${cid}`)
    }
  }

  // Only tasks that could run concurrently can collide.
  for (let i = 0; i < plan.tasks.length; i++) {
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i]!
      const b = plan.tasks[j]!
      const ordered = ancestors(plan, a.id).has(b.id) || ancestors(plan, b.id).has(a.id)
      if (ordered) continue
      const shared = a.ownsFiles.filter(f => b.ownsFiles.includes(f))
      if (shared.length > 0) {
        problems.push(
          `tasks ${a.id} and ${b.id} can run concurrently but both own: ${shared.join(', ')}`,
        )
      }
    }
  }

  return problems
}

export type PlanDeps = {
  brief: Brief
  map: CodebaseMap
  digest: string
  maxAttempts: number
  spawn: (args: { prompt: string }) => Promise<AgentOutcome<{ plan: Plan; spec: string }>>
}

export type PlanResult = { plan: Plan; spec: string; costUsd: number } | { dead: string }

export async function runPlan(deps: PlanDeps): Promise<PlanResult> {
  const criterionIds = deps.brief.acceptanceCriteria.map(c => c.id)
  let problems: string[] = []
  let costUsd = 0

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    const prompt = buildPlanPrompt({ brief: deps.brief, map: deps.map, digest: deps.digest, problems })
    const outcome = await deps.spawn({ prompt })

    if (outcome.status === 'dead') {
      return { dead: `manager died during planning (${outcome.reason}): ${outcome.detail}` }
    }
    costUsd += outcome.costUsd

    problems = validatePlan(outcome.value.plan, criterionIds)
    if (problems.length === 0) {
      return { plan: outcome.value.plan, spec: outcome.value.spec, costUsd }
    }
  }

  return {
    dead: `manager produced an invalid plan after ${deps.maxAttempts} attempts: ${problems.join('; ')}`,
  }
}
