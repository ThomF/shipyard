import { describe, it, expect } from 'vitest'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initState, writeState, readState, newRunId } from '../src/state/store.js'

async function tmp() { return mkdtemp(join(tmpdir(), 'sy-store-')) }

describe('newRunId', () => {
  it('is stable for the same inputs', () => {
    expect(newRunId('2026-10-01T12-00-00', 1)).toBe('2026-10-01T12-00-00-001')
    expect(newRunId('2026-10-01T12-00-00', 12)).toBe('2026-10-01T12-00-00-012')
  })
})

describe('state store', () => {
  it('round-trips a state through disk', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    const s = initState({ runId: 'r1', target: '/t', idea: 'build a thing', createdAt: 'now' })
    await writeState(path, s)
    const back = await readState(path)
    expect(back.runId).toBe('r1')
    expect(back.stage).toBe('intake')
    expect(back.cycle).toBe(1)
  })

  it('leaves no temp files behind', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    await writeState(path, initState({ runId: 'r1', target: '/t', idea: 'i', createdAt: 'now' }))
    const files = await readdir(dir)
    expect(files).toEqual(['state.json'])
  })

  // Review Focus #5: a crash mid-write must not leave a half-applied state
  it('preserves the previous state when a later write is interrupted', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    const first = initState({ runId: 'r1', target: '/t', idea: 'i', createdAt: 'now' })
    await writeState(path, first)
    // Simulate an interrupted write: a stray temp file, no rename
    await writeFile(path + '.tmp', '{ truncated')
    const back = await readState(path)
    expect(back.stage).toBe('intake')
    expect(back.runId).toBe('r1')
  })

  it('advances stage and records cost', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    const s = initState({ runId: 'r1', target: '/t', idea: 'i', createdAt: 'now' })
    s.stage = 'plan'
    s.totalCostUsd = 1.5
    s.completedStages.push('intake', 'survey')
    await writeState(path, s)
    const back = await readState(path)
    expect(back.stage).toBe('plan')
    expect(back.totalCostUsd).toBe(1.5)
    expect(back.completedStages).toEqual(['intake', 'survey'])
  })

  it('rejects a state file that does not match the schema', async () => {
    const dir = await tmp()
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({ runId: 'r1' }))
    await expect(readState(path)).rejects.toThrow()
  })
})
