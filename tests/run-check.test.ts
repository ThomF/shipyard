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
const checkWith = (input: string, ...args: string[]) => {
  const r = spawnSync('node', [CHECK, ...args], { encoding: 'utf8', input })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

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

describe('run-check handoff', () => {
  const plan = () => [
    task('T1', ['a.ts'], [], ['AC1']),
    task('T2', ['b.ts'], ['T1'], ['AC2']),
    task('T3', ['c.ts'], [], ['AC3']),
  ]
  async function planned() {
    const dir = await runDir('standard', [criterion('AC1'), criterion('AC2', 'browser'), criterion('AC3')], plan())
    await writeFile(join(dir, 'codebase-map.json'), JSON.stringify({ testCommand: 'npm test' }))
    const r = check('plan', dir)
    expect(r.code).toBe(0)
    return dir
  }
  const HANDOFF = [
    'Built the export endpoint. One thing is shaky.',
    '',
    'STATUS: done',
    'COMMIT: abc1234',
    'TESTS:',
    'AC1 | tests/export.test.ts | writes a header row',
    '- AC1, AC3 | `tests/shared.test.ts` | escapes commas | and pipes',
    'BUILT: exportCsv(rows: Row[]): string in a.ts',
    'GET /api/export returns text/csv',
    'RUN: PORT=4010 DB=$TMP/db npm start',
    'UNSURE: large exports are not streamed',
  ].join('\n')

  it('writes a brief per task when the plan passes, and sets every task to todo', async () => {
    const dir = await planned()
    const brief = await json(join(dir, 'cycles', '1', 'tasks', 'T2.json'))
    expect(brief).toMatchObject({ id: 'T2', ownsFiles: ['b.ts'], dependsOn: ['T1'], testCommand: 'npm test' })
    expect(brief.criteria).toEqual([{ id: 'AC2', statement: 'AC2 holds', check: 'browser' }])
    expect(brief.codebaseMap).toMatch(/codebase-map\.json$/)
    expect((await json(join(dir, 'state.json'))).tasks).toEqual({ T1: 'todo', T2: 'todo', T3: 'todo' })
  })

  it('starts a task id again in a new cycle, but not on a re-check of the same one', async () => {
    const dir = await planned()
    check('finish', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1')
    check('plan', dir)
    expect((await json(join(dir, 'state.json'))).tasks.T1).toBe('done')

    await mkdir(join(dir, 'cycles', '2'))
    await writeFile(join(dir, 'cycles', '2', 'plan.json'), JSON.stringify({ summary: 's', tasks: plan() }))
    expect(check('plan', dir, '2').code).toBe(0)
    expect((await json(join(dir, 'state.json'))).tasks.T1).toBe('todo')
  })

  it('writes no briefs for a rejected plan', async () => {
    const dir = await runDir('standard', many(2), [task('T1', ['a.ts'])])
    expect(check('plan', dir).code).toBe(1)
    expect(check('start', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1').out).not.toContain('brief:')
  })

  it('puts an agent on deck and takes it off, naming the tasks that became ready', async () => {
    const dir = await planned()
    const started = check('start', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1')
    expect(started.out).toMatch(/^brief: .*cycles\/1\/tasks\/T1\.json$/m)
    check('start', dir, '--agent', 'dev-T3', '--role', 'dev', '--task', 'T3')
    let state = await json(join(dir, 'state.json'))
    expect(state.active.map((a: { id: string }) => a.id)).toEqual(['dev-T1', 'dev-T3'])
    expect(state.active[0].since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(state.tasks).toEqual({ T1: 'running', T2: 'todo', T3: 'running' })

    const done = checkWith(HANDOFF, 'finish', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1', '--model', 'sonnet', '--tokens', '1000', '--handoff', '-')
    expect(done.code).toBe(0)
    expect(done.out).toContain('T1 done (abc1234), 3 test(s) named')
    expect(done.out).toContain('ready: T2')
    expect(done.out).toContain('running: T3')
    expect(done.out).toContain('run tokens: 1,000')
    expect(done.out).not.toContain('build complete')

    state = await json(join(dir, 'state.json'))
    expect(state.active.map((a: { id: string }) => a.id)).toEqual(['dev-T3'])
    expect(state.tasks.T1).toBe('done')
    expect(state.usage[0]).toMatchObject({ agent: 'dev-T1', model: 'sonnet', tokens: 1000, toolUses: null })
    expect(await readFile(join(dir, 'report.html'), 'utf8')).toContain('run-data')
  })

  it('files the handoff where the tester and the next dev read it', async () => {
    const dir = await planned()
    await writeFile(join(dir, 'report-notes.json'), JSON.stringify({ plan_changes: [], notes: ['kept'], observations: [] }))
    checkWith(HANDOFF, 'finish', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1', '--handoff', '-')

    const handoff = await json(join(dir, 'cycles', '1', 'handoff.json'))
    expect(handoff.tasks.T1).toMatchObject({
      agent: 'dev-T1', status: 'done', commit: 'abc1234', run: 'PORT=4010 DB=$TMP/db npm start',
      built: 'exportCsv(rows: Row[]): string in a.ts\nGET /api/export returns text/csv',
    })
    expect(handoff.tests.AC1).toEqual([
      { task: 'T1', file: 'tests/export.test.ts', name: 'writes a header row' },
      { task: 'T1', file: 'tests/shared.test.ts', name: 'escapes commas | and pipes' },
    ])
    expect(handoff.tests.AC3).toEqual([{ task: 'T1', file: 'tests/shared.test.ts', name: 'escapes commas | and pipes' }])
    expect((await json(join(dir, 'report-notes.json'))).notes).toEqual(['kept', 'dev-T1: large exports are not streamed'])

    // The dependent task's brief now carries what T1 really built.
    check('start', dir, '--agent', 'dev-T2', '--role', 'dev', '--task', 'T2')
    expect((await json(join(dir, 'cycles', '1', 'tasks', 'T2.json'))).from).toEqual([
      { task: 'T1', commit: 'abc1234', built: 'exportCsv(rows: Row[]): string in a.ts\nGET /api/export returns text/csv' },
    ])
  })

  it('keeps a message with no block as written, and blocks a task that says it is blocked', async () => {
    const dir = await planned()
    const loose = checkWith('All done, tests pass.', 'finish', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1', '--handoff', '-')
    expect(loose.out).toContain('no STATUS block found')
    expect((await json(join(dir, 'cycles', '1', 'handoff.json'))).tasks.T1.raw).toBe('All done, tests pass.')
    expect((await json(join(dir, 'state.json'))).tasks.T1).toBe('done')

    const blocked = checkWith('**STATUS:** blocked: needs d.ts\nUNSURE: none', 'finish', dir, '--agent', 'dev-T3', '--role', 'dev', '--task', 'T3', '--handoff', '-')
    expect(blocked.out).toContain('T3 blocked')
    expect(blocked.out).toContain('blocked: T3')
    expect(blocked.out).not.toContain('unsure:')
  })

  it('lets a fix replace the tests it restates and keep the rest', async () => {
    const dir = await planned()
    checkWith(HANDOFF, 'finish', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1', '--handoff', '-')
    const fix = 'STATUS: done\nCOMMIT: def5678\nTESTS:\nAC1 | tests/export.test.ts | writes a header row, even when empty'
    const r = checkWith(fix, 'finish', dir, '--agent', 'dev-F1', '--role', 'dev', '--fix-of', 'T1', '--handoff', '-')
    expect(r.out).not.toContain('T1 done')

    const handoff = await json(join(dir, 'cycles', '1', 'handoff.json'))
    expect(handoff.tasks.T1).toMatchObject({ commit: 'def5678', agent: 'dev-F1', run: 'PORT=4010 DB=$TMP/db npm start' })
    expect(handoff.tests.AC1).toEqual([
      { task: 'T1', file: 'tests/shared.test.ts', name: 'escapes commas | and pipes' },
      { task: 'T1', file: 'tests/export.test.ts', name: 'writes a header row, even when empty' },
    ])
    const state = await json(join(dir, 'state.json'))
    expect(state.usage[1]).toMatchObject({ agent: 'dev-F1', fixOf: 'T1' })
    expect(state.tasks.T1).toBe('done')
  })

  it('counts deaths, sends a sonnet task to opus, and blocks a task on the third', async () => {
    const dir = await planned()
    const die = () => check('finish', dir, '--agent', 'dev-T1', '--role', 'dev', '--task', 'T1', '--model', 'sonnet', '--state', 'dead')
    const first = die()
    expect(first.out).toContain('T1 died (1 of 3): respawn it with a handoff note, on opus')
    expect(first.out).toContain('ready: T1 T3')
    die()
    expect(die().out).toContain('T1 blocked: death 3 of 3')
    const state = await json(join(dir, 'state.json'))
    expect(state.deaths).toHaveLength(3)
    expect(state.tasks.T1).toBe('blocked')
  })

  it('says the build is complete only when every task is done', async () => {
    const dir = await planned()
    for (const id of ['T1', 'T3']) expect(check('finish', dir, '--agent', `dev-${id}`, '--role', 'dev', '--task', id).out).not.toContain('build complete')
    expect(check('finish', dir, '--agent', 'dev-T2', '--role', 'dev', '--task', 'T2').out).toContain('build complete: all 3 task(s) done')
  })

  it('survives agents finishing at the same moment', async () => {
    const dir = await planned()
    const { spawn } = await import('node:child_process')
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((done) => {
      spawn('node', [CHECK, 'record', dir, '--agent', `a${i}`, '--role', 'dev', '--tokens', '10'], { stdio: 'ignore' }).on('exit', done)
    })))
    expect((await json(join(dir, 'state.json'))).usage).toHaveLength(8)
  })

  it('checks the tree after a tester, but not while a dev is still writing', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'shipyard-tree-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, encoding: 'utf8' })
    g('init', '-q'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't')
    await writeFile(join(repoDir, 'a.txt'), 'one\n')
    g('add', '.'); g('commit', '-qm', 'init')
    const dir = join(repoDir, '.shipyard', 'runs', 'r1')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.json'), JSON.stringify({ size: 'lite', cycle: 1 }))

    expect(check('finish', dir, '--agent', 'tester-1', '--role', 'tester').out).toContain('tree clean')
    await writeFile(join(repoDir, 'a.txt'), 'two\n')
    expect(check('finish', dir, '--agent', 'tester-2', '--role', 'browser-tester').out).toContain('TREE MODIFIED outside .shipyard/:  M a.txt')
    check('start', dir, '--agent', 'dev-F1', '--role', 'dev', '--fix-of', 'T1')
    expect(check('finish', dir, '--agent', 'tester-3', '--role', 'tester').out).not.toContain('TREE')
  })
})

describe('run-check verdicts', () => {
  async function tested(reports: Record<string, object>) {
    const criteria = [criterion('AC1'), criterion('AC2', 'browser'), criterion('AC3'), criterion('AC4')]
    const tasks = [task('T1', ['a.ts'], [], ['AC1', 'AC2']), task('T2', ['b.ts'], [], ['AC3']), task('T3', ['c.ts'], [], ['AC3', 'AC4'])]
    const dir = await runDir('standard', criteria, tasks)
    for (const [name, report] of Object.entries(reports)) await writeFile(join(dir, 'cycles', '1', name), JSON.stringify(report))
    return dir
  }
  const pass = { verdict: 'pass', evidence: 'named test asserts it' }

  it('merges the reports into state and prints only what did not pass, with its owner', async () => {
    const dir = await tested({
      'test-report.json': { criteria: { AC1: pass, AC3: pass }, observations: [{ what: 'slow list', severity: 'low' }] },
      'test-report-browser.json': {
        criteria: [{ id: 'AC2', verdict: 'fail', evidence: 'dead spot at\n[0.25, 0.75] on the card' }],
        observations: [{ what: 'slow list', severity: 'low' }, { what: 'export drops rows', severity: 'high' }],
      },
    })
    const r = check('verdicts', dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain('criteria: 2/4 pass')
    expect(r.out).toContain('fail AC2 (browser) owner T1: dead spot at [0.25, 0.75] on the card')
    expect(r.out).toContain('untested AC4 (unit) owner T3: no tester reported on it')
    expect(r.out).not.toContain('AC1')
    expect(r.out).toContain('one owner each: T1 T3')
    expect(r.out).toContain('observations: 2 added to report-notes.json, 1 high severity')
    expect(r.out).toContain('high: export drops rows')

    expect((await json(join(dir, 'state.json'))).criteria).toEqual({ AC1: 'pass', AC2: 'fail', AC3: 'pass', AC4: 'untested' })
    expect((await json(join(dir, 'report-notes.json'))).observations).toHaveLength(2)
  })

  it('lets a re-test settle what it lists and leaves the rest', async () => {
    const dir = await tested({
      'test-report.json': { criteria: { AC1: pass, AC3: { verdict: 'fail', evidence: 'expected 3, got 2' }, AC4: pass } },
      'test-report-browser.json': { criteria: { AC2: pass } },
    })
    const first = check('verdicts', dir).out
    expect(first).toContain('fail AC3 (unit) owner T2,T3: expected 3, got 2')
    expect(first).not.toContain('one owner each')

    await writeFile(join(dir, 'cycles', '1', 'test-report-fix1.json'), JSON.stringify({ criteria: { AC3: pass } }))
    expect(check('verdicts', dir).out).toBe('ALL PASS: 4/4\n')
    expect((await json(join(dir, 'state.json'))).criteria.AC3).toBe('pass')
  })

  it('refuses to guess when there is no report', async () => {
    const r = check('verdicts', await tested({}))
    expect(r.code).toBe(1)
    expect(r.err).toContain('no test report')
  })
})
