#!/usr/bin/env node
// Installs Shipyard: SHIPYARD.md becomes one self-contained slash command at
// ~/.claude/commands/shipyard.md, so `/shipyard` works from inside ANY repo, and
// agents/*.md become agent definitions at ~/.claude/agents/shipyard-<role>.md.
//
// Why bundle: Claude Code can only read files inside the folder it was started
// in. Run from ~/Code/monitiv, it cannot reach ~/Code/shipyard. The harness
// loads command and agent files regardless of cwd.
//
// Why agent definitions rather than inlined role text: the harbormaster used to
// repeat a role in every dispatch, paying for it in each prompt and carrying
// every role in its own context. A definition also enforces the role's tool
// limits, which the Agent tool has no parameter for.
//
// SHIPYARD.md stays the single source of truth. Re-run this after editing it or
// any role file. It builds /harbor from HARBOR.md the same way, for reading a
// build afterwards.
//
//   node tools/build-command.mjs                  install to ~/.claude/
//   node tools/build-command.mjs --print          write /shipyard to stdout instead
//   node tools/build-command.mjs --print-harbor   write /harbor to stdout instead
//
// The helper scripts are NOT inlined and NOT copied into targets. They are
// installed at ~/.claude/shipyard/ and run from there, so a run leaves no stray
// files in the target's working tree.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const manual = readFileSync(join(repo, 'SHIPYARD.md'), 'utf8').trim()
const harborManual = readFileSync(join(repo, 'HARBOR.md'), 'utf8').trim()
const HELPERS = ['render-report.mjs', 'write-shipyard-report.mjs', 'run-check.mjs', 'harbor.mjs', 'serve.mjs', 'yard.mjs']
const SHIPYARD_HOME = '~/.claude/shipyard'

const ROLE_DESCRIPTIONS = {
  'browser-tester': 'Shipyard browser tester: uses the app, then scripts what it learned; fixes nothing',
  dev: 'Shipyard developer: builds one task, touching only the files it owns',
  intake: 'Shipyard intake: turns a request into a contract of acceptance criteria',
  manager: 'Shipyard manager: decomposes a goal into a task DAG, or triages defects',
  reporter: 'Shipyard reporter: writes the report a human reads instead of watching a run',
  surveyor: 'Shipyard surveyor: maps one concern of an existing repository',
  tester: 'Shipyard tester: verifies acceptance criteria and reports a verdict; fixes nothing',
}

/** One role file as an agent definition for the Claude Code harness. */
function agentDefinition(name, raw) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  if (!match) throw new Error(`agents/${name}.md is missing a frontmatter block`)
  const field = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1])?.[1]?.trim()
  const description = ROLE_DESCRIPTIONS[name]
  if (!description) throw new Error(`no description for role ${name}: add it to ROLE_DESCRIPTIONS`)
  const tools = (field('tools') ?? '').replace(/^\[|\]$/g, '')
  // The browser tester needs browser tools, whose names vary by machine, so it
  // cannot be given an allowlist. It denies the tools that write or delegate
  // instead, and pays for loading every tool definition, which is why it is a
  // separate agent from the tester rather than the one agent for all testing.
  const access = name === 'browser-tester' ? 'disallowedTools: Write, Edit, NotebookEdit, Agent' : `tools: ${tools}`
  const permissionMode = field('permissionMode')
  return [
    '---',
    `name: shipyard-${name}`,
    // Quoted: an unquoted ": " inside a YAML value is a parse error.
    `description: ${JSON.stringify(description)}`,
    `model: ${field('model')}`,
    access,
    ...(permissionMode ? [`permissionMode: ${permissionMode}`] : []),
    '---',
    match[2].trim(),
    '',
  ].join('\n')
}

const roles = readdirSync(join(repo, 'agents'))
  .filter(f => f.endsWith('.md'))
  .sort()
  .map(f => f.replace(/\.md$/, ''))
  .map(name => ({ name, definition: agentDefinition(name, readFileSync(join(repo, 'agents', `${name}.md`), 'utf8')) }))

if (roles.length === 0) {
  console.error('no role files found in agents/ — refusing to build an empty command')
  process.exit(1)
}

