import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRole, canWriteFiles, PERMISSION_FLOOR } from '../src/agents/roles.js'

describe('loadRole', () => {
  it('loads the shipped manager definition', async () => {
    const r = await loadRole('manager')
    expect(r.name).toBe('manager')
    expect(r.model).toBe('opus')
    expect(r.delegatesTo).toContain('dev')
    expect(r.systemPrompt.length).toBeGreaterThan(0)
  })

  it('gives devs write tools and acceptEdits mode', async () => {
    const r = await loadRole('dev')
    expect(r.tools).toContain('Write')
    expect(r.tools).toContain('Edit')
    expect(r.permissionMode).toBe('acceptEdits')
  })

  it('gives testers Bash but never Write or Edit', async () => {
    const r = await loadRole('tester')
    expect(r.tools).toContain('Bash')
    expect(r.tools).not.toContain('Write')
    expect(r.tools).not.toContain('Edit')
  })

  it('denies managers Bash and every write tool', async () => {
    const r = await loadRole('manager')
    for (const forbidden of ['Write', 'Edit', 'Bash']) {
      expect(r.tools).not.toContain(forbidden)
    }
  })

  it('lets a role file narrow its tools below the floor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'dev.md'), '---\nname: dev\nmodel: m\ntools: [Read]\n---\nbody')
    const r = await loadRole('dev', dir)
    expect(r.tools).toEqual(['Read'])
  })

  // The safety boundary: editing a role file must not be able to weaken separation of duties
  it('rejects a role file that widens tools past the floor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'tester.md'), '---\nname: tester\nmodel: m\ntools: [Read, Write]\n---\nbody')
    await expect(loadRole('tester', dir)).rejects.toThrow(/not permitted for role tester/i)
  })

  it('rejects a role file with an empty system prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'dev.md'), '---\nname: dev\nmodel: m\ntools: [Read]\n---\n   \n')
    await expect(loadRole('dev', dir)).rejects.toThrow(/empty system prompt/i)
  })

  it('rejects a role file whose name does not match the requested role', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sy-roles-'))
    await writeFile(join(dir, 'dev.md'), '---\nname: tester\nmodel: m\ntools: [Read]\n---\nbody')
    await expect(loadRole('dev', dir)).rejects.toThrow(/declares name/i)
  })
})

describe('canWriteFiles', () => {
  it('is true only for dev', () => {
    expect(canWriteFiles('dev')).toBe(true)
    expect(canWriteFiles('tester')).toBe(false)
    expect(canWriteFiles('manager')).toBe(false)
  })
})

describe('PERMISSION_FLOOR', () => {
  it('never grants a write tool to a non-dev role', () => {
    for (const [role, tools] of Object.entries(PERMISSION_FLOOR)) {
      if (role === 'dev') continue
      expect(tools).not.toContain('Write')
      expect(tools).not.toContain('Edit')
    }
  })
})
