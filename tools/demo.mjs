#!/usr/bin/env node
// Generates a throwaway yard with three runs so you can see the dashboard
// without waiting on a real build. Writes to .demo/ (git-ignored).
//
//   npm run demo

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const yard = join(repo, '.demo', '.shipyard')
rmSync(join(repo, '.demo'), { recursive: true, force: true })

const w = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }

const RUNS = [
  {
    id: '2026-09-28T08-12-00',
    state: {
      stage: 'done', cycle: 1, maxCycles: 3, verdict: 'shipped',
      branch: 'shipyard/dark-mode-toggle-2026-09-28T08-12-00',
      criteria: { AC1: 'pass', AC2: 'pass', AC3: 'pass' },
      tasks: { T1: 'done', T2: 'done' }, deaths: [],
    },
    goal: 'Add a dark mode toggle that persists across reloads.',
    criteria: [
      ['AC1', 'A toggle appears in the header'],
      ['AC2', 'Choosing dark applies the dark palette immediately'],
      ['AC3', 'The choice survives a page reload'],
    ],
    tasks: [
      ['T1', 'Theme context + localStorage persistence', [], ['src/theme/ThemeProvider.tsx']],
      ['T2', 'Header toggle wired to the context', ['T1'], ['src/components/Header.tsx']],
    ],
    spec: '# Cycle 1 spec\n\nTheme state lives in a context so the toggle and the\nconsumers never disagree. Persistence is localStorage read once on mount —\nnot on every render, which would thrash.\n\nI am deliberately NOT adding a system-preference listener. It was not asked\nfor, and it changes behaviour on machines the user never tested.\n',
    report: '# Report\n\n**Verdict: shipped.** All three criteria pass on the first cycle.\n\nThe toggle persists via localStorage and applies synchronously on mount, so\nthere is no flash of the light theme on reload.\n\nNo defects were found. One note for later: there is no system-preference\nlistener, which was out of scope but is the obvious next request.\n',
    ledger: '08:12:02 intake  -> 3 criteria\n08:12:48 survey  -> react + vitest\n08:13:30 plan    -> 2 tasks\n08:16:10 build   -> T1, T2 done\n08:18:40 test    -> 3/3 pass\n08:19:02 report  -> shipped\n',
  },
  {
    id: '2026-10-01T14-05-00',
    state: {
      stage: 'done', cycle: 3, maxCycles: 3, verdict: 'partial', fixRound: 3, maxFixRounds: 3,
      branch: 'shipyard/bulk-import-2026-10-01T14-05-00',
      criteria: { AC1: 'pass', AC2: 'pass', AC3: 'fail', AC4: 'untested' },
      tasks: { T1: 'done', T2: 'done', T3: 'blocked' },
      deaths: [
        { agentId: 'dev-006', reason: 'timeout', detail: 'exceeded 900000ms parsing a 40MB fixture' },
        { agentId: 'dev-009', reason: 'invalid-output', detail: 'returned prose instead of the task schema' },
      ],
    },
    goal: 'Bulk-import members from a CSV upload, with per-row validation errors.',
    criteria: [
      ['AC1', 'Upload accepts a .csv and shows a preview'],
      ['AC2', 'Rows failing validation are listed with the reason'],
      ['AC3', 'A 40MB file imports without exhausting memory'],
      ['AC4', 'Partial imports can be rolled back'],
    ],
    tasks: [
      ['T1', 'CSV parse + per-row validation', [], ['src/import/parse.ts']],
      ['T2', 'Upload UI with error table', ['T1'], ['src/import/UploadPanel.tsx']],
      ['T3', 'Streaming import for large files', ['T1'], ['src/import/stream.ts']],
    ],
    spec: '# Cycle 3 spec\n\nTwo cycles failed on memory. Both read the whole file before\nvalidating. This cycle streams: parse row by row, validate as we go, never\nhold more than a window.\n\nI am NOT attempting AC4 (rollback) this cycle. It needs a transaction boundary\nthat does not exist in the current data layer, and inventing one under a fix\nbudget would be worse than reporting it honestly.\n',
    report: '# Report\n\n**Verdict: partially shipped.** Two of four criteria pass.\n\nUpload, preview, and per-row validation errors work and are covered by tests.\n\nAC3 (40MB import) still fails after three cycles. Each cycle got closer —\ncycle 1 read the whole file, cycle 2 chunked but kept all rows in memory, cycle\n3 streams correctly but still buffers the error list, which is what blows up on\na file where most rows are invalid.\n\nAC4 (rollback) was never attempted. It needs a transaction boundary the data\nlayer does not have. That is a design decision, not a bug, and it should be made\nby a human.\n\n**Recommended next step:** decide whether partial imports are acceptable. If\nthey are, AC4 disappears and AC3 becomes tractable by capping the error list.\n',
    ledger: '14:05:02 intake  -> 4 criteria\n14:06:10 survey  -> 5 surveyors\n14:07:40 plan    -> 3 tasks\n14:21:00 test    -> AC3 FAIL (heap)\n14:52:00 cycle 2 -> fresh manager, chunked read\n15:30:00 test    -> AC3 FAIL (heap)\n15:31:00 cycle 3 -> fresh manager, streaming\n16:02:00 test    -> AC3 FAIL, AC4 UNTESTED\n16:02:30 report  -> partial, cycle budget spent\n',
  },
  {
    id: '2026-10-02T11-40-00',
    state: {
      stage: 'build', cycle: 1, maxCycles: 3, verdict: 'pending', fixRound: 0,
      branch: 'shipyard/export-orders-csv-2026-10-02T11-40-00',
      criteria: { AC1: 'pass', AC2: 'untested', AC3: 'untested' },
      tasks: { T1: 'done', T2: 'running', T3: 'todo' },
      deaths: [{ agentId: 'dev-002', reason: 'timeout', detail: 'no output for 15m; respawned as dev-003' }],
    },
    goal: 'Export the orders table to CSV, respecting the active filter.',
    criteria: [
      ['AC1', 'An Export CSV button renders on the orders page'],
      ['AC2', 'The file contains only rows matching the active filter'],
      ['AC3', 'Commas inside an address do not shift columns'],
    ],
    tasks: [
      ['T1', 'RFC4180 serializer', [], ['src/export/csv.ts']],
      ['T2', 'Download hook', ['T1'], ['src/export/useCsvDownload.ts']],
      ['T3', 'Button on the orders page', ['T2'], ['src/admin/OrdersPage.tsx']],
    ],
    spec: '# Cycle 1 spec\n\nSerialization stays pure and DOM-free so the quoting rule\ncan be tested without rendering anything. RFC4180: quote when the field holds a\ncomma, quote, or newline; double any interior quote.\n',
    report: '',
    ledger: '11:40:02 intake  -> 3 criteria\n11:40:55 survey  -> react + vitest, filter state in a store\n11:41:48 plan    -> 3 tasks, ownership disjoint\n11:43:20 build   -> T1 done\n11:51:10 build   -> dev-002 lost (timeout), respawning as dev-003\n',
  },
]

