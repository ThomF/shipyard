#!/usr/bin/env node
// Renders a Shipyard run directory into one self-contained HTML file.
// Data is inlined, so report.html opens from file:// with no server.
//
//   node tools/render-report.mjs <target>/.shipyard/runs/<run-id>

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, basename } from 'node:path'

const runDir = process.argv[2]
if (!runDir) {
  console.error('usage: render-report.mjs <run-dir>')
  process.exit(1)
}
if (!existsSync(runDir)) {
  console.error(`no such run directory: ${runDir}`)
  process.exit(1)
}

const readJson = (p, fallback = null) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}
const readText = (p, fallback = '') => {
  try { return readFileSync(p, 'utf8') } catch { return fallback }
}
const listDirs = (p) => {
  try { return readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] }
}
const listFiles = (p) => {
  try { return readdirSync(p, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name) } catch { return [] }
}

const state = readJson(join(runDir, 'state.json'), {})
const brief = readJson(join(runDir, 'brief.json'), null)
const map = readJson(join(runDir, 'codebase-map.json'), null)
const ledger = readText(join(runDir, 'ledger.md'))
const reportMd = readText(join(runDir, 'report.md'))

const cycles = listDirs(join(runDir, 'cycles')).sort().map(n => {
  const dir = join(runDir, 'cycles', n)
  return {
    n,
    spec: readText(join(dir, 'spec.md')),
    plan: readJson(join(dir, 'plan.json'), null),
    testReport: readJson(join(dir, 'test-report.json'), null),
    browserReport: readJson(join(dir, 'test-report-browser.json'), null),
    defects: readJson(join(dir, 'defects.json'), null),
    tasks: listFiles(join(dir, 'tasks')).map(f => readJson(join(dir, 'tasks', f))).filter(Boolean),
  }
})

const agents = listFiles(join(runDir, 'agents'))
  .filter(f => f.endsWith('.md'))
  .map(f => ({ id: basename(f, '.md'), body: readText(join(runDir, 'agents', f)) }))

// A run still in flight auto-refreshes; a finished one stops, so an archived
// report does not spin forever in a background tab.
const STAGES = ['intake', 'survey', 'plan', 'build', 'test', 'fix', 'report', 'done']
const live = Boolean(state.stage) && state.stage !== 'done' && (state.verdict ?? 'pending') === 'pending'

let stateMtime = 0
try { stateMtime = statSync(join(runDir, 'state.json')).mtimeMs } catch {}

/**
 * What the crew has touched so far, straight from git: everything changed
 * since the commit the run branched from, committed or not, plus new files.
 * Uncommitted paths are flagged so the page can show which files a dev is in
 * the middle of writing. Read-only git calls; any failure just hides the panel.
 */
