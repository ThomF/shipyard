import { describe, it, expect } from 'vitest'
import { BriefSchema, PlanSchema } from '../src/schemas/index.js'

describe('BriefSchema', () => {
  it('accepts a well-formed brief', () => {
    const brief = {
      goal: 'Build a CLI that converts CSV to JSON',
      stack: ['typescript', 'node'],
      constraints: ['no external deps'],
      assumptions: ['input files are UTF-8'],
      acceptanceCriteria: [
        { id: 'AC1', statement: 'Running `csv2json x.csv` writes x.json', verifiable: true },
      ],
      risks: ['large files may not fit in memory'],
    }
    expect(BriefSchema.parse(brief).acceptanceCriteria).toHaveLength(1)
  })

  it('rejects a brief whose acceptance criteria are missing', () => {
    expect(() => BriefSchema.parse({ goal: 'x', stack: [], constraints: [], assumptions: [], risks: [] })).toThrow()
  })
})

describe('PlanSchema', () => {
  it('accepts a plan with a task DAG', () => {
    const plan = {
      summary: 'Two tasks',
      tasks: [
        { id: 'T1', goal: 'Write the parser', dependsOn: [], ownsFiles: ['src/parse.ts'], criteriaIds: ['AC1'] },
        { id: 'T2', goal: 'Wire the CLI', dependsOn: ['T1'], ownsFiles: ['src/cli.ts'], criteriaIds: ['AC1'] },
      ],
    }
    expect(PlanSchema.parse(plan).tasks[1]!.dependsOn).toEqual(['T1'])
  })

  it('rejects a task that owns zero files', () => {
    const plan = { summary: 's', tasks: [{ id: 'T1', goal: 'g', dependsOn: [], ownsFiles: [], criteriaIds: ['AC1'] }] }
    expect(() => PlanSchema.parse(plan)).toThrow()
  })
})