for (const r of RUNS) {
  const dir = join(yard, 'runs', r.id)
  w(join(dir, 'state.json'), { runId: r.id, target: '/Users/you/Code/grid-city', request: r.goal, ...r.state })
  w(join(dir, 'brief.json'), {
    goal: r.goal, stack: ['typescript', 'react'], constraints: [],
    assumptions: ['Existing auth and routing are unchanged'],
    risks: [], acceptanceCriteria: r.criteria.map(([id, statement]) => ({ id, statement, verifiable: true })),
  })
  w(join(dir, 'cycles/1/plan.json'), {
    summary: r.spec.split('\n').find(l => l && !l.startsWith('#')) || 'Plan',
    tasks: r.tasks.map(([id, goal, dependsOn, ownsFiles]) => ({ id, goal, dependsOn, ownsFiles, criteriaIds: [r.criteria[0][0]] })),
  })
  w(join(dir, 'cycles/1/spec.md'), r.spec)
  w(join(dir, 'ledger.md'), '# Harbormaster log\n\n' + r.ledger)
  if (r.report) w(join(dir, 'report.md'), r.report)
  w(join(dir, 'agents/manager-001.md'), 'MANAGER-001\n\nDecomposed into ' + r.tasks.length + ' tasks. Ownership is disjoint for every\npair that can run concurrently, so the build stage can fan out safely.\n')
  w(join(dir, 'agents/tester-001.md'), 'TESTER-001\n\nRan the suite against the acceptance criteria. Reported verdicts only; I did\nnot modify any files.\n')
  execFileSync('node', [join(repo, 'tools', 'render-report.mjs'), dir], { stdio: 'pipe' })
}

execFileSync('node', [join(repo, 'tools', 'render-index.mjs'), yard], { stdio: 'pipe' })

const index = join(yard, 'index.html')
console.log(`\n  demo yard built — ${RUNS.length} runs (shipped, partial, in-flight)\n`)
console.log(`  ${index}\n`)
console.log(`  open it with:  open ${index}\n`)
