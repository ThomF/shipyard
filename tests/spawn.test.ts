import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { spawnAgent, type QueryFn } from '../src/agents/spawn.js'
import type { RoleDefinition } from '../src/agents/roles.js'

const role: RoleDefinition = {
  name: 'tester',
  model: 'opus',
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
    expect(seen.options.model).toBe('opus')
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

  // Fix round 1, finding 1: a filesystem failure preparing the transcript must be a dead
  // agent, not a thrown promise. Callers branch on `status`; they do not wrap in try/catch.
  it('is dead when the transcript directory cannot be created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-spawn-'))
    const blocker = join(dir, 'afile')
    await writeFile(blocker, 'not a directory')
    const opts = await base({
      cwd: dir,
      // Parent is a regular file, so mkdir -p fails with ENOTDIR.
      transcriptPath: join(blocker, 'sub', 'x.jsonl'),
      query: fakeQuery([
        { type: 'result', subtype: 'success', structured_output: { passed: true }, total_cost_usd: 0 },
      ]),
    })
    const out = await spawnAgent(opts as never)
    expect(out.status).toBe('dead')
    if (out.status === 'dead') {
      expect(out.reason).toBe('error')
      expect(out.detail).toMatch(/ENOTDIR|ENOENT|EEXIST/)
    }
  })

  // Fix round 1, finding 2: the wall clock must force a return. A query that ignores the
  // AbortSignal and never settles must not stall the orchestrator forever.
  it('is dead with reason timeout when the stream never settles at all', async () => {
    const opts = await base({
      timeoutMs: 20,
      // Never yields, never returns, never throws, and ignores the abort signal.
      query: () => (async function* () {
        await new Promise(() => {})
        yield { type: 'result', subtype: 'success' } as never
      })(),
    })
    const started = Date.now()
    const out = await spawnAgent(opts as never)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(out.status).toBe('dead')
    if (out.status === 'dead') expect(out.reason).toBe('timeout')
  }, 3000)
})
