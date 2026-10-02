#!/usr/bin/env node
// The yard — a local control room for every Shipyard run across every repo.
//
//   npm run yard                 scans ~/Code
//   npm run yard -- ~/work ~/Code   scans several roots
//   PORT=8080 npm run yard
//
// Zero dependencies. Nothing leaves the machine; it binds to 127.0.0.1 only.
//
// Why a server when report.html already works from file://: a file:// page
// cannot scan your disk, so it can only ever show the one run it was built
// for. The server walks every repo you point it at and puts the whole yard
// behind one URL that does not change.

import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(repo, 'tools', 'render-report.mjs')
const PORT = Number(process.env.PORT || 7343)
const ROOTS = process.argv.slice(2).length ? process.argv.slice(2) : [join(homedir(), 'Code')]

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/** Collect runs from one `<project>/.shipyard/runs` directory. */
function collect(projectDir, out) {
  const runsDir = join(projectDir, '.shipyard', 'runs')
  if (!existsSync(runsDir)) return
  for (const r of readdirSync(runsDir, { withFileTypes: true })) {
    if (!r.isDirectory()) continue
    const dir = join(runsDir, r.name)
    const state = readJson(join(dir, 'state.json'))
    if (!state) continue
    const brief = readJson(join(dir, 'brief.json'))
    const crit = state.criteria || {}
    const keys = Object.keys(crit)
    let mtime = 0
    try { mtime = statSync(join(dir, 'state.json')).mtimeMs } catch {}
    out.push({
      project: basename(projectDir), id: r.name, dir, state, mtime,
      goal: brief?.goal || state.request || '(no brief recorded)',
      pass: keys.filter(k => crit[k] === 'pass').length,
      fail: keys.filter(k => crit[k] === 'fail').length,
      total: keys.length,
    })
  }
}

/**
 * A root may itself be a project, or a folder full of them. Check both, so
 * `~/Code` and `~/Code/grid-city` are each a valid thing to point at.
 */
function scan() {
  const out = []
  for (const root of ROOTS) {
    if (!existsSync(root)) continue
    collect(root, out)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(root, entry.name), out)
    }
  }
  return out
    .filter((r, i, a) => a.findIndex(x => x.dir === r.dir) === i)
    .sort((a, b) => b.mtime - a.mtime || b.id.localeCompare(a.id))
}

const CSS = `
:root{--bg:#0b0a08;--panel:#15120d;--panel2:#1d1812;--amber:#ffb53d;--amber-dim:#8a6224;
--glow:rgba(255,181,61,.25);--green:#7ddba0;--red:#ff6b4a;--grey:#6b6354;--rule:#3a3024}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg)}
body{font-family:"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;color:var(--amber);
font-size:13px;line-height:1.55;padding:24px;max-width:1180px;margin:0 auto;text-shadow:0 0 1px var(--glow)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:99;
background:repeating-linear-gradient(180deg,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.22) 2px 4px)}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:98;
background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,.55) 100%)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes flicker{0%,100%{opacity:1}97%{opacity:1}98%{opacity:.82}99%{opacity:1}}
@keyframes sweep{0%{transform:translateX(-100%)}100%{transform:translateX(420%)}}
a{color:var(--amber);text-decoration:none}a:hover{text-shadow:0 0 9px var(--amber)}
.hazard{height:8px;background:repeating-linear-gradient(45deg,var(--amber-dim) 0 10px,#0b0a08 10px 20px);margin:14px 0;opacity:.6}
header{border:2px solid var(--amber-dim);background:var(--panel);padding:14px 16px;animation:flicker 7s infinite}
header h1{margin:0;font-size:22px;letter-spacing:.42em}
header h1 small{letter-spacing:.1em;font-size:11px;color:var(--amber-dim);display:block;margin-top:6px}
.meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.chip{border:1px solid var(--rule);background:var(--panel2);padding:3px 9px;font-size:11px;
letter-spacing:.14em;text-transform:uppercase;color:var(--amber-dim)}
.chip b{color:var(--amber)}
.live{border-color:var(--green)!important;color:var(--green)!important}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);
margin-right:7px;animation:pulse 1.1s infinite;box-shadow:0 0 6px var(--green)}
.scan{position:relative;overflow:hidden;height:3px;background:#0c0a07;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.scan i{position:absolute;top:0;left:0;height:100%;width:24%;background:linear-gradient(90deg,transparent,var(--amber),transparent);animation:sweep 2.4s linear infinite}
section{border:1px solid var(--rule);background:var(--panel);margin:18px 0}
section>h2{margin:0;padding:8px 14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;
background:var(--panel2);border-bottom:1px solid var(--rule);color:var(--amber-dim)}
.berth{display:grid;grid-template-columns:14px 1fr auto;gap:14px;align-items:start;padding:13px 16px;border-bottom:1px solid var(--rule)}
.berth:last-child{border-bottom:0}.berth:hover{background:var(--panel2)}
.lamp{width:10px;height:10px;border-radius:50%;margin-top:5px;box-shadow:0 0 7px currentColor}
.l-shipped{background:var(--green);color:var(--green)}
.l-failed{background:var(--red);color:var(--red)}
.l-partial{background:var(--amber);color:var(--amber)}
.l-pending{background:var(--green);color:var(--green);animation:pulse 1.1s infinite}
.goal{font-size:13px;color:#e8d5ad;margin:0 0 5px}
.proj{color:var(--amber);letter-spacing:.16em;font-size:10px;text-transform:uppercase;margin-right:9px}
.sub{font-size:11px;color:var(--grey);letter-spacing:.08em}
.right{text-align:right;white-space:nowrap}
.score{font-size:17px}
.verdict{font-size:10px;letter-spacing:.22em;text-transform:uppercase;display:block;margin-top:3px}
.v-shipped{color:var(--green)}.v-failed{color:var(--red)}.v-partial,.v-pending{color:var(--amber)}
.mini{height:5px;border:1px solid var(--rule);background:#0c0a07;display:flex;width:130px;margin-top:6px}
.mini i{display:block;height:100%}.mini i.p{background:var(--green)}.mini i.f{background:var(--red)}.mini i.u{background:#2a2419}
.none{padding:38px 16px;text-align:center;color:var(--grey)}
.none b{display:block;color:var(--amber-dim);letter-spacing:.3em;margin-bottom:10px}
code{color:var(--amber)}
footer{color:var(--grey);font-size:11px;letter-spacing:.14em;text-align:center;padding:18px 0}
`

