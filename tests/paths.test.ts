import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
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

  // A missing path must not be reported as "not a git repository" — telling a user to
  // `git init` a directory that does not exist is wrong advice, and a typo'd --target
  // is the most likely way anyone hits this.
  it('rejects a path that does not exist, without suggesting git init', async () => {
    await expect(assertGitRepo('/nonexistent/path/xyz')).rejects.toThrow(
      /does not exist/i,
    )
    await expect(assertGitRepo('/nonexistent/path/xyz')).rejects.not.toThrow(
      /git init/i,
    )
  })

  it('rejects a path that exists but is not a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-file-'))
    const file = join(dir, 'afile.txt')
    await writeFile(file, 'hello')
    await expect(assertGitRepo(file)).rejects.toThrow(/not a directory/i)
    await expect(assertGitRepo(file)).rejects.not.toThrow(/git init/i)
  })
})
