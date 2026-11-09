import { afterEach, describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const YARD = join(repo, 'tools', 'yard.mjs')

// Each test gets its own range, so a run of the suite never meets a real yard.
let nextPort = 17400 + Math.floor(Math.random() * 2000)
const started: number[] = []
const blockers: Server[] = []

afterEach(async () => {
  for (const port of started.splice(0)) {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()).catch(() => null) as { pid?: number } | null
    if (health?.pid) process.kill(health.pid)
  }
  for (const b of blockers.splice(0)) b.close()
})

/** Runs yard.mjs and resolves as soon as it exits, proving it does not block. */
function yard(runDir: string, home: string, port: number, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn('node', [YARD, runDir], {
      env: { ...process.env, HOME: home, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', code => done({ code, out: out.trim(), err }))
  })
}

async function target() {
  const home = await mkdtemp(join(tmpdir(), 'yard-home-'))
  const dir = await mkdtemp(join(tmpdir(), 'yard-target-'))
  const runDir = join(dir, '.shipyard', 'runs', 'r1')
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'state.json'), JSON.stringify({ runId: 'r1', stage: 'build', verdict: 'pending', request: 'do a thing' }))
  const port = nextPort
  nextPort += 20
  started.push(port, port + 1)
  return { home, dir, runDir, port }
}

describe('yard', () => {
  it('starts a detached server for a repo outside its roots and prints the run URL', async () => {
    const t = await target()
    const r = await yard(t.runDir, t.home, t.port)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toBe(`http://localhost:${t.port}/r?d=${encodeURIComponent(t.runDir)}`)

    // The script has exited, so the server answering now means it outlived the caller.
    const res = await fetch(r.out.replace('localhost', '127.0.0.1'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('SHIPYARD')
    expect(JSON.parse(await readFile(join(t.home, '.claude', 'shipyard', 'yard-roots.json'), 'utf8'))).toContain(t.dir)
  })

  it('reuses a running server, and finds a second repo through it', async () => {
    const t = await target()
    await yard(t.runDir, t.home, t.port)
    const first = await fetch(`http://127.0.0.1:${t.port}/health`).then(r => r.json()) as { pid: number }

    const otherDir = await mkdtemp(join(tmpdir(), 'yard-other-'))
    const otherRun = join(otherDir, '.shipyard', 'runs', 'r2')
    await mkdir(otherRun, { recursive: true })
    await writeFile(join(otherRun, 'state.json'), JSON.stringify({ runId: 'r2', stage: 'plan', verdict: 'pending' }))

    const r = await yard(otherRun, t.home, t.port)
    expect(r.code).toBe(0)
    expect(r.out).toContain(`localhost:${t.port}/`)
    const second = await fetch(`http://127.0.0.1:${t.port}/health`).then(r => r.json()) as { pid: number }
    expect(second.pid).toBe(first.pid)
  })

  it('moves to the next port when something else holds the first', async () => {
    const t = await target()
    const blocker = createServer((_req, res) => { res.writeHead(404); res.end() })
    blockers.push(blocker)
    await new Promise<void>(done => blocker.listen(t.port, '127.0.0.1', done))

    const r = await yard(t.runDir, t.home, t.port)
    expect(r.code).toBe(0)
    expect(r.out).toContain(`localhost:${t.port + 1}/`)
  })

  it('leaves a finished run\'s committed report alone, and keeps rendering a live one', async () => {
    const t = await target()
    await writeFile(join(t.runDir, 'state.json'), JSON.stringify({ runId: 'r1', stage: 'done', verdict: 'shipped' }))
    await writeFile(join(t.runDir, 'report.html'), '<html><body>committed</body></html>')
    const url = (await yard(t.runDir, t.home, t.port)).out.replace('localhost', '127.0.0.1')
    expect(await readFile(join(t.runDir, 'report.html'), 'utf8')).toBe('<html><body>committed</body></html>')

    await new Promise(done => setTimeout(done, 2100)) // Past the server's scan cache.
    await writeFile(join(t.runDir, 'state.json'), JSON.stringify({ runId: 'r1', stage: 'build', verdict: 'pending' }))
    await new Promise(done => setTimeout(done, 2100))
    await fetch(url)
    expect(await readFile(join(t.runDir, 'report.html'), 'utf8')).toContain('run-data')
  })

  it('fails without blocking when the run does not exist', async () => {
    const t = await target()
    const r = await yard(join(t.dir, 'nope'), t.home, t.port)
    expect(r.code).toBe(1)
    expect(r.err).toContain('no such run directory')
  })

  it('shuts itself down once idle', async () => {
    const t = await target()
    await yard(t.runDir, t.home, t.port, { YARD_IDLE_MS: '1500' })
    await new Promise(done => setTimeout(done, 3500))
    await expect(fetch(`http://127.0.0.1:${t.port}/health`)).rejects.toThrow()
  })
})
