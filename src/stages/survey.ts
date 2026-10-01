import { readdir } from 'node:fs/promises'
import type { CodebaseMap, Brief } from '../schemas/index.js'
import type { AgentOutcome } from '../agents/spawn.js'

export type SurveyConcern = { id: string; prompt: string }

export const SURVEY_CONCERNS: readonly SurveyConcern[] = [
  { id: 'structure', prompt: 'Directory layout, language, framework, build system. Fill structure, language, framework.' },
  { id: 'tests', prompt: 'Test runner, the exact command used to run tests, coverage conventions. Fill testCommand.' },
  { id: 'conventions', prompt: 'Naming, error handling, module patterns, lint rules. Fill conventions.' },
  { id: 'documentation', prompt: 'README, docs/, CONTRIBUTING, architecture notes. Report stated intent, invariants, and rejected approaches. Fill conventions with what the docs require.' },
  { id: 'relevant', prompt: 'The modules the stated goal actually touches. Fill relevantModules.' },
]

const IGNORED = new Set(['.git', '.shipyard', '.DS_Store'])

export async function isEmptyTarget(target: string): Promise<boolean> {
  const entries = await readdir(target)
  return entries.filter(e => !IGNORED.has(e)).length === 0
}

export type SurveyDeps = {
  brief: Brief
  spawn: (args: { concernId: string; concernPrompt: string }) => Promise<AgentOutcome<CodebaseMap>>
}

export type SurveyResult = { map: CodebaseMap; costUsd: number } | { dead: string }

export async function runSurvey(deps: SurveyDeps): Promise<SurveyResult> {
  const outcomes = await Promise.all(
    SURVEY_CONCERNS.map(c => deps.spawn({ concernId: c.id, concernPrompt: c.prompt })),
  )

  const dead = outcomes.filter(o => o.status === 'dead')
  if (dead.length > 0) {
    const detail = dead.map(d => `${d.agentId} (${d.reason})`).join(', ')
    return { dead: `survey agents died: ${detail}` }
  }

  const maps = outcomes.map(o => (o as Extract<typeof o, { status: 'ok' }>).value)
  const costUsd = outcomes.reduce((sum, o) => sum + (o.status === 'ok' ? o.costUsd : 0), 0)

  // Each surveyor fills only its own fields; first non-empty value wins.
  const merged: CodebaseMap = {
    structure: maps.map(m => m.structure).find(v => v) ?? '',
    language: maps.map(m => m.language).find(v => v) ?? '',
    framework: maps.map(m => m.framework).find(v => v) ?? null,
    testCommand: maps.map(m => m.testCommand).find(v => v) ?? null,
    conventions: maps.flatMap(m => m.conventions),
    relevantModules: maps.flatMap(m => m.relevantModules),
  }

  return { map: merged, costUsd }
}
