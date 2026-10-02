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

/**
 * Emitted verbatim whenever the returned digest is not the complete rendering of
 * the input. Room for it is reserved *before* anything is cut, so it is never
 * itself truncated: a manager can always trust that a missing notice means a
 * complete picture.
 */
const TRUNCATION_NOTICE =
  'NOTE: this digest was truncated to fit the cap; it is a partial picture.'

export function buildDigest(input: DigestInput): string {
  const all = sections(input).filter(s => s.text.length > 0)
  const render = (parts: typeof all) => parts.map(p => p.text).join('\n\n')

  const full = render(all)
  if (full.length <= DIGEST_CAP) return full

  // From here the result is necessarily partial, so the notice is mandatory and
  // its cost is charged against the cap before any content is measured.
  let kept = all
  let dropped = 0
  const header = (): string => {
    const detail = dropped > 0 ? `\n  (dropped ${dropped} lower-priority section(s))` : ''
    return `${TRUNCATION_NOTICE}${detail}\n\n`
  }

  // Keep non-droppable sections in their declared order; drop droppables front-first.
  let out = render(kept)
  while (out.length + header().length > DIGEST_CAP && kept.some(s => s.droppable)) {
    const idx = kept.findIndex(s => s.droppable)
    kept = [...kept.slice(0, idx), ...kept.slice(idx + 1)]
    dropped++
    out = render(kept)
  }

  // Non-droppable content alone can still exceed the cap (e.g. hundreds of
  // acceptance criteria). Hard-cut it, but only within the room the notice left.
  const prefix = header()
  const room = Math.max(0, DIGEST_CAP - prefix.length)
  return prefix + (out.length > room ? out.slice(0, room) : out)
}
