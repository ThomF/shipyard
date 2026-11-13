<div align="center">

```
 ░▒▓ S H I P Y A R D ▓▒░
 AUTONOMOUS DEV YARD
```

**Stand in a repo, name a feature. It plans, builds, tests, fixes, and hands you a report.**

</div>

---

## What it is

Shipyard is an autonomous development team that runs inside Claude Code. You give
it a repository and a feature request. It writes acceptance criteria, plans the
work, hands tasks to dev agents, has testers judge the result, fixes what fails,
and leaves a branch and a written report.

You read the report. You don't watch the run.

A **harbormaster** runs the circuit. **Devs** write code and **testers** decide
whether it works. Testers never fix what they find: they report, the harbormaster
triages, and devs fix. It allows three fix rounds per cycle and three cycles, then
stops and tells you what it learned.

**No agent lives long enough to fill its context.** Each one is spawned for a
single job, returns under 150 words, and exits. Durable memory is `state.json` and
`ledger.md` on disk, not a conversation, so an agent dying mid-run is routine: its
partial work is in the tree, and a fresh agent picks it up from `git diff`.

## Install

Once per machine:

```bash
git clone git@github.com:ThomF/shipyard.git && cd shipyard
npm run install-command
```

This installs three things under `~/.claude/`, and nothing is ever copied into
your repos:

| What | Where |
|---|---|
| The `/shipyard` and `/harbor` commands | `commands/shipyard.md`, `commands/harbor.md` |
| The seven roles, as agents | `agents/shipyard-<role>.md` |
| The helper scripts each run calls | `shipyard/` |

Start a new Claude Code session afterwards so it picks up the agents.

> **Re-run `npm run install-command` after editing `SHIPYARD.md`, `HARBOR.md`, a
> role file, or a script in `tools/`.** The installed files are generated; this
> repo is the source of truth.

## Quick start

Stand in the repo you want the work done in:

```bash
cd ~/Code/some-project
claude
```

```
/shipyard add CSV export to the admin orders page
/shipyard docs/stories/CSV-EXPORT.md
/shipyard --lite add an about page
/shipyard --budget 500000 add CSV export to the reports page
/shipyard
```

- **The target is the repo you are standing in.** There is no path to get wrong.
- **The request is prose or a file.** A story file that already states testable
  criteria becomes the contract directly.
- **Run it bare** and it looks for likely work in the repo and asks which to build.
- **The tree must be clean.** Shipyard never builds on uncommitted work.

Shipyard creates a branch in place, works there, and commits its report there. It
does not merge and does not push. The branch is yours to review.

### Watch it work

`/shipyard` opens a live view by itself. In the Claude desktop app it appears in the
browser pane; elsewhere you get a `localhost` link. It shows:

- the stage pipeline, with a timer on every stage and a run clock
- the crew on deck, and how long each agent has been working
- acceptance criteria flipping to pass, and tasks going from running to done
- every file the crew has touched, with a pulsing dot on those being written now
- any agent that died and was respawned

If the harbormaster goes quiet for 20 minutes the page raises **NO SIGNAL**, so a
stalled run never looks like a busy one.

## The circuit

```
     feature request + target repo
                 │
      ┌──────────▼──────────┐ ┌─────────────────────┐
      │ INTAKE              │ │ SURVEY   ×1-3       │  run at the same time
      │ acceptance criteria │ │ cached between runs │  (skipped for an empty
      └──────────┬──────────┘ └──────────┬──────────┘   target)
                 │◄──────────────────────┘
      ┌──────────▼──────────┐
      │ PLAN                │  task DAG + a spec page explaining the approach
      │                     │  writes one brief per dev
      └──────────┬──────────┘
      ┌──────────▼──────────┐
      │ BUILD    devs       │  each owns a disjoint file set,
      │                     │  and ends with a handoff block
      └──────────┬──────────┘
      ┌──────────▼──────────┐
      │ TEST     2 testers  │  browser tester starts with the test suite;
      │                     │  verdict per criterion, with evidence
      └──────────┬──────────┘
            pass │ fail
                 │   └──► TRIAGE ──► fix ──► re-test failing   ×3 rounds
                 │              └──► still failing? new manager, new cycle ×3
                 ▼
              REPORT
```

**File ownership is how parallel work stays safe.** Two tasks that could run at the
same time may never own the same file. Two that share a file are fine when one
depends on the other, because they run in sequence. A plan that gets this wrong is
rejected and re-planned.

### How work changes hands

The harbormaster passes paths, not text, and scripts keep the books. It never
retypes a task into a prompt and never reads a test report.

