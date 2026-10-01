import { writeFile, readFile, rename } from 'node:fs/promises'
import { z } from 'zod'

export const StageSchema = z.enum([
  'intake', 'survey', 'plan', 'build', 'integrate', 'verify', 'report', 'done',
])
export type Stage = z.infer<typeof StageSchema>

export const RunStateSchema = z.object({
  runId: z.string().min(1),
  target: z.string().min(1),
  idea: z.string().min(1),
  createdAt: z.string(),
  stage: StageSchema,
  completedStages: z.array(StageSchema),
  cycle: z.number().int().min(1),
  maxCycles: z.number().int().min(1),
  totalCostUsd: z.number().min(0),
  deaths: z.array(z.object({ agentId: z.string(), reason: z.string(), detail: z.string() })),
  verdict: z.enum(['pending', 'shipped', 'partial', 'failed']),
})
export type RunState = z.infer<typeof RunStateSchema>

export function newRunId(timestamp: string, seq: number): string {
  return `${timestamp}-${String(seq).padStart(3, '0')}`
}

export function initState(args: {
  runId: string; target: string; idea: string; createdAt: string; maxCycles?: number
}): RunState {
  return {
    runId: args.runId,
    target: args.target,
    idea: args.idea,
    createdAt: args.createdAt,
    stage: 'intake',
    completedStages: [],
    cycle: 1,
    maxCycles: args.maxCycles ?? 3,
    totalCostUsd: 0,
    deaths: [],
    verdict: 'pending',
  }
}

export async function writeState(path: string, state: RunState): Promise<void> {
  RunStateSchema.parse(state)
  const tmp = `${path}.writing`
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, path)
}

export async function readState(path: string): Promise<RunState> {
  return RunStateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}
