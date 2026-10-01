import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SURVEY_CONCERNS, isEmptyTarget, runSurvey } from '../src/stages/survey.js'

const brief = {
  goal: 'g', stack: [], constraints: [], assumptions: [],
  acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: true }], risks: [],
}

describe('SURVEY_CONCERNS', () => {
  it('covers five distinct concerns including documentation', () => {
    expect(SURVEY_CONCERNS).toHaveLength(5)
    expect(SURVEY_CONCERNS.map(c => c.id)).toContain('documentation')
  })

  it('has no duplicate concern ids', () => {
    const ids = SURVEY_CONCERNS.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('isEmptyTarget', () => {
  it('is true for an empty directory', async () => {
    expect(await isEmptyTarget(await mkdtemp(join(tmpdir(), 'sy-e-')))).toBe(true)
  })

  it('ignores .git and .shipyard when deciding emptiness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-e-'))
    await mkdir(join(dir, '.git'))
    await mkdir(join(dir, '.shipyard'))
    expect(await isEmptyTarget(dir)).toBe(true)
  })

  it('is false when real source files exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-e-'))
    await writeFile(join(dir, 'index.ts'), 'export {}')
    expect(await isEmptyTarget(dir)).toBe(false)
  })
})

describe('runSurvey', () => {
  it('spawns one agent per concern and merges their output', async () => {
    const seen: string[] = []
    const r = await runSurvey({
      brief,
      spawn: async ({ concernId }) => {
        seen.push(concernId)
        return {
          status: 'ok', agentId: concernId, costUsd: 1,
          value: {
            structure: concernId === 'structure' ? 'src/' : '',
            language: concernId === 'structure' ? 'typescript' : '',
            framework: null,
            testCommand: concernId === 'tests' ? 'npm test' : null,
            conventions: concernId === 'conventions' ? ['tabs'] : [],
            relevantModules: [],
          },
        }
      },
    })
    expect(seen.sort()).toEqual(SURVEY_CONCERNS.map(c => c.id).sort())
    expect('map' in r && r.map.language).toBe('typescript')
    expect('map' in r && r.map.testCommand).toBe('npm test')
    expect('costUsd' in r && r.costUsd).toBe(5)
  })

  it('fails the stage when any surveyor dies', async () => {
    const r = await runSurvey({
      brief,
      spawn: async ({ concernId }) =>
        concernId === 'tests'
          ? { status: 'dead', reason: 'timeout', detail: 'slow', agentId: concernId }
          : {
              status: 'ok', agentId: concernId, costUsd: 0,
              value: { structure: '', language: '', framework: null, testCommand: null, conventions: [], relevantModules: [] },
            },
    })
    expect('dead' in r && r.dead).toMatch(/tests/)
  })
})