| Step | What happens |
|---|---|
| Plan accepted | `run-check.mjs plan` writes each dev's brief: its task, criteria, files, the test command and the codebase map's path |
| Dev dispatched | `start` puts it on deck. Its whole prompt is the path of its brief, which now also holds what the tasks before it really built |
| Dev returns | It ends with a block naming its commit, the test that proves each criterion, what it built, and anything it is unsure of. `finish` files that in `handoff.json`, records the tokens used, and prints which tasks are now ready |
| Testers run | They open the tests the handoff names instead of searching. The handoff is a pointer, never evidence: a tester still reads each test |
| Testers return | `verdicts` merges the reports into `state.json` and prints only what failed, with the evidence and the task that owns it |

## Built for speed

Shipyard takes a fast path wherever it can do so without weakening a check. Each
one taken is recorded in `state.json` and shown as a chip on the dashboard.

| Fast path | What it saves |
|---|---|
| Model split | Surveyors, the reporter, mechanical dev tasks and the checklist tester run on sonnet; the rest stay on opus |
| Parallel intake | Survey starts alongside intake, not after it |
| `survey-cache` | The codebase map is cached in `.git/shipyard/`; when nothing structural changed, only the request-specific surveyor runs |
| Sized survey | One surveyor for small repos, three for large ones |
| Rolling build | Each dev is dispatched the moment its dependencies finish, not in waves |
| Early browser tester | The slowest tester starts as the build ends, alongside the test suite |
| `red-suite-fix` | A suite that goes red after the build goes straight to a fix dev, with no tester spent restating the failure |
| `direct-fix` | A first-round defect with one owner and clear evidence goes to a dev without a manager |
| `command-retest` | After a fix, a criterion whose own check now passes is settled by re-running it |
| `scoped-retest` | Otherwise a tester re-verifies only the criteria still failing |
| `intake-from-story` | A story file with testable criteria becomes the brief directly |

`PROJECT-REPORT.md` notes the slowest stage of every run, so you can see where the
time goes.

## Run sizes and token use

| Size | Use for | Agents skipped | Devs | Criteria (browser) |
|---|---|---|---|---|
| `--lite` | One page, endpoint or fix | Intake and manager | 1-2 | 8 (1) |
| `--standard` | A normal feature | None | 3-5 | 12 (3) |
| `--full` | Must be asked for by name | None | Up to 10 | 30 (no cap) |

With no size named, the harbormaster picks `lite` or `standard` and says why. It
never picks `full` itself.

Every run records what each agent used, and the report totals it by role. With
`--budget <tokens>`, the harbormaster pauses and asks before dispatching more agents
once the run's agents have used that many. There is no default budget, the count
cannot see your account's usage meter, and the harbormaster's own tokens are not
included.

Each criterion is tagged `unit`, `api`, `command` or `browser`, and two testers
split them:

- **The checklist tester** (sonnet) confirms that the named tests truly assert the
  behaviour. It starts no browser.
- **The browser tester** (opus) uses the app first, in at most 25 browser tool
  calls, then writes what it learned as a Playwright check at
  `.shipyard/checks/<feature>.check.mjs`. A check clicks several points across each
  element, because a click that lands at one point proves little. Shipyard asks
  before adding Playwright to a repo.

## Roles are files, not code

Every role is a markdown file in `agents/`, with frontmatter and a system prompt:

```markdown
---
name: tester
model: sonnet
tools: [Read, Grep, Glob, Bash]
---
You are a tester. You verify acceptance criteria and report a verdict.
You do NOT fix anything...
```

**Tuning the team is editing a prompt.** Want devs more conservative? Change
`dev.md`. Want a different model? Change one line. Then re-run
`npm run install-command`.

| Role | Model | Writes code | Decides "done" |
|---|---|---|---|
| `intake.md` | opus | no | no |
| `surveyor.md` | sonnet | no | no |
| `manager.md` | opus | no | yes: plans, triages, assigns |
| `dev.md` | opus (sonnet for mechanical tasks) | **yes** | no |
| `tester.md` | sonnet | no | reports a verdict only |
| `browser-tester.md` | opus | no | reports a verdict only |
| `reporter.md` | sonnet | no | no |

Separation of duties is checked, not trusted. Testers have no edit tools, but they
need `Bash` to run tests and Bash can write files. So `finish` checks the tree after
every tester, and a tester that changed anything outside `.shipyard/` compromises
the run.

## The report

