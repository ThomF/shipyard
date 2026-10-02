import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runThroughPlan } from '../src/harbormaster/run.js'
import { runPaths } from '../src/state/paths.js'

const exec = promisify(execFile)

async function gitDir() {
  const dir = await mkdtemp(join(tmpdir(), 'sy-run-'))
  await exec('git', ['init', '-q'], { cwd: dir })
  return dir
}

const brief = {
  goal: 'g', stack: [], constraints: [], assumptions: [],
  acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: true }], risks: [],
}
const map = { structure: '', language: 'ts', framework: null, testCommand: null, conventions: [], relevantModules: [] }
const plan = { summary: 's', tasks: [{ id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] }] }

function deps(target: string, overrides = {}) {
  return {
    target, idea: 'build it', runId: 'r1', createdAt: 'now',
    intake: async () => ({ brief, costUsd: 1 }),
    survey: async () => ({ map, costUsd: 2 }),
    plan: async () => ({ plan, spec: '# Spec', costUsd: 3 }),
    ...overrides,
  }
}

describe('runThroughPlan', () => {
  it('walks all three stages and writes every artifact', async () => {
    const target = await gitDir()
    await writeFile(join(target, 'index.ts'), 'export {}')
    const out = await runThroughPlan(deps(target) as never)
    expect(out.ok).toBe(true)

    const p = runPaths(target, 'r1')
    expect(JSON.parse(await readFile(p.brief, 'utf8')).goal).toBe('g')
    expect(JSON.parse(await readFile(p.codebaseMap, 'utf8')).language).toBe('ts')
    expect(JSON.parse(await readFile(join(p.cycleDir(1), 'plan.json'), 'utf8')).tasks).toHaveLength(1)
    expect(await readFile(join(p.cycleDir(1), 'spec.md'), 'utf8')).toBe('# Spec')
  })

  it('accumulates cost across stages into state', async () => {
    const target = await gitDir()
    await writeFile(join(target, 'index.ts'), 'export {}')
    const out = await runThroughPlan(deps(target) as never)
    expect(out.state.totalCostUsd).toBe(6)
    expect(out.state.completedStages).toEqual(['intake', 'survey', 'plan'])
  })

  it('skips survey for an empty target', async () => {
    const target = await gitDir()
    let surveyed = false
    const out = await runThroughPlan(deps(target, {
      survey: async () => { surveyed = true; return { map, costUsd: 2 } },
    }) as never)
    expect(surveyed).toBe(false)
    expect(out.ok).toBe(true)
    expect(out.state.totalCostUsd).toBe(4)
  })

  it('refuses a target that is not a git repository', async () => {
    const target = await mkdtemp(join(tmpdir(), 'sy-nogit-'))
    await expect(runThroughPlan(deps(target) as never)).rejects.toThrow(/not a git repository/i)
  })

  it('stops at the failing stage and records the reason', async () => {
    const target = await gitDir()
    await writeFile(join(target, 'index.ts'), 'export {}')
    const out = await runThroughPlan(deps(target, {
      plan: async () => ({ dead: 'manager died' }),
    }) as never)
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/manager died/)
    expect(out.state.completedStages).toEqual(['intake', 'survey'])
    expect(out.state.verdict).toBe('failed')
  })

  // Review Focus #5: resuming must not repeat completed work
  it('does not re-run a stage whose artifact already exists', async () => {
    const target = await gitDir()
    await writeFile(join(target, 'index.ts'), 'export {}')
    const p = runPaths(target, 'r1')
    await mkdir(p.root, { recursive: true })
    await writeFile(p.brief, JSON.stringify(brief))

    let intakeCalls = 0
    const out = await runThroughPlan(deps(target, {
      intake: async () => { intakeCalls++; return { brief, costUsd: 1 } },
    }) as never)
    expect(intakeCalls).toBe(0)
    expect(out.ok).toBe(true)
    expect(out.state.totalCostUsd).toBe(5) // intake not paid for again
  })
})
