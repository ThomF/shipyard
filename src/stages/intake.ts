import { zodToJsonSchema } from 'zod-to-json-schema'
import { BriefSchema, type Brief } from '../schemas/index.js'
import type { AgentOutcome } from '../agents/spawn.js'
import { buildIntakePrompt } from '../prompts/intake.js'

export type IntakeDeps = {
  idea: string
  projectReport: string | null
  spawn: (args: { prompt: string; jsonSchema: Record<string, unknown> }) => Promise<AgentOutcome<Brief>>
}

export type IntakeResult = { brief: Brief; costUsd: number } | { dead: string }

export async function runIntake(deps: IntakeDeps): Promise<IntakeResult> {
  const prompt = buildIntakePrompt({ idea: deps.idea, projectReport: deps.projectReport })
  const jsonSchema = zodToJsonSchema(BriefSchema) as Record<string, unknown>

  const outcome = await deps.spawn({ prompt, jsonSchema })
  if (outcome.status === 'dead') {
    return { dead: `intake agent died (${outcome.reason}): ${outcome.detail}` }
  }

  const brief = outcome.value

  // A brief whose criteria cannot be checked makes every downstream stage meaningless.
  if (!brief.acceptanceCriteria.some(c => c.verifiable)) {
    return { dead: 'intake produced no verifiable acceptance criteria' }
  }

  const ids = brief.acceptanceCriteria.map(c => c.id)
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (duplicates.length > 0) {
    return { dead: `intake produced duplicate criterion ids: ${[...new Set(duplicates)].join(', ')}` }
  }

  return { brief, costUsd: outcome.costUsd }
}
