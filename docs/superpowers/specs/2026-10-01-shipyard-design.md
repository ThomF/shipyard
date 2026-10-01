# Shipyard — Design Spec

**Date:** 2026-10-01
**Status:** Approved design, pending implementation plan

---

## 1. Purpose

Shipyard is an autonomous development system. You give it an idea and a target
directory; it plans the work, builds it with parallel agents, tests it against
criteria agreed upfront, fixes what fails, and hands you a written report.

You read the report. You do not watch the run.

### The constraint that drives the architecture

A long-lived orchestrating agent accumulates context until it slows down and
degrades. Every design decision in this document serves one goal: **no agent in
Shipyard ever lives long enough to fill its context window.**

This is achieved structurally, not through prompting or compaction. The
orchestrator is a program with no message history. Every agent is spawned for a
single question, answers it, and exits. State lives on disk in validated
artifacts, and any prompt an agent needs is assembled from those artifacts by
code at spawn time.

### Success criteria

1. A one-sentence idea plus a target path produces working, tested code or a
   report explaining precisely why it could not.
2. No agent's context utilization exceeds a safe threshold, regardless of run
   length or number of restarts.
3. An agent crashing mid-run is recovered automatically and is indistinguishable
   from an agent finishing normally.
4. The user's entire interface to a completed run is one markdown report.
5. A run can be interrupted and resumed without repeating completed work.

### Non-goals

- A web dashboard or GUI. CLI plus markdown report only.
- Replacing human code review. Shipyard produces branches for review.
- Operating on repositories it does not have an explicit target path for.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Harbormaster** | The runtime. Code, not an agent. Owns the state machine, spawns and supervises agents, persists artifacts. Holds no model context and makes no judgment calls. |
| **Manager** | An agent role. Makes judgment calls: decompose work, triage defects, decide done. Short-lived by construction. |
| **Dev** | An agent role. Writes code in an isolated worktree. Cannot declare work complete. |
| **Tester** | An agent role. Runs acceptance criteria and reports a verdict. Has no write tools. |
| **Run** | One invocation of Shipyard against an idea and a target. |
| **Cycle** | One manager's full attempt: plan, build, integrate, test, fix. Max 3 cycles per run. |
| **Artifact** | A schema-validated JSON or markdown file on disk. The only medium of inter-agent communication. |
| **Digest** | A code-generated ~2 page summary of run state, used to brief a fresh manager. |

---

## 3. Architecture

### 3.1 The seven stages

```
                    idea + target path
                            │
    ┌───────────────────────▼───────────────────────┐
    │  1. INTAKE                        1 agent     │
    │     idea ──► brief.json                       │
    │     goal, constraints, stack, risks,          │
    │     and explicit acceptance criteria          │
    └───────────────────────┬───────────────────────┘
                            │
    ┌───────────────────────▼───────────────────────┐
    │  2. SURVEY            N agents  (skipped if   │
    │     target ──► codebase-map.json  target is   │
    │     structure, conventions, test setup empty) │
    └───────────────────────┬───────────────────────┘
                            │
    ┌───────────────────────▼───────────────────────┐
    │  3. PLAN              1 manager agent         │
    │     brief + map + learnings ──► plan.json     │
    │     task DAG, per-task criteria,              │
    │     file ownership assignments                │
    └───────────────────────┬───────────────────────┘
                            │
    ┌───────────────────────▼───────────────────────┐
    │  4. BUILD             N dev agents            │
    │     one worktree + branch per task            │
    │     ──► tasks/<id>.json                       │
    └───────────────────────┬───────────────────────┘
                            │
    ┌───────────────────────▼───────────────────────┐
    │  5. INTEGRATE         no agent                │
    │     merge branches ──► integration branch     │
    │     conflicts fail back to manager triage     │
    └───────────────────────┬───────────────────────┘
                            │
    ┌───────────────────────▼───────────────────────┐
    │  6. VERIFY            tester + manager + devs │
    │     the fix loop, detailed in §5              │
    └───────────────────────┬───────────────────────┘
                            │
    ┌───────────────────────▼───────────────────────┐
    │  7. REPORT            1 agent                 │
    │     artifacts ──► report.md                   │
    └───────────────────────────────────────────────┘
```