function workingTree(base) {
  if (!base || !/^[0-9a-f]{7,40}$/i.test(base)) return null
  const git = (...args) => execFileSync('git', ['-C', runDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  try {
    const files = new Map()
    for (const line of git('diff', '--numstat', base, '--').split('\n')) {
      const m = line.match(/^(\S+)\t(\S+)\t(.+)$/)
      if (m) files.set(m[3], { path: m[3], add: m[1] === '-' ? null : +m[1], del: m[2] === '-' ? null : +m[2], wip: false })
    }
    const pending = new Set()
    for (const line of git('status', '--porcelain', '--untracked-files=all').split('\n')) {
      if (!line.trim()) continue
      const path = line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')
      pending.add(path)
      if (!files.has(path)) files.set(path, { path, add: null, del: null, wip: true, isNew: line.startsWith('??') })
    }
    for (const f of files.values()) if (pending.has(f.path)) f.wip = true
    const list = [...files.values()]
      .filter(f => !f.path.startsWith('.shipyard/'))
      .sort((a, b) => Number(b.wip) - Number(a.wip) || a.path.localeCompare(b.path))
    return { files: list.slice(0, 200), total: list.length }
  } catch {
    return null
  }
}

const tree = workingTree(state.baseCommit)

const data = { state, brief, map, ledger, reportMd, cycles, agents, runDir, live, stages: STAGES, tree, stateMtime, renderedAt: Date.now() }

// </script> inside inlined JSON would close the tag early.
const payload = JSON.stringify(data).replace(/</g, '\\u003c')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${live ? '<meta http-equiv="refresh" content="4">' : ''}
<title>${live ? '◉ ' : ''}SHIPYARD // ${state.runId ?? basename(runDir)}</title>
<style>
:root{
  --bg:#0b0a08; --panel:#15120d; --panel2:#1d1812;
  --amber:#ffb53d; --amber-dim:#8a6224; --amber-glow:rgba(255,181,61,.25);
  --green:#7ddba0; --red:#ff6b4a; --grey:#6b6354;
  --rule:#3a3024;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);}
body{
  font-family:"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;
  color:var(--amber); font-size:13px; line-height:1.55;
  padding:24px; max-width:1180px; margin:0 auto;
  text-shadow:0 0 1px var(--amber-glow);
}
/* CRT scanlines */
body::before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:99;
  background:repeating-linear-gradient(180deg,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.22) 2px 4px);
}
body::after{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:98;
  background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,.55) 100%);
}
a{color:var(--amber)}
.hazard{height:8px;background:repeating-linear-gradient(45deg,var(--amber-dim) 0 10px,#0b0a08 10px 20px);margin:14px 0;opacity:.6}
header{border:2px solid var(--amber-dim);background:var(--panel);padding:14px 16px;position:relative}
header h1{margin:0;font-size:22px;letter-spacing:.42em;font-weight:700}
header h1 small{letter-spacing:.1em;font-size:11px;color:var(--amber-dim);display:block;margin-top:6px}
.meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.chip{border:1px solid var(--rule);background:var(--panel2);padding:3px 9px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--amber-dim)}
.chip b{color:var(--amber);font-weight:600}
.verdict{border-width:2px;padding:4px 12px;font-weight:700;letter-spacing:.2em}
.v-shipped{border-color:var(--green);color:var(--green)}
.v-failed{border-color:var(--red);color:var(--red)}
.v-partial,.v-pending{border-color:var(--amber);color:var(--amber)}
section{border:1px solid var(--rule);background:var(--panel);margin:18px 0}
section>h2{
  margin:0;padding:8px 14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;
  background:var(--panel2);border-bottom:1px solid var(--rule);color:var(--amber-dim);
}
section>.body{padding:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.crit{border:1px solid var(--rule);padding:9px 11px;background:var(--panel2)}
.crit .id{font-weight:700;letter-spacing:.14em}
.crit .st{float:right;font-size:11px;letter-spacing:.14em}
.pass{color:var(--green)} .fail{color:var(--red)} .untested{color:var(--grey)}
.crit p{margin:6px 0 0;color:#d9c9a6;font-size:12px}
.bar{height:16px;border:1px solid var(--rule);background:#0c0a07;display:flex;margin-bottom:14px}
.bar i{display:block;height:100%}
.bar i.p{background:var(--green)} .bar i.f{background:var(--red)} .bar i.u{background:#2a2419}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:6px 9px;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--amber-dim);font-size:10px;letter-spacing:.2em;text-transform:uppercase}
td.mono{color:#d9c9a6}
.tag{border:1px solid var(--rule);padding:1px 6px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--amber-dim)}
.t-done{border-color:var(--green);color:var(--green)}
.t-blocked{border-color:var(--red);color:var(--red)}
pre{background:#0c0a07;border:1px solid var(--rule);padding:11px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#d9c9a6;font-size:12px;margin:0}
details{border:1px solid var(--rule);background:var(--panel2);margin:7px 0}
details>summary{padding:7px 11px;cursor:pointer;letter-spacing:.14em;font-size:11px;text-transform:uppercase;color:var(--amber-dim)}
details[open]>summary{border-bottom:1px solid var(--rule);color:var(--amber)}
details .inner{padding:11px}
.cycle-head{display:flex;align-items:center;gap:12px;margin:0 0 10px}
.cycle-head h3{margin:0;font-size:13px;letter-spacing:.26em}
.empty{color:var(--grey);font-style:italic}
footer{color:var(--grey);font-size:11px;letter-spacing:.14em;text-align:center;padding:18px 0}
@media print{body::before,body::after{display:none}}

/* ── live telemetry ─────────────────────────────────────── */
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes sweep{0%{transform:translateX(-100%)}100%{transform:translateX(420%)}}
@keyframes flicker{0%,100%{opacity:1}97%{opacity:1}98%{opacity:.82}99%{opacity:1}}
header{animation:flicker 7s infinite}
.live{border-color:var(--green)!important;color:var(--green)!important}
.live .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);margin-right:7px;animation:pulse 1.1s infinite;box-shadow:0 0 6px var(--green)}
.scan{position:relative;overflow:hidden;height:3px;background:#0c0a07;border:1px solid var(--rule);border-left:0;border-right:0;margin:0}
.scan i{position:absolute;top:0;left:0;height:100%;width:24%;background:linear-gradient(90deg,transparent,var(--amber),transparent);animation:sweep 2.4s linear infinite}
/* stage pipeline */
.pipe{display:flex;gap:0;margin:12px 0 2px;border:1px solid var(--rule);background:#0c0a07}
.pipe div{flex:1;text-align:center;padding:7px 2px;font-size:10px;letter-spacing:.18em;color:#3b3225;border-right:1px solid var(--rule);position:relative}
.pipe div:last-child{border-right:0}
.pipe div.done{color:var(--amber-dim);background:#140f09}
.pipe div.now{color:#0b0a08;background:var(--amber);font-weight:700;animation:pulse 1.6s infinite}
.tele{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.2em;color:var(--grey);margin-top:6px}
.pipe div small{display:block;font-size:9px;letter-spacing:.08em;margin-top:2px;opacity:.85}
.nosignal{border-color:var(--red)!important;color:var(--red)!important;animation:pulse 1.6s infinite}
.fast{border-color:var(--green);color:var(--green)}
.crew{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.hand{border:1px solid var(--green);background:var(--panel2);padding:9px 11px}
.hand .role{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--green)}
.hand .role .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:6px;animation:pulse 1.1s infinite}
.hand .who{font-weight:700;margin:4px 0 2px}
.hand .clock{float:right;color:#e8d5ad}
.hand.slow{border-color:var(--amber)}
td.num{text-align:right;white-space:nowrap}
.add{color:var(--green)} .del{color:var(--red)}
.wip{color:var(--green);animation:pulse 1.1s infinite}
</style>
</head>
<body>
<div id="app"></div>
<script id="run-data" type="application/json">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('run-data').textContent);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstElementChild; };

const st = D.state || {};
const verdict = (st.verdict || 'pending').toLowerCase();
const crit = st.criteria || {};
const critKeys = Object.keys(crit);
const statements = {};
const checks = {};
(D.brief?.acceptanceCriteria || []).forEach(c => { statements[c.id] = c.statement; checks[c.id] = c.check; });
const keys = critKeys.length ? critKeys : Object.keys(statements);
const counts = { pass: 0, fail: 0, untested: 0 };
keys.forEach(k => { counts[(crit[k] || 'untested')] = (counts[(crit[k] || 'untested')] || 0) + 1; });
const total = keys.length || 1;

const parts = [];

const nowIdx = D.stages.indexOf(st.stage);
const T = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const dur = ms => {
  if (ms == null || ms < 0) return '';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return h ? \`\${h}h\${String(m).padStart(2, '0')}m\` : m ? \`\${m}m\${String(r).padStart(2, '0')}s\` : \`\${r}s\`;
};
// Elements carrying data-since tick every second, so the page looks alive
// between renders even while one long agent is working.
const since = (iso, end) => {
  const a = T(iso); if (a == null) return '—';
  const b = T(end);
  return b != null ? dur(b - a) : \`<span data-since="\${a}">\${dur(Date.now() - a)}</span>\`;
};
const times = st.stageTimes || {};
const pipeline = D.stages.filter(s => s !== 'done').map((s, i) => {
  const cls = D.live && i === nowIdx ? 'now' : (nowIdx > i || !D.live ? 'done' : '');
  const t = times[s];
  const clock = t?.start ? \`<small>\${since(t.start, (D.live && i === nowIdx) ? null : (t.end || null))}</small>\` : '';
  return \`<div class="\${cls}">\${s.toUpperCase()}\${clock}</div>\`;
}).join('');
const quietMs = D.stateMtime ? Date.now() - D.stateMtime : 0;
const active = Array.isArray(st.active) ? st.active : [];
const usage = Array.isArray(st.usage) ? st.usage : [];
const tokenTotal = usage.reduce((sum, u) => sum + (u.tokens ?? 0), 0);

parts.push(\`
<header>
  <h1>SHIPYARD<small>AUTONOMOUS DEV YARD // \${D.live ? 'YARD ACTIVE' : 'RUN RECORD'}</small></h1>
  <div class="meta">
    \${D.live
      ? '<span class="chip verdict live"><span class="dot"></span>WORKING</span>'
      : \`<span class="chip verdict v-\${esc(verdict)}">\${esc(verdict)}</span>\`}
    <span class="chip">RUN <b>\${esc(st.runId || '—')}</b></span>
    \${st.size ? \`<span class="chip">SIZE <b>\${esc(st.size)}</b></span>\` : ''}
    \${usage.length ? \`<span class="chip">TOKENS <b>\${tokenTotal.toLocaleString('en-US')}</b></span>\` : ''}
    \${st.startedAt ? \`<span class="chip">ELAPSED <b>\${since(st.startedAt, D.live ? null : st.endedAt)}</b></span>\` : ''}
    \${D.live && active.length ? \`<span class="chip live">CREW <b>\${active.length}</b></span>\` : ''}
    \${D.live ? \`<span class="chip nosignal" id="nosignal" data-mtime="\${D.stateMtime}" style="display:none">NO SIGNAL <b></b></span>\` : ''}
    <span class="chip">CYCLE <b>\${esc(st.cycle || '?')}/\${esc(st.maxCycles || 3)}</b></span>
    \${st.fixRound ? \`<span class="chip">FIX ROUND <b>\${esc(st.fixRound)}/\${esc(st.maxFixRounds || 3)}</b></span>\` : ''}
    <span class="chip">BRANCH <b>\${esc(st.branch || '—')}</b></span>
    <span class="chip">TARGET <b>\${esc(st.target || '—')}</b></span>
    \${(st.fastPaths || []).map(f => \`<span class="chip fast">FAST PATH <b>\${esc(f)}</b></span>\`).join('')}
  </div>
  <div class="pipe">\${pipeline}</div>
  <div class="tele">
    <span>\${D.live ? '◉ TELEMETRY LIVE — REFRESHING EVERY 4s' : '· TRANSMISSION ENDED'}</span>
    <span>STAGE: \${esc((st.stage || 'unknown').toUpperCase())}</span>
  </div>
</header>
\${D.live ? '<div class="scan"><i></i></div>' : ''}
<div class="hazard"></div>\`);

if (D.live && active.length) {
  parts.push(\`<section><h2>Crew on deck — \${active.length} working</h2><div class="body"><div class="crew">
    \${active.map(a => {
      const t = T(a.since);
      const slow = t != null && Date.now() - t > 15 * 60 * 1000;
      return \`<div class="hand\${slow ? ' slow' : ''}"><div class="role"><span class="dot"></span>\${esc(a.role || 'agent')}<span class="clock">\${since(a.since)}</span></div>
        <div class="who">\${esc(a.id || '?')}</div>
        \${a.task ? \`<div class="sub" style="color:var(--grey);font-size:11px">\${esc(a.task)}</div>\` : ''}</div>\`;
    }).join('')}
  </div></div></section>\`);
}

if (D.tree && D.tree.total) {
  const wip = D.tree.files.filter(f => f.wip).length;
  const rows = D.tree.files.map(f => \`<tr>
      <td class="mono">\${f.wip ? '<span class="wip">●</span> ' : ''}\${esc(f.path)}</td>
      <td class="num">\${f.add == null ? (f.isNew ? '<span class="add">new</span>' : '') : f.add ? '<span class="add">+' + f.add + '</span>' : ''}</td>
      <td class="num">\${f.del ? '<span class="del">−' + f.del + '</span>' : ''}</td></tr>\`).join('');
  parts.push(\`<section><h2>Working tree — \${D.tree.total} file\${D.tree.total === 1 ? '' : 's'} changed\${wip ? ', ' + wip + ' uncommitted' : ''}</h2><div class="body">
    <table><thead><tr><th>File \${wip ? '(● = being written)' : ''}</th><th style="text-align:right">Added</th><th style="text-align:right">Removed</th></tr></thead><tbody>\${rows}</tbody></table>
    \${D.tree.total > D.tree.files.length ? '<p class="empty">Showing the first ' + D.tree.files.length + '.</p>' : ''}
  </div></section>\`);
}

if (st.request || D.brief?.goal) {
  parts.push(\`<section><h2>Work order</h2><div class="body">
    <pre>\${esc(D.brief?.goal || st.request)}</pre>
    \${(D.brief?.assumptions || []).length ? '<p style="margin:11px 0 4px;color:var(--amber-dim);font-size:11px;letter-spacing:.2em">ASSUMPTIONS MADE</p><ul>' + D.brief.assumptions.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul>' : ''}
  </div></section>\`);
}

// Acceptance criteria
const bar = \`<div class="bar">
  <i class="p" style="width:\${counts.pass / total * 100}%"></i>
  <i class="f" style="width:\${counts.fail / total * 100}%"></i>
  <i class="u" style="width:\${counts.untested / total * 100}%"></i>
</div>\`;
const cards = keys.length ? keys.map(k => {
  const s = crit[k] || 'untested';
  return \`<div class="crit"><span class="id">\${esc(k)}</span><span class="st \${esc(s)}">\${s === 'pass' ? '◉ PASS' : s === 'fail' ? '✗ FAIL' : '· UNTESTED'}</span>
    <p>\${esc(statements[k] || '')}</p>\${checks[k] ? \`<span class="tag">\${esc(checks[k])}</span>\` : ''}</div>\`;
}).join('') : '<p class="empty">No acceptance criteria recorded — intake did not complete.</p>';
parts.push(\`<section><h2>Acceptance criteria — \${counts.pass}/\${keys.length || 0} pass</h2><div class="body">\${keys.length ? bar : ''}<div class="grid">\${cards}</div></div></section>\`);

// Token use. The figures come straight from state.json's usage list.
if (usage.length) {
  const byRole = {};
  usage.forEach(u => {
    const r = byRole[u.role] || (byRole[u.role] = { agents: 0, tokens: 0 });
    r.agents++;
    r.tokens += u.tokens ?? 0;
  });
  const fmt = n => Number(n).toLocaleString('en-US');
  const roleRows = Object.entries(byRole).sort((a, b) => b[1].tokens - a[1].tokens).map(([role, r]) =>
    \`<tr><td><b>\${esc(role)}</b></td><td class="num">\${r.agents}</td><td class="num">\${fmt(r.tokens)}</td><td class="num">\${tokenTotal ? Math.round(r.tokens / tokenTotal * 100) : 0}%</td></tr>\`).join('');
  const agentRows = usage.map(u =>
    \`<tr><td class="mono">\${esc(u.agent)}\${u.fixOf ? ' (fix of ' + esc(u.fixOf) + ')' : ''}</td><td>\${esc(u.role)}</td><td>\${esc(u.model || '—')}</td><td class="num">\${u.tokens == null ? 'unavailable' : fmt(u.tokens)}</td><td class="num">\${u.toolUses ?? '—'}</td></tr>\`).join('');
  const unknown = usage.filter(u => u.tokens == null).length;
  const hasHarbormaster = usage.some(u => u.role === 'harbormaster');
  parts.push(\`<section><h2>Token use — \${fmt(tokenTotal)} reported</h2><div class="body">
    <table><thead><tr><th>Role</th><th style="text-align:right">Agents</th><th style="text-align:right">Tokens</th><th style="text-align:right">Share</th></tr></thead><tbody>\${roleRows}</tbody></table>
    \${hasHarbormaster ? '' : "<p class=\\"empty\\">The harbormaster's own tokens are not included: no figure was available.</p>"}
    \${unknown ? '<p class="empty">' + unknown + ' agent(s) reported no figure and count as 0, so the real total is higher.</p>' : ''}
    <details><summary>Per agent</summary><div class="inner"><table><thead><tr><th>Agent</th><th>Role</th><th>Model</th><th style="text-align:right">Tokens</th><th style="text-align:right">Tool uses</th></tr></thead><tbody>\${agentRows}</tbody></table></div></details>
  </div></section>\`);
}

// Cycles
(D.cycles || []).forEach(c => {
  const tasks = (c.plan?.tasks || []);
  const taskState = st.tasks || {};
  const rows = tasks.length ? tasks.map(t => {
    const s = taskState[t.id] || 'todo';
    return \`<tr><td><b>\${esc(t.id)}</b></td><td>\${esc(t.goal)}\${t.model ? \` <span class="tag">\${esc(t.model)}</span>\` : ''}</td>
      <td class="mono">\${esc((t.ownsFiles || []).join(', '))}</td>
      <td class="mono">\${esc((t.dependsOn || []).join(', ') || '—')}</td>
      <td><span class="tag t-\${esc(s)}">\${esc(s)}</span></td></tr>\`;
  }).join('') : '<tr><td colspan="5" class="empty">No plan produced for this cycle.</td></tr>';

  parts.push(\`<section><h2>Cycle \${esc(c.n)}</h2><div class="body">
    <div class="cycle-head"><h3>DELEGATION</h3></div>
    <table><thead><tr><th>Task</th><th>Goal</th><th>Owns files</th><th>After</th><th>State</th></tr></thead><tbody>\${rows}</tbody></table>
    \${c.spec ? '<details><summary>Manager spec — what it intended to build</summary><div class="inner"><pre>' + esc(c.spec) + '</pre></div></details>' : ''}
    \${c.testReport ? '<details><summary>Tester verdict + evidence</summary><div class="inner"><pre>' + esc(JSON.stringify(c.testReport, null, 2)) + '</pre></div></details>' : ''}
    \${c.browserReport ? '<details><summary>Browser tester verdict + evidence</summary><div class="inner"><pre>' + esc(JSON.stringify(c.browserReport, null, 2)) + '</pre></div></details>' : ''}
    \${c.defects ? '<details><summary>Triaged defects</summary><div class="inner"><pre>' + esc(JSON.stringify(c.defects, null, 2)) + '</pre></div></details>' : ''}
  </div></section>\`);
});

// Deaths
if ((st.deaths || []).length) {
  parts.push(\`<section><h2>Agent losses — \${st.deaths.length}</h2><div class="body"><table>
    <thead><tr><th>Agent</th><th>Reason</th><th>Detail</th></tr></thead><tbody>
    \${st.deaths.map(d => \`<tr><td><b>\${esc(d.agentId || d.agent || '?')}</b></td><td class="fail">\${esc(d.reason)}</td><td class="mono">\${esc(d.detail)}</td></tr>\`).join('')}
    </tbody></table></div></section>\`);
}

if (D.reportMd) {
  parts.push(\`<section><h2>Report</h2><div class="body"><pre>\${esc(D.reportMd)}</pre></div></section>\`);
}

if ((D.agents || []).length) {
  parts.push(\`<section><h2>Crew logs — \${D.agents.length} agents</h2><div class="body">
    \${D.agents.map(a => '<details><summary>' + esc(a.id) + '</summary><div class="inner"><pre>' + esc(a.body) + '</pre></div></details>').join('')}
  </div></section>\`);
}

if (D.ledger) {
  parts.push(\`<section><h2>Harbormaster log</h2><div class="body"><pre>\${esc(D.ledger)}</pre></div></section>\`);
}

parts.push(\`<div class="hazard"></div><footer>
  SHIPYARD // \${esc(D.runDir)}<br>
  \${D.live
    ? 'YARD ACTIVE — this page reloads itself. Leave the tab open.'
    : 'TRANSMISSION ENDED — this page is final and will not reload.'}
</footer>\`);
document.getElementById('app').innerHTML = parts.join('');

// Tick the clocks between reloads, and raise NO SIGNAL if the harbormaster
// has not written state.json for a long time while the run claims to be live.
(function tick(){
  const fmt = ms => {
    const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? h + 'h' + String(m).padStart(2, '0') + 'm' : m ? m + 'm' + String(r).padStart(2, '0') + 's' : r + 's';
  };
  const QUIET = 20 * 60 * 1000;
  function step(){
    document.querySelectorAll('[data-since]').forEach(n => { n.textContent = fmt(Date.now() - +n.dataset.since); });
    const ns = document.getElementById('nosignal');
    if (ns && +ns.dataset.mtime) {
      const q = Date.now() - +ns.dataset.mtime;
      ns.style.display = q > QUIET ? '' : 'none';
      ns.querySelector('b').textContent = fmt(q);
    }
  }
  step(); setInterval(step, 1000);
})();

// A meta-refresh is a full reload, which would slam every <details> shut and
// jump you back to the top mid-read. Persist what the reader opened and where
// they were, keyed by run so two tabs do not fight. sessionStorage, not local:
// this is view state, and it should die with the tab.
(function preserveReadingState(){
  const KEY = 'shipyard:' + (D.state?.runId || 'run');
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || '{}') } catch {}

  const summaries = () => [...document.querySelectorAll('details')];

  summaries().forEach(d => {
    const label = d.querySelector('summary')?.textContent?.trim();
    if (label && saved.open && saved.open.includes(label)) d.open = true;
    d.addEventListener('toggle', save);
  });

  if (typeof saved.scroll === 'number') window.scrollTo(0, saved.scroll);

  function save(){
    const open = summaries().filter(d => d.open)
      .map(d => d.querySelector('summary')?.textContent?.trim())
      .filter(Boolean);
    try { sessionStorage.setItem(KEY, JSON.stringify({ open, scroll: window.scrollY })) } catch {}
  }

  let t;
  window.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(save, 150) }, { passive: true });
  window.addEventListener('beforeunload', save);
})();
</script>
</body>
</html>`

const out = join(runDir, 'report.html')
writeFileSync(out, html)
console.log(out)
