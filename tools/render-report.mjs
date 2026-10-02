#!/usr/bin/env node
// Renders a Shipyard run directory into one self-contained HTML file.
// Data is inlined, so report.html opens from file:// with no server.
//
//   node tools/render-report.mjs <target>/.shipyard/runs/<run-id>

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
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
    defects: readJson(join(dir, 'defects.json'), null),
    tasks: listFiles(join(dir, 'tasks')).map(f => readJson(join(dir, 'tasks', f))).filter(Boolean),
  }
})

const agents = listFiles(join(runDir, 'agents'))
  .filter(f => f.endsWith('.md'))
  .map(f => ({ id: basename(f, '.md'), body: readText(join(runDir, 'agents', f)) }))

const data = { state, brief, map, ledger, reportMd, cycles, agents, runDir }

// </script> inside inlined JSON would close the tag early.
const payload = JSON.stringify(data).replace(/</g, '\\u003c')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SHIPYARD // ${state.runId ?? basename(runDir)}</title>
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
(D.brief?.acceptanceCriteria || []).forEach(c => { statements[c.id] = c.statement; });
const keys = critKeys.length ? critKeys : Object.keys(statements);
const counts = { pass: 0, fail: 0, untested: 0 };
keys.forEach(k => { counts[(crit[k] || 'untested')] = (counts[(crit[k] || 'untested')] || 0) + 1; });
const total = keys.length || 1;

const parts = [];

parts.push(\`
<header>
  <h1>SHIPYARD<small>AUTONOMOUS DEV YARD // RUN RECORD</small></h1>
  <div class="meta">
    <span class="chip verdict v-\${esc(verdict)}">\${esc(verdict)}</span>
    <span class="chip">RUN <b>\${esc(st.runId || '—')}</b></span>
    <span class="chip">CYCLE <b>\${esc(st.cycle || '?')}/\${esc(st.maxCycles || 3)}</b></span>
    <span class="chip">STAGE <b>\${esc(st.stage || '—')}</b></span>
    <span class="chip">BRANCH <b>\${esc(st.branch || '—')}</b></span>
    <span class="chip">TARGET <b>\${esc(st.target || '—')}</b></span>
  </div>
</header>
<div class="hazard"></div>\`);

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
    <p>\${esc(statements[k] || '')}</p></div>\`;
}).join('') : '<p class="empty">No acceptance criteria recorded — intake did not complete.</p>';
parts.push(\`<section><h2>Acceptance criteria — \${counts.pass}/\${keys.length || 0} pass</h2><div class="body">\${keys.length ? bar : ''}<div class="grid">\${cards}</div></div></section>\`);

// Cycles
(D.cycles || []).forEach(c => {
  const tasks = (c.plan?.tasks || []);
  const taskState = st.tasks || {};
  const rows = tasks.length ? tasks.map(t => {
    const s = taskState[t.id] || 'todo';
    return \`<tr><td><b>\${esc(t.id)}</b></td><td>\${esc(t.goal)}</td>
      <td class="mono">\${esc((t.ownsFiles || []).join(', '))}</td>
      <td class="mono">\${esc((t.dependsOn || []).join(', ') || '—')}</td>
      <td><span class="tag t-\${esc(s)}">\${esc(s)}</span></td></tr>\`;
  }).join('') : '<tr><td colspan="5" class="empty">No plan produced for this cycle.</td></tr>';

  parts.push(\`<section><h2>Cycle \${esc(c.n)}</h2><div class="body">
    <div class="cycle-head"><h3>DELEGATION</h3></div>
    <table><thead><tr><th>Task</th><th>Goal</th><th>Owns files</th><th>After</th><th>State</th></tr></thead><tbody>\${rows}</tbody></table>
    \${c.spec ? '<details><summary>Manager spec — what it intended to build</summary><div class="inner"><pre>' + esc(c.spec) + '</pre></div></details>' : ''}
    \${c.testReport ? '<details><summary>Tester verdict + evidence</summary><div class="inner"><pre>' + esc(JSON.stringify(c.testReport, null, 2)) + '</pre></div></details>' : ''}
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

parts.push(\`<div class="hazard"></div><footer>SHIPYARD // \${esc(D.runDir)}</footer>\`);
document.getElementById('app').innerHTML = parts.join('');
</script>
</body>
</html>`

const out = join(runDir, 'report.html')
writeFileSync(out, html)
console.log(out)
