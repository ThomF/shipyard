import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = join(repo, 'tools', 'run-check.mjs')
const RENDER = join(repo, 'tools', 'render-report.mjs')

const check = (...args: string[]) => {
  const r = spawnSync('node', [CHECK, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

type Criterion = { id: string; statement: string; check?: string }
type Task = { id: string; goal?: string; ownsFiles: string[]; dependsOn: string[]; criteriaIds: string[]; model?: string }

const criterion = (id: string, tag = 'unit'): Criterion => ({ id, statement: `${id} holds`, check: tag })
const task = (id: string, files: string[], dependsOn: string[] = [], criteriaIds: string[] = ['AC1']): Task =>
  ({ id, goal: `do ${id}`, ownsFiles: files, dependsOn, criteriaIds })

async function runDir(size: string | undefined, criteria: Criterion[], tasks?: Task[], state: object = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), 'shipyard-check-')), 'r1')
  await mkdir(join(dir, 'cycles', '1'), { recursive: true })
  await writeFile(join(dir, 'state.json'), JSON.stringify({ size, cycle: 1, ...state }))
  await writeFile(join(dir, 'brief.json'), JSON.stringify({ goal: 'g', acceptanceCriteria: criteria }))
  if (tasks) await writeFile(join(dir, 'cycles', '1', 'plan.json'), JSON.stringify({ summary: 's', tasks }))
  return dir
}

const many = (n: number) => Array.from({ length: n }, (_, i) => criterion(`AC${i + 1}`))