### 3.2 Stage 1 — Intake

A single agent converts the user's idea into `brief.json`. Its most important
output is the acceptance criteria list: each criterion must be specific enough
that a tester can produce a pass/fail verdict without judgment calls.

Intake also records what it was **not** told. Unstated assumptions appear in the
brief as an `assumptions` array and are surfaced in the final report, so a wrong
assumption is visible in a short file rather than buried in generated code.

**Intake reads the project report.** If `<target>/.shipyard/PROJECT-REPORT.md`
exists (§8.1), it is included in the intake prompt. This is what gives the
system continuity across runs: it knows what was already built against this
target and which ideas already failed, so a new run does not re-attempt a
known-dead approach. The project report is the only artifact that crosses a run
boundary, and it is code-generated, so this costs nothing in accumulated
context.

### 3.3 Stage 2 — Survey

Skipped when the target directory is empty. Otherwise, four read-only agents run
in parallel, split by concern rather than by directory so the shape of the
survey does not change with repository size:

1. **Structure and stack** — layout, language, framework, build system
2. **Test setup** — test runner, existing test command, coverage conventions
3. **Conventions** — naming, error handling, module patterns, lint rules
4. **Documentation** — `README`, `docs/`, `CONTRIBUTING`, architecture notes,
   and any design docs the repository already carries
5. **Relevant modules** — the code the brief actually touches

Their outputs merge into one `codebase-map.json`.

The documentation surveyor matters more than it looks. A repository's own
documentation states intent that the code cannot: why a module exists, what
invariants hold, which approaches were already rejected. Feeding that into
planning is what separates a plan that fits the project from one that merely
compiles against it.

Surveying once and caching the result is deliberate. N build agents each
exploring the same repository independently costs N times the tokens and
produces N subtly different mental models.

### 3.4 Stage 3 — Plan

A manager agent receives the brief, the codebase map, and (on cycles 2 and 3)
the accumulated learnings. It produces `plan.json`: a task DAG where each task
carries a goal, the acceptance criteria it serves, its dependencies, and an
explicit list of files it owns.

File ownership is how parallel work stays conflict-free. The planner assigns
disjoint file sets. The harbormaster validates this: overlapping ownership
between two concurrently-runnable tasks is a plan validation error, and the
manager is re-prompted with the specific conflict.

**The manager also writes a spec page.** Alongside `plan.json` it produces
`spec.md` — prose explaining what it intends to build and why, grounded in the
brief, the codebase map, and the repository's own documentation. The plan is
what the harbormaster executes; the spec page is what you read to judge whether
the manager understood the job before any code exists. On cycles 2 and 3 a
fresh manager writes a new spec page, so the three are directly comparable and
show how the approach changed.

### 3.5 Stage 4 — Build

The harbormaster walks the DAG. Tasks whose dependencies are satisfied run
concurrently, up to a configurable limit (default: `min(4, cores - 2)`).

Each dev agent gets its own `git worktree` on its own branch. It receives the
task, its own acceptance criteria, the codebase map, and the specific files it
owns. It does not receive the full brief, the full plan, or any other agent's
report. Its output is `tasks/<id>.json`: what it changed, what tests it wrote,
its own confidence, and any blockers.

### 3.6 Stage 5 — Integrate

Branches merge into the run's integration branch in dependency order. This stage
uses no agent at all.

File ownership validation in §3.4 is what makes this safe: two concurrently
runnable tasks cannot own the same file, so clean merges are the expected case.
A conflict means the plan was wrong, so it is treated as a planning defect — the
merge is aborted, the conflicting tasks are marked blocked, and both go to
manager triage with the conflicting hunks attached.

A dedicated resolver agent was considered and rejected for v1. Triage already
exists and is the correct owner of a bad plan; adding a resolver would paper
over planning errors instead of surfacing them.

### 3.7 Stage 7 — Report

A single agent reads the artifacts — never the raw transcripts — and writes
`report.md`. Report contents are specified in §8.

---

## 3.8 The agent definition folder

Roles are defined by files, not by code. Shipyard ships an `agents/` directory
where each role is one markdown file with YAML frontmatter:

