import pc from 'picocolors'
import type { Plan } from '../schemas/index.js'

export function timestampSlug(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-')
}

export function renderPlanSummary(plan: Plan): string {
  const ready = plan.tasks.filter(t => t.dependsOn.length === 0).length
  const lines = [
    pc.bold('PLAN'),
    `  ${plan.summary}`,
    '',
    `  ${plan.tasks.length} tasks; ${ready} task${ready === 1 ? '' : 's'} can start immediately`,
    '',
  ]
  for (const t of plan.tasks) {
    const after = t.dependsOn.length > 0 ? pc.dim(` (after ${t.dependsOn.join(', ')})`) : ''
    lines.push(`  ${pc.cyan(t.id)} ${t.goal}${after}`)
    lines.push(pc.dim(`      owns: ${t.ownsFiles.join(', ')}`))
    lines.push(pc.dim(`      serves: ${t.criteriaIds.join(', ')}`))
  }
  return lines.join('\n')
}