function page(runs) {
  const live = runs.filter(r => (r.state.verdict ?? 'pending') === 'pending' && r.state.stage !== 'done')
  const tally = runs.reduce((a, r) => { const v = r.state.verdict || 'pending'; a[v] = (a[v] || 0) + 1; return a }, {})
  const projects = new Set(runs.map(r => r.project))

  const berths = runs.map(r => {
    const v = r.state.verdict || 'pending'
    const pct = r.total ? r.pass / r.total * 100 : 0
    const fpct = r.total ? r.fail / r.total * 100 : 0
    const lost = (r.state.deaths || []).length
    return `<div class="berth">
      <div class="lamp l-${esc(v)}"></div>
      <div>
        <p class="goal"><span class="proj">${esc(r.project)}</span><a href="/r?d=${encodeURIComponent(r.dir)}">${esc(r.goal)}</a></p>
        <div class="sub">${esc(r.id)} · cycle ${esc(r.state.cycle || '?')}/${esc(r.state.maxCycles || 3)} · stage ${esc(r.state.stage || '—')}${r.state.branch ? ' · ' + esc(r.state.branch) : ''}${lost ? ` · <span style="color:var(--red)">${lost} lost</span>` : ''}</div>
        ${r.total ? `<div class="mini"><i class="p" style="width:${pct}%"></i><i class="f" style="width:${fpct}%"></i><i class="u" style="width:${100 - pct - fpct}%"></i></div>` : ''}
      </div>
      <div class="right"><span class="score">${r.total ? r.pass + '/' + r.total : '—'}</span>
        <span class="verdict v-${esc(v)}">${esc(v)}</span></div>
    </div>`
  }).join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${live.length ? '<meta http-equiv="refresh" content="5">' : ''}
<title>${live.length ? '◉ ' : ''}SHIPYARD // THE YARD</title><style>${CSS}</style></head><body>
<header>
  <h1>SHIPYARD<small>THE YARD // ${esc(ROOTS.join('  ·  '))}</small></h1>
  <div class="meta">
    ${live.length ? `<span class="chip live"><span class="dot"></span>${live.length} ACTIVE</span>` : '<span class="chip">ALL QUIET</span>'}
    <span class="chip">RUNS <b>${runs.length}</b></span>
    <span class="chip">PROJECTS <b>${projects.size}</b></span>
    ${Object.entries(tally).map(([k, v]) => `<span class="chip">${esc(k)} <b>${v}</b></span>`).join('')}
  </div>
</header>
${live.length ? '<div class="scan"><i></i></div>' : ''}
<div class="hazard"></div>
<section><h2>Berths — most recent first</h2>
${runs.length ? berths : `<div class="none"><b>YARD EMPTY</b>
No runs found under ${esc(ROOTS.join(', '))}.<br><br>
Stand in a repo and run <code>/shipyard &lt;what you want built&gt;</code>,<br>
or see the demo yard with <code>npm run demo</code>.</div>`}
</section>
<div class="hazard"></div>
<footer>${live.length ? 'YARD ACTIVE — reloading every 5s' : 'ALL BERTHS QUIET'} // 127.0.0.1:${PORT}</footer>
</body></html>`
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/r') {
    const dir = url.searchParams.get('d')
    // Only serve run directories the scan actually found — never arbitrary paths.
    if (!dir || !scan().some(r => r.dir === dir)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end('unknown run')
    }
    try { execFileSync('node', [RENDERER, dir], { stdio: 'pipe' }) } catch {}
    const file = join(dir, 'report.html')
    if (!existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      return res.end('could not render that run')
    }
    const html = readFileSync(file, 'utf8')
      .replace('<body>', `<body><div style="padding:0 0 14px"><a href="/" style="color:#8a6224;letter-spacing:.2em;font-size:11px;font-family:monospace">◂ BACK TO THE YARD</a></div>`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(html)
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(page(scan()))
}).listen(PORT, '127.0.0.1', () => {
  const found = scan()
  console.log(`\n  ░▒▓ SHIPYARD ▓▒░  the yard is open\n`)
  console.log(`  http://localhost:${PORT}\n`)
  console.log(`  watching: ${ROOTS.join(', ')}`)
  console.log(`  found:    ${found.length} run(s) across ${new Set(found.map(r => r.project)).size} project(s)`)
  console.log(`\n  ctrl-c to close the yard\n`)
})
