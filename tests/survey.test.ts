import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SURVEY_CONCERNS, SURVEY_CREWS, crewPrompt, isEmptyTarget, runSurvey } from '../src/stages/survey.js'

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
  it('groups every concern into exactly one crew', () => {
    const flat = SURVEY_CREWS.flat()
    expect(flat.sort()).toEqual(SURVEY_CONCERNS.map(c => c.id).sort())
    expect(SURVEY_CREWS.length).toBeLessThan(SURVEY_CONCERNS.length)
  })

  it('builds a combined prompt that labels each concern', () => {
    const p = crewPrompt(['structure', 'tests'])
    expect(p).toMatch(/\[structure\]/)
    expect(p).toMatch(/\[tests\]/)
    expect(() => crewPrompt(['nope'])).toThrow(/unknown survey concern/)
  })

  it('spawns one agent per crew and merges their output', async () => {
    const seen: string[] = []
    const r = await runSurvey({
      brief,
      spawn: async ({ concernId }) => {
        seen.push(concernId)
        return {
          status: 'ok', agentId: concernId, costUsd: 1,
          value: {
            structure: concernId.includes('structure') ? 'src/' : '',
            language: concernId.includes('structure') ? 'typescript' : '',
            framework: null,
            testCommand: concernId.includes('tests') ? 'npm test' : null,
            conventions: concernId.includes('conventions') ? ['tabs'] : [],
            relevantModules: [],
          },
        }
      },
    })
    expect(seen.sort()).toEqual(SURVEY_CREWS.map(c => c.join('+')).sort())
    expect('map' in r && r.map.language).toBe('typescript')
    expect('map' in r && r.map.testCommand).toBe('npm test')
    expect('map' in r && r.map.conventions).toEqual(['tabs'])
    expect('costUsd' in r && r.costUsd).toBe(SURVEY_CREWS.length)
  })

  it('still supports one surveyor per concern when asked', async () => {
    const seen: string[] = []
    await runSurvey({
      brief,
      crews: SURVEY_CONCERNS.map(c => [c.id]),
      spawn: async ({ concernId }) => {
        seen.push(concernId)
        return { status: 'ok', agentId: concernId, costUsd: 0, value: { structure: '', language: '', framework: null, testCommand: null, conventions: [], relevantModules: [] } }
      },
    })
    expect(seen).toHaveLength(SURVEY_CONCERNS.length)
  })

  it('fails the stage when any surveyor dies', async () => {
    const r = await runSurvey({
      brief,
      spawn: async ({ concernId }) =>
        concernId.includes('tests')
          ? { status: 'dead', reason: 'timeout', detail: 'slow', agentId: concernId }
          : {
              status: 'ok', agentId: concernId, costUsd: 0,
              value: { structure: '', language: '', framework: null, testCommand: null, conventions: [], relevantModules: [] },
            },
    })
    expect('dead' in r && r.dead).toMatch(/tests/)
  })
})
