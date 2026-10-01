import { describe, it, expect } from 'vitest'
import { buildIntakePrompt } from '../src/prompts/intake.js'
import { runIntake } from '../src/stages/intake.js'

const goodBrief = {
  goal: 'g', stack: [], constraints: [], assumptions: [],
  acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: true }], risks: [],
}

describe('buildIntakePrompt', () => {
  it('includes the idea', () => {
    expect(buildIntakePrompt({ idea: 'build a parser', projectReport: null })).toContain('build a parser')
  })

  it('includes the project report when one exists', () => {
    const p = buildIntakePrompt({ idea: 'x', projectReport: '## Run 1\nFailed: parser approach' })
    expect(p).toContain('parser approach')
    expect(p).toMatch(/previous runs/i)
  })

  it('omits the prior-runs section entirely on a fresh target', () => {
    expect(buildIntakePrompt({ idea: 'x', projectReport: null })).not.toMatch(/previous runs/i)
  })
})

describe('runIntake', () => {
  it('returns the validated brief', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null,
      spawn: async () => ({ status: 'ok', value: goodBrief, costUsd: 0.5, agentId: 'a1' }),
    })
    expect('brief' in r && r.brief.goal).toBe('g')
    expect('costUsd' in r && r.costUsd).toBe(0.5)
  })

  it('surfaces a dead agent rather than throwing', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null,
      spawn: async () => ({ status: 'dead', reason: 'timeout', detail: 'slow', agentId: 'a1' }),
    })
    expect('dead' in r).toBe(true)
  })

  // Review Focus #2: schema-valid but semantically empty output must not pass
  it('rejects a brief whose criteria are all unverifiable', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null,
      spawn: async () => ({
        status: 'ok', agentId: 'a1', costUsd: 0,
        value: { ...goodBrief, acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: false }] },
      }),
    })
    expect('dead' in r && r.dead).toMatch(/verifiable/i)
  })

  it('rejects duplicate criterion ids', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null,
      spawn: async () => ({
        status: 'ok', agentId: 'a1', costUsd: 0,
        value: { ...goodBrief, acceptanceCriteria: [
          { id: 'AC1', statement: 'a', verifiable: true },
          { id: 'AC1', statement: 'b', verifiable: true },
        ] },
      }),
    })
    expect('dead' in r && r.dead).toMatch(/duplicate/i)
  })
})
