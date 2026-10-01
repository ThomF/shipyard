# Shipyard Core Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Shipyard's core runtime — schemas, state store, agent spawning with per-role tool restriction, and the intake → survey → plan stages — so that `shipyard run "<idea>" --target <path> --dry-run` produces a validated task plan.

**Architecture:** A deterministic TypeScript orchestrator ("harbormaster") with no model context of its own. Every LLM call is a single-use agent spawned via the Claude Agent SDK's `query()` with its own `cwd`, `allowedTools`, and `outputFormat` JSON schema. Agents return schema-validated JSON and exit; raw transcripts stream to disk write-only. All run state lives in an atomically-written `state.json`.

**Tech Stack:** TypeScript on Node, `@anthropic-ai/claude-agent-sdk` (MIT), `zod` (MIT), `commander` (MIT), `picocolors` (ISC), `vitest` (MIT).

**Spec:** `docs/superpowers/specs/2026-10-01-shipyard-design.md`

**Scope:** This is plan 1 of 2. It ends when a plan can be produced and validated. Plan 2 covers build / integrate / verify / fix / cycles / report.

## Global Constraints

- TypeScript, ES modules, Node 22+. `"type": "module"` in package.json.
- Every artifact has a Zod schema in `src/schemas/`. Nothing is written to disk unvalidated.
- `state.json` is written atomically: write temp file, then `fs.rename`.
- Agent transcripts are write-only. No code path reads `agents/*.jsonl` back into a prompt.
- The harbormaster never calls a model. All model calls go through `spawnAgent`.
- `spawnAgent` takes its `query` implementation as an injected dependency so tests never hit the network.
- Writes are confined to the target path and `<target>/.shipyard/`.
- Nothing is deleted. Failed work is archived, never removed.
- Default model for every role is `claude-opus-4-8`, overridable per role via config.
- Max parallel agents defaults to `Math.max(1, Math.min(4, os.cpus().length - 2))`.
- Digest is capped at 8000 characters.
- Tool names are exact SDK strings: `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`.

## Review Focus

Input classes the spec implies but no task's own happy-path tests exercise. Each gets a test added to the task that owns the code.

1. **Target path is not a git repository** — worktrees are impossible; the run must fail at startup with a clear message, not midway through building. (Task 2)
2. **Intake returns structurally valid but semantically empty output** — zero acceptance criteria passes the schema but makes every downstream stage meaningless. Must be rejected. (Task 6)
3. **An agent returns output that fails schema validation repeatedly** — must stop after bounded retries and surface a death, not loop forever. (Task 4)
4. **Two concurrently-runnable tasks claim the same file** — the plan is wrong; must be a validation error that re-prompts the planner, not a silent conflict later. (Task 8)
5. **A run is resumed after a crash mid-stage** — partially written state must not produce a half-applied stage or duplicate work. (Task 9)

---

## File Structure

```
package.json            deps, scripts, "type": "module"
tsconfig.json           strict, ES2022, NodeNext
vitest.config.ts

src/
  schemas/index.ts      zod schemas for every artifact + inferred types
  state/paths.ts        run directory layout; pure path helpers
  state/store.ts        RunState type, atomic read/write, resume
  agents/roles.ts       role → tool permission table
  agents/spawn.ts       spawnAgent(): query() wrapper, validation, transcript, timeout
  prompts/intake.ts     prompt builder
  prompts/survey.ts     prompt builders (4 concerns)
  prompts/plan.ts       prompt builder
  digest/digest.ts      deterministic rundown generator
  stages/intake.ts
  stages/survey.ts
  stages/plan.ts
  harbormaster/run.ts   stage machine + resume
  cli/index.ts          commander entrypoint
  cli/render.ts         live progress tree

tests/                  mirrors src/
```

---

