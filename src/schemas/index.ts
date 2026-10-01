import { z } from 'zod'

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  verifiable: z.boolean(),
})

export const BriefSchema = z.object({
  goal: z.string().min(1),
  stack: z.array(z.string()),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  risks: z.array(z.string()),
})

export const CodebaseMapSchema = z.object({
  structure: z.string(),
  language: z.string(),
  framework: z.string().nullable(),
  testCommand: z.string().nullable(),
  conventions: z.array(z.string()),
  relevantModules: z.array(z.object({ path: z.string(), why: z.string() })),
})

export const PlanTaskSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  dependsOn: z.array(z.string()),
  ownsFiles: z.array(z.string()).min(1),
  criteriaIds: z.array(z.string()),
})

export const PlanSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(PlanTaskSchema).min(1),
})

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>
export type Brief = z.infer<typeof BriefSchema>
export type CodebaseMap = z.infer<typeof CodebaseMapSchema>
export type PlanTask = z.infer<typeof PlanTaskSchema>
export type Plan = z.infer<typeof PlanSchema>
