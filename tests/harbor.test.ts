import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRITER = join(repo, 'tools', 'write-shipyard-report.mjs')
const HARBOR = join(repo, 'tools', 'harbor.mjs')
const BUILD = join(repo, 'tools', 'build-command.mjs')
const BRANCH = 'shipyard/thing'

const HANDLER = [
  'export function handle(id) {',
  '  const row = lookup(id)',
  '  if (!row) return { status: 404 }',
  '  return { status: 200, row }',
  '}',
  '',
].join('\n')

/** A target repo as a Shipyard build leaves it: code plus a committed run directory. */
async function builtRepo(options: { report?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'harbor-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 't')
  await writeFile(join(dir, 'old.ts'), 'export const old = 1\n')
  await writeFile(join(dir, 'config.json'), '{\n  "a": 1\n}\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  const base = g('rev-parse', 'HEAD').trim()

  g('checkout', '-qb', BRANCH)
  await writeFile(join(dir, 'handler.ts'), HANDLER)
  await writeFile(join(dir, 'config.json'), '{\n  "a": 1,\n  "b": 2\n}\n')
  g('rm', '-q', 'old.ts')

  const runDir = join(dir, '.shipyard', 'runs', 'r1')
  await mkdir(join(runDir, 'cycles', '1'), { recursive: true })
  await writeFile(join(runDir, 'state.json'), JSON.stringify({ request: 'Add a handler', branch: BRANCH, baseCommit: base }))
  await writeFile(join(runDir, 'brief.json'), JSON.stringify({ goal: 'A handler', acceptanceCriteria: [{ id: 'AC1', statement: 'Returns 404' }] }))
  await writeFile(join(runDir, 'report-notes.json'), JSON.stringify({ plan_changes: [{ change: 'Dropped the cache.', why: 'Survey found none.' }], notes: ['Unsure about 404.'] }))
  await writeFile(join(runDir, 'cycles', '1', 'test-report.json'), JSON.stringify({ criteria: { AC1: { verdict: 'fail', evidence: 'first' } } }))
  await writeFile(join(runDir, 'cycles', '1', 'test-report-fix1.json'), JSON.stringify({ criteria: { AC1: { verdict: 'pass', evidence: 'second' } } }))
  g('add', '.')
  g('commit', '-qm', 'build')
  if (options.report !== false) {
    execFileSync('node', [WRITER, runDir], { encoding: 'utf8' })
    g('add', '.')
    g('commit', '-qm', 'report')
  }
  return { dir, g, base, runDir, work: join(runDir, '.harbor'), guidePath: join(runDir, 'REVIEW_GUIDE.md') }
}

type Built = Awaited<ReturnType<typeof builtRepo>>

/** Runs the script as the /harbor session does. A nonzero exit comes back as `ok: false`. */
function harbor(dir: string, args: string[], input = '') {
  const r = spawnSync('node', [HARBOR, ...args], { cwd: dir, input, encoding: 'utf8' })
  return { ok: r.status === 0, out: r.stdout, err: r.stderr }
}

const OUTPUT = {
  summary: 'Adds a handler.',
  files: [
    { path: 'handler.ts', group: 'logic', purpose: 'Looks up a row.' },
    { path: 'config.json', group: 'plumbing', purpose: 'Adds b.' },
    { path: 'not-changed.ts', group: 'logic', purpose: 'Should be ignored.' },
  ],
  steps: [{
    title: 'Handle the request',
    path: 'handler.ts',
    startLine: 1,
    endLine: 5,
    does: 'Looks up the row.\n\nThen returns it.',
    handsTo: 'A status and row.',
    onFailure: 'Returns 404.',
  }],
  lookHereFirst: [{ step: 'S1', line: 3, why: 'A falsy row is a 404.' }],
  beforeYouApprove: ['What does lookup throw?', 'Who calls this?', 'Is 404 right?'],
}

async function guideFor(b: Built, output: unknown = OUTPUT, prepareArgs: string[] = []) {
  const prepared = harbor(b.dir, ['prepare', ...prepareArgs])
  if (!prepared.ok) throw new Error(prepared.err)
  await writeFile(join(b.work, 'guide-output.json'), JSON.stringify(output))
  const rendered = harbor(b.dir, ['render'])
  if (!rendered.ok) throw new Error(rendered.err)
  return { out: rendered.out, guide: await readFile(b.guidePath, 'utf8') }
}

const ANSWER = { answer: 'Line 3 returns 404\nwhen the row is falsy.', quotes: [{ path: 'handler.ts', startLine: 3, endLine: 3 }], checkYourself: null }

async function asking(b: Built, question: string, answer: unknown = ANSWER) {
  const prepared = harbor(b.dir, ['ask-prepare'], question)
  if (!prepared.ok) throw new Error(prepared.err)
  await writeFile(join(b.work, 'answer-output.json'), JSON.stringify(answer))
  const appended = harbor(b.dir, ['ask-append'])
  if (!appended.ok) throw new Error(appended.err)
  return { out: appended.out, guide: await readFile(b.guidePath, 'utf8') }
}

const verifyOf = (b: Built) => harbor(b.dir, ['verify'])

describe('write-shipyard-report', () => {
  const report = async (b: Built) => JSON.parse(await readFile(join(b.runDir, 'shipyard-report.json'), 'utf8'))

  it('writes a report harbor accepts', async () => {
    const b = await builtRepo()
    const r = await report(b)
    expect(r.base).toBe(b.base)
    expect(r.branch).toBe(BRANCH)
    expect(r.plan).toContain('Add a handler')
    expect(r.plan_changes[0].why).toBe('Survey found none.')
    expect(r.notes).toEqual(['Unsure about 404.'])
    expect(harbor(b.dir, ['prepare']).ok).toBe(true)
  })

  it('leaves its own run directory out of files_changed', async () => {
    const b = await builtRepo()
    expect((await report(b)).files_changed).toEqual([
      { path: 'config.json', status: 'modified' },
      { path: 'handler.ts', status: 'added' },
      { path: 'old.ts', status: 'deleted' },
    ])
  })

  it('keeps every criterion when a re-test lists only what it settled', async () => {
    const b = await builtRepo()
    const cycle = join(b.runDir, 'cycles', '1')
    await writeFile(join(cycle, 'test-report-browser.json'), JSON.stringify({ criteria: { AC2: { verdict: 'pass', evidence: 'browser' } } }))
    execFileSync('node', [WRITER, b.runDir], { encoding: 'utf8' })
    const tests = (await report(b)).tests
    expect(tests).toContainEqual({ name: 'AC1: Returns 404', status: 'pass', evidence: 'second' })
    expect(tests).toContainEqual({ name: 'AC2', status: 'pass', evidence: 'browser' })
  })

  it('reads criteria written as a list, by id rather than by position', async () => {
    const b = await builtRepo()
    const cycle = join(b.runDir, 'cycles', '1')
    await writeFile(join(cycle, 'test-report.json'), JSON.stringify({ criteria: [
      { id: 'AC1', verdict: 'pass', evidence: 'unit' },
      { id: 'AC2', verdict: 'untested', evidence: 'browser criterion' },
    ] }))
    await writeFile(join(cycle, 'test-report-browser.json'), JSON.stringify({ criteria: [
      { id: 'AC2', verdict: 'pass', evidence: 'browser' },
    ] }))
    await rm(join(cycle, 'test-report-fix1.json'))
    execFileSync('node', [WRITER, b.runDir], { encoding: 'utf8' })
    expect((await report(b)).tests).toEqual([
      { name: 'AC1: Returns 404', status: 'pass', evidence: 'unit' },
      { name: 'AC2', status: 'pass', evidence: 'browser' },
    ])
  })

  it('refuses a listed criterion with no id', async () => {
    const b = await builtRepo()
    await writeFile(join(b.runDir, 'cycles', '1', 'test-report-fix1.json'), JSON.stringify({ criteria: [{ verdict: 'pass' }] }))
    expect(() => execFileSync('node', [WRITER, b.runDir], { stdio: 'pipe' })).toThrow(/test-report-fix1\.json lists a criterion with no id/)
  })

  it('takes test results from the latest fix round', async () => {
    const b = await builtRepo()
    expect((await report(b)).tests).toEqual([{ name: 'AC1: Returns 404', status: 'pass', evidence: 'second' }])
  })

  it('refuses to run without report-notes.json', async () => {
    const { runDir, g } = await builtRepo({ report: false })
    g('rm', '-q', join(runDir, 'report-notes.json'))
    expect(() => execFileSync('node', [WRITER, runDir], { stdio: 'pipe' })).toThrow(/report-notes\.json is missing/)
  })
})

describe('finding the report', () => {
  it('stops when no run has a report', async () => {
    const b = await builtRepo({ report: false })
    const r = harbor(b.dir, ['prepare'])
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/No Shipyard report for branch/)
  })

  it('stops when the report is malformed, naming the bad field', async () => {
    const b = await builtRepo()
    const path = join(b.runDir, 'shipyard-report.json')
    const report = JSON.parse(await readFile(path, 'utf8'))
    delete report.plan_changes
    await writeFile(path, JSON.stringify(report))
    const r = harbor(b.dir, ['prepare'])
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/malformed[\s\S]*plan_changes/)
  })

  it('stops when the report is not JSON', async () => {
    const b = await builtRepo()
    await writeFile(join(b.runDir, 'shipyard-report.json'), 'not json')
    expect(harbor(b.dir, ['prepare']).err).toMatch(/not valid JSON/)
  })

  it('refuses a run from another branch', async () => {
    const b = await builtRepo()
    b.g('checkout', '-q', '-b', 'other')
    expect(harbor(b.dir, ['prepare', '--run', 'r1']).err).toMatch(/Check out shipyard\/thing/)
  })

  it('finds the run from a subdirectory', async () => {
    const b = await builtRepo()
    await mkdir(join(b.dir, 'sub'))
    expect(harbor(join(b.dir, 'sub'), ['prepare']).ok).toBe(true)
  })
})