```
shipyard/agents/
  manager.md     decompose, triage, decide done
  dev.md         write code in an assigned worktree
  tester.md      run criteria, return a verdict
  surveyor.md    read an existing repository
  intake.md      turn an idea into a brief
  reporter.md    turn artifacts into the report
```

```markdown
---
name: manager
model: claude-opus-4-8
tools: [Read, Grep, Glob]
delegatesTo: [dev, tester]
---
You are the manager. You decompose a brief into tasks...
```

**Why files:** tuning a role is editing a prompt, not editing a program. The
behaviour of the whole system is adjustable without a build step, and the
definitions are reviewable in a diff.

**Startup sequence for any agent.** The harbormaster loads the role file,
assembles the digest and task slice, and spawns the agent with the file's body
as its system prompt and its `tools` list as the agent's entire tool set. The
agent reads its brief, does one job, returns structured output, and exits.

**Delegation is a decision, not an action.** A manager has no tool that spawns
agents. It returns a decision naming the role and the tasks to delegate; the
harbormaster loads that role's file and does the spawning. This is deliberate:
if a manager spawned its own workers it would have to hold their results in its
own context, which is exactly what must not happen.

**The permission floor is code, not file.** The loader validates every role
file against a hard-coded floor before use. A `tester.md` that declares `Write`
or `Edit` is a startup error, not a silently weakened tester. Role files can
narrow permissions below the floor; they cannot widen them past it.

## 4. The context guarantee

These are invariants enforced in code, not instructions given to agents.

**I1 — The harbormaster never calls a model.**
It spawns agents, validates their structured output, writes artifacts, and
advances a state machine. It has no message array, so it has nothing that can
grow.

**I2 — Every agent is single-use.**
Spawn, answer one question, return structured output, exit. No agent instance is
reused across tasks or stages. An agent's context is therefore bounded by the
size of one task, not by the length of the run.

**I3 — Transcripts are write-only.**
Each agent's raw conversation streams to `agents/<id>.jsonl` for human
debugging. No code path reads it back into another agent's context. The
harbormaster only ever handles schema-validated result objects.

**I4 — Prompts are assembled, not inherited.**
A dev fixing a defect receives the failing test output, the files it may touch,
and a list of what previous attempts already tried. It does not receive the
brief, the plan, or other agents' reports. Each prompt is built by code from
artifacts, containing exactly the slice that role needs for that question.

**I5 — Run state lives in a file, not a context window.**
`state.json` is the single source of truth. It is written atomically (temp file
plus rename) after every state transition, which is what makes runs resumable
and crash recovery routine.

### Consequence

A fix in cycle 3 is produced by an agent as sharp as the one that wrote the
original code in cycle 1, because nothing degraded in between. Context
exhaustion is not mitigated; it is made impossible.

---

## 5. The verify and fix loop

```
  devs build ──► integrate ──► TESTER runs acceptance criteria
                                       │
                                  test-report.json
                                       │
                            pass ──────┴────── fail
                             │                  │
                             ▼                  ▼
                        REPORT ✓           defects.json
                                                │
                                                ▼
                                    MANAGER triages defects
                                    into scoped fix tasks
                                                │
                                                ▼
                                    DEVS fix in worktrees
                                                │
                                                ▼
                                    re-test  ──► up to 3 rounds
                                                │
                                       still failing after 3
                                                ▼
                                    distill learnings.md
                                                │
                                        cycles remaining?
                                                │
                                   ┌────────────┴────────────┐
                                  yes                        no
                                   │                          │
                        archive branch,              REPORT ✗
                        fresh manager,               with full
                        re-plan from scratch         failure analysis
```

### 5.1 Separation of duties

| Role | Filesystem access | May run tests | May declare done |
|---|---|---|---|
| Manager | read-only | no | yes — triages and assigns |
| Dev | write, own worktree only | yes, for own feedback | **no** |
| Tester | **read-only, no write tools** | yes | reports verdict only |

Enforcement is through the tool permissions each agent is spawned with, not
through prompt instructions. A tester holds no write tools, so it is
*incapable* of fixing a defect it found and reporting green. A dev may run tests
to know its own code compiles and behaves — coding blind is strictly worse — but
has no authority to mark a criterion met. That verdict is the tester's exclusive
output.

