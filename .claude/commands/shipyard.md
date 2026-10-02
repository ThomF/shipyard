---
description: Run the Shipyard autonomous dev team circuit against a target repo
argument-hint: <target-repo-path> "<feature request>"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent, TaskCreate, TaskUpdate
---

Run the Shipyard circuit.

**Arguments:** `$ARGUMENTS` — the first token is the target repository path, the
rest is the feature request.

Before anything else, read `SHIPYARD.md` in this repository. It is your full
operating manual: the circuit, the role files, the cycle and fix-round budgets,
the death-and-respawn behavior, and the safety rules. Follow it exactly.

Then:

1. Resolve the target path and confirm it is a git repository with a clean
   working tree. Stop and tell the user if it is dirty.
2. Run the preflight in `SHIPYARD.md` — branch, run directory, project report.
3. Work the circuit: intake → survey → plan → build → test → triage/fix →
   report. Three fix rounds per cycle, three cycles maximum.
4. Finish by telling the user the branch name, the verdict, and the path to
   `report.html`.

Two reminders that matter more than the rest:

- **Keep your own context small.** Every subagent writes its full report to a
  file and returns under 150 words. Your durable memory is `state.json` and
  `ledger.md`, not this conversation.
- **Do not merge or push.** The branch is for the user to review.

If the request is ambiguous enough that intake would be guessing at what "done"
means, ask the user one clarifying question before starting rather than burning
a cycle on the wrong contract.