describe('prepare', () => {
  it('numbers new-side lines, leaves removed lines unnumbered, and excludes .shipyard', async () => {
    const b = await builtRepo()
    harbor(b.dir, ['prepare'])
    const context = await readFile(join(b.work, 'guide-context.md'), 'utf8')
    expect(context).toMatch(/^\s+3 \+ {2}"b": 2$/m)
    expect(context).toMatch(/^\s+- {2}"a": 1$/m)
    expect(context).toContain('### handler.ts (added)')
    expect(context).toContain('### old.ts (deleted)')
    expect(context).not.toContain('### .shipyard')
    expect(context).toContain('Unsure about 404.')
  })

  it('names the files the session should read and write', async () => {
    const b = await builtRepo()
    const { out } = harbor(b.dir, ['prepare'])
    expect(out).toContain(join(b.work, 'guide-context.md'))
    expect(out).toContain(join(b.work, 'guide-output.json'))
  })

  it('stops on uncommitted edits to a changed file', async () => {
    const b = await builtRepo()
    await writeFile(join(b.dir, 'handler.ts'), 'edited\n')
    expect(harbor(b.dir, ['prepare']).err).toMatch(/uncommitted edits/)
  })

  it('throws away a stale answer from an earlier prepare', async () => {
    const b = await builtRepo()
    harbor(b.dir, ['prepare'])
    await writeFile(join(b.work, 'guide-output.json'), JSON.stringify(OUTPUT))
    harbor(b.dir, ['prepare'])
    expect(harbor(b.dir, ['render']).err).toMatch(/guide-output\.json does not exist/)
  })
})