Instructions asking an agent to stay in its lane are ignored under pressure.
Capability boundaries are not.

### 5.2 Fix rounds

Three fix rounds per cycle. Each round spawns fresh devs. Each fix task carries
an `attempts` array summarizing what previous rounds tried and why it did not
work, which prevents the system from cycling through the same wrong fix.

### 5.3 Cycles and restarts

Three cycles per run, each run by a new manager. A fresh manager on cycle 2 or 3
receives the digest plus `learnings.md` and re-plans from scratch — it is a
genuine second attempt, not a retry of the same plan.

After cycle 3 fails, the run stops and reports. This ceiling is hard: no code
path loops indefinitely.

---

## 6. Supervision and recovery

### 6.1 Death is the normal case

Every manager is already short-lived — it answers one question and exits. A
manager that crashes is therefore handled by the same code path as a manager
that finishes: the harbormaster rebuilds the digest and spawns the next one.

This matters because crash recovery is not a rarely-exercised emergency path
that rots. It is the main loop.

### 6.2 The digest

The rundown handed to a fresh manager is **generated deterministically by code**
from `state.json`. It costs no tokens to maintain and cannot be stale, because
it is not stored — it is derived at spawn time.

Contents, capped at roughly two pages:

- The goal, in one paragraph
- Acceptance criteria, each with current pass/fail/untested status
- The task board: done, in progress, blocked, not started
- What has already been tried and failed, condensed from `learnings.md`
- Open defects with their triage status
- Branch and worktree state

If the digest would exceed its cap, code truncates the lowest-value sections
first (completed task detail before open defects) and records the truncation in
the digest itself.

### 6.3 Dev and tester recovery

An agent exiting without valid structured output is treated as dead. The
harbormaster respawns it on the same task with a handoff note. Its partial work
is still in its worktree, so `git diff` against the branch point *is* the
handoff — no state is lost.

Respawn policy: two respawns per task. A third death marks the task `blocked`
and escalates to the manager at the next triage, rather than retrying forever.

### 6.4 Timeouts and heartbeats

Every spawn carries a wall-clock timeout and a no-output heartbeat timeout. A
hung agent is killed and treated as dead, so an unresponsive agent cannot stall
a run.

---

## 7. State, artifacts, and layout

### 7.1 Run directory

```
<target>/.shipyard/
  PROJECT-REPORT.md         cumulative across every run — see §8.1
  runs/<run-id>/
    state.json              harbormaster state machine — source of truth
    brief.json              stage 1
    codebase-map.json       stage 2
    learnings.md            accumulated across cycles
    report.md               stage 7 — what the user reads
    cycles/
      1/
        spec.md             the manager's written intent for this cycle
        plan.json
        tasks/<task-id>.json
        test-report.json
        defects.json
        fix-rounds/<n>/...
      2/ ...
    agents/
      <agent-id>.jsonl      raw transcripts, write-only
```

Role definitions live in Shipyard's own `agents/` directory (§3.8), not in the
target — they are shared across every project.

Archived failed branches are named `shipyard/run-<id>/cycle-<n>-failed`.

### 7.2 Schemas

Every artifact has a Zod schema. Agents are required to produce structured
output matching it; a mismatch is a validation failure that re-prompts the agent
with the specific error rather than a parse crash downstream.

### 7.3 Resumability

Because `state.json` is written atomically after every transition, an
interrupted run resumes at the last completed stage. Completed tasks are not
rebuilt.

---

## 8. The report

The report is the product. Its sections:

1. **Verdict** — shipped, partially shipped, or failed, in one line
2. **What you asked for** — the brief restated, plus assumptions intake made
3. **Acceptance criteria** — a table of every criterion and its final status
4. **What was built** — components, files changed, with branch name
5. **Test results** — what passed, what failed, and the actual failure output
6. **What went wrong and why** — per cycle, if anything did
7. **What each cycle learned** — the content of `learnings.md`
8. **Cost and duration** — tokens and wall-clock, per stage
9. **Recommended next steps** — explicit, actionable

Failure reports are more detailed than success reports. A failed run must
explain itself well enough that the user can decide what to change about the
idea.

### 8.1 The project report

