import { describe, it, expect } from 'vitest'
import { validatePlan, runPlan } from '../src/stages/plan.js'
import type { Plan } from '../src/schemas/index.js'

const brief = {
  goal: 'g', stack: [], constraints: [], assumptions: [],
  acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: true }], risks: [],
}

const map = {
  structure: '', language: 'ts', framework: null, testCommand: null,
  conventions: [], relevantModules: [],
}

const ok: Plan = {
  summary: 's',
  tasks: [
    { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
    { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['b.ts'], criteriaIds: ['AC1'] },
  ],
}

describe('validatePlan', () => {
  it('accepts disjoint file ownership', () => {
    expect(validatePlan(ok, ['AC1'])).toEqual([])
  })

  // Review Focus #4: concurrently-runnable tasks must never share a file
  it('rejects two independent tasks owning the same file', () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
    ] }
    const problems = validatePlan(bad, ['AC1'])
    expect(problems.join(' ')).toMatch(/same\.ts/)
    expect(problems.join(' ')).toMatch(/T1.*T2|T2.*T1/)
  })

  it('allows a shared file when one task depends on the other', () => {
    const seq: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: ['T1'], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(seq, ['AC1'])).toEqual([])
  })

  it('allows a shared file across a transitive dependency chain', () => {
    const chain: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: ['T1'], ownsFiles: ['x.ts'], criteriaIds: ['AC1'] },
      { id: 'T3', goal: 'c', dependsOn: ['T2'], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(chain, ['AC1'])).toEqual([])
  })

  it('rejects a dependency on an unknown task', () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: ['NOPE'], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(bad, ['AC1']).join(' ')).toMatch(/NOPE/)
  })

  it('rejects a dependency cycle', () => {
    const cyc: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: ['T2'], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: ['T1'], ownsFiles: ['b.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(cyc, ['AC1']).join(' ')).toMatch(/cycle/i)
  })

  it('rejects duplicate task ids', () => {
    const dup: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
      { id: 'T1', goal: 'b', dependsOn: [], ownsFiles: ['b.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(dup, ['AC1']).join(' ')).toMatch(/duplicate/i)
  })

  it('rejects a reference to an unknown acceptance criterion', () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['a.ts'], criteriaIds: ['AC9'] },
    ] }
    expect(validatePlan(bad, ['AC1']).join(' ')).toMatch(/AC9/)
  })

  it('rejects a plan that leaves a criterion unserved', () => {
    expect(validatePlan(ok, ['AC1', 'AC2']).join(' ')).toMatch(/AC2/)
  })
})

describe('runPlan', () => {
  it('returns a valid plan and its spec page', async () => {
    const r = await runPlan({
      brief, map, digest: 'd', maxAttempts: 2,
      spawn: async () => ({ status: 'ok', agentId: 'm1', costUsd: 2, value: { plan: ok, spec: '# Spec' } }),
    })
    expect('plan' in r && r.plan.tasks).toHaveLength(2)
    expect('spec' in r && r.spec).toBe('# Spec')
  })

  it('re-prompts the manager with the specific problem and accepts the retry', async () => {
    const prompts: string[] = []
    let call = 0
    const r = await runPlan({
      brief, map, digest: 'd', maxAttempts: 2,
      spawn: async ({ prompt }) => {
        prompts.push(prompt)
        call++
        const plan: Plan = call === 1
          ? { summary: 's', tasks: [
              { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['dup.ts'], criteriaIds: ['AC1'] },
              { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['dup.ts'], criteriaIds: ['AC1'] },
            ] }
          : ok
        return { status: 'ok', agentId: `m${call}`, costUsd: 1, value: { plan, spec: 's' } }
      },
    })
    expect('plan' in r).toBe(true)
    expect(prompts[1]).toMatch(/dup\.ts/)
    expect('costUsd' in r && r.costUsd).toBe(2)
  })

  it('dies after maxAttempts of invalid plans', async () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['x.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['x.ts'], criteriaIds: ['AC1'] },
    ] }
    const r = await runPlan({
      brief, map, digest: 'd', maxAttempts: 2,
      spawn: async () => ({ status: 'ok', agentId: 'm', costUsd: 0, value: { plan: bad, spec: 's' } }),
    })
    expect('dead' in r && r.dead).toMatch(/2 attempts/)
  })
})