describe('render', () => {
  it('has all seven sections and passes its own check', async () => {
    const { guide, out } = await guideFor(await builtRepo())
    expect(guide.split('\n').filter(l => /^## \d\./.test(l))).toEqual([
      '## 1. What this build does', '## 2. File map', '## 3. The walkthrough', '## 4. Plumbing, collapsed',
      '## 5. Look here first', '## 6. Before you approve', '## 7. Q&A log',
    ])
    expect(out).toMatch(/2 snippets match the branch\. Took \d+s\./)
  })

  it('copies the code from the branch, with its path and range', async () => {
    const { guide } = await guideFor(await builtRepo())
    expect(guide).toContain(`**\`handler.ts:1-5\`**\n\n\`\`\`ts\n${HANDLER.trimEnd()}\n\`\`\``)
  })

  it('reads the commit, not the working tree', async () => {
    const b = await builtRepo()
    harbor(b.dir, ['prepare'])
    await writeFile(join(b.dir, 'handler.ts'), 'edited\n')
    await writeFile(join(b.work, 'guide-output.json'), JSON.stringify(OUTPUT))
    expect(harbor(b.dir, ['render']).ok).toBe(true)
    expect(await readFile(b.guidePath, 'utf8')).toContain('export function handle(id) {')
  })

  it('sorts files, ignores files that did not change, and flags unclassified ones', async () => {
    const { guide } = await guideFor(await builtRepo())
    expect(guide).toContain('- `handler.ts` (added): Looks up a row.')
    expect(guide).toContain('- `config.json` (modified): Adds b.')
    expect(guide).toContain('- `old.ts` (deleted): Not classified.')
    expect(guide).not.toContain('not-changed.ts')
  })

  it('collapses plumbing and shows only its changed lines', async () => {
    const { guide } = await guideFor(await builtRepo())
    expect(guide).toContain('<details>\n<summary><code>config.json</code>: Adds b.</summary>')
    expect(guide).toContain('**`config.json:2-3`**')
    expect(guide).toContain('Deleted in this build')
  })

  it('carries plan changes from the report and flattens prose', async () => {
    const { guide } = await guideFor(await builtRepo())
    expect(guide).toContain('- Dropped the cache. Why: Survey found none.')
    expect(guide).toContain('**What it does:** Looks up the row. Then returns it.')
  })

  it('says so when the report and the diff disagree', async () => {
    const b = await builtRepo()
    await writeFile(join(b.dir, 'late.ts'), 'export {}\n')
    b.g('add', '.')
    b.g('commit', '-qm', 'after the report')
    const { guide } = await guideFor(b)
    expect(guide).toContain('The report and the diff disagree')
    expect(guide).toContain('`late.ts` is in the diff but not in the report.')
  })

  it.each([
    ['a range past the end of the file', { ...OUTPUT, steps: [{ ...OUTPUT.steps[0]!, endLine: 99 }] }, /outside the file/],
    ['a file that did not change', { ...OUTPUT, steps: [{ ...OUTPUT.steps[0]!, path: 'nope.ts' }] }, /not a changed text file/],
    ['a deleted file', { ...OUTPUT, steps: [{ ...OUTPUT.steps[0]!, path: 'old.ts' }] }, /not a changed text file/],
    ['a step that does not exist', { ...OUTPUT, lookHereFirst: [{ step: 'S9', line: 1, why: 'x' }] }, /S9/],
    ['a line outside its step', { ...OUTPUT, lookHereFirst: [{ step: 'S1', line: 99, why: 'x' }] }, /outside 1-5/],
    ['too few questions', { ...OUTPUT, beforeYouApprove: ['one'] }, /3 to 5/],
    ['no summary', { ...OUTPUT, summary: '' }, /summary/],
  ])('writes nothing for %s, and a corrected file then renders', async (_name, output, message) => {
    const b = await builtRepo()
    await expect(guideFor(b, output)).rejects.toThrow(message)
    expect(existsSync(b.guidePath)).toBe(false)
    await writeFile(join(b.work, 'guide-output.json'), JSON.stringify(OUTPUT))
    expect(harbor(b.dir, ['render']).ok).toBe(true)
  })

  it('stops if HEAD moved after prepare', async () => {
    const b = await builtRepo()
    harbor(b.dir, ['prepare'])
    await writeFile(join(b.work, 'guide-output.json'), JSON.stringify(OUTPUT))
    b.g('commit', '-q', '--allow-empty', '-m', 'later')
    expect(harbor(b.dir, ['render']).err).toMatch(/HEAD has moved/)
  })

  it('stays out of git status, so the next build still sees a clean tree', async () => {
    const b = await builtRepo()
    await guideFor(b)
    expect(b.g('status', '--porcelain')).toBe('')
  })

  it('will not overwrite a guide unless forced, and then keeps the old one', async () => {
    const b = await builtRepo()
    await guideFor(b)
    expect(harbor(b.dir, ['prepare']).err).toMatch(/--force/)
    await guideFor(b, OUTPUT, ['--force'])
    expect((await readdir(b.runDir)).filter(n => n.startsWith('REVIEW_GUIDE'))).toHaveLength(2)
    expect(b.g('status', '--porcelain')).toBe('')
  })

  it('fences code that itself contains a fence', async () => {
    const b = await builtRepo()
    await writeFile(join(b.dir, 'doc.md'), '# Doc\n```js\nx\n```\n')
    b.g('add', '.')
    b.g('commit', '-qm', 'doc')
    const { guide } = await guideFor(b, {
      ...OUTPUT,
      steps: [{ ...OUTPUT.steps[0]!, path: 'doc.md', startLine: 1, endLine: 4 }],
      lookHereFirst: [{ step: 'S1', line: 2, why: 'x' }],
    })
    expect(guide).toContain('````markdown\n# Doc\n```js\nx\n```\n````')
    expect(verifyOf(b).ok).toBe(true)
  })
})

