import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDER = join(repo, 'tools', 'render-report.mjs')
const BUILD = join(repo, 'tools', 'build-command.mjs')

const run = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Pull the inlined JSON payload back out of a rendered report. */
async function payload(runDir: string) {
  const html = await readFile(join(runDir, 'report.html'), 'utf8')
  const m = html.match(/<script id="run-data" type="application\/json">([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no payload in report.html')
  return { html, data: JSON.parse(m[1]!) }
}

async function gitTarget() {
  const dir = await mkdtemp(join(tmpdir(), 'shipyard-tgt-'))
  const g = (...a: string[]) => run('git', a, dir)
  g('init', '-q')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 't')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  const base = g('rev-parse', 'HEAD').trim()
  return { dir, g, base }
}

describe('render-report', () => {
  it('shows files changed since baseCommit and flags uncommitted ones', async () => {
    const { dir, g, base } = await gitTarget()
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    g('commit', '-qam', 'dev work')
    await writeFile(join(dir, 'b.ts'), 'export {}\n')
    const runDir = join(dir, '.shipyard', 'runs', 'r1')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'state.json'), JSON.stringify({ runId: 'r1', stage: 'build', verdict: 'pending', baseCommit: base }))

    run('node', [RENDER, runDir])
    const { data } = await payload(runDir)
    const byPath = Object.fromEntries(data.tree.files.map((f: { path: string }) => [f.path, f]))
    expect(byPath['a.txt']).toMatchObject({ add: 1, del: 0, wip: false })
    expect(byPath['b.ts']).toMatchObject({ wip: true, isNew: true })
    // The run's own artifacts are not "work"; they must not appear.
    expect(data.tree.files.some((f: { path: string }) => f.path.startsWith('.shipyard/'))).toBe(false)
  })

  it('omits the working tree when there is no baseCommit or it is not a sha', async () => {
    const { dir } = await gitTarget()
    const runDir = join(dir, '.shipyard', 'runs', 'r2')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'state.json'), JSON.stringify({ stage: 'plan', baseCommit: '--output=/tmp/x' }))
    run('node', [RENDER, runDir])
    expect((await payload(runDir)).data.tree).toBeNull()
  })

  it('auto-refreshes only while live and carries telemetry for the clocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shipyard-run-'))
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      stage: 'build', verdict: 'pending', startedAt: '2026-01-01T00:00:00Z',
      active: [{ id: 'dev-T1', role: 'dev', task: 'T1', since: '2026-01-01T00:01:00Z' }],
    }))
    run('node', [RENDER, dir])
    const live = await payload(dir)
    expect(live.html).toMatch(/http-equiv="refresh"/)
    expect(live.data.stateMtime).toBeGreaterThan(0)
    expect(live.data.state.active).toHaveLength(1)

    await writeFile(join(dir, 'state.json'), JSON.stringify({ stage: 'done', verdict: 'shipped' }))
    run('node', [RENDER, dir])
    expect((await payload(dir)).html).not.toMatch(/http-equiv="refresh"/)
  })
})

describe('build-command', () => {
  const command = run('node', [BUILD, '--print'])

  it('copies the installed renderer instead of inlining it', () => {
    expect(command).toMatch(/cp ~\/\.claude\/shipyard\/render-report\.mjs \.shipyard\/render-report\.mjs/)
    expect(command).not.toMatch(/# THE RENDERER/)
    expect(command).not.toMatch(/function workingTree/)
  })

  it('bundles every role with its model', () => {
    for (const role of ['intake', 'surveyor', 'manager', 'dev', 'tester', 'reporter']) {
      expect(command).toContain(`## Role: ${role}`)
    }
    expect(command).toMatch(/model: sonnet/)
    expect(command).toMatch(/model: opus/)
  })

  it('stays small enough to load quickly', () => {
    expect(command.length).toBeLessThan(30_000)
  })
})
