import { join } from 'node:path'
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
  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd: target })
  } catch (cause) {
    throw new Error(
      `${target} is not a git repository. Shipyard isolates each agent in a git worktree, so the target must be a git repo. Run \`git init\` there first.`,
      { cause },
    )
  }
}
