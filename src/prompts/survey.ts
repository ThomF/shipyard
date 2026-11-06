import type { Brief } from '../schemas/index.js'

export function buildSurveyPrompt(args: { brief: Brief; concernPrompt: string }): string {
  return [
    'You are surveying an existing repository. Cover ONLY the concern(s) below.',
    '',
    'CONCERNS',
    args.concernPrompt,
    '',
    'THE WORK THIS SURVEY SUPPORTS',
    args.brief.goal,
    '',
    'Report what you actually found. If something is absent, say it is absent.',
    'Leave fields outside your concern empty rather than guessing at them.',
  ].join('\n')
}
