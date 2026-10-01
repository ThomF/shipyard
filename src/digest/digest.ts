import type { RunState } from '../state/store.js'
import type { Brief, Plan } from '../schemas/index.js'

export const DIGEST_CAP = 8000

export type DigestInput = {
  state: RunState
  brief: Brief
  plan?: Plan
  criteriaStatus?: Record<string, 'pass' | 'fail' | 'untested'>
  taskStatus?: Record<string, 'done' | 'running' | 'blocked' | 'todo'>
  learnings?: string
}

/** Sections in drop order: the first entry is discarded first when over cap. */
function sections(input: DigestInput): Array<{ droppable: boolean; text: string }> {
  const { state, brief, plan, criteriaStatus = {}, taskStatus = {}, learnings } = input

  const criteria = brief.acceptanceCriteria
    .map(c => `  - ${c.id} [${criteriaStatus[c.id] ?? 'untested'}] ${c.statement}`)
    .join('\n')

  const byStatus = (s: string) =>
    (plan?.tasks ?? []).filter(t => (taskStatus[t.id] ?? 'todo') === s)

  const doneDetail = byStatus('done').map(t => `  - ${t.id} ${t.goal}`).join('\n')
  const openDetail = [...byStatus('running'), ...byStatus('blocked'), ...byStatus('todo')]
    .map(t => `  - ${t.id} [${taskStatus[t.id] ?? 'todo'}] ${t.goal}`)
    .join('\n')

  return [
    // dropped first
    { droppable: true, text: doneDetail ? `COMPLETED TASKS\n${doneDetail}` : '' },
    { droppable: true, text: plan?.summary ? `PLAN SUMMARY\n  ${plan.summary}` : '' },
    { droppable: true, text: learnings ? `ALREADY TRIED AND FAILED\n${learnings}` : '' },
    // never dropped
    { droppable: false, text: `GOAL\n  ${brief.goal}` },
    { droppable: false, text: `PROGRESS\n  cycle ${state.cycle} of ${state.maxCycles}` },
    { droppable: false, text: `ACCEPTANCE CRITERIA\n${criteria}` },
    { droppable: false, text: openDetail ? `OPEN TASKS\n${openDetail}` : '' },
  ]
}

export function buildDigest(input: DigestInput): string {
  const all = sections(input).filter(s => s.text.length > 0)
  const render = (parts: typeof all) => parts.map(p => p.text).join('\n\n')

  // Keep non-droppable sections in their declared order; drop droppables front-first.
  let kept = all
  let out = render(kept)
  let dropped = 0
  while (out.length > DIGEST_CAP && kept.some(s => s.droppable)) {
    const idx = kept.findIndex(s => s.droppable)
    kept = [...kept.slice(0, idx), ...kept.slice(idx + 1)]
    dropped++
    out = render(kept)
  }

  if (dropped > 0) {
    out = `NOTE: ${dropped} section(s) truncated to fit the digest cap; this is a partial picture.\n\n${out}`
  }
  return out.length > DIGEST_CAP ? out.slice(0, DIGEST_CAP) : out
}