describe('verify', () => {
  async function tampered(change: (guide: string) => string) {
    const b = await builtRepo()
    const { guide } = await guideFor(b)
    await writeFile(b.guidePath, change(guide))
    return verifyOf(b)
  }

  it('passes a fresh guide', async () => {
    const b = await builtRepo()
    await guideFor(b)
    expect(verifyOf(b).out).toContain('2 snippets match the branch')
  })

  it('catches an edited snippet', async () => {
    const r = await tampered(g => g.replace('status: 404', 'status: 500'))
    expect(r.ok).toBe(false)
    expect(r.err).toContain('handler.ts:1-5: snippet does not match the branch.')
  })

  it('catches a wrong line range', async () => {
    expect((await tampered(g => g.replace('handler.ts:1-5', 'handler.ts:2-5'))).err).toMatch(/does not match/)
    expect((await tampered(g => g.replace('handler.ts:1-5', 'handler.ts:1-50'))).err).toMatch(/outside the file/)
  })

  it('catches a code block with no label', async () => {
    expect((await tampered(g => `${g}\n\`\`\`ts\ninvented()\n\`\`\`\n`)).err).toMatch(/no path and line range/)
  })

  it('catches a missing section', async () => {
    expect((await tampered(g => g.replace('## 5. Look here first', '## Look'))).err).toContain('Missing section "5. Look here first".')
  })

  it('checks against the commit the guide describes, not later ones', async () => {
    const b = await builtRepo()
    await guideFor(b)
    await writeFile(join(b.dir, 'handler.ts'), 'moved on\n')
    b.g('commit', '-qam', 'later')
    expect(verifyOf(b).ok).toBe(true)
  })
})

