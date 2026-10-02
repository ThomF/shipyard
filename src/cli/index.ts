#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { z } from 'zod'
import { loadRole } from '../agents/roles.js'
import { spawnAgent, type QueryFn } from '../agents/spawn.js'
import { runThroughPlan } from '../harbormaster/run.js'
import { runIntake } from '../stages/intake.js'
import { runSurvey } from '../stages/survey.js'
import { runPlan } from '../stages/plan.js'
import { buildSurveyPrompt } from '../prompts/survey.js'
import { runPaths } from '../state/paths.js'
import { buildDigest } from '../digest/digest.js'
import { BriefSchema, CodebaseMapSchema, PlanSchema } from '../schemas/index.js'
import { renderPlanSummary, timestampSlug } from './render.js'

const AGENT_TIMEOUT_MS = 15 * 60 * 1000

const ManagerOutputSchema = z.object({ plan: PlanSchema, spec: z.string().min(1) })

// The SDK's query() yields its own SDKMessage union; spawnAgent only needs to read
// `.type`, `.subtype`, `.structured_output`, and `.total_cost_usd` off each message.
// This adapter narrows the SDK type to the structural shape spawnAgent declares.
// If this cast fails to compile, widen QueryFn's element type rather than loosening spawnAgent.
const sdkQuery = query as unknown as QueryFn

async function readProjectReport(target: string): Promise<string | null> {
  try {
    return await readFile(join(target, '.shipyard', 'PROJECT-REPORT.md'), 'utf8')
  } catch {
    return null
  }
}

const program = new Command()
program.name('shipyard').description('Autonomous development team')

program
  .command('run')
  .argument('<idea>', 'what you want built')
  .requiredOption('--target <path>', 'directory to build in or against')
  .option('--dry-run', 'stop after planning and print the plan')
  .action(async (idea: string, opts: { target: string; dryRun?: boolean }) => {
    const target = resolve(opts.target)
    const runId = `${timestampSlug(new Date())}-001`
    const paths = runPaths(target, runId)

    const agentCounter = { n: 0 }
    const nextAgentId = (role: string) => `${role}-${String(++agentCounter.n).padStart(3, '0')}`

    const outcome = await runThroughPlan({
      target, idea, runId, createdAt: new Date().toISOString(),

      intake: async () => {
        const role = await loadRole('intake')
        console.log(pc.dim('  intake...'))
        return runIntake({
          idea, projectReport: await readProjectReport(target),
          spawn: ({ prompt, jsonSchema }) => {
            const agentId = nextAgentId('intake')
            return spawnAgent({
              role, agentId, prompt, schema: BriefSchema, jsonSchema, cwd: target,
              transcriptPath: join(paths.agentsDir, `${agentId}.jsonl`),
              timeoutMs: AGENT_TIMEOUT_MS, query: sdkQuery,
            })
          },
        })
      },

      survey: async (brief) => {
        const role = await loadRole('surveyor')
        console.log(pc.dim('  survey...'))
        return runSurvey({
          brief,
          spawn: ({ concernId, concernPrompt }) => {
            const agentId = nextAgentId(`survey-${concernId}`)
            return spawnAgent({
              role, agentId,
              prompt: buildSurveyPrompt({ brief, concernPrompt }),
              schema: CodebaseMapSchema,
              jsonSchema: zodToJsonSchema(CodebaseMapSchema) as Record<string, unknown>,
              cwd: target,
              transcriptPath: join(paths.agentsDir, `${agentId}.jsonl`),
              timeoutMs: AGENT_TIMEOUT_MS, query: sdkQuery,
            })
          },
        })
      },

      plan: async (brief, map) => {
        const role = await loadRole('manager')
        console.log(pc.dim('  plan...'))
        return runPlan({
          brief, map, maxAttempts: 3,
          digest: buildDigest({
            state: { runId, target, idea, createdAt: '', stage: 'plan', completedStages: [],
                     cycle: 1, maxCycles: 3, totalCostUsd: 0, deaths: [], verdict: 'pending' },
            brief,
          }),
          spawn: ({ prompt }) => {
            const agentId = nextAgentId('manager')
            return spawnAgent({
              role, agentId, prompt,
              schema: ManagerOutputSchema,
              jsonSchema: zodToJsonSchema(ManagerOutputSchema) as Record<string, unknown>,
              cwd: target,
              transcriptPath: join(paths.agentsDir, `${agentId}.jsonl`),
              timeoutMs: AGENT_TIMEOUT_MS, query: sdkQuery,
            })
          },
        })
      },
    })

    if (!outcome.ok) {
      console.error(pc.red(`\nFailed during ${outcome.state.stage}: ${outcome.reason}`))
      console.error(pc.dim(`Run directory: ${paths.root}`))
      process.exitCode = 1
      return
    }

    const plan = PlanSchema.parse(JSON.parse(await readFile(outcome.planPath, 'utf8')))
    console.log('\n' + renderPlanSummary(plan))
    console.log(pc.dim(`\nCost so far: $${outcome.state.totalCostUsd.toFixed(2)}`))
    console.log(pc.dim(`Spec page:   ${join(paths.cycleDir(1), 'spec.md')}`))

    if (opts.dryRun) {
      console.log(pc.yellow('\n--dry-run: stopping before build.'))
      return
    }
    console.log(pc.yellow('\nBuild stage is not implemented yet. Re-run with --dry-run.'))
  })

program.parse()
