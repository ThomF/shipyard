#!/usr/bin/env node
// Builds the yard overview — one page listing every run against a project.
//
//   node tools/render-index.mjs <project>/.shipyard
//
// Writes <project>/.shipyard/index.html. Self-contained, opens from file://.
//
// The CSS is deliberately duplicated from render-report.mjs rather than shared.
// render-report.mjs gets bundled verbatim into the slash command and written
// into target repos, where it cannot resolve an import from this repo.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root || !existsSync(root)) {
  console.error('usage: render-index.mjs <project>/.shipyard')
  process.exit(1)
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

const runsDir = join(root, 'runs')
const runs = (existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true }) : [])
  .filter(d => d.isDirectory())
  .map(d => {
    const dir = join(runsDir, d.name)
    const state = readJson(join(dir, 'state.json')) || {}
    const brief = readJson(join(dir, 'brief.json'))
    const crit = state.criteria || {}
    const keys = Object.keys(crit)
    return {
      id: d.name,
      state,
      goal: brief?.goal || state.request || '(no brief recorded)',
      pass: keys.filter(k => crit[k] === 'pass').length,
      total: keys.length,
      hasReport: existsSync(join(dir, 'report.html')),
    }
  })
  .sort((a, b) => b.id.localeCompare(a.id))

const anyLive = runs.some(r => r.state.verdict === 'pending' && r.state.stage !== 'done')
const tally = runs.reduce((a, r) => { a[r.state.verdict || 'pending'] = (a[r.state.verdict || 'pending'] || 0) + 1; return a }, {})

