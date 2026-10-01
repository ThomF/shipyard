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
