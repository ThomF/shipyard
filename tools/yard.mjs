#!/usr/bin/env node
// Makes sure the yard server is up, without ever blocking the caller, and prints
// the URL of one run.
//
//   node yard.mjs <target>/.shipyard/runs/<run-id>
//
// The server has to outlive this call, and a command that never returns would hang
// until the shell timed it out and killed it. So the server starts detached, an
// already running one is reused, and this script exits as soon as the page answers.
//
// A run must carry on if its view cannot start, so failing here only means exit 1.
//
// No dependencies: this file is copied into ~/.claude/shipyard and run from there.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'serve.mjs')
const ROOTS_FILE = join(homedir(), '.claude', 'shipyard', 'yard-roots.json')
const BASE_PORT = Number(process.env.PORT || 7343)
const PORTS_TO_TRY = 10
const STARTUP_MS = 5000
// A started server goes away on its own once nobody has looked at it for this long.
const IDLE_MS = process.env.YARD_IDLE_MS || String(2 * 60 * 60 * 1000)

const sleep = (ms) => new Promise(done => setTimeout(done, ms))

function fail(message) {
  console.error(`yard: ${message}`)
  process.exit(1)
}

const runArg = process.argv[2]
if (!runArg) fail('usage: yard.mjs <run-dir>')
const runDir = resolve(runArg)
if (!existsSync(runDir)) fail(`no such run directory: ${runDir}`)

/** Tell the server about this repo, which may be outside the roots it scans. */
function registerRoot(root) {
  let roots = []
  try {
    roots = JSON.parse(readFileSync(ROOTS_FILE, 'utf8'))
  } catch {
    // No file yet, or a damaged one: start the list again.
  }
  const next = [...new Set([...(Array.isArray(roots) ? roots : []), root])].filter(existsSync)
  mkdirSync(dirname(ROOTS_FILE), { recursive: true })
  writeFileSync(ROOTS_FILE, `${JSON.stringify(next, null, 2)}\n`)
}

async function isYard(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok && (await res.json()).yard === true
  } catch {
    return false
  }
}

/** Starts a server on this port. False if the port is taken by something else. */
async function startOn(port) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), YARD_IDLE_MS: IDLE_MS },
  })
  let exited = false
  child.on('exit', () => { exited = true })
  child.on('error', () => { exited = true })
  child.unref()

  const deadline = Date.now() + STARTUP_MS
  while (Date.now() < deadline) {
    if (await isYard(port)) return true
    if (exited) return false
    await sleep(100)
  }
  return false
}

async function findYard() {
  for (let port = BASE_PORT; port < BASE_PORT + PORTS_TO_TRY; port++) {
    if (await isYard(port) || await startOn(port)) return port
  }
  return null
}

registerRoot(resolve(runDir, '..', '..', '..'))
const port = await findYard()
if (port === null) fail(`could not start the yard on ports ${BASE_PORT}-${BASE_PORT + PORTS_TO_TRY - 1}`)

// The server reuses a scan for a moment, so a new run can take a little to appear.
const path = `/r?d=${encodeURIComponent(runDir)}`
const deadline = Date.now() + STARTUP_MS
for (;;) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`).catch(() => null)
  if (res?.ok) break
  if (Date.now() > deadline) fail(`the yard is up on port ${port} but cannot show ${runDir}; does it have a state.json?`)
  await sleep(200)
}
console.log(`http://localhost:${port}${path}`)