describe('ask', () => {
  const ready = async () => {
    const b = await builtRepo()
    await guideFor(b)
    return b
  }

  it('appends the question and quoted lines to the Q&A log', async () => {
    const { guide, out } = await asking(await ready(), 'S1: why 404?')
    const log = guide.slice(guide.indexOf('## 7. Q&A log'))
    expect(log).toContain('### Q1: S1: why 404?')
    expect(log).toContain('Line 3 returns 404 when the row is falsy.')
    expect(log).toContain('**`handler.ts:3-3`**\n\n```ts\n  if (!row) return { status: 404 }\n```')
    expect(log).not.toContain('No questions yet')
    expect(out).toContain('### Q1: S1: why 404?')
  })

  it('numbers questions and leaves a guide that still verifies', async () => {
    const b = await ready()
    await asking(b, 'S1: first?')
    const { guide } = await asking(b, 'S1: second?')
    expect(guide.indexOf('### Q1: S1: first?')).toBeLessThan(guide.indexOf('### Q2: S1: second?'))
    expect(guide.indexOf('### Q1')).toBeGreaterThan(-1)
    expect(verifyOf(b).out).toContain('4 snippets match the branch')
  })

  it('gives the context the files the step touches and no others', async () => {
    const b = await ready()
    harbor(b.dir, ['ask-prepare'], 'S1: why 404?')
    const context = await readFile(join(b.work, 'ask-context.md'), 'utf8')
    const section = context.slice(context.indexOf('# Files this question touches'), context.indexOf('# The question'))
    expect(section).toContain('### handler.ts')
    expect(section).not.toContain('config.json')
    expect(context.endsWith('# The question\n\nS1: why 404?')).toBe(true)
  })

  it('finds a file the question names', async () => {
    const b = await ready()
    harbor(b.dir, ['ask-prepare'], 'what is in config.json?')
    const context = await readFile(join(b.work, 'ask-context.md'), 'utf8')
    expect(context.slice(context.indexOf('# Files this question touches'))).toContain('### config.json')
  })

  it('takes a question with shell characters word for word', async () => {
    const q = `S1: does $HOME or \`x\` "break" it's quoting?`
    const { guide } = await asking(await ready(), q)
    expect(guide).toContain(`### Q1: ${q}`)
  })

  it('rejects a step the guide does not have', async () => {
    const r = harbor((await ready()).dir, ['ask-prepare'], 'S9: why?')
    expect(r.ok).toBe(false)
    expect(r.err).toContain('The guide has no step S9. It has S1.')
  })

  it('says so when it is not sure', async () => {
    const { guide } = await asking(await ready(), 'S1: what does lookup throw?', { answer: 'I cannot tell.', quotes: [], checkYourself: 'Where lookup is defined.' })
    expect(guide).toContain('**Not sure. Check this yourself:** Where lookup is defined.')
  })

  it.each([
    ['a range that does not exist', { ...ANSWER, quotes: [{ path: 'handler.ts', startLine: 50, endLine: 51 }] }, /outside the file/],
    ['a file outside the change', { ...ANSWER, quotes: [{ path: 'secret.ts', startLine: 1, endLine: 1 }] }, /not a changed text file/],
    ['nothing at all', { answer: 'Trust me.', quotes: [], checkYourself: null }, /quotes no lines/],
  ])('does not log an answer that cites %s', async (_name, answer, message) => {
    const b = await ready()
    const before = await readFile(b.guidePath, 'utf8')
    await expect(asking(b, 'S1: why?', answer)).rejects.toThrow(message)
    expect(await readFile(b.guidePath, 'utf8')).toBe(before)
  })

  it('stops when there is no guide yet', async () => {
    const b = await builtRepo()
    expect(harbor(b.dir, ['ask-prepare'], 'why?').err).toMatch(/Run \/harbor first/)
  })

  it('stops on an empty question', async () => {
    expect(harbor((await ready()).dir, ['ask-prepare'], '  \n').err).toMatch(/No question given/)
  })

  it('answers from the guide\'s commit after HEAD moves, and says it moved', async () => {
    const b = await ready()
    await writeFile(join(b.dir, 'handler.ts'), 'moved on\n')
    b.g('commit', '-qam', 'later')
    const { out } = await asking(b, 'S1: why?')
    expect(out).toContain('if (!row) return { status: 404 }')
    expect(out).toContain('HEAD has moved')
  })

  it('leaves git status clean', async () => {
    const b = await ready()
    await asking(b, 'S1: why?')
    expect(b.g('status', '--porcelain')).toBe('')
  })
})