`<target>/.shipyard/PROJECT-REPORT.md` accumulates across every run against that
target. Each completed run appends one entry: date, idea, verdict, what shipped,
what failed and why, and the branch name.

It is append-only and generated by code from each run's `state.json` — no agent
writes it, so it cannot drift from what actually happened.

**Why it is separate from the run report.** The run report answers "what
happened this time." The project report answers "what has this project been
through" — which ideas were tried, which failed and for what reason, what is
already built. It is the file to read before starting a new run on a target you
have used before, and it is the natural input to a future run's intake stage.

---

## 9. Safety

- **Writes are confined** to the target path and `.shipyard/`. Agents receive no
  ambient permission to touch the rest of the filesystem.
- **Nothing is deleted.** A failed cycle's branch is archived, not removed. If
  cycle 3 does worse than cycle 2, cycle 2's work still exists.
- **Destructive operations require explicit user confirmation.** Shipyard never
  runs `rm -rf`, force-pushes, resets hard, or drops database objects on its own
  initiative.
- **The test command is configured, not invented.** An agent cannot substitute a
  weaker command to make a run go green.
- **Secrets are redacted** from artifacts, transcripts, and the report. No
  credential, token, or connection string is written to any file Shipyard
  produces.
- **No network mutations.** Shipyard does not push branches, open pull requests,
  or call external services unless explicitly configured to.

---

## 10. Standards for generated code

Dev agents are prompted and reviewed against these standards. They apply to all
code Shipyard produces.

- Database access uses parameterized queries. String concatenation into SQL is
  rejected at review.
- Any generated query is flagged in the report for verification against the
  production schema before it is run.
- Code touching customer data carries a comment noting the data classification
  requirement.
- No credentials or tokens in source. Environment variable placeholders only.
- Error handling is required. No bare `try` blocks or swallowed exceptions.
- Third-party dependencies added by agents are reported with their license type.

---

## 11. Technology

TypeScript on Node, chosen because the Claude Agent SDK is first-class there and
because structured output plus Zod gives compile-time and runtime safety on
every artifact boundary.

| Dependency | Purpose | License |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | agent spawning and tooling | MIT |
| `zod` | artifact schema validation | MIT |
| `commander` | CLI argument parsing | MIT |
| `picocolors` | terminal color | ISC |
| `vitest` | Shipyard's own test suite | MIT |

The live progress tree is a small hand-rolled ANSI renderer rather than a UI
framework dependency.

### Source layout

```
src/
  cli/           entrypoint, flags, live progress renderer
  harbormaster/  state machine, supervisor, atomic state store
  agents/        one spawn wrapper per role
  prompts/       prompt builders per role
  schemas/       zod schemas for every artifact
  digest/        deterministic rundown generator
  worktrees/     git worktree lifecycle
  report/        markdown report generator
tests/
```

### Model assignment

Configurable per role. Defaults:

| Role | Default model |
|---|---|
| Intake, Manager | `claude-opus-4-8` |
| Dev, Tester, Reporter | `claude-sonnet-4-6` |
| Survey | `claude-sonnet-4-6` |
| Digest | none — generated by code |

---

## 12. CLI

```
shipyard run "<idea>" --target <path> [options]

  --target <path>        directory to build in or against (required)
  --test-cmd <cmd>       acceptance test command
  --max-parallel <n>     concurrent dev agents (default: min(4, cores-2))
  --max-cycles <n>       default 3
  --max-fix-rounds <n>   default 3
  --model-<role> <id>    per-role model override
  --resume <run-id>      resume an interrupted run
  --dry-run              stop after planning; print the plan and exit

shipyard report <run-id>     print a previous run's report
shipyard runs                list runs and their verdicts
```

While running, the terminal shows a live tree of stages and agents. On
completion it prints the report path and the one-line verdict.

`--dry-run` is the cheap way to check that intake understood the idea before
spending a full run on it.

---

## 13. Deliberately deferred

- **Resolver agent for merge conflicts.** Conflicts go to triage in v1. See
  §3.6.
- **Web dashboard.** CLI and markdown report only.
- **Pushing branches or opening pull requests.** Shipyard leaves work on local
  branches for human review.
- **Cost-based ceilings.** The ceiling is 3 cycles. A token budget option may be
  added once real runs show what a typical run costs.
