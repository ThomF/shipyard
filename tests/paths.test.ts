import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runPaths, assertGitRepo } from '../src/state/paths.js'

const exec = promisify(execFile)

describe('runPaths', () => {
  it('places every artifact under the target .shipyard run directory', () => {
    const p = runPaths('/tmp/proj', 'run-abc')
    expect(p.root).toBe('/tmp/proj/.shipyard/runs/run-abc')
    expect(p.state).toBe('/tmp/proj/.shipyard/runs/run-abc/state.json')
    expect(p.brief).toBe('/tmp/proj/.shipyard/runs/run-abc/brief.json')
    expect(p.agentsDir).toBe('/tmp/proj/.shipyard/runs/run-abc/agents')
    expect(p.cycleDir(2)).toBe('/tmp/proj/.shipyard/runs/run-abc/cycles/2')
  })
})

describe('assertGitRepo', () => {
  it('resolves for a real git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-git-'))
    await exec('git', ['init', '-q'], { cwd: dir })
    await expect(assertGitRepo(dir)).resolves.toBeUndefined()
  })

  // Review Focus #1: target is not a git repo — must fail at startup, not mid-build
  it('rejects a directory that is not a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-nogit-'))
    await expect(assertGitRepo(dir)).rejects.toThrow(/not a git repository/i)
  })

  it('rejects a path that does not exist', async () => {
    await expect(assertGitRepo('/nonexistent/path/xyz')).rejects.toThrow()
  })
})
