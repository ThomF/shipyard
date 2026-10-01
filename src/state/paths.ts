import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type RunPaths = {
  root: string
  state: string
  brief: string
  codebaseMap: string
  learnings: string
  report: string
  agentsDir: string
  cycleDir: (n: number) => string
}

export function runPaths(target: string, runId: string): RunPaths {
  const root = join(target, '.shipyard', 'runs', runId)
  return {
    root,
    state: join(root, 'state.json'),
    brief: join(root, 'brief.json'),
    codebaseMap: join(root, 'codebase-map.json'),
    learnings: join(root, 'learnings.md'),
    report: join(root, 'report.md'),
    agentsDir: join(root, 'agents'),
    cycleDir: (n: number) => join(root, 'cycles', String(n)),
  }
}

export async function assertGitRepo(target: string): Promise<void> {
  // Check the path separately from the git check. Running git with a cwd that does
  // not exist fails with `spawn git ENOENT`, which is indistinguishable from git
  // rejecting a real directory — and reporting that as "not a git repository" would
  // tell the user to `git init` a path that isn't there (most likely a typo'd target).
  let stats
  try {
    stats = await stat(target)
  } catch (cause) {
    throw new Error(`${target} does not exist. Check the target path.`, { cause })
  }

  if (!stats.isDirectory()) {
    throw new Error(`${target} is not a directory. The target must be a directory.`)
  }

  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd: target })
  } catch (cause) {
    throw new Error(
      `${target} is not a git repository. Shipyard isolates each agent in a git worktree, so the target must be a git repo. Run \`git init\` there first.`,
      { cause },
    )
  }
}
