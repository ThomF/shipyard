import { describe, it, expect } from 'vitest'
import { renderPlanSummary, timestampSlug } from '../src/cli/render.js'
import type { Plan } from '../src/schemas/index.js'

const plan: Plan = {
  summary: 'Two tasks, one sequential',
  tasks: [
    { id: 'T1', goal: 'Write the parser', dependsOn: [], ownsFiles: ['src/parse.ts'], criteriaIds: ['AC1'] },
    { id: 'T2', goal: 'Wire the CLI', dependsOn: ['T1'], ownsFiles: ['src/cli.ts'], criteriaIds: ['AC2'] },
  ],
}

describe('timestampSlug', () => {
  it('is filesystem-safe and sorts chronologically', () => {
    const a = timestampSlug(new Date('2026-10-01T09:05:00Z'))
    const b = timestampSlug(new Date('2026-10-01T11:05:00Z'))
    expect(a).toBe('2026-10-01T09-05-00')
    expect(a < b).toBe(true)
    expect(a).not.toMatch(/[:/\\]/)
  })
})

describe('renderPlanSummary', () => {
  it('lists every task with its goal', () => {
    const out = renderPlanSummary(plan)
    expect(out).toContain('T1')
    expect(out).toContain('Write the parser')
    expect(out).toContain('T2')
  })

  it('shows dependencies so sequencing is visible', () => {
    expect(renderPlanSummary(plan)).toMatch(/T2.*after T1|depends on T1/s)
  })

  it('shows which files each task owns', () => {
    expect(renderPlanSummary(plan)).toContain('src/parse.ts')
  })

  it('reports how many tasks can start immediately', () => {
    expect(renderPlanSummary(plan)).toMatch(/1 task can start immediately/)
  })
})