describe('run-check brief', () => {
  it('accepts a brief at its size cap', async () => {
    expect(check('brief', await runDir('lite', many(8))).code).toBe(0)
  })

  it('rejects a brief over its size cap', async () => {
    const r = check('brief', await runDir('lite', many(9)))
    expect(r.code).toBe(1)
    expect(r.err).toContain('9 criteria is over the lite cap of 8')
  })

  it('rejects an untagged criterion', async () => {
    const r = check('brief', await runDir('standard', [{ id: 'AC1', statement: 's' }]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('AC1 needs check')
  })

  it.each([['lite', 2, 1], ['standard', 4, 3]])('caps browser criteria at %s', async (size, count, cap) => {
    const criteria = Array.from({ length: count as number }, (_, i) => criterion(`AC${i + 1}`, 'browser'))
    const r = check('brief', await runDir(size as string, criteria))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`cap of ${cap}`)
  })

  it.each(['Every test in the baseline (717 tests) still passes', 'All 1,204 existing tests pass', 'the 3 new tests pass'])('rejects a test count: %s', async (statement) => {
    const r = check('brief', await runDir('standard', [{ id: 'AC1', statement, check: 'command' }]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('AC1 pins a test count')
  })

  it.each(['The existing tests still pass', 'Two tests prove the rule', 'Returns 3 latest albums', 'Top 10 test results show'])('allows: %s', async (statement) => {
    expect(check('brief', await runDir('standard', [{ id: 'AC1', statement, check: 'command' }])).code).toBe(0)
  })

  it('needs a size in state.json', async () => {
    const r = check('brief', await runDir(undefined, many(1)))
    expect(r.code).toBe(1)
    expect(r.err).toContain('needs a size')
  })
})

describe('run-check plan', () => {
  const inSequence = (n: number) =>
    Array.from({ length: n }, (_, i) => task(`T${i + 1}`, [`f${i}.ts`], i ? [`T${i}`] : []))

  it('accepts a plan at its cap and rejects one over it', async () => {
    expect(check('plan', await runDir('standard', many(1), inSequence(5))).code).toBe(0)
    const r = check('plan', await runDir('standard', many(1), inSequence(6)))
    expect(r.code).toBe(1)
    expect(r.err).toContain('6 tasks is over the standard cap of 5')
  })

  it('caps lite at two tasks', async () => {
    expect(check('plan', await runDir('lite', many(1), inSequence(3))).code).toBe(1)
  })

  it('rejects an unserved criterion', async () => {
    const r = check('plan', await runDir('standard', many(2), inSequence(1)))
    expect(r.err).toContain('no task serves AC2')
  })

  it('rejects concurrent tasks sharing a file, but allows ordered ones', async () => {
    const clash = check('plan', await runDir('standard', many(1), [task('T1', ['a.ts']), task('T2', ['a.ts'])]))
    expect(clash.code).toBe(1)
    expect(clash.err).toContain('T1 and T2 can run at once but both own a.ts')

    const transitive = [task('T1', ['a.ts']), task('T2', ['b.ts'], ['T1']), task('T3', ['a.ts'], ['T2'])]
    expect(check('plan', await runDir('standard', many(1), transitive)).code).toBe(0)
  })

  it('rejects dependency cycles and missing dependencies', async () => {
    const cycle = check('plan', await runDir('standard', many(1), [task('T1', ['a'], ['T2']), task('T2', ['b'], ['T1'])]))
    expect(cycle.err).toContain('dependency cycle')
    const missing = check('plan', await runDir('standard', many(1), [task('T1', ['a'], ['T9'])]))
    expect(missing.err).toContain('T1 depends on T9')
  })

  it('names the fields it expects rather than guessing', async () => {
    const legacy = [{ id: 'T1', title: 't', files: ['a'], depends_on: [], criteria: ['AC1'] }] as unknown as Task[]
    const r = check('plan', await runDir('standard', many(1), legacy))
    expect(r.code).toBe(1)
    expect(r.err).toContain('T1 needs a ownsFiles array')
  })

  it.each(['.shipyard/checks/admin.check.mjs', './.shipyard/checks/lib.mjs', '.shipyard'])('rejects a dev owning %s', async (file) => {
    const r = check('plan', await runDir('standard', many(1), [task('T1', ['a.ts', file])]))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`T1 owns ${file}`)
  })

  it('allows a path that only looks like .shipyard', async () => {
    expect(check('plan', await runDir('standard', many(1), [task('T1', ['docs/.shipyard-notes.md', '.shipyard-old/a.ts'])])).code).toBe(0)
  })

  it('rejects an unknown model', async () => {
    const r = check('plan', await runDir('standard', many(1), [{ ...task('T1', ['a']), model: 'gpt' }]))
    expect(r.err).toContain('T1 has model gpt')
  })
})

describe('run-check checks', () => {
  async function checksIn(files: Record<string, string>) {
    const repoDir = await mkdtemp(join(tmpdir(), 'shipyard-checks-'))
    const dir = join(repoDir, '.shipyard', 'runs', 'r1')
    await mkdir(dir, { recursive: true })
    await mkdir(join(repoDir, '.shipyard', 'checks'))
    for (const [name, body] of Object.entries(files)) await writeFile(join(repoDir, '.shipyard', 'checks', name), body)
    return { dir, out: join(dir, 'out.txt') }
  }

  it('runs each check and old browser.mjs from the repo root, but not helpers', async () => {
    const { dir, out } = await checksIn({
      'a.check.mjs': "console.log('PASS AC1', process.cwd().endsWith('.shipyard') ? 'wrong cwd' : 'root')",
      'browser.mjs': "console.log('PASS AC2')",
      'lib.mjs': "throw new Error('helpers are not checks')",
    })
    const r = check('checks', dir, out)
    expect(r.code).toBe(0)
    expect(r.out).toBe('ok a.check.mjs\nok browser.mjs\n')
    const saved = await readFile(out, 'utf8')
    expect(saved).toContain('PASS AC1 root')
    expect(saved).toContain('PASS AC2')
  })

  it('reports a failing check by criterion and keeps running the rest', async () => {
    const { dir, out } = await checksIn({
      'a.check.mjs': "console.log('FAIL AC1'); process.exit(1)",
      'b.check.mjs': "console.log('PASS AC2')",
    })
    const r = check('checks', dir, out)
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAILED a.check.mjs: FAIL AC1')
    expect(r.out).toContain('ok b.check.mjs')
  })

  it('passes when there are no checks', async () => {
    const { dir, out } = await checksIn({})
    expect(check('checks', dir, out)).toMatchObject({ code: 0, out: 'no browser checks\n' })
  })
})

describe('run-check usage', () => {
  const add = (dir: string, ...args: string[]) => check('record', dir, ...args)

  it('records figures, keeps unknowns null, and totals by role', async () => {
    const dir = await runDir('standard', many(1))
    add(dir, '--agent', 'dev-T1', '--role', 'dev', '--model', 'sonnet', '--tokens', '1000', '--tools', '5', '--ms', '60000')
    add(dir, '--agent', 'dev-T2', '--role', 'dev', '--model', 'opus', '--tokens', '2000')
    add(dir, '--agent', 'tester-1', '--role', 'tester')

    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    expect(state.usage).toHaveLength(3)
    expect(state.usage[0]).toEqual({ agent: 'dev-T1', role: 'dev', model: 'sonnet', tokens: 1000, toolUses: 5, durationMs: 60000 })
    expect(state.usage[2]).toEqual({ agent: 'tester-1', role: 'tester', model: null, tokens: null, toolUses: null, durationMs: null })

    const md = check('usage', dir).out
    expect(md).toContain('Size: standard. Reported total: 3,000 tokens across 3 agents.')
    expect(md).toContain('| dev | 2 | 3,000 | 100% |')
    expect(md).toContain('| tester-1 | - | unavailable | - | - |')
    expect(md).toContain("harbormaster's own tokens are not included")
    expect(md).toContain('1 agent(s) reported no figure')

    const line = check('usage', dir, '--line').out
    expect(line).toContain('Tokens: 3,000 across 3 agents (size standard')
  })

  it('refuses a figure that is not a count', async () => {
    const dir = await runDir('standard', many(1))
    const r = add(dir, '--agent', 'a', '--role', 'dev', '--tokens', 'about 5k')
    expect(r.code).toBe(1)
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).usage).toBeUndefined()
  })

  it('says when a budget is passed, and that it counts only this run', async () => {
    const dir = await runDir('standard', many(1), undefined, { budgetTokens: 1000 })
    expect(add(dir, '--agent', 'a', '--role', 'dev', '--tokens', '400').out).not.toContain('OVER BUDGET')
    const over = add(dir, '--agent', 'b', '--role', 'dev', '--tokens', '600').out
    expect(over).toContain('OVER BUDGET')
    expect(over).toContain('not the account')
  })

  it('compares fixes per model across runs, charging a fix to the model that wrote the task', async () => {
    const dir = await runDir('standard', many(1))
    add(dir, '--agent', 'dev-T1', '--role', 'dev', '--model', 'sonnet', '--tokens', '100')
    add(dir, '--agent', 'dev-T2', '--role', 'dev', '--model', 'opus', '--tokens', '100')
    add(dir, '--agent', 'dev-F1', '--role', 'dev', '--model', 'opus', '--tokens', '50', '--fix-of', 'T1')

    const sibling = join(dirname(dir), 'r2')
    await mkdir(sibling)
    await writeFile(join(sibling, 'state.json'), JSON.stringify({
      usage: [{ agent: 'dev-T1', role: 'dev', model: 'sonnet', tokens: 100, toolUses: null, durationMs: null }],
    }))

    const md = check('usage', dir).out
    expect(md).toContain('across 2 run(s)')
    expect(md).toContain('| sonnet | 2 | 1 | 0.50 | 250 |')
    expect(md).toContain('| opus | 1 | 0 | 0.00 | 100 |')
  })

  it('shows role totals that sum to the agents on the dashboard', async () => {
    const dir = await runDir('lite', [criterion('AC1', 'browser')])
    add(dir, '--agent', 'dev-T1', '--role', 'dev', '--model', 'sonnet', '--tokens', '1500')
    add(dir, '--agent', 'tester-1', '--role', 'tester', '--tokens', '500')
    execFileSync('node', [RENDER, dir], { encoding: 'utf8' })
    const html = await readFile(join(dir, 'report.html'), 'utf8')
    const data = JSON.parse(/<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!)
    expect(data.state.size).toBe('lite')
    expect(data.state.usage.reduce((sum: number, u: { tokens: number }) => sum + u.tokens, 0)).toBe(2000)
    expect(html).toContain('Token use')
    expect(html).toContain('The harbormaster')
  })
})