Every run produces a self-contained `report.html`: one file, data inlined, no
server. It is committed with the work, so the evidence travels with the branch.
While the run is in flight it reloads itself and is the live view; when the run
ends it becomes the permanent record.

It shows the verdict, every criterion and its status, how the manager delegated,
which tasks owned which files, the testers' real failure output, token use, any
agents that died, and the harbormaster's log.

`.shipyard/PROJECT-REPORT.md` gains one entry per run, so a later run knows what was
already tried and what already failed.

## The yard: one URL for every run

`/shipyard` starts the yard server for you. To look at it without a run:

```bash
npm run yard                     # or: npm run dev
npm run yard -- ~/work ~/Code    # watch several roots
PORT=8080 npm run yard           # different port
```

It is a local control room at **http://localhost:7343** listing every run in
`~/Code` and in every repo `/shipyard` has run in, newest first, with a status lamp
per run and a link into each report. It binds to `127.0.0.1` only, and serves only
run directories it found.

To see it before you have run anything:

```bash
npm run demo && npm run yard -- .demo
```

That builds a throwaway yard with three runs: one shipped, one partial after all
three cycles, and one still building.

## Harbor Pilot: reading what it built

`/harbor` lays the code a build wrote out in the order the data moves, so you can
follow it from start to finish. It is not a reviewer. It doesn't approve, fix or
score anything. You are the reviewer.

On the build's branch:

```
/harbor
/harbor ask "S3: why does this return 200 when the query fails?"
/harbor verify
```

`/harbor` writes `.shipyard/runs/<run-id>/REVIEW_GUIDE.md`. `/harbor ask` answers
with quoted lines and logs the question and answer in the guide. `/harbor verify`
re-checks every snippet in the guide against the branch.

- **The code can't be paraphrased.** Claude only cites line ranges. `tools/harbor.mjs`
  copies those lines from the commit, and refuses citations that don't exist.
- **It reads what the script hands it.** The manual tells the session to stick to
  the report, the diff and the changed files. That is an instruction, not a sandbox.
  The snippet check holds either way.
- **It reads a report, not your repo's history.** Each build writes
  `shipyard-report.json`. Harbor Pilot uses the newest one for your branch, or the
  one you name with `--run <id>`, and stops if it is missing or malformed.
- **The guide stays out of your branch.** It is listed in `.git/info/exclude`, so it
  isn't committed and doesn't block the next build's clean-tree check. Rebuilding
  needs `--force`, which keeps the old guide beside the new one.

## Two ways to run it

**Session-driven** is the default and what `/shipyard` uses. Claude Code reads
`SHIPYARD.md` and acts as the harbormaster, on an ordinary Claude Code session.

**Standalone binary** (`src/`) is not wired up yet. It is a TypeScript program that
spawns its own agents through the Claude Agent SDK and runs unattended. It covers
intake, survey and plan; build, test and fix are not implemented. It also needs API
access to the models the role files name.

Both read the same `agents/*.md` files.

## Layout

```
SHIPYARD.md                      the harbormaster's operating manual
HARBOR.md                        Harbor Pilot's manual
agents/*.md                      role definitions: edit these to tune the team
tools/build-command.mjs          installs the commands, agents and scripts
tools/run-check.mjs              brief and plan checks, agent start and finish,
                                 handoffs, verdicts, browser checks, token ledger
tools/render-report.mjs          run directory → report.html
tools/write-shipyard-report.mjs  run directory → the report Harbor Pilot reads
tools/harbor.mjs                 Harbor Pilot's plain-code half
tools/serve.mjs, yard.mjs        the yard server, and its detached starter
tools/demo.mjs                   builds the throwaway demo yard
src/                             the standalone binary (not wired up yet)
tests/                           tests for the tools and the binary
docs/superpowers/                design spec and implementation plan
```

To work on Shipyard itself:

```bash
npm install && npm test
```

## Safety

- Writes are confined to the target repo: its working tree, its `.shipyard/`
  directory, and the survey cache under `.git/shipyard/`
- Nothing is deleted. Failed cycles are archived as tags
- It never force-pushes, resets hard, or drops database objects
- The test command comes from the survey, so no agent can substitute a weaker one
  to go green
- Secrets are redacted from reports and artifacts
- It does not merge and does not push

## Generated code standards

Devs are held to these:

- Parameterized queries, never string concatenation into SQL
- No credentials in source; environment variable placeholders only
- Error handling required; no bare `try` blocks or swallowed exceptions
- Code touching customer data carries a data-classification comment
- Third-party dependencies reported with their license type
- Generated queries flagged for verification against the production schema
