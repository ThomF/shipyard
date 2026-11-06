import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Role = 'intake' | 'surveyor' | 'manager' | 'dev' | 'tester' | 'reporter'

export type RoleDefinition = {
  name: Role
  model: string
  tools: string[]
  permissionMode: 'default' | 'acceptEdits'
  delegatesTo: Role[]
  systemPrompt: string
}

const READ_ONLY = ['Read', 'Grep', 'Glob']

/** Maximum tools any role file may claim. Files may narrow this; never widen it. */
export const PERMISSION_FLOOR: Record<Role, readonly string[]> = {
  intake: READ_ONLY,
  surveyor: READ_ONLY,
  manager: READ_ONLY,
  reporter: READ_ONLY,
  tester: [...READ_ONLY, 'Bash'],
  dev: [...READ_ONLY, 'Write', 'Edit', 'Bash'],
}

export function canWriteFiles(role: Role): boolean {
  return PERMISSION_FLOOR[role].includes('Write')
}

function defaultAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents')
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('role file is missing a --- frontmatter block')
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { fields, body: match[2] ?? '' }
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean)
}

export async function loadRole(role: Role, dir = defaultAgentsDir()): Promise<RoleDefinition> {
  const path = join(dir, `${role}.md`)
  const { fields, body } = parseFrontmatter(await readFile(path, 'utf8'))

  if (fields.name !== role) {
    throw new Error(`${path} declares name "${fields.name}" but was loaded as role "${role}"`)
  }
  const systemPrompt = body.trim()
  if (!systemPrompt) throw new Error(`${path} has an empty system prompt`)

  const declared = parseList(fields.tools)
  const floor = PERMISSION_FLOOR[role]
  const widened = declared.filter(t => !floor.includes(t))
  if (widened.length > 0) {
    throw new Error(
      `${path} declares tools not permitted for role ${role}: ${widened.join(', ')}. ` +
      `Role files may narrow permissions but never widen them.`,
    )
  }

  const mode = fields.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default'
  return {
    name: role,
    model: fields.model || 'opus',
    tools: declared.length > 0 ? declared : [...floor],
    permissionMode: canWriteFiles(role) ? mode : 'default',
    delegatesTo: parseList(fields.delegatesTo) as Role[],
    systemPrompt,
  }
}
