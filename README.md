<div align="center">

```
 ░▒▓ S H I P Y A R D ▓▒░
 AUTONOMOUS DEV YARD
```

**Stand in a repo, name a feature. It plans, builds, tests, fixes, and hands you a report.**

</div>

---

## What it is

Shipyard is an autonomous development team. You give it a repository and a
feature request; it decomposes the work, delegates to dev agents, commands
testers, fixes what fails, and leaves a branch plus a written report.

You read the report. You don't watch the run.

A **harbormaster** runs the circuit and delegates to **devs** (who write code)
and **testers** (who decide whether it works). Testers never fix what they find
— they report defects, the harbormaster triages them, and devs do the fixing.
Three fix rounds per cycle, three cycles maximum, then it stops and tells you
what it learned.

## The constraint that shapes everything

**No agent lives long enough to fill its context.** A manager that has been
running for hours makes worse decisions than one that just started, so Shipyard
never lets one run that long.

Every agent is spawned for a single question, writes its full output to a file,
returns under 150 words, and exits. Durable memory lives in `state.json` and
`ledger.md` on disk — not in a conversation. An agent dying mid-run is routine:
its partial work is in the tree, so `git diff` is the handoff, and a fresh agent
picks it up.

That property is the whole design. Everything else follows from it.

## Install

Once per machine:

```bash
git clone git@github.com:ThomF/shipyard.git && cd shipyard
npm run install-command
```

That bundles `SHIPYARD.md` into a self-contained slash command at
`~/.claude/commands/shipyard.md`, so `/shipyard` works from inside any repository.
It installs the seven roles as agents at `~/.claude/agents/shipyard-<role>.md` and the
helper scripts at `~/.claude/shipyard/`, where each run calls them, so nothing is
copied into your repo. Start a new Claude Code session after installing so it picks
up the agents.

> **Re-run `npm run install-command` after editing `SHIPYARD.md`, `HARBOR.md`, any
> role file, or a script in `tools/`.** The command is generated; the repo is the source of
> truth.

## Quick start

Stand in the repo you want the work done in, and pilot Shipyard into it:

```bash
cd ~/Code/some-project
claude
```

```
/shipyard add CSV export to the admin orders page
```

The target is simply the repo you are standing in — no paths to get wrong, and
Shipyard cannot touch anything outside it because the session cannot see
anything outside it.

The feature request can also be a **file** already in the repo, which is usually
how a real user story arrives:

```
/shipyard docs/stories/CSV-EXPORT.md
```

Run it bare and it will look for likely sources of work and ask which one to
build.

Shipyard creates a branch in that repo, works there, and writes the report
there. It does not merge and does not push — the branch is yours to review.

**Watch it work.** `/shipyard` starts the live view by itself, with nothing to
install or run. In the Claude desktop app it opens in the browser pane. Elsewhere it
gives you a `localhost` link. It updates by itself while the run is in flight and
stops when the run ends.

You see the stage pipeline advance with a timer on every stage, a run clock,
the crew currently on deck with how long each agent has been working,
acceptance criteria flip to pass, tasks go from running to done, every file the
crew has touched (with a pulsing dot on the ones being written right now), and
any agent that dies and gets respawned. If the harbormaster goes quiet for 20
minutes the page raises **NO SIGNAL**, so a stalled run never looks like a busy
one.

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
      │                     │  two concurrent tasks may never own the same file
      └──────────┬──────────┘
      ┌──────────▼──────────┐
      │ BUILD    devs       │  each owns a disjoint file set
      └──────────┬──────────┘
      ┌──────────▼──────────┐
      │ TEST     tester     │  verdict per criterion, with real output as evidence
      └──────────┬──────────┘
            pass │ fail
                 │   └──► TRIAGE ──► fix ──► re-test failing   ×3 rounds
                 │              └──► still failing? new manager, new cycle ×3
                 ▼
              REPORT