describe('the /harbor command', () => {
  const printed = () => execFileSync('node', [BUILD, '--print-harbor'], { encoding: 'utf8' })

  it('bundles the manual and needs no key or SDK', () => {
    const command = printed()
    expect(command).toContain('# HARBOR PILOT')
    expect(command).toContain('$ARGUMENTS')
    expect(command).toContain('node ~/.claude/shipyard/harbor.mjs ask-prepare')
    expect(command).not.toMatch(/API_KEY|claude-agent-sdk/)
  })

  it('keeps the script free of dependencies, since it runs from ~/.claude/shipyard', async () => {
    const imports = [...(await readFile(HARBOR, 'utf8')).matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]!)
    expect(imports.every(name => name.startsWith('node:'))).toBe(true)
  })

  it('installs beside /shipyard, and /shipyard hands off to it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'harbor-home-'))
    execFileSync('node', [BUILD], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    expect(existsSync(join(home, '.claude', 'commands', 'harbor.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'shipyard', 'harbor.mjs'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'shipyard', 'write-shipyard-report.mjs'))).toBe(true)
    const shipyard = await readFile(join(home, '.claude', 'commands', 'shipyard.md'), 'utf8')
    expect(shipyard).toContain('`/harbor`')
    expect(shipyard).not.toMatch(/running `harbor`/)
  })
})
