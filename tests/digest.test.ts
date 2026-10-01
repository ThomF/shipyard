import { describe, it, expect } from 'vitest'
import { buildDigest, DIGEST_CAP } from '../src/digest/digest.js'
import { initState } from '../src/state/store.js'
import type { Brief, Plan } from '../src/schemas/index.js'

const brief: Brief = {
  goal: 'Build a CSV to JSON converter',
  stack: ['typescript'],
  constraints: ['no deps'],
  assumptions: ['UTF-8 input'],
  acceptanceCriteria: [
    { id: 'AC1', statement: 'converts a simple file', verifiable: true },
    { id: 'AC2', statement: 'handles quoted commas', verifiable: true },
  ],
  risks: [],
}

const state = initState({ runId: 'r1', target: '/t', idea: 'csv to json', createdAt: 'now' })

describe('buildDigest', () => {
  it('states the goal', () => {
    expect(buildDigest({ state, brief })).toContain('Build a CSV to JSON converter')
  })

  it('lists every criterion with its status', () => {
    const d = buildDigest({ state, brief, criteriaStatus: { AC1: 'pass', AC2: 'fail' } })
    expect(d).toMatch(/AC1.*pass/)
    expect(d).toMatch(/AC2.*fail/)
  })

  it('marks criteria with no recorded status as untested', () => {
    expect(buildDigest({ state, brief })).toMatch(/AC1.*untested/)
  })

  it('is deterministic for identical input', () => {
    const a = buildDigest({ state, brief })
    const b = buildDigest({ state, brief })
    expect(a).toBe(b)
  })

  it('includes learnings when present', () => {
    const d = buildDigest({ state, brief, learnings: 'Tried a regex parser; it failed on quotes.' })
    expect(d).toContain('regex parser')
  })

  it('reports the current cycle out of the maximum', () => {
    expect(buildDigest({ state, brief })).toContain('cycle 1 of 3')
  })

  it('stays within the cap and says so when it truncates', () => {
    const huge: Plan = {
      summary: 'x'.repeat(200),
      tasks: Array.from({ length: 400 }, (_, i) => ({
        id: `T${i}`, goal: 'g'.repeat(120), dependsOn: [], ownsFiles: [`f${i}.ts`], criteriaIds: ['AC1'],
      })),
    }
    const taskStatus = Object.fromEntries(huge.tasks.map(t => [t.id, 'done' as const]))
    const d = buildDigest({ state, brief, plan: huge, taskStatus })
    expect(d.length).toBeLessThanOrEqual(DIGEST_CAP)
    expect(d).toMatch(/truncated/i)
  })

  it('keeps failing criteria even when it has to truncate', () => {
    const huge: Plan = {
      summary: 'x',
      tasks: Array.from({ length: 400 }, (_, i) => ({
        id: `T${i}`, goal: 'g'.repeat(120), dependsOn: [], ownsFiles: [`f${i}.ts`], criteriaIds: ['AC1'],
      })),
    }
    const d = buildDigest({
      state, brief, plan: huge,
      taskStatus: Object.fromEntries(huge.tasks.map(t => [t.id, 'done' as const])),
      criteriaStatus: { AC1: 'fail', AC2: 'fail' },
    })
    expect(d).toMatch(/AC1.*fail/)
    expect(d).toMatch(/AC2.*fail/)
  })
})