const command = `---
description: Pilot Shipyard into the current repo — plan, build, test, and fix a feature autonomously
argument-hint: [--lite|--standard|--full] [--budget <tokens>] <feature request, or path to a story file>
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent, TaskCreate, TaskUpdate, mcp__Claude_Browser__preview_start
---

# Shipyard — pilot in

You are the **harbormaster**. Everything you need is in this file; do not try to
read \`SHIPYARD.md\` from disk, because the Shipyard repo is outside this session's
reach.

## This invocation

**The target repository is the current working directory.** You are already
standing in it. Do not ask for a path and do not operate on any other repo.

**The feature request is:** \`$ARGUMENTS\`

First take off any \`--lite\`, \`--standard\` or \`--full\` (the run's size) and any
\`--budget <tokens>\` (recorded as \`budgetTokens\`). Interpret the rest like this:

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

## Helper scripts and agents

Wherever the manual says \`<shipyard>/tools/<script>\`, run
\`${SHIPYARD_HOME}/<script>\`. Run these from there and **never copy them into this
repo**. Do not read them or write your own. If one is missing, stop and tell the
user to run \`npm run install-command\` in their Shipyard checkout.

The roles are installed as \`shipyard-<role>\` agents. If the Agent tool does not
know one, this session started before the install: \`cat\` the role from
\`~/.claude/agents/shipyard-<role>.md\` and pass its body in a \`general-purpose\`
agent's prompt, with its \`model\`. Tell a tester's copy about its write limits,
since nothing enforces them there.

## The live yard view

**After every stage transition and every agent you spawn, finish, or lose**, run:

\`\`\`bash
node ${SHIPYARD_HOME}/render-report.mjs .shipyard/runs/<run-id>
\`\`\`

It regenerates \`report.html\`, which reloads itself every 4 seconds while the run is
in flight and stops when it ends, so the user can keep one tab open and watch.

**Open the live view as soon as \`state.json\` first exists**, without being asked:

\`\`\`bash
node ${SHIPYARD_HOME}/yard.mjs .shipyard/runs/<run-id>
\`\`\`

It starts the yard server if needed, returns at once, and prints the run's URL. Never
start the server any other way, because \`npm run yard\` never returns. If you have
\`mcp__Claude_Browser__preview_start\`, call it with that \`url\`, which shows the run in
this desktop session. Do not open \`report.html\` there, because the pane shows local
files as snapshots that never update. Otherwise give the user the URL. **A view that
fails to start never stops the run:** give the user the path to \`report.html\`, and
carry on.

Rendering is one cheap local \`node\` call, so do it liberally. Never read its output
beyond the path it prints.

## Reporting back

When finished, tell the user: the branch name, the verdict, how many cycles it
took, the path to \`report.html\`, and that running \`/harbor\` on this branch lays
the code out for review. Then stop.

---

${manual}

`

const HARBOR = `${SHIPYARD_HOME}/harbor.mjs`
const harborCommand = `---
description: Lay a Shipyard build out so you can read it start to finish, then ask about any step
argument-hint: [ask "<question>" | verify] [--run <id>] [--force]
allowed-tools: Read, Write, Bash(node ${HARBOR}:*)
---

# Harbor Pilot

Everything you need is in this file; do not try to read \`HARBOR.md\` from disk.

## This invocation

**The repo is the current working directory**, on the branch of the build.

**The arguments are:** \`$ARGUMENTS\`

- **Starts with \`ask\`** — the rest is the question. Follow *Answering a question*.
- **Starts with \`verify\`** — run \`node ${HARBOR} verify\` and report what it says.
- **Anything else** — follow *Building the guide*.

Pass any \`--run <id>\` on to every script call. Pass \`--force\` on to \`prepare\`.

If \`${HARBOR}\` is missing, stop and tell the user to run \`npm run install-command\`
in their Shipyard checkout.

## The script

Call it exactly like this, and do not read its source:

\`\`\`bash
node ${HARBOR} prepare
node ${HARBOR} render
node ${HARBOR} ask-append
node ${HARBOR} ask-prepare <<'HARBOR_QUESTION'
the question, word for word
HARBOR_QUESTION
\`\`\`

---

${harborManual}
`

if (process.argv.includes('--print')) {
  process.stdout.write(command)
  process.exit(0)
}
if (process.argv.includes('--print-harbor')) {
  process.stdout.write(harborCommand)
  process.exit(0)
}

const dir = join(homedir(), '.claude', 'commands')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'shipyard.md')
writeFileSync(out, command)
const harborOut = join(dir, 'harbor.md')
writeFileSync(harborOut, harborCommand)

const home = join(homedir(), '.claude', 'shipyard')
mkdirSync(home, { recursive: true })
for (const helper of HELPERS) copyFileSync(join(repo, 'tools', helper), join(home, helper))

const agentsDir = join(homedir(), '.claude', 'agents')
mkdirSync(agentsDir, { recursive: true })
for (const role of roles) writeFileSync(join(agentsDir, `shipyard-${role.name}.md`), role.definition)

const kb = (command.length / 1024).toFixed(1)
console.log(`installed ${out}`)
console.log(`installed ${harborOut}`)
for (const helper of HELPERS) console.log(`installed ${join(home, helper)}`)
console.log(`installed ${roles.length} agents in ${agentsDir}: ${roles.map(r => `shipyard-${r.name}`).join(', ')}`)
console.log('  start a new Claude Code session so it picks up the agents')
console.log(`  ${kb} KB — /shipyard and /harbor now work from inside any repo`)