```

**File ownership is how parallel work stays safe.** Two tasks that could run at
the same time must never claim the same file. Two tasks that share a file are
fine when one depends on the other — they run in sequence. The plan is rejected
and re-planned if it gets this wrong.

## Built for speed

A run is many agents in sequence, so Shipyard takes a fast path at every stage
where it can do so without weakening a check. Each one taken is recorded in
`state.json` and shown as a chip on the dashboard.

| Fast path | What it skips |
|---|---|
| Model split | Surveyors, the reporter, mechanical dev tasks and the checklist and re-test testers run on sonnet; the rest stay on opus |
| Parallel intake | Survey starts alongside intake instead of after it |
| `survey-cache` | The codebase map is cached in `.git/shipyard/` and reused when nothing structural changed; only the request-specific surveyor runs |
| Sized survey | One surveyor for small repos, three for large ones, never five |
| Rolling build | Each dev is dispatched the moment its dependencies finish, not in waves |
| `scoped-retest` | Fix rounds re-verify only failing criteria, plus one full regression run |
| `direct-fix` | A first-round defect with clear evidence goes straight to a dev without a manager |
| `intake-from-story` | A story file that already has testable criteria becomes the brief directly |
| Installed renderer | The dashboard renderer is copied in, not re-typed by the harbormaster |

Stage timings are recorded too, and `PROJECT-REPORT.md` notes the slowest stage
of every run, so you can see where the time actually goes.

## Keeping token use down

Every run records what each agent used in `state.json`, and the report totals it by
role. The harbormaster's own tokens are not included, because no figure is available.

| Size | Use for | Stages skipped | Devs | Criteria (browser) |
|---|---|---|---|---|
| `--lite` | One page, endpoint or fix | Intake and manager agents | 1-2 | 8 (1) |
| `--standard` | A normal feature | None | 3-5 | 12 (3) |
| `--full` | Must be asked for by name | None | Up to 10 | 30 (no cap) |

```
/shipyard --lite add an about page
/shipyard --budget 500000 add CSV export to the reports page
```

With no size named, the harbormaster picks `lite` or `standard` and says why. It
never picks `full` itself. With `--budget`, it pauses and asks before dispatching
more agents once the run's agents have used that many tokens. There is no default
budget yet, and the count can't see your account's usage meter.

Each criterion is tagged `unit`, `api`, `command` or `browser`, and two testers
split the work. A sonnet tester checks that the named tests truly assert the
behaviour, and starts no browser. An opus tester handles the `browser` criteria: it
uses the app first, in at most 25 browser tool calls, then writes what it learned
into a Playwright check per feature at `.shipyard/checks/<feature>.check.mjs`. Each
check clicks several points across each element, because a click that lands at one point proves
little. Shipyard asks before adding Playwright to a repo.

After a fix, the harbormaster re-runs the tests and the checks itself. A tester is
needed only if the check was too weak or the fix changed it.

## Roles are files, not code

Every role is a markdown file in `agents/` with frontmatter and a system prompt:

```markdown
---
name: tester
model: sonnet
tools: [Read, Grep, Glob, Bash]
---
You are a tester. You verify acceptance criteria and report a verdict.
You do NOT fix anything...
```

**Tuning the team is editing a prompt, not editing a program.** Want devs more
conservative? Change `dev.md`. Want a different model? Change one line (`opus`,
`sonnet`, or `haiku`). Then re-run `npm run install-command`.

| Role | Model | Writes code | Decides "done" |
|---|---|---|---|
| `manager.md` | opus | no | yes — triages and assigns |
| `dev.md` | opus (sonnet for mechanical tasks) | **yes** | no |
| `tester.md` | sonnet | no | reports verdict only |
| `browser-tester.md` | opus | no | reports verdict only |
| `intake.md` | opus | no | no |
| `surveyor.md` | sonnet | no | no |
| `reporter.md` | sonnet | no | no |

Separation of duties is checked, not trusted. Testers have no write or edit
tools — but they need `Bash` to run tests, and Bash can write files, so after a
tester runs the harbormaster verifies that nothing outside `.shipyard/` changed and
fails the run if it did.

## The yard — one URL for every run

```bash
cd ~/Code/shipyard
npm run dev          # or: npm run yard — same thing
```

`/shipyard` starts this server for you, so you only need these commands to look at
the yard without a run. It's a local control room at **http://localhost:7343** listing
every Shipyard run in `~/Code` and every repo `/shipyard` has run in, newest first, with a status lamp per run
and a link into each full report. It reloads itself every 5 seconds while
anything is building.

```bash
npm run yard -- ~/work ~/Code    # watch several roots
PORT=8080 npm run yard           # different port
```

Binds to `127.0.0.1` only — nothing leaves the machine, and it serves only run
directories it actually found.

Want to see it before you've run anything?

```bash
npm run demo && npm run yard -- .demo
```

That builds a throwaway yard with three runs — one shipped, one partial after
burning all three cycles, one still building — so you can see what it looks
like in each state.

## The report

Every run produces a self-contained `report.html` — one file, data inlined, no
server, no port. Open it by double-clicking. It commits alongside the work, so
the evidence travels with the branch.

While a run is in flight the page reloads itself every 4 seconds, so it doubles
as a live view of the yard. When the run ends it stops reloading and becomes the
permanent record.

It shows the verdict, every acceptance criterion and its status, how the manager
delegated, which tasks owned which files, the tester's actual failure output,
any agents that died, and the harbormaster's log.

`.shipyard/PROJECT-REPORT.md` accumulates one entry per run against that target,
so a later run knows what was already tried and what already failed.

## Harbor Pilot: reading what it built

`/harbor` takes the many files a build wrote and lays the real code out so you can
follow it from start to finish, in the order the data moves. It is not a reviewer. It
doesn't approve, fix, or score anything. You are the reviewer.

It works like `/shipyard`: `npm run install-command` installs both, and it runs on an
ordinary Claude Code session. After a build, on the build's branch:

```
/harbor
/harbor ask "S3: why does this return 200 when the query fails?"
/harbor verify
```

`/harbor` writes `.shipyard/runs/<run-id>/REVIEW_GUIDE.md`. `/harbor ask` answers with
quoted lines and adds the question and answer to the guide's Q&A log. `/harbor verify`
re-checks every snippet in the guide against the branch.

- **The code can't be paraphrased.** Claude only cites line ranges. `tools/harbor.mjs`
  copies those lines from the commit, and refuses citations that don't exist.
- **It reads what the script hands it.** The manual tells the session to stick to the
  report, the diff, and the changed files. That is an instruction, not a sandbox: a
  session has tools. The snippet check holds either way.
- **It reads a report, not your repo's history.** Each build writes
  `.shipyard/runs/<run-id>/shipyard-report.json`. Harbor Pilot uses the newest one for
  your branch, or the one you name with `--run <id>`, and stops if it is missing or
  malformed. `.shipyard/` is left out of the diff.
- **The guide stays out of your branch.** It is listed in `.git/info/exclude`, so it
  isn't committed and doesn't block the next build's clean-tree check. Rebuilding needs
  `--force`, which keeps the old guide beside the new one.

## Two ways to run it

**Session-driven** (default, what `/shipyard` uses). Claude Code reads
`SHIPYARD.md` and acts as the harbormaster. Runs on an ordinary Claude Code
session — no separate API entitlements.

**Standalone binary** (`src/`, not wired up yet). A TypeScript program that
spawns its own agents via the Claude Agent SDK and runs unattended — you could
close the laptop on an overnight job. It covers intake → survey → plan; the
build/test/fix half is not implemented. It also needs API entitlement to the
model named in the role files, which is why the session-driven path is the
default.

```bash
npm install && npm test
```

Both read the same `agents/*.md` files and produce the same artifacts.

## Layout

```
SHIPYARD.md              the harbormaster's operating manual
agents/*.md              role definitions — edit these to tune the team
tools/build-command.mjs  bundles the above into ~/.claude/commands/shipyard.md
tools/render-report.mjs  run directory → self-contained report.html
tools/write-shipyard-report.mjs  run directory → the report Harbor Pilot reads
tools/run-check.mjs      brief and plan checks, and the token ledger
tools/serve.mjs          the yard server: every run behind one local URL
tools/yard.mjs           starts the yard server detached, for /shipyard
HARBOR.md                Harbor Pilot's manual, bundled into ~/.claude/commands/harbor.md
tools/harbor.mjs         Harbor Pilot's plain-code half: context, snippets, checks
docs/superpowers/        design spec and implementation plan
src/, tests/             the standalone binary (not wired up yet)
```

## Safety

- Writes are confined to the target repo: its working tree, its `.shipyard/`
  directory, and the survey cache under `.git/shipyard/`
- Nothing is deleted — failed cycles are archived as tags, never destroyed
- Never force-pushes, resets hard, or drops database objects
- The test command comes from the survey, not from an agent's invention, so no
  agent can substitute a weaker command to go green
- Secrets are redacted from reports and artifacts
- It does not merge and does not push

## Generated code standards

Devs are held to these:

- Parameterized queries — never string concatenation into SQL
- No credentials in source; environment variable placeholders only
- Error handling required; no bare `try` blocks or swallowed exceptions
- Code touching customer data carries a data-classification comment
- Third-party dependencies reported with their license type
- Generated queries flagged for verification against the production schema
