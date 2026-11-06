#!/usr/bin/env node
// Bundles SHIPYARD.md + agents/*.md into one self-contained slash command at
// ~/.claude/commands/shipyard.md, so `/shipyard` works from inside ANY repo.
//
// Why bundle: Claude Code can only read files inside the folder it was started
// in. Run from ~/Code/monitiv, it cannot reach ~/Code/shipyard. The harness
// loads command files regardless of cwd, so everything the harbormaster needs
// has to live inside the command itself.
//
// SHIPYARD.md stays the single source of truth. Re-run this after editing it or
// any role file.
//
//   node tools/build-command.mjs            install to ~/.claude/commands/
//   node tools/build-command.mjs --print    write to stdout instead
//
// The report renderer is NOT inlined into the command. It is installed beside
// it at ~/.claude/shipyard/render-report.mjs and copied into each target with
// one `cp`. Inlining it meant the harbormaster had to re-type ~16 KB of
// JavaScript verbatim at the start of every run: slow, token-expensive, and a
// single transcription slip broke the live view.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const manual = readFileSync(join(repo, 'SHIPYARD.md'), 'utf8').trim()
const RENDERER_SRC = join(repo, 'tools', 'render-report.mjs')
const SHIPYARD_HOME = '~/.claude/shipyard'

const roles = readdirSync(join(repo, 'agents'))
  .filter(f => f.endsWith('.md'))
  .sort()
  .map(f => ({ name: f.replace(/\.md$/, ''), body: readFileSync(join(repo, 'agents', f), 'utf8').trim() }))

if (roles.length === 0) {
  console.error('no role files found in agents/ — refusing to build an empty command')
  process.exit(1)
}

const command = `---
description: Pilot Shipyard into the current repo — plan, build, test, and fix a feature autonomously
argument-hint: <feature request, or path to a story file in this repo>
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent, TaskCreate, TaskUpdate
---

# Shipyard — pilot in

You are the **harbormaster**. Everything you need is in this file; do not try to
read \`SHIPYARD.md\` or \`agents/*.md\` from disk, because the Shipyard repo is
outside this session's reach. The role definitions are inlined at the end.

## This invocation

**The target repository is the current working directory.** You are already
standing in it. Do not ask for a path and do not operate on any other repo.

**The feature request is:** \`$ARGUMENTS\`

Interpret it like this:

- **A path that exists in this repo** (e.g. \`docs/stories/CSV-EXPORT.md\`) — read
  that file; its contents are the feature request. Treat any acceptance criteria
  it already states as authoritative rather than inventing your own.
- **Prose** — that is the request as written.
- **Empty** — look for likely sources of work in this repo (a \`docs/stories/\`
  directory, recent specs, a TODO section in the README) and ask the user which
  one to build, listing what you found. Do not guess.

Before starting, if the request is vague enough that "done" cannot be defined
without guessing, ask **one** clarifying question. A wrong contract wastes a
whole cycle.

## The live yard view

During preflight, install the renderer into this repo with one command. Do not
write it by hand and do not read it; just copy it:

\`\`\`bash
mkdir -p .shipyard && cp ${SHIPYARD_HOME}/render-report.mjs .shipyard/render-report.mjs
\`\`\`

If that file is missing, stop and tell the user to run
\`npm run install-command\` in their Shipyard checkout. Do not improvise a
renderer.

Then, **after every stage transition and every agent you spawn, finish, or
lose**, run:

\`\`\`bash
node .shipyard/render-report.mjs .shipyard/runs/<run-id>
\`\`\`

It regenerates \`report.html\`. While the run is in flight that page reloads
itself every 4 seconds, so the user keeps one tab open and watches the yard
work: criteria flipping, tasks completing, crew timers ticking, files changing
in the working tree, agents dying and respawning. When the run ends it stops
reloading on its own.

Tell the user the path to \`report.html\` **as soon as it first exists**, not at
the end. Also mention that \`npm run yard\` in their Shipyard checkout gives a
fully live view at http://localhost:7343 that re-renders on every refresh, so
it shows files changing even while a dev is mid-task.

Re-rendering is cheap and local. Do it liberally; a stale page is worse than a
redundant render. Rendering is a single \`node\` call: never read its output
back into your context beyond the path it prints.

## Reporting back

When finished, tell the user: the branch name, the verdict, how many cycles it
took, and the path to \`report.html\`. Then stop.

---

${manual}

---

# ROLE DEFINITIONS

These are the role files referenced throughout the manual above, inlined. When
the manual says "spawn an agent with \`agents/dev.md\`", use the **dev** section
below as that subagent's instructions, give it exactly the tools its
frontmatter lists, and pass its frontmatter \`model\` (\`opus\` or \`sonnet\`)
as the Agent tool's \`model\` parameter. The split is deliberate: roles that
decide (intake, manager, dev, tester) run on opus; roles that read and
summarise (surveyor, reporter) run on sonnet, which is much faster.

${roles.map(r => `## Role: ${r.name}\n\n\`\`\`markdown\n${r.body}\n\`\`\``).join('\n\n')}

`

if (process.argv.includes('--print')) {
  process.stdout.write(command)
  process.exit(0)
}

const dir = join(homedir(), '.claude', 'commands')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'shipyard.md')
writeFileSync(out, command)

const home = join(homedir(), '.claude', 'shipyard')
mkdirSync(home, { recursive: true })
copyFileSync(RENDERER_SRC, join(home, 'render-report.mjs'))

const kb = (command.length / 1024).toFixed(1)
console.log(`installed ${out}`)
console.log(`installed ${join(home, 'render-report.mjs')}`)
console.log(`  ${roles.length} roles bundled: ${roles.map(r => r.name).join(', ')}`)
console.log(`  ${kb} KB — /shipyard now works from inside any repo`)