### Task 1: Project scaffolding and artifact schemas

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/schemas/index.ts`
- Test: `tests/schemas.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `BriefSchema`, `CodebaseMapSchema`, `PlanSchema`, `TaskSchema`, `AcceptanceCriterionSchema` and inferred types `Brief`, `CodebaseMap`, `Plan`, `PlanTask`, `AcceptanceCriterion`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "shipyard",
  "version": "0.1.0",
  "type": "module",
  "bin": { "shipyard": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "commander": "^12.1.0",
    "picocolors": "^1.1.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts and .gitignore**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
```

`.gitignore`:
```
node_modules/
dist/
.shipyard/
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, no peer-dependency errors.

- [ ] **Step 5: Write the failing schema test**

```typescript
import { describe, it, expect } from 'vitest'
import { BriefSchema, PlanSchema } from '../src/schemas/index.js'

describe('BriefSchema', () => {
  it('accepts a well-formed brief', () => {
    const brief = {
      goal: 'Build a CLI that converts CSV to JSON',
      stack: ['typescript', 'node'],
      constraints: ['no external deps'],
      assumptions: ['input files are UTF-8'],
      acceptanceCriteria: [
        { id: 'AC1', statement: 'Running `csv2json x.csv` writes x.json', verifiable: true },
      ],
      risks: ['large files may not fit in memory'],
    }
    expect(BriefSchema.parse(brief).acceptanceCriteria).toHaveLength(1)
  })

  it('rejects a brief whose acceptance criteria are missing', () => {
    expect(() => BriefSchema.parse({ goal: 'x', stack: [], constraints: [], assumptions: [], risks: [] })).toThrow()
  })
})

describe('PlanSchema', () => {
  it('accepts a plan with a task DAG', () => {
    const plan = {
      summary: 'Two tasks',
      tasks: [
        { id: 'T1', goal: 'Write the parser', dependsOn: [], ownsFiles: ['src/parse.ts'], criteriaIds: ['AC1'] },
        { id: 'T2', goal: 'Wire the CLI', dependsOn: ['T1'], ownsFiles: ['src/cli.ts'], criteriaIds: ['AC1'] },
      ],
    }
    expect(PlanSchema.parse(plan).tasks[1]!.dependsOn).toEqual(['T1'])
  })

  it('rejects a task that owns zero files', () => {
    const plan = { summary: 's', tasks: [{ id: 'T1', goal: 'g', dependsOn: [], ownsFiles: [], criteriaIds: ['AC1'] }] }
    expect(() => PlanSchema.parse(plan)).toThrow()
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/schemas/index.js`.

- [ ] **Step 7: Write src/schemas/index.ts**

```typescript
import { z } from 'zod'

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  verifiable: z.boolean(),
})

export const BriefSchema = z.object({
  goal: z.string().min(1),
  stack: z.array(z.string()),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  risks: z.array(z.string()),
})

export const CodebaseMapSchema = z.object({
  structure: z.string(),
  language: z.string(),
  framework: z.string().nullable(),
  testCommand: z.string().nullable(),
  conventions: z.array(z.string()),
  relevantModules: z.array(z.object({ path: z.string(), why: z.string() })),
})

export const PlanTaskSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  dependsOn: z.array(z.string()),
  ownsFiles: z.array(z.string()).min(1),
  criteriaIds: z.array(z.string()),
})

export const PlanSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(PlanTaskSchema).min(1),
})

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>
export type Brief = z.infer<typeof BriefSchema>
export type CodebaseMap = z.infer<typeof CodebaseMapSchema>
export type PlanTask = z.infer<typeof PlanTaskSchema>
export type Plan = z.infer<typeof PlanSchema>
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/schemas.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/schemas/index.ts tests/schemas.test.ts
git commit -m "feat: scaffold project and define artifact schemas"
```

---

### Task 2: Run directory layout and git preflight

**Files:**
- Create: `src/state/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `runPaths(target: string, runId: string): RunPaths` where `RunPaths` has `root`, `state`, `brief`, `codebaseMap`, `learnings`, `report`, `agentsDir`, `cycleDir(n: number): string`; and `assertGitRepo(target: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/paths.test.ts`
Expected: FAIL — cannot resolve `../src/state/paths.js`.

- [ ] **Step 3: Write src/state/paths.ts**

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/paths.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state/paths.ts tests/paths.test.ts
git commit -m "feat: add run directory layout and git preflight check"
```

---

### Task 3: Role definition files and loader with permission floor

**Files:**
- Create: `agents/manager.md`, `agents/dev.md`, `agents/tester.md`, `agents/surveyor.md`, `agents/intake.md`, `agents/reporter.md`
- Create: `src/agents/roles.ts`
- Test: `tests/roles.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type Role = 'intake' | 'surveyor' | 'manager' | 'dev' | 'tester' | 'reporter'`; `type RoleDefinition = { name: Role; model: string; tools: string[]; permissionMode: 'default' | 'acceptEdits'; delegatesTo: Role[]; systemPrompt: string }`; `loadRole(role: Role, dir?: string): Promise<RoleDefinition>`; `PERMISSION_FLOOR: Record<Role, readonly string[]>`; `canWriteFiles(role: Role): boolean`

Roles are defined in editable markdown files (spec §3.8), so tuning a role is editing a prompt rather than editing a program. The loader is the safety boundary: it intersects each file's declared `tools` with a hard-coded floor, so a role file can narrow permissions but never widen them. A `tester.md` that declares `Write` is a startup error.

**Note on the tester:** `Bash` is required to run tests, and Bash can write files (`echo > f`). Removing `Write`/`Edit` is real enforcement but not airtight. `canWriteFiles` exists so plan 2's verify stage knows which roles to audit with a worktree-cleanliness check, which is what actually closes the gap.

- [ ] **Step 1: Write the six role definition files**

`agents/manager.md`:
```markdown
---
name: manager
model: claude-opus-4-8
tools: [Read, Grep, Glob]
delegatesTo: [dev, tester]
---
You are the manager of an autonomous development team.

You are given a goal, a map of the codebase, and a digest of everything that has
already been tried. You do exactly one job per invocation and then you stop.

Decompose the goal into tasks. Each task must:
- have a single clear deliverable
- name the acceptance criteria it serves
- own a set of files that NO other concurrently-runnable task owns

File ownership is how parallel work stays conflict-free. Two tasks that can run
at the same time must never list the same file. If two pieces of work genuinely
need the same file, make one depend on the other.

You also write a spec page: prose explaining what you intend to build and why,
grounded in the brief, the codebase map, and the repository's own documentation.
Someone should be able to read it and tell whether you understood the job.

You cannot write code and you cannot run commands. You decide; others execute.
Do not ask for permission or offer to continue — return your decision and stop.
```

`agents/dev.md`:
```markdown
---
name: dev
model: claude-opus-4-8
tools: [Read, Grep, Glob, Write, Edit, Bash]
permissionMode: acceptEdits
delegatesTo: []
---
You are a developer. You have been given ONE task and a set of files you own.

Only modify files you own. If the task cannot be done without touching a file
you do not own, stop and report that as a blocker — do not touch it anyway.

Write tests for the acceptance criteria your task serves. Run them. You may run
tests to check your own work, but you do NOT decide whether the task is done —
a tester makes that call. Report honestly: if something does not work, say so.

Standards for all code you write:
- Database access uses parameterized queries, never string concatenation
- No credentials or tokens in source; use environment variable placeholders
- Error handling is required; no bare try blocks or swallowed exceptions
- Code touching customer data carries a data-classification comment
- Note the license type of any third-party dependency you add
```

`agents/tester.md`:
```markdown
---
name: tester
model: claude-opus-4-8
tools: [Read, Grep, Glob, Bash]
delegatesTo: []
---
You are a tester. You verify acceptance criteria and report a verdict.

You do NOT fix anything. You have no editing tools, and you must not use Bash to
modify files either — the worktree is checked for modifications after you run and
a dirty worktree fails the run.

For each criterion, run what is needed to decide pass or fail, and report the
actual command output as evidence. A criterion you could not test is "untested",
not "pass". Do not round up: a test that passes trivially because it asserts
nothing is a fail, and you should say why.
```

`agents/surveyor.md`:
```markdown
---
name: surveyor
model: claude-opus-4-8
tools: [Read, Grep, Glob]
delegatesTo: []
---
You are a surveyor. You read an existing repository and report what is there.

You will be told which single concern to cover. Stay on it — another surveyor
covers the others. Report what you actually found, not what you assume is
typical for this kind of project. If something is absent, say it is absent.
```

`agents/intake.md`:
```markdown
---
name: intake
model: claude-opus-4-8
tools: [Read, Grep, Glob]
delegatesTo: []
---
You turn a one-sentence idea into an explicit contract.

Your most important output is the acceptance criteria: each must be specific
enough that a tester can return pass or fail without judgement. "Works well" is
not a criterion; "running `foo x.csv` writes `x.json` with one object per row"
is.

Record what you were NOT told as assumptions. A wrong assumption surfaced in a
short list is cheap; the same assumption buried in generated code is expensive.
```

`agents/reporter.md`:
```markdown
---
name: reporter
model: claude-opus-4-8
tools: [Read, Grep, Glob]
delegatesTo: []
---
You write the report a human reads instead of watching the run.

Lead with the verdict in one line. Then what was asked for, the acceptance
criteria table with final status, what was built, test results with actual
failure output, what went wrong and why, and recommended next steps.

A failed run must explain itself well enough that the reader can decide what to
change about the idea. Do not soften failures and do not claim work you cannot
point to evidence for in the artifacts.
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRole, canWriteFiles, PERMISSION_FLOOR } from '../src/agents/roles.js'

describe('loadRole', () => {
  it('loads the shipped manager definition', async () => {
    const r = await loadRole('manager')
    expect(r.name).toBe('manager')
    expect(r.model).toBe('claude-opus-4-8')
    expect(r.delegatesTo).toContain('dev')
    expect(r.systemPrompt.length).toBeGreaterThan(0)
  })

  it('gives devs write tools and acceptEdits mode', async () => {
    const r = await loadRole('dev')
    expect(r.tools).toContain('Write')
    expect(r.tools).toContain('Edit')
    expect(r.permissionMode).toBe('acceptEdits')
  })

  it('gives testers Bash but never Write or Edit', async () => {
    const r = await loadRole('tester')
    expect(r.tools).toContain('Bash')
    expect(r.tools).not.toContain('Write')
    expect(r.tools).not.toContain('Edit')
  })

  it('denies managers Bash and every write tool', async () => {
    const r = await loadRole('manager')
    for (const forbidden of ['Write', 'Edit', 'Bash']) {
      expect(r.tools).not.toContain(forbidden)
    }
  })

  it('lets a role file narrow its tools below the floor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'dev.md'), '---\nname: dev\nmodel: m\ntools: [Read]\n---\nbody')
    const r = await loadRole('dev', dir)
    expect(r.tools).toEqual(['Read'])
  })

  // The safety boundary: editing a role file must not be able to weaken separation of duties
  it('rejects a role file that widens tools past the floor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'tester.md'), '---\nname: tester\nmodel: m\ntools: [Read, Write]\n---\nbody')
    await expect(loadRole('tester', dir)).rejects.toThrow(/not permitted for role tester/i)
  })

  it('rejects a role file with an empty system prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'dev.md'), '---\nname: dev\nmodel: m\ntools: [Read]\n---\n   \n')
    await expect(loadRole('dev', dir)).rejects.toThrow(/empty system prompt/i)
  })

  it('rejects a role file whose name does not match the requested role', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'dev.md'), '---\nname: tester\nmodel: m\ntools: [Read]\n---\nbody')
    await expect(loadRole('dev', dir)).rejects.toThrow(/declares name/i)
  })
})

describe('canWriteFiles', () => {
  it('is true only for dev', () => {
    expect(canWriteFiles('dev')).toBe(true)
    expect(canWriteFiles('tester')).toBe(false)
    expect(canWriteFiles('manager')).toBe(false)
  })
})

describe('PERMISSION_FLOOR', () => {
  it('never grants a write tool to a non-dev role', () => {
    for (const [role, tools] of Object.entries(PERMISSION_FLOOR)) {
      if (role === 'dev') continue
      expect(tools).not.toContain('Write')
      expect(tools).not.toContain('Edit')
    }
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/roles.test.ts`
Expected: FAIL — cannot resolve `../src/agents/roles.js`.

- [ ] **Step 4: Write src/agents/roles.ts**

The frontmatter parser is deliberately small — these are our own files in a fixed format, so a YAML dependency is not warranted.

```typescript
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Role = 'intake' | 'surveyor' | 'manager' | 'dev' | 'tester' | 'reporter'

export type RoleDefinition = {
  name: Role
  model: string
  tools: string[]
  permissionMode: 'default' | 'acceptEdits'
  delegatesTo: Role[]
  systemPrompt: string
}

const READ_ONLY = ['Read', 'Grep', 'Glob']

/** Maximum tools any role file may claim. Files may narrow this; never widen it. */
export const PERMISSION_FLOOR: Record<Role, readonly string[]> = {
  intake: READ_ONLY,
  surveyor: READ_ONLY,
  manager: READ_ONLY,
  reporter: READ_ONLY,
  tester: [...READ_ONLY, 'Bash'],
  dev: [...READ_ONLY, 'Write', 'Edit', 'Bash'],
}

export function canWriteFiles(role: Role): boolean {
  return PERMISSION_FLOOR[role].includes('Write')
}

function defaultAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents')
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('role file is missing a --- frontmatter block')
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { fields, body: match[2] ?? '' }
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean)
}

export async function loadRole(role: Role, dir = defaultAgentsDir()): Promise<RoleDefinition> {
  const path = join(dir, `${role}.md`)
  const { fields, body } = parseFrontmatter(await readFile(path, 'utf8'))

  if (fields.name !== role) {
    throw new Error(`${path} declares name "${fields.name}" but was loaded as role "${role}"`)
  }
  const systemPrompt = body.trim()
  if (!systemPrompt) throw new Error(`${path} has an empty system prompt`)

  const declared = parseList(fields.tools)
  const floor = PERMISSION_FLOOR[role]
  const widened = declared.filter(t => !floor.includes(t))
  if (widened.length > 0) {
    throw new Error(
      `${path} declares tools not permitted for role ${role}: ${widened.join(', ')}. ` +
      `Role files may narrow permissions but never widen them.`,
    )
  }

  const mode = fields.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default'
  return {
    name: role,
    model: fields.model || 'claude-opus-4-8',
    tools: declared.length > 0 ? declared : [...floor],
    permissionMode: canWriteFiles(role) ? mode : 'default',
    delegatesTo: parseList(fields.delegatesTo) as Role[],
    systemPrompt,
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/roles.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add agents/ src/agents/roles.ts tests/roles.test.ts
git commit -m "feat: load roles from editable definition files with a permission floor"
```

---

### Task 4: spawnAgent — the single point where a model is called

**Files:**
- Create: `src/agents/spawn.ts`
- Test: `tests/spawn.test.ts`

**Interfaces:**
- Consumes: `RoleDefinition` from `src/agents/roles.js`
- Produces: `type AgentOutcome<T>`; `type QueryFn`; `spawnAgent<T>(opts: SpawnOptions<T>): Promise<AgentOutcome<T>>`

This is the only function in Shipyard that calls a model. It enforces invariants I1–I4 from the spec: one job per agent, transcripts write-only, prompts assembled by code, schema-validated results.

The SDK's `query()` is injected via `opts.query` so tests run without network access. The real import is `import { query } from '@anthropic-ai/claude-agent-sdk'`.

An agent that returns no result, returns unparseable output, or exceeds its timeout is **dead**, not an exception — death is the normal case (spec §6.1) and the caller decides whether to respawn.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { spawnAgent, type QueryFn } from '../src/agents/spawn.js'
import type { RoleDefinition } from '../src/agents/roles.js'

const role: RoleDefinition = {
  name: 'tester',
  model: 'claude-opus-4-8',
  tools: ['Read', 'Bash'],
  permissionMode: 'default',
  delegatesTo: [],
  systemPrompt: 'You are a tester.',
}

const Schema = z.object({ passed: z.boolean() })

function fakeQuery(messages: unknown[]): QueryFn {
  return () => (async function* () { for (const m of messages) yield m as never })()
}

async function base(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sy-spawn-'))
  return {
    role,
    agentId: 'a1',
    prompt: 'check it',
    schema: Schema,
    jsonSchema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] },
    cwd: dir,
    transcriptPath: join(dir, 'a1.jsonl'),
    timeoutMs: 5000,
    ...overrides,
  }
}

