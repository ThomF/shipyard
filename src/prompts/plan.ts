import type { Brief, CodebaseMap } from '../schemas/index.js'

export function buildPlanPrompt(args: {
  brief: Brief
  map: CodebaseMap
  digest: string
  problems: string[]
}): string {
  const parts = [
    'Decompose the goal below into a task DAG, and write a spec page explaining your approach.',
    '',
    'DIGEST',
    args.digest,
    '',
    'GOAL',
    args.brief.goal,
    '',
    'ACCEPTANCE CRITERIA',
    ...args.brief.acceptanceCriteria.map(c => `  ${c.id}: ${c.statement}`),
    '',
    'CODEBASE',
    `  language: ${args.map.language || 'unknown'}`,
    `  test command: ${args.map.testCommand ?? 'none found'}`,
    `  conventions: ${args.map.conventions.join('; ') || 'none recorded'}`,
    '',
    'RULES',
    '  Every acceptance criterion must be served by at least one task.',
    '  Two tasks that can run at the same time must NOT list the same file.',
    '  If two pieces of work need the same file, make one depend on the other.',
  ]

  if (args.problems.length > 0) {
    parts.push(
      '',
      'YOUR PREVIOUS PLAN WAS REJECTED. Fix exactly these problems:',
      ...args.problems.map(p => `  - ${p}`),
    )
  }
  return parts.join('\n')
}
