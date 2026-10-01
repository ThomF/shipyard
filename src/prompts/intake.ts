export function buildIntakePrompt(args: { idea: string; projectReport: string | null }): string {
  const parts = [
    'Turn the following idea into an explicit contract.',
    '',
    'IDEA',
    args.idea,
  ]

  if (args.projectReport) {
    parts.push(
      '',
      'HISTORY OF PREVIOUS RUNS AGAINST THIS TARGET',
      'Do not re-attempt an approach recorded here as failed. Build on what already exists.',
      args.projectReport,
    )
  }

  parts.push(
    '',
    'Produce acceptance criteria specific enough that a tester can return pass or fail',
    'without judgement. Record anything you were not told as an assumption.',
  )
  return parts.join('\n')
}