describe('spawnAgent', () => {
  it('returns the validated structured output', async () => {
    const opts = await base({
      query: fakeQuery([
        { type: 'assistant', text: 'working' },
        { type: 'result', subtype: 'success', structured_output: { passed: true }, total_cost_usd: 0.12 },
      ]),
    })
    const out = await spawnAgent(opts as never)
    expect(out.status).toBe('ok')
    if (out.status === 'ok') {
      expect(out.value.passed).toBe(true)
      expect(out.costUsd).toBe(0.12)
    }
  })

  it('passes the role tool list and cwd through to query', async () => {
    let seen: any
    const opts = await base({
      query: (args: any) => { seen = args; return (async function* () {
        yield { type: 'result', subtype: 'success', structured_output: { passed: true }, total_cost_usd: 0 }
      })() },
    })
    await spawnAgent(opts as never)
    expect(seen.options.allowedTools).toEqual(['Read', 'Bash'])
    expect(seen.options.cwd).toBe(opts.cwd)
    expect(seen.options.model).toBe('claude-opus-4-8')
    expect(seen.options.systemPrompt).toBe('You are a tester.')
    expect(seen.options.outputFormat.type).toBe('json_schema')
  })

  it('writes every message to the transcript as jsonl', async () => {
    const opts = await base({
      query: fakeQuery([
        { type: 'assistant', text: 'one' },
        { type: 'result', subtype: 'success', structured_output: { passed: true }, total_cost_usd: 0 },
      ]),
    })
    await spawnAgent(opts as never)
    const lines = (await readFile(opts.transcriptPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).text).toBe('one')
  })

  // Review Focus #3: output that fails validation must produce a bounded death, not a loop
  it('is dead when structured output does not match the schema', async () => {
    const opts = await base({
      query: fakeQuery([
        { type: 'result', subtype: 'success', structured_output: { passed: 'yes' }, total_cost_usd: 0 },
      ]),
    })
    const out = await spawnAgent(opts as never)
    expect(out.status).toBe('dead')
    if (out.status === 'dead') expect(out.reason).toBe('invalid-output')
  })

  it('is dead when the stream ends with no result message', async () => {
    const opts = await base({ query: fakeQuery([{ type: 'assistant', text: 'hi' }]) })
    const out = await spawnAgent(opts as never)
    expect(out.status).toBe('dead')
    if (out.status === 'dead') expect(out.reason).toBe('invalid-output')
  })

  it('is dead when the SDK reports a failure subtype', async () => {
    const opts = await base({
      query: fakeQuery([{ type: 'result', subtype: 'error_max_structured_output_retries' }]),
    })
    const out = await spawnAgent(opts as never)
    expect(out.status).toBe('dead')
  })

  it('is dead with reason timeout when the agent exceeds its wall clock', async () => {
    const opts = await base({
      timeoutMs: 20,
      query: () => (async function* () {
        await new Promise(r => setTimeout(r, 200))
        yield { type: 'result', subtype: 'success', structured_output: { passed: true }, total_cost_usd: 0 } as never
      })(),
    })
    const out = await spawnAgent(opts as never)
    expect(out.status).toBe('dead')
    if (out.status === 'dead') expect(out.reason).toBe('timeout')
  })

  it('is dead when query throws', async () => {
    const opts = await base({
      query: () => (async function* () { throw new Error('boom') })(),
    })
    const out = await spawnAgent(opts as never)
    expect(out.status).toBe('dead')
    if (out.status === 'dead') expect(out.detail).toMatch(/boom/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/spawn.test.ts`
Expected: FAIL — cannot resolve `../src/agents/spawn.js`.

- [ ] **Step 3: Write src/agents/spawn.ts**

```typescript
import { mkdir, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { z } from 'zod'
import type { RoleDefinition } from './roles.js'

export type QueryFn = (args: {
  prompt: string
  options: Record<string, unknown>
}) => AsyncIterable<Record<string, unknown>>

export type AgentOutcome<T> =
  | { status: 'ok'; value: T; costUsd: number; agentId: string }
  | { status: 'dead'; reason: 'timeout' | 'invalid-output' | 'error'; detail: string; agentId: string }

export type SpawnOptions<T> = {
  role: RoleDefinition
  agentId: string
  prompt: string
  schema: z.ZodType<T>
  jsonSchema: Record<string, unknown>
  cwd: string
  transcriptPath: string
  timeoutMs: number
  query: QueryFn
}

export async function spawnAgent<T>(opts: SpawnOptions<T>): Promise<AgentOutcome<T>> {
  const { role, agentId, transcriptPath } = opts
  await mkdir(dirname(transcriptPath), { recursive: true })

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, opts.timeoutMs)

  let result: Record<string, unknown> | undefined

  try {
    const stream = opts.query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        model: role.model,
        systemPrompt: role.systemPrompt,
        allowedTools: role.tools,
        permissionMode: role.permissionMode,
        outputFormat: { type: 'json_schema', schema: opts.jsonSchema },
        abortController: controller,
      },
    })

    for await (const message of stream) {
      // Transcript is write-only: nothing reads this back into another prompt.
      await appendFile(transcriptPath, JSON.stringify(message) + '\n')
      if (message.type === 'result') result = message
    }
  } catch (err) {
    clearTimeout(timer)
    if (timedOut) {
      return { status: 'dead', reason: 'timeout', detail: `exceeded ${opts.timeoutMs}ms`, agentId }
    }
    return { status: 'dead', reason: 'error', detail: String(err), agentId }
  }
  clearTimeout(timer)

  if (timedOut) {
    return { status: 'dead', reason: 'timeout', detail: `exceeded ${opts.timeoutMs}ms`, agentId }
  }
  if (!result || result.subtype !== 'success') {
    return {
      status: 'dead',
      reason: 'invalid-output',
      detail: result ? `result subtype ${String(result.subtype)}` : 'stream ended with no result message',
      agentId,
    }
  }

  const parsed = opts.schema.safeParse(result.structured_output)
  if (!parsed.success) {
    return { status: 'dead', reason: 'invalid-output', detail: parsed.error.message, agentId }
  }

  return {
    status: 'ok',
    value: parsed.data,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0,
    agentId,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/spawn.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/spawn.ts tests/spawn.test.ts
git commit -m "feat: add spawnAgent, the single model-calling boundary"
```

---

### Task 5: Atomic state store

**Files:**
- Create: `src/state/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `runPaths` from `src/state/paths.js`; `Brief`, `CodebaseMap`, `Plan` from `src/schemas/index.js`
- Produces: `RunStateSchema`; `type RunState`; `type Stage = 'intake' | 'survey' | 'plan' | 'build' | 'integrate' | 'verify' | 'report' | 'done'`; `initState(args)`, `writeState(path, state)`, `readState(path)`, `newRunId(seq)`

`state.json` is the single source of truth (spec I5). It is written to a temp file and renamed, so a crash mid-write leaves the previous valid state rather than a truncated file.

`newRunId` takes a sequence number rather than reading the clock, so run IDs are deterministic in tests. The caller supplies the timestamp.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initState, writeState, readState, newRunId } from '../src/state/store.js'

async function tmp() { return mkdtemp(join(tmpdir(), 'sy-store-')) }

describe('newRunId', () => {
  it('is stable for the same inputs', () => {
    expect(newRunId('2026-10-01T12-00-00', 1)).toBe('2026-10-01T12-00-00-001')
    expect(newRunId('2026-10-01T12-00-00', 12)).toBe('2026-10-01T12-00-00-012')
  })
})

describe('state store', () => {
  it('round-trips a state through disk', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    const s = initState({ runId: 'r1', target: '/t', idea: 'build a thing', createdAt: 'now' })
    await writeState(path, s)
    const back = await readState(path)
    expect(back.runId).toBe('r1')
    expect(back.stage).toBe('intake')
    expect(back.cycle).toBe(1)
  })

  it('leaves no temp files behind', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    await writeState(path, initState({ runId: 'r1', target: '/t', idea: 'i', createdAt: 'now' }))
    const files = await readdir(dir)
    expect(files).toEqual(['state.json'])
  })

  // Review Focus #5: a crash mid-write must not leave a half-applied state
  it('preserves the previous state when a later write is interrupted', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    const first = initState({ runId: 'r1', target: '/t', idea: 'i', createdAt: 'now' })
    await writeState(path, first)
    // Simulate an interrupted write: a stray temp file, no rename
    await writeFile(path + '.tmp', '{ truncated')
    const back = await readState(path)
    expect(back.stage).toBe('intake')
    expect(back.runId).toBe('r1')
  })

  it('advances stage and records cost', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    const s = initState({ runId: 'r1', target: '/t', idea: 'i', createdAt: 'now' })
    s.stage = 'plan'
    s.totalCostUsd = 1.5
    s.completedStages.push('intake', 'survey')
    await writeState(path, s)
    const back = await readState(path)
    expect(back.stage).toBe('plan')
    expect(back.totalCostUsd).toBe(1.5)
    expect(back.completedStages).toEqual(['intake', 'survey'])
  })

  it('rejects a state file that does not match the schema', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({ runId: 'r1' }))
    await expect(readState(path)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot resolve `../src/state/store.js`.

- [ ] **Step 3: Write src/state/store.ts**

```typescript
import { writeFile, readFile, rename } from 'node:fs/promises'
import { z } from 'zod'

export const StageSchema = z.enum([
  'intake', 'survey', 'plan', 'build', 'integrate', 'verify', 'report', 'done',
])
export type Stage = z.infer<typeof StageSchema>

export const RunStateSchema = z.object({
  runId: z.string().min(1),
  target: z.string().min(1),
  idea: z.string().min(1),
  createdAt: z.string(),
  stage: StageSchema,
  completedStages: z.array(StageSchema),
  cycle: z.number().int().min(1),
  maxCycles: z.number().int().min(1),
  totalCostUsd: z.number().min(0),
  deaths: z.array(z.object({ agentId: z.string(), reason: z.string(), detail: z.string() })),
  verdict: z.enum(['pending', 'shipped', 'partial', 'failed']),
})
export type RunState = z.infer<typeof RunStateSchema>

export function newRunId(timestamp: string, seq: number): string {
  return `${timestamp}-${String(seq).padStart(3, '0')}`
}

export function initState(args: {
  runId: string; target: string; idea: string; createdAt: string; maxCycles?: number
}): RunState {
  return {
    runId: args.runId,
    target: args.target,
    idea: args.idea,
    createdAt: args.createdAt,
    stage: 'intake',
    completedStages: [],
    cycle: 1,
    maxCycles: args.maxCycles ?? 3,
    totalCostUsd: 0,
    deaths: [],
    verdict: 'pending',
  }
}

export async function writeState(path: string, state: RunState): Promise<void> {
  RunStateSchema.parse(state)
  const tmp = `${path}.writing`
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, path)
}

export async function readState(path: string): Promise<RunState> {
  return RunStateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state/store.ts tests/store.test.ts
git commit -m "feat: add atomically-written run state store"
```

---

### Task 6: Deterministic digest generator

**Files:**
- Create: `src/digest/digest.ts`
- Test: `tests/digest.test.ts`

**Interfaces:**
- Consumes: `RunState` from `src/state/store.js`; `Brief`, `Plan` from `src/schemas/index.js`
- Produces: `DIGEST_CAP`; `buildDigest(input: DigestInput): string` where `DigestInput = { state: RunState; brief: Brief; plan?: Plan; criteriaStatus?: Record<string, 'pass' | 'fail' | 'untested'>; taskStatus?: Record<string, 'done' | 'running' | 'blocked' | 'todo'>; learnings?: string }`

This is the "rundown" a fresh manager reads (spec §6.2). It is generated by code from state, so it costs no tokens to maintain and cannot be stale. It is **never** stored — always derived at spawn time.

Truncation order when over `DIGEST_CAP`: completed-task detail is dropped first, then the codebase summary, then older learnings. Open defects and failing criteria are dropped last because they are what the manager most needs. Any truncation is recorded in the digest itself so the manager knows it is reading a partial picture.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { buildDigest, DIGEST_CAP } from '../src/digest/digest.js'
import { initState } from '../src/state/store.js'
import type { Brief, Plan } from '../src/schemas/index.js'

const brief: Brief = {
  goal: 'Build a CSV to JSON converter',
  stack: ['typescript'],
  constraints: ['no deps'],
  assumptions: ['UTF-8 input'],
  acceptanceCriteria: [
    { id: 'AC1', statement: 'converts a simple file', verifiable: true },
    { id: 'AC2', statement: 'handles quoted commas', verifiable: true },
  ],
  risks: [],
}

const state = initState({ runId: 'r1', target: '/t', idea: 'csv to json', createdAt: 'now' })

describe('buildDigest', () => {
  it('states the goal', () => {
    expect(buildDigest({ state, brief })).toContain('Build a CSV to JSON converter')
  })

  it('lists every criterion with its status', () => {
    const d = buildDigest({ state, brief, criteriaStatus: { AC1: 'pass', AC2: 'fail' } })
    expect(d).toMatch(/AC1.*pass/)
    expect(d).toMatch(/AC2.*fail/)
  })

  it('marks criteria with no recorded status as untested', () => {
    expect(buildDigest({ state, brief })).toMatch(/AC1.*untested/)
  })

  it('is deterministic for identical input', () => {
    const a = buildDigest({ state, brief })
    const b = buildDigest({ state, brief })
    expect(a).toBe(b)
  })

  it('includes learnings when present', () => {
    const d = buildDigest({ state, brief, learnings: 'Tried a regex parser; it failed on quotes.' })
    expect(d).toContain('regex parser')
  })

  it('reports the current cycle out of the maximum', () => {
    expect(buildDigest({ state, brief })).toContain('cycle 1 of 3')
  })

  it('stays within the cap and says so when it truncates', () => {
    const huge: Plan = {
      summary: 'x'.repeat(200),
      tasks: Array.from({ length: 400 }, (_, i) => ({
        id: `T${i}`, goal: 'g'.repeat(120), dependsOn: [], ownsFiles: [`f${i}.ts`], criteriaIds: ['AC1'],
      })),
    }
    const taskStatus = Object.fromEntries(huge.tasks.map(t => [t.id, 'done' as const]))
    const d = buildDigest({ state, brief, plan: huge, taskStatus })
    expect(d.length).toBeLessThanOrEqual(DIGEST_CAP)
    expect(d).toMatch(/truncated/i)
  })

  it('keeps failing criteria even when it has to truncate', () => {
    const huge: Plan = {
      summary: 'x',
      tasks: Array.from({ length: 400 }, (_, i) => ({
        id: `T${i}`, goal: 'g'.repeat(120), dependsOn: [], ownsFiles: [`f${i}.ts`], criteriaIds: ['AC1'],
      })),
    }
    const d = buildDigest({
      state, brief, plan: huge,
      taskStatus: Object.fromEntries(huge.tasks.map(t => [t.id, 'done' as const])),
      criteriaStatus: { AC1: 'fail', AC2: 'fail' },
    })
    expect(d).toMatch(/AC1.*fail/)
    expect(d).toMatch(/AC2.*fail/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/digest.test.ts`
Expected: FAIL — cannot resolve `../src/digest/digest.js`.

- [ ] **Step 3: Write src/digest/digest.ts**

```typescript
import type { RunState } from '../state/store.js'
import type { Brief, Plan } from '../schemas/index.js'

export const DIGEST_CAP = 8000

export type DigestInput = {
  state: RunState
  brief: Brief
  plan?: Plan
  criteriaStatus?: Record<string, 'pass' | 'fail' | 'untested'>
  taskStatus?: Record<string, 'done' | 'running' | 'blocked' | 'todo'>
  learnings?: string
}

/** Sections in drop order: the first entry is discarded first when over cap. */
function sections(input: DigestInput): Array<{ droppable: boolean; text: string }> {
  const { state, brief, plan, criteriaStatus = {}, taskStatus = {}, learnings } = input

  const criteria = brief.acceptanceCriteria
    .map(c => `  - ${c.id} [${criteriaStatus[c.id] ?? 'untested'}] ${c.statement}`)
    .join('\n')

  const byStatus = (s: string) =>
    (plan?.tasks ?? []).filter(t => (taskStatus[t.id] ?? 'todo') === s)

  const doneDetail = byStatus('done').map(t => `  - ${t.id} ${t.goal}`).join('\n')
  const openDetail = [...byStatus('running'), ...byStatus('blocked'), ...byStatus('todo')]
    .map(t => `  - ${t.id} [${taskStatus[t.id] ?? 'todo'}] ${t.goal}`)
    .join('\n')

  return [
    // dropped first
    { droppable: true, text: doneDetail ? `COMPLETED TASKS\n${doneDetail}` : '' },
    { droppable: true, text: plan?.summary ? `PLAN SUMMARY\n  ${plan.summary}` : '' },
    { droppable: true, text: learnings ? `ALREADY TRIED AND FAILED\n${learnings}` : '' },
    // never dropped
    { droppable: false, text: `GOAL\n  ${brief.goal}` },
    { droppable: false, text: `PROGRESS\n  cycle ${state.cycle} of ${state.maxCycles}` },
    { droppable: false, text: `ACCEPTANCE CRITERIA\n${criteria}` },
    { droppable: false, text: openDetail ? `OPEN TASKS\n${openDetail}` : '' },
  ]
}

export function buildDigest(input: DigestInput): string {
  const all = sections(input).filter(s => s.text.length > 0)
  const render = (parts: typeof all) => parts.map(p => p.text).join('\n\n')

  // Keep non-droppable sections in their declared order; drop droppables front-first.
  let kept = all
  let out = render(kept)
  let dropped = 0
  while (out.length > DIGEST_CAP && kept.some(s => s.droppable)) {
    const idx = kept.findIndex(s => s.droppable)
    kept = [...kept.slice(0, idx), ...kept.slice(idx + 1)]
    dropped++
    out = render(kept)
  }

  if (dropped > 0) {
    out = `NOTE: ${dropped} section(s) truncated to fit the digest cap; this is a partial picture.\n\n${out}`
  }
  return out.length > DIGEST_CAP ? out.slice(0, DIGEST_CAP) : out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/digest.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/digest/digest.ts tests/digest.test.ts
git commit -m "feat: generate the manager rundown deterministically from state"
```

---

### Task 7: Intake stage

**Files:**
- Create: `src/prompts/intake.ts`
- Create: `src/stages/intake.ts`
- Modify: `package.json` (add `zod-to-json-schema`)
- Test: `tests/intake.test.ts`

**Interfaces:**
- Consumes: `spawnAgent`, `AgentOutcome` from `src/agents/spawn.js`; `loadRole` from `src/agents/roles.js`; `BriefSchema`, `Brief` from `src/schemas/index.js`
- Produces: `buildIntakePrompt(args: { idea: string; projectReport: string | null }): string`; `runIntake(deps): Promise<{ brief: Brief; costUsd: number } | { dead: string }>`

`zod-to-json-schema` (MIT) converts each Zod schema into the JSON Schema that `outputFormat` requires, so the shape is defined once rather than maintained twice.

Intake reads `<target>/.shipyard/PROJECT-REPORT.md` when it exists (spec §3.2) — this is the only artifact that crosses a run boundary.

- [ ] **Step 1: Add the dependency**

Run: `npm install zod-to-json-schema@^3.23.5`
Expected: added to `dependencies`. License: MIT.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { buildIntakePrompt } from '../src/prompts/intake.js'
import { runIntake } from '../src/stages/intake.js'
import type { RoleDefinition } from '../src/agents/roles.js'

const role: RoleDefinition = {
  name: 'intake', model: 'claude-opus-4-8', tools: ['Read'],
  permissionMode: 'default', delegatesTo: [], systemPrompt: 'intake',
}

const goodBrief = {
  goal: 'g', stack: [], constraints: [], assumptions: [],
  acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: true }], risks: [],
}

describe('buildIntakePrompt', () => {
  it('includes the idea', () => {
    expect(buildIntakePrompt({ idea: 'build a parser', projectReport: null })).toContain('build a parser')
  })

  it('includes the project report when one exists', () => {
    const p = buildIntakePrompt({ idea: 'x', projectReport: '## Run 1\nFailed: parser approach' })
    expect(p).toContain('parser approach')
    expect(p).toMatch(/previous runs/i)
  })

  it('omits the prior-runs section entirely on a fresh target', () => {
    expect(buildIntakePrompt({ idea: 'x', projectReport: null })).not.toMatch(/previous runs/i)
  })
})

describe('runIntake', () => {
  it('returns the validated brief', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null, role,
      spawn: async () => ({ status: 'ok', value: goodBrief, costUsd: 0.5, agentId: 'a1' }),
    })
    expect('brief' in r && r.brief.goal).toBe('g')
    expect('costUsd' in r && r.costUsd).toBe(0.5)
  })

  it('surfaces a dead agent rather than throwing', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null, role,
      spawn: async () => ({ status: 'dead', reason: 'timeout', detail: 'slow', agentId: 'a1' }),
    })
    expect('dead' in r).toBe(true)
  })

  // Review Focus #2: schema-valid but semantically empty output must not pass
  it('rejects a brief whose criteria are all unverifiable', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null, role,
      spawn: async () => ({
        status: 'ok', agentId: 'a1', costUsd: 0,
        value: { ...goodBrief, acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: false }] },
      }),
    })
    expect('dead' in r && r.dead).toMatch(/verifiable/i)
  })

  it('rejects duplicate criterion ids', async () => {
    const r = await runIntake({
      idea: 'x', projectReport: null, role,
      spawn: async () => ({
        status: 'ok', agentId: 'a1', costUsd: 0,
        value: { ...goodBrief, acceptanceCriteria: [
          { id: 'AC1', statement: 'a', verifiable: true },
          { id: 'AC1', statement: 'b', verifiable: true },
        ] },
      }),
    })
    expect('dead' in r && r.dead).toMatch(/duplicate/i)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/intake.test.ts`
Expected: FAIL — cannot resolve `../src/prompts/intake.js`.

- [ ] **Step 4: Write src/prompts/intake.ts**

```typescript
export function buildIntakePrompt(args: { idea: string; projectReport: string | null }): string {
  const parts = [
    'Turn the following idea into an explicit contract.',
    '',
    'IDEA',
    args.idea,
  ]

  if (args.projectReport) {
    parts.push(
      '',
      'HISTORY OF PREVIOUS RUNS AGAINST THIS TARGET',
      'Do not re-attempt an approach recorded here as failed. Build on what already exists.',
      args.projectReport,
    )
  }

  parts.push(
    '',
    'Produce acceptance criteria specific enough that a tester can return pass or fail',
    'without judgement. Record anything you were not told as an assumption.',
  )
  return parts.join('\n')
}
```

- [ ] **Step 5: Write src/stages/intake.ts**

```typescript
import { zodToJsonSchema } from 'zod-to-json-schema'
import { BriefSchema, type Brief } from '../schemas/index.js'
import type { AgentOutcome } from '../agents/spawn.js'
import type { RoleDefinition } from '../agents/roles.js'
import { buildIntakePrompt } from '../prompts/intake.js'

export type IntakeDeps = {
  idea: string
  projectReport: string | null
  role: RoleDefinition
  spawn: (args: { prompt: string; jsonSchema: Record<string, unknown> }) => Promise<AgentOutcome<Brief>>
}

export type IntakeResult = { brief: Brief; costUsd: number } | { dead: string }

export async function runIntake(deps: IntakeDeps): Promise<IntakeResult> {
  const prompt = buildIntakePrompt({ idea: deps.idea, projectReport: deps.projectReport })
  const jsonSchema = zodToJsonSchema(BriefSchema) as Record<string, unknown>

  const outcome = await deps.spawn({ prompt, jsonSchema })
  if (outcome.status === 'dead') {
    return { dead: `intake agent died (${outcome.reason}): ${outcome.detail}` }
  }

  const brief = outcome.value

  // A brief whose criteria cannot be checked makes every downstream stage meaningless.
  if (!brief.acceptanceCriteria.some(c => c.verifiable)) {
    return { dead: 'intake produced no verifiable acceptance criteria' }
  }

  const ids = brief.acceptanceCriteria.map(c => c.id)
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (duplicates.length > 0) {
    return { dead: `intake produced duplicate criterion ids: ${[...new Set(duplicates)].join(', ')}` }
  }

  return { brief, costUsd: outcome.costUsd }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/intake.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/prompts/intake.ts src/stages/intake.ts tests/intake.test.ts
git commit -m "feat: add intake stage with project-report continuity"
```

---

### Task 8: Survey stage

**Files:**
- Create: `src/prompts/survey.ts`
- Create: `src/stages/survey.ts`
- Test: `tests/survey.test.ts`

**Interfaces:**
- Consumes: `AgentOutcome` from `src/agents/spawn.js`; `CodebaseMapSchema`, `CodebaseMap`, `Brief` from `src/schemas/index.js`
- Produces: `SURVEY_CONCERNS: readonly SurveyConcern[]` where `SurveyConcern = { id: string; prompt: string }`; `isEmptyTarget(target: string): Promise<boolean>`; `runSurvey(deps): Promise<{ map: CodebaseMap; costUsd: number } | { dead: string }>`

Five read-only surveyors run in parallel, split by concern so survey cost does not scale with repository size (spec §3.3). Their outputs merge into one `codebase-map.json`.

Survey is skipped entirely when the target is empty.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SURVEY_CONCERNS, isEmptyTarget, runSurvey } from '../src/stages/survey.js'
import type { RoleDefinition } from '../src/agents/roles.js'

const role: RoleDefinition = {
  name: 'surveyor', model: 'claude-opus-4-8', tools: ['Read'],
  permissionMode: 'default', delegatesTo: [], systemPrompt: 'surveyor',
}

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
  it('spawns one agent per concern and merges their output', async () => {
    const seen: string[] = []
    const r = await runSurvey({
      brief, role,
      spawn: async ({ concernId }) => {
        seen.push(concernId)
        return {
          status: 'ok', agentId: concernId, costUsd: 1,
          value: {
            structure: concernId === 'structure' ? 'src/' : '',
            language: concernId === 'structure' ? 'typescript' : '',
            framework: null,
            testCommand: concernId === 'tests' ? 'npm test' : null,
            conventions: concernId === 'conventions' ? ['tabs'] : [],
            relevantModules: [],
          },
        }
      },
    })
    expect(seen.sort()).toEqual(SURVEY_CONCERNS.map(c => c.id).sort())
    expect('map' in r && r.map.language).toBe('typescript')
    expect('map' in r && r.map.testCommand).toBe('npm test')
    expect('costUsd' in r && r.costUsd).toBe(5)
  })

  it('fails the stage when any surveyor dies', async () => {
    const r = await runSurvey({
      brief, role,
      spawn: async ({ concernId }) =>
        concernId === 'tests'
          ? { status: 'dead', reason: 'timeout', detail: 'slow', agentId: concernId }
          : {
              status: 'ok', agentId: concernId, costUsd: 0,
              value: { structure: '', language: '', framework: null, testCommand: null, conventions: [], relevantModules: [] },
            },
    })
    expect('dead' in r && r.dead).toMatch(/tests/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/survey.test.ts`
Expected: FAIL — cannot resolve `../src/stages/survey.js`.

- [ ] **Step 3: Write src/prompts/survey.ts**

```typescript
import type { Brief } from '../schemas/index.js'

export function buildSurveyPrompt(args: { brief: Brief; concernPrompt: string }): string {
  return [
    'You are surveying an existing repository. Cover ONLY the concern below.',
    '',
    'CONCERN',
    args.concernPrompt,
    '',
    'THE WORK THIS SURVEY SUPPORTS',
    args.brief.goal,
    '',
    'Report what you actually found. If something is absent, say it is absent.',
    'Leave fields outside your concern empty rather than guessing at them.',
  ].join('\n')
}
```

- [ ] **Step 4: Write src/stages/survey.ts**

```typescript
import { readdir } from 'node:fs/promises'
import type { CodebaseMap, Brief } from '../schemas/index.js'
import type { AgentOutcome } from '../agents/spawn.js'
import type { RoleDefinition } from '../agents/roles.js'

export type SurveyConcern = { id: string; prompt: string }

export const SURVEY_CONCERNS: readonly SurveyConcern[] = [
  { id: 'structure', prompt: 'Directory layout, language, framework, build system. Fill structure, language, framework.' },
  { id: 'tests', prompt: 'Test runner, the exact command used to run tests, coverage conventions. Fill testCommand.' },
  { id: 'conventions', prompt: 'Naming, error handling, module patterns, lint rules. Fill conventions.' },
  { id: 'documentation', prompt: 'README, docs/, CONTRIBUTING, architecture notes. Report stated intent, invariants, and rejected approaches. Fill conventions with what the docs require.' },
  { id: 'relevant', prompt: 'The modules the stated goal actually touches. Fill relevantModules.' },
]

const IGNORED = new Set(['.git', '.shipyard', '.DS_Store'])

export async function isEmptyTarget(target: string): Promise<boolean> {
  const entries = await readdir(target)
  return entries.filter(e => !IGNORED.has(e)).length === 0
}

export type SurveyDeps = {
  brief: Brief
  role: RoleDefinition
  spawn: (args: { concernId: string; concernPrompt: string }) => Promise<AgentOutcome<CodebaseMap>>
}

export type SurveyResult = { map: CodebaseMap; costUsd: number } | { dead: string }

export async function runSurvey(deps: SurveyDeps): Promise<SurveyResult> {
  const outcomes = await Promise.all(
    SURVEY_CONCERNS.map(c => deps.spawn({ concernId: c.id, concernPrompt: c.prompt })),
  )

  const dead = outcomes.filter(o => o.status === 'dead')
  if (dead.length > 0) {
    const detail = dead.map(d => `${d.agentId} (${d.reason})`).join(', ')
    return { dead: `survey agents died: ${detail}` }
  }

  const maps = outcomes.map(o => (o as Extract<typeof o, { status: 'ok' }>).value)
  const costUsd = outcomes.reduce((sum, o) => sum + (o.status === 'ok' ? o.costUsd : 0), 0)

  // Each surveyor fills only its own fields; first non-empty value wins.
  const merged: CodebaseMap = {
    structure: maps.map(m => m.structure).find(v => v) ?? '',
    language: maps.map(m => m.language).find(v => v) ?? '',
    framework: maps.map(m => m.framework).find(v => v) ?? null,
    testCommand: maps.map(m => m.testCommand).find(v => v) ?? null,
    conventions: maps.flatMap(m => m.conventions),
    relevantModules: maps.flatMap(m => m.relevantModules),
  }

  return { map: merged, costUsd }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/survey.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/survey.ts src/stages/survey.ts tests/survey.test.ts
git commit -m "feat: add survey stage with five parallel concern agents"
```

---

### Task 9: Plan stage with file-ownership validation

**Files:**
- Create: `src/prompts/plan.ts`
- Create: `src/stages/plan.ts`
- Test: `tests/plan.test.ts`

**Interfaces:**
- Consumes: `AgentOutcome` from `src/agents/spawn.js`; `Plan`, `PlanTask`, `Brief`, `CodebaseMap` from `src/schemas/index.js`; `buildDigest` from `src/digest/digest.js`
- Produces: `validatePlan(plan: Plan, criterionIds: string[]): string[]`; `runPlan(deps): Promise<{ plan: Plan; spec: string; costUsd: number } | { dead: string }>`

Two tasks conflict only if they could run **at the same time** — that is, neither is a transitive dependency of the other. Two tasks that share a file are fine when one depends on the other, because they run in sequence.

`validatePlan` returns a list of human-readable problems. A non-empty list is fed back to the manager as a re-prompt, up to `maxAttempts`, before the stage is declared dead.

The manager returns both the plan and its spec page (spec §3.4) in one structured response.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { validatePlan, runPlan } from '../src/stages/plan.js'
import type { Plan } from '../src/schemas/index.js'
import type { RoleDefinition } from '../src/agents/roles.js'

const role: RoleDefinition = {
  name: 'manager', model: 'claude-opus-4-8', tools: ['Read'],
  permissionMode: 'default', delegatesTo: ['dev'], systemPrompt: 'manager',
}

const brief = {
  goal: 'g', stack: [], constraints: [], assumptions: [],
  acceptanceCriteria: [{ id: 'AC1', statement: 's', verifiable: true }], risks: [],
}

const map = {
  structure: '', language: 'ts', framework: null, testCommand: null,
  conventions: [], relevantModules: [],
}

const ok: Plan = {
  summary: 's',
  tasks: [
    { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
    { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['b.ts'], criteriaIds: ['AC1'] },
  ],
}

describe('validatePlan', () => {
  it('accepts disjoint file ownership', () => {
    expect(validatePlan(ok, ['AC1'])).toEqual([])
  })

  // Review Focus #4: concurrently-runnable tasks must never share a file
  it('rejects two independent tasks owning the same file', () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
    ] }
    const problems = validatePlan(bad, ['AC1'])
    expect(problems.join(' ')).toMatch(/same\.ts/)
    expect(problems.join(' ')).toMatch(/T1.*T2|T2.*T1/)
  })

  it('allows a shared file when one task depends on the other', () => {
    const seq: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: ['T1'], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(seq, ['AC1'])).toEqual([])
  })

  it('allows a shared file across a transitive dependency chain', () => {
    const chain: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: ['T1'], ownsFiles: ['x.ts'], criteriaIds: ['AC1'] },
      { id: 'T3', goal: 'c', dependsOn: ['T2'], ownsFiles: ['same.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(chain, ['AC1'])).toEqual([])
  })

  it('rejects a dependency on an unknown task', () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: ['NOPE'], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(bad, ['AC1']).join(' ')).toMatch(/NOPE/)
  })

  it('rejects a dependency cycle', () => {
    const cyc: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: ['T2'], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: ['T1'], ownsFiles: ['b.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(cyc, ['AC1']).join(' ')).toMatch(/cycle/i)
  })

  it('rejects duplicate task ids', () => {
    const dup: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['a.ts'], criteriaIds: ['AC1'] },
      { id: 'T1', goal: 'b', dependsOn: [], ownsFiles: ['b.ts'], criteriaIds: ['AC1'] },
    ] }
    expect(validatePlan(dup, ['AC1']).join(' ')).toMatch(/duplicate/i)
  })

  it('rejects a reference to an unknown acceptance criterion', () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['a.ts'], criteriaIds: ['AC9'] },
    ] }
    expect(validatePlan(bad, ['AC1']).join(' ')).toMatch(/AC9/)
  })

  it('rejects a plan that leaves a criterion unserved', () => {
    expect(validatePlan(ok, ['AC1', 'AC2']).join(' ')).toMatch(/AC2/)
  })
})

describe('runPlan', () => {
  it('returns a valid plan and its spec page', async () => {
    const r = await runPlan({
      brief, map, digest: 'd', role, maxAttempts: 2,
      spawn: async () => ({ status: 'ok', agentId: 'm1', costUsd: 2, value: { plan: ok, spec: '# Spec' } }),
    })
    expect('plan' in r && r.plan.tasks).toHaveLength(2)
    expect('spec' in r && r.spec).toBe('# Spec')
  })

  it('re-prompts the manager with the specific problem and accepts the retry', async () => {
    const prompts: string[] = []
    let call = 0
    const r = await runPlan({
      brief, map, digest: 'd', role, maxAttempts: 2,
      spawn: async ({ prompt }) => {
        prompts.push(prompt)
        call++
        const plan: Plan = call === 1
          ? { summary: 's', tasks: [
              { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['dup.ts'], criteriaIds: ['AC1'] },
              { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['dup.ts'], criteriaIds: ['AC1'] },
            ] }
          : ok
        return { status: 'ok', agentId: `m${call}`, costUsd: 1, value: { plan, spec: 's' } }
      },
    })
    expect('plan' in r).toBe(true)
    expect(prompts[1]).toMatch(/dup\.ts/)
    expect('costUsd' in r && r.costUsd).toBe(2)
  })

  it('dies after maxAttempts of invalid plans', async () => {
    const bad: Plan = { summary: 's', tasks: [
      { id: 'T1', goal: 'a', dependsOn: [], ownsFiles: ['x.ts'], criteriaIds: ['AC1'] },
      { id: 'T2', goal: 'b', dependsOn: [], ownsFiles: ['x.ts'], criteriaIds: ['AC1'] },
    ] }
    const r = await runPlan({
      brief, map, digest: 'd', role, maxAttempts: 2,
      spawn: async () => ({ status: 'ok', agentId: 'm', costUsd: 0, value: { plan: bad, spec: 's' } }),
    })
    expect('dead' in r && r.dead).toMatch(/2 attempts/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/plan.test.ts`
Expected: FAIL — cannot resolve `../src/stages/plan.js`.

- [ ] **Step 3: Write src/prompts/plan.ts**

```typescript
import type { Brief, CodebaseMap } from '../schemas/index.js'

export function buildPlanPrompt(args: {
  brief: Brief
  map: CodebaseMap
  digest: string
  problems: string[]
}): string {
  const parts = [
    'Decompose the goal below into a task DAG, and write a spec page explaining your approach.',
    '',
    'DIGEST',
    args.digest,
    '',
    'GOAL',
    args.brief.goal,
    '',
    'ACCEPTANCE CRITERIA',
    ...args.brief.acceptanceCriteria.map(c => `  ${c.id}: ${c.statement}`),
    '',
    'CODEBASE',
    `  language: ${args.map.language || 'unknown'}`,
    `  test command: ${args.map.testCommand ?? 'none found'}`,
    `  conventions: ${args.map.conventions.join('; ') || 'none recorded'}`,
    '',
    'RULES',
    '  Every acceptance criterion must be served by at least one task.',
    '  Two tasks that can run at the same time must NOT list the same file.',
    '  If two pieces of work need the same file, make one depend on the other.',
  ]

  if (args.problems.length > 0) {
    parts.push(
      '',
      'YOUR PREVIOUS PLAN WAS REJECTED. Fix exactly these problems:',
      ...args.problems.map(p => `  - ${p}`),
    )
  }
  return parts.join('\n')
}
```

- [ ] **Step 4: Write src/stages/plan.ts**

```typescript
import type { Plan, Brief, CodebaseMap } from '../schemas/index.js'
import type { AgentOutcome } from '../agents/spawn.js'
import type { RoleDefinition } from '../agents/roles.js'
import { buildPlanPrompt } from '../prompts/plan.js'

/** Transitive dependency closure for one task. */
function ancestors(plan: Plan, id: string, seen = new Set<string>()): Set<string> {
  const task = plan.tasks.find(t => t.id === id)
  if (!task) return seen
  for (const dep of task.dependsOn) {
    if (seen.has(dep)) continue
    seen.add(dep)
    ancestors(plan, dep, seen)
  }
  return seen
}

function hasCycle(plan: Plan): boolean {
  return plan.tasks.some(t => ancestors(plan, t.id).has(t.id))
}

export function validatePlan(plan: Plan, criterionIds: string[]): string[] {
  const problems: string[] = []
  const ids = plan.tasks.map(t => t.id)

  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (duplicates.length > 0) problems.push(`duplicate task ids: ${duplicates.join(', ')}`)

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.includes(dep)) problems.push(`task ${task.id} depends on unknown task ${dep}`)
    }
    for (const cid of task.criteriaIds) {
      if (!criterionIds.includes(cid)) problems.push(`task ${task.id} references unknown criterion ${cid}`)
    }
  }

  if (hasCycle(plan)) {
    problems.push('the task graph contains a dependency cycle')
    return problems // ancestor checks below are meaningless on a cyclic graph
  }

  for (const cid of criterionIds) {
    if (!plan.tasks.some(t => t.criteriaIds.includes(cid))) {
      problems.push(`no task serves acceptance criterion ${cid}`)
    }
  }

  // Only tasks that could run concurrently can collide.
  for (let i = 0; i < plan.tasks.length; i++) {
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i]!
      const b = plan.tasks[j]!
      const ordered = ancestors(plan, a.id).has(b.id) || ancestors(plan, b.id).has(a.id)
      if (ordered) continue
      const shared = a.ownsFiles.filter(f => b.ownsFiles.includes(f))
      if (shared.length > 0) {
        problems.push(
          `tasks ${a.id} and ${b.id} can run concurrently but both own: ${shared.join(', ')}`,
        )
      }
    }
  }

  return problems
}

export type PlanDeps = {
  brief: Brief
  map: CodebaseMap
  digest: string
  role: RoleDefinition
  maxAttempts: number
  spawn: (args: { prompt: string }) => Promise<AgentOutcome<{ plan: Plan; spec: string }>>
}

export type PlanResult = { plan: Plan; spec: string; costUsd: number } | { dead: string }

export async function runPlan(deps: PlanDeps): Promise<PlanResult> {
  const criterionIds = deps.brief.acceptanceCriteria.map(c => c.id)
  let problems: string[] = []
  let costUsd = 0

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    const prompt = buildPlanPrompt({ brief: deps.brief, map: deps.map, digest: deps.digest, problems })
    const outcome = await deps.spawn({ prompt })

    if (outcome.status === 'dead') {
      return { dead: `manager died during planning (${outcome.reason}): ${outcome.detail}` }
    }
    costUsd += outcome.costUsd

    problems = validatePlan(outcome.value.plan, criterionIds)
    if (problems.length === 0) {
      return { plan: outcome.value.plan, spec: outcome.value.spec, costUsd }
    }
  }

  return {
    dead: `manager produced an invalid plan after ${deps.maxAttempts} attempts: ${problems.join('; ')}`,
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/plan.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/plan.ts src/stages/plan.ts tests/plan.test.ts
git commit -m "feat: add plan stage with DAG-aware file ownership validation"
```

---

### Task 10: Stage machine with resume

**Files:**
- Create: `src/harbormaster/run.ts`
- Test: `tests/run.test.ts`

**Interfaces:**
- Consumes: `runPaths`, `assertGitRepo` from `src/state/paths.js`; `initState`, `writeState`, `readState`, `RunState` from `src/state/store.js`; `runIntake`, `runSurvey`, `isEmptyTarget`, `runPlan` from the stage modules
- Produces: `runThroughPlan(deps: RunDeps): Promise<RunOutcome>` where `RunOutcome = { ok: true; state: RunState; planPath: string } | { ok: false; state: RunState; reason: string }`

Walks intake → survey → plan, writing each artifact and advancing `state.json` after every transition. A stage whose output already exists on disk is skipped on resume (spec §7.3), so an interrupted run does not repeat completed work or pay for it twice.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/run.test.ts`
Expected: FAIL — cannot resolve `../src/harbormaster/run.js`.

- [ ] **Step 3: Write src/harbormaster/run.ts**

```typescript
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runPaths, assertGitRepo } from '../state/paths.js'
import { initState, writeState, type RunState } from '../state/store.js'
import { isEmptyTarget } from '../stages/survey.js'
import { BriefSchema, CodebaseMapSchema, PlanSchema, type Brief, type CodebaseMap, type Plan } from '../schemas/index.js'

export type RunDeps = {
  target: string
  idea: string
  runId: string
  createdAt: string
  intake: () => Promise<{ brief: Brief; costUsd: number } | { dead: string }>
  survey: (brief: Brief) => Promise<{ map: CodebaseMap; costUsd: number } | { dead: string }>
  plan: (brief: Brief, map: CodebaseMap) => Promise<{ plan: Plan; spec: string; costUsd: number } | { dead: string }>
}

export type RunOutcome =
  | { ok: true; state: RunState; planPath: string }
  | { ok: false; state: RunState; reason: string }

async function readIfPresent<T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

const EMPTY_MAP: CodebaseMap = {
  structure: '', language: '', framework: null, testCommand: null, conventions: [], relevantModules: [],
}

export async function runThroughPlan(deps: RunDeps): Promise<RunOutcome> {
  await assertGitRepo(deps.target)

  const paths = runPaths(deps.target, deps.runId)
  await mkdir(paths.agentsDir, { recursive: true })
  await mkdir(paths.cycleDir(1), { recursive: true })

  const state = initState({
    runId: deps.runId, target: deps.target, idea: deps.idea, createdAt: deps.createdAt,
  })

  const fail = async (reason: string): Promise<RunOutcome> => {
    state.verdict = 'failed'
    await writeState(paths.state, state)
    return { ok: false, state, reason }
  }

  // --- intake ---
  state.stage = 'intake'
  await writeState(paths.state, state)
  let brief = await readIfPresent(paths.brief, BriefSchema)
  if (!brief) {
    const r = await deps.intake()
    if ('dead' in r) return fail(r.dead)
    brief = r.brief
    state.totalCostUsd += r.costUsd
    await writeFile(paths.brief, JSON.stringify(brief, null, 2))
  }
  state.completedStages.push('intake')

  // --- survey ---
  state.stage = 'survey'
  await writeState(paths.state, state)
  let map = await readIfPresent(paths.codebaseMap, CodebaseMapSchema)
  if (!map) {
    if (await isEmptyTarget(deps.target)) {
      map = EMPTY_MAP
    } else {
      const r = await deps.survey(brief)
      if ('dead' in r) return fail(r.dead)
      map = r.map
      state.totalCostUsd += r.costUsd
    }
    await writeFile(paths.codebaseMap, JSON.stringify(map, null, 2))
  }
  state.completedStages.push('survey')

  // --- plan ---
  state.stage = 'plan'
  await writeState(paths.state, state)
  const planPath = join(paths.cycleDir(state.cycle), 'plan.json')
  let plan = await readIfPresent(planPath, PlanSchema)
  if (!plan) {
    const r = await deps.plan(brief, map)
    if ('dead' in r) return fail(r.dead)
    plan = r.plan
    state.totalCostUsd += r.costUsd
    await writeFile(planPath, JSON.stringify(plan, null, 2))
    await writeFile(join(paths.cycleDir(state.cycle), 'spec.md'), r.spec)
  }
  state.completedStages.push('plan')

  state.stage = 'build'
  await writeState(paths.state, state)
  return { ok: true, state, planPath }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/run.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/harbormaster/run.ts tests/run.test.ts
git commit -m "feat: add resumable stage machine through planning"
```

---

### Task 11: CLI with --dry-run

**Files:**
- Create: `src/cli/render.ts`
- Create: `src/cli/index.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `runThroughPlan` from `src/harbormaster/run.js`; `loadRole` from `src/agents/roles.js`; `spawnAgent` from `src/agents/spawn.js`; stage modules
- Produces: `renderPlanSummary(plan: Plan): string`; `timestampSlug(date: Date): string`; a `shipyard` command with `run` and `runs` subcommands

`--dry-run` stops after planning and prints the plan. It is the cheap way to check that intake understood the idea before paying for a full run (spec §12).

`timestampSlug` is pure and takes a `Date`, so run-ID generation is testable without mocking the clock.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { renderPlanSummary, timestampSlug } from '../src/cli/render.js'
import type { Plan } from '../src/schemas/index.js'

const plan: Plan = {
  summary: 'Two tasks, one sequential',
  tasks: [
    { id: 'T1', goal: 'Write the parser', dependsOn: [], ownsFiles: ['src/parse.ts'], criteriaIds: ['AC1'] },
    { id: 'T2', goal: 'Wire the CLI', dependsOn: ['T1'], ownsFiles: ['src/cli.ts'], criteriaIds: ['AC2'] },
  ],
}

describe('timestampSlug', () => {
  it('is filesystem-safe and sorts chronologically', () => {
    const a = timestampSlug(new Date('2026-10-01T09:05:00Z'))
    const b = timestampSlug(new Date('2026-10-01T11:05:00Z'))
    expect(a).toBe('2026-10-01T09-05-00')
    expect(a < b).toBe(true)
    expect(a).not.toMatch(/[:/\\]/)
  })
})

describe('renderPlanSummary', () => {
  it('lists every task with its goal', () => {
    const out = renderPlanSummary(plan)
    expect(out).toContain('T1')
    expect(out).toContain('Write the parser')
    expect(out).toContain('T2')
  })

  it('shows dependencies so sequencing is visible', () => {
    expect(renderPlanSummary(plan)).toMatch(/T2.*after T1|depends on T1/s)
  })

  it('shows which files each task owns', () => {
    expect(renderPlanSummary(plan)).toContain('src/parse.ts')
  })

  it('reports how many tasks can start immediately', () => {
    expect(renderPlanSummary(plan)).toMatch(/1 task can start immediately/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL — cannot resolve `../src/cli/render.js`.

- [ ] **Step 3: Write src/cli/render.ts**

```typescript
import pc from 'picocolors'
import type { Plan } from '../schemas/index.js'

export function timestampSlug(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-')
}

export function renderPlanSummary(plan: Plan): string {
  const ready = plan.tasks.filter(t => t.dependsOn.length === 0).length
  const lines = [
    pc.bold('PLAN'),
    `  ${plan.summary}`,
    '',
    `  ${plan.tasks.length} tasks; ${ready} task${ready === 1 ? '' : 's'} can start immediately`,
    '',
  ]
  for (const t of plan.tasks) {
    const after = t.dependsOn.length > 0 ? pc.dim(` (after ${t.dependsOn.join(', ')})`) : ''
    lines.push(`  ${pc.cyan(t.id)} ${t.goal}${after}`)
    lines.push(pc.dim(`      owns: ${t.ownsFiles.join(', ')}`))
    lines.push(pc.dim(`      serves: ${t.criteriaIds.join(', ')}`))
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/render.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write src/cli/index.ts**

```typescript
#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { z } from 'zod'
import { loadRole } from '../agents/roles.js'
import { spawnAgent, type QueryFn } from '../agents/spawn.js'
import { runThroughPlan } from '../harbormaster/run.js'
import { runIntake } from '../stages/intake.js'
import { runSurvey } from '../stages/survey.js'
import { runPlan } from '../stages/plan.js'
import { buildSurveyPrompt } from '../prompts/survey.js'
import { runPaths } from '../state/paths.js'
import { buildDigest } from '../digest/digest.js'
import { BriefSchema, CodebaseMapSchema, PlanSchema } from '../schemas/index.js'
import { renderPlanSummary, timestampSlug } from './render.js'

const AGENT_TIMEOUT_MS = 15 * 60 * 1000

const ManagerOutputSchema = z.object({ plan: PlanSchema, spec: z.string().min(1) })

// The SDK's query() yields its own SDKMessage union; spawnAgent only needs to read
// `.type`, `.subtype`, `.structured_output`, and `.total_cost_usd` off each message.
// This adapter narrows the SDK type to the structural shape spawnAgent declares.
// If this cast fails to compile, widen QueryFn's element type rather than loosening spawnAgent.
const sdkQuery = query as unknown as QueryFn

async function readProjectReport(target: string): Promise<string | null> {
  try {
    return await readFile(join(target, '.shipyard', 'PROJECT-REPORT.md'), 'utf8')
  } catch {
    return null
  }
}

const program = new Command()
program.name('shipyard').description('Autonomous development team')

program
  .command('run')
  .argument('<idea>', 'what you want built')
  .requiredOption('--target <path>', 'directory to build in or against')
  .option('--dry-run', 'stop after planning and print the plan')
  .action(async (idea: string, opts: { target: string; dryRun?: boolean }) => {
    const target = resolve(opts.target)
    const runId = `${timestampSlug(new Date())}-001`
    const paths = runPaths(target, runId)

    const agentCounter = { n: 0 }
    const nextAgentId = (role: string) => `${role}-${String(++agentCounter.n).padStart(3, '0')}`

    const outcome = await runThroughPlan({
      target, idea, runId, createdAt: new Date().toISOString(),

      intake: async () => {
        const role = await loadRole('intake')
        console.log(pc.dim('  intake...'))
        return runIntake({
          idea, projectReport: await readProjectReport(target), role,
          spawn: ({ prompt, jsonSchema }) => {
            const agentId = nextAgentId('intake')
            return spawnAgent({
              role, agentId, prompt, schema: BriefSchema, jsonSchema, cwd: target,
              transcriptPath: join(paths.agentsDir, `${agentId}.jsonl`),
              timeoutMs: AGENT_TIMEOUT_MS, query: sdkQuery,
            })
          },
        })
      },

      survey: async (brief) => {
        const role = await loadRole('surveyor')
        console.log(pc.dim('  survey...'))
        return runSurvey({
          brief, role,
          spawn: ({ concernId, concernPrompt }) => {
            const agentId = nextAgentId(`survey-${concernId}`)
            return spawnAgent({
              role, agentId,
              prompt: buildSurveyPrompt({ brief, concernPrompt }),
              schema: CodebaseMapSchema,
              jsonSchema: zodToJsonSchema(CodebaseMapSchema) as Record<string, unknown>,
              cwd: target,
              transcriptPath: join(paths.agentsDir, `${agentId}.jsonl`),
              timeoutMs: AGENT_TIMEOUT_MS, query: sdkQuery,
            })
          },
        })
      },

      plan: async (brief, map) => {
        const role = await loadRole('manager')
        console.log(pc.dim('  plan...'))
        return runPlan({
          brief, map, role, maxAttempts: 3,
          digest: buildDigest({
            state: { runId, target, idea, createdAt: '', stage: 'plan', completedStages: [],
                     cycle: 1, maxCycles: 3, totalCostUsd: 0, deaths: [], verdict: 'pending' },
            brief,
          }),
          spawn: ({ prompt }) => {
            const agentId = nextAgentId('manager')
            return spawnAgent({
              role, agentId, prompt,
              schema: ManagerOutputSchema,
              jsonSchema: zodToJsonSchema(ManagerOutputSchema) as Record<string, unknown>,
              cwd: target,
              transcriptPath: join(paths.agentsDir, `${agentId}.jsonl`),
              timeoutMs: AGENT_TIMEOUT_MS, query: sdkQuery,
            })
          },
        })
      },
    })

    if (!outcome.ok) {
      console.error(pc.red(`\nFailed during ${outcome.state.stage}: ${outcome.reason}`))
      console.error(pc.dim(`Run directory: ${paths.root}`))
      process.exitCode = 1
      return
    }

    const plan = PlanSchema.parse(JSON.parse(await readFile(outcome.planPath, 'utf8')))
    console.log('\n' + renderPlanSummary(plan))
    console.log(pc.dim(`\nCost so far: $${outcome.state.totalCostUsd.toFixed(2)}`))
    console.log(pc.dim(`Spec page:   ${join(paths.cycleDir(1), 'spec.md')}`))

    if (opts.dryRun) {
      console.log(pc.yellow('\n--dry-run: stopping before build.'))
      return
    }
    console.log(pc.yellow('\nBuild stage is not implemented yet. Re-run with --dry-run.'))
  })

program.parse()
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass across every suite.

- [ ] **Step 8: Verify the CLI end to end against a real repository**

```bash
mkdir -p /tmp/sy-demo && cd /tmp/sy-demo && git init -q
node /Users/thomasfuhriman/Code/shipyard/dist/cli/index.js run \
  "a CLI that converts a CSV file to JSON" --target /tmp/sy-demo --dry-run
```

Expected: intake, survey (skipped — empty target), and plan run; a task list prints; `/tmp/sy-demo/.shipyard/runs/<id>/cycles/1/spec.md` exists and reads as a sensible description of the work.

- [ ] **Step 9: Commit**

```bash
git add src/cli/index.ts src/cli/render.ts tests/render.test.ts
git commit -m "feat: add CLI with dry-run planning"
```