const payload = JSON.stringify({ runs, root, anyLive, tally }).replace(/</g, '\\u003c')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${anyLive ? '<meta http-equiv="refresh" content="6">' : ''}
<title>${anyLive ? '◉ ' : ''}SHIPYARD // YARD OVERVIEW</title>
<style>
:root{--bg:#0b0a08;--panel:#15120d;--panel2:#1d1812;--amber:#ffb53d;--amber-dim:#8a6224;
--amber-glow:rgba(255,181,61,.25);--green:#7ddba0;--red:#ff6b4a;--grey:#6b6354;--rule:#3a3024;}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg)}
body{font-family:"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;color:var(--amber);
font-size:13px;line-height:1.55;padding:24px;max-width:1180px;margin:0 auto;text-shadow:0 0 1px var(--amber-glow)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:99;
background:repeating-linear-gradient(180deg,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.22) 2px 4px)}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:98;
background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,.55) 100%)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes flicker{0%,100%{opacity:1}97%{opacity:1}98%{opacity:.82}99%{opacity:1}}
a{color:var(--amber);text-decoration:none}
a:hover{text-shadow:0 0 8px var(--amber)}
.hazard{height:8px;background:repeating-linear-gradient(45deg,var(--amber-dim) 0 10px,#0b0a08 10px 20px);margin:14px 0;opacity:.6}
header{border:2px solid var(--amber-dim);background:var(--panel);padding:14px 16px;animation:flicker 7s infinite}
header h1{margin:0;font-size:22px;letter-spacing:.42em;font-weight:700}
header h1 small{letter-spacing:.1em;font-size:11px;color:var(--amber-dim);display:block;margin-top:6px}
.meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.chip{border:1px solid var(--rule);background:var(--panel2);padding:3px 9px;font-size:11px;
letter-spacing:.14em;text-transform:uppercase;color:var(--amber-dim)}
.chip b{color:var(--amber);font-weight:600}
.live{border-color:var(--green)!important;color:var(--green)!important}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);
margin-right:7px;animation:pulse 1.1s infinite;box-shadow:0 0 6px var(--green)}
section{border:1px solid var(--rule);background:var(--panel);margin:18px 0}
section>h2{margin:0;padding:8px 14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;
background:var(--panel2);border-bottom:1px solid var(--rule);color:var(--amber-dim)}
section>.body{padding:0}
.berth{display:grid;grid-template-columns:14px 1fr auto;gap:14px;align-items:start;
padding:13px 16px;border-bottom:1px solid var(--rule)}
.berth:last-child{border-bottom:0}
.berth:hover{background:var(--panel2)}
.lamp{width:10px;height:10px;border-radius:50%;margin-top:5px;box-shadow:0 0 7px currentColor}
.l-shipped{background:var(--green);color:var(--green)}
.l-failed{background:var(--red);color:var(--red)}
.l-partial{background:var(--amber);color:var(--amber)}
.l-pending{background:var(--green);color:var(--green);animation:pulse 1.1s infinite}
.goal{font-size:13px;color:#e8d5ad;margin:0 0 5px}
.sub{font-size:11px;color:var(--grey);letter-spacing:.08em}
.sub b{color:var(--amber-dim);font-weight:400}
.right{text-align:right;white-space:nowrap}
.score{font-size:17px;letter-spacing:.08em}
.verdict{font-size:10px;letter-spacing:.22em;text-transform:uppercase;display:block;margin-top:3px}
.v-shipped{color:var(--green)}.v-failed{color:var(--red)}.v-partial,.v-pending{color:var(--amber)}
.mini{height:5px;border:1px solid var(--rule);background:#0c0a07;display:flex;width:120px;margin-top:6px}
.mini i{display:block;height:100%}.mini i.p{background:var(--green)}.mini i.u{background:#2a2419}
.none{padding:34px 16px;text-align:center;color:var(--grey)}
.none b{display:block;color:var(--amber-dim);letter-spacing:.3em;margin-bottom:9px}
footer{color:var(--grey);font-size:11px;letter-spacing:.14em;text-align:center;padding:18px 0}
</style>
</head>
<body><div id="app"></div>
<script id="yard-data" type="application/json">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('yard-data').textContent);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const parts = [];

parts.push(\`<header>
  <h1>SHIPYARD<small>YARD OVERVIEW // \${esc(D.root)}</small></h1>
  <div class="meta">
    \${D.anyLive ? '<span class="chip live"><span class="dot"></span>YARD ACTIVE</span>' : ''}
    <span class="chip">RUNS <b>\${D.runs.length}</b></span>
    \${Object.entries(D.tally).map(([k,v]) => \`<span class="chip">\${esc(k)} <b>\${v}</b></span>\`).join('')}
  </div>
</header><div class="hazard"></div>\`);

if (!D.runs.length) {
  parts.push(\`<section><h2>Berths</h2><div class="body"><div class="none">
    <b>YARD EMPTY</b>
    No runs recorded yet.<br>Stand in this repo and run <code>/shipyard &lt;what you want built&gt;</code>.
  </div></div></section>\`);
} else {
  parts.push(\`<section><h2>Berths — newest first</h2><div class="body">\${D.runs.map(r => {
    const v = r.state.verdict || 'pending';
    const pct = r.total ? r.pass / r.total * 100 : 0;
    const link = r.hasReport ? \`runs/\${encodeURIComponent(r.id)}/report.html\` : null;
    const title = link ? \`<a href="\${link}">\${esc(r.goal)}</a>\` : esc(r.goal);
    return \`<div class="berth">
      <div class="lamp l-\${esc(v)}"></div>
      <div>
        <p class="goal">\${title}</p>
        <div class="sub">
          <b>\${esc(r.id)}</b> · cycle \${esc(r.state.cycle || '?')}/\${esc(r.state.maxCycles || 3)}
          · stage \${esc(r.state.stage || '—')}
          \${r.state.branch ? ' · ' + esc(r.state.branch) : ''}
          \${(r.state.deaths||[]).length ? ' · <span style="color:var(--red)">' + r.state.deaths.length + ' lost</span>' : ''}
        </div>
        \${r.total ? \`<div class="mini"><i class="p" style="width:\${pct}%"></i><i class="u" style="width:\${100-pct}%"></i></div>\` : ''}
      </div>
      <div class="right">
        <span class="score">\${r.total ? r.pass + '/' + r.total : '—'}</span>
        <span class="verdict v-\${esc(v)}">\${esc(v)}</span>
      </div>
    </div>\`;
  }).join('')}</div></section>\`);
}

parts.push(\`<div class="hazard"></div><footer>
  \${D.anyLive ? 'YARD ACTIVE — reloading every 6s' : 'ALL BERTHS QUIET'}
</footer>\`);
document.getElementById('app').innerHTML = parts.join('');
</script></body></html>`

const out = join(root, 'index.html')
writeFileSync(out, html)
console.log(out)
