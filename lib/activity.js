// Activity per project per day: Claude sessions (split by the project folders they touched), note edits, git commits.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad = n => String(n).padStart(2, '0');
const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const N = 5; // [tokens, cost, sessions, edits, commits]

const { rootPat } = require('./runs');

// Project folder name -> project note path, read from each project's `folder:` property.
function projectDirs(notes, dirs) {
  const map = new Map();
  const sorted = [...dirs].sort((a, b) => b.length - a.length);
  for (const n of notes) {
    if (n.type !== 'project' || !n.props.folder) continue;
    const text = String(n.props.folder);
    for (const d of sorted) if (!map.has(d) && new RegExp(rootPat() + '[\\\\/]+' + esc(d) + '(?=$|[\\\\/;,()\\s])', 'i').test(text)) map.set(d, n.rel);
  }
  return map;
}

// Which projects a session worked on, as shares that add up to 1. '' = no known project.
function shares(session, dirMap) {
  const w = {};
  const fol = Object.assign({}, session.folders);
  const m = new RegExp(rootPat() + '[\\\\/]+([^\\\\/]+)', 'i').exec(session.cwd || '');
  if (m) fol[m[1]] = (fol[m[1]] || 0) + 5;
  let total = 0;
  for (const [f, n] of Object.entries(fol)) { const p = dirMap.get(f); if (p) { w[p] = (w[p] || 0) + n; total += n; } }
  if (!total) return { '': 1 };
  for (const k in w) w[k] /= total;
  return w;
}

// series[key][day] = [tokens, cost, sessions, edits, commits]; key '_all' is the whole workspace.
function build(sessions, notes, dirs, activity, commits = {}) {
  const dirMap = projectDirs(notes, dirs);
  const series = { _all: {} };
  const add = (key, day, i, v) => { const s = series[key] || (series[key] = {}); const d = s[day] || (s[day] = new Array(N).fill(0)); d[i] += v; };
  for (const s of sessions) {
    const sh = shares(s, dirMap);
    for (const [day, v] of Object.entries(s.days)) {
      add('_all', day, 0, v[0]); add('_all', day, 1, v[1]); add('_all', day, 2, 1);
      for (const [p, f] of Object.entries(sh)) { const k = p || '_other'; add(k, day, 0, v[0] * f); add(k, day, 1, v[1] * f); add(k, day, 2, 1); }
    }
  }
  const isProject = new Set(notes.filter(n => n.type === 'project').map(n => n.rel));
  for (const e of activity) {
    if (!e.path || e.action === 'run') continue;
    const day = dayOf(e.ts);
    add('_all', day, 3, 1);
    if (isProject.has(e.path)) add(e.path, day, 3, 1);
  }
  for (const [p, days] of Object.entries(commits)) for (const [day, n] of Object.entries(days)) { add('_all', day, 4, n); add(p, day, 4, n); }
  return { series, dirMap };
}

// Token use split by file inside one scope over [from, today]. A session's tokens for the project are
// shared across the project files it touched, by how often it touched each. Files are paths under the projects folder.
function fileBubbles(sessions, dirMap, scope, from) {
  const out = new Map();
  const addTo = (key, v) => out.set(key, (out.get(key) || 0) + v);
  for (const s of sessions) {
    let tok = 0; for (const [d, v] of Object.entries(s.days)) if (d >= from) tok += v[0];
    if (!tok) continue;
    const sh = shares(s, dirMap);
    const share = scope === '_other' ? (sh[''] || 0) : (sh[scope] || 0);
    if (!share) continue;
    const files = Object.entries(s.files || {}).filter(([f]) => {
      const p = dirMap.get(f.split('/')[0]);
      return scope === '_other' ? !p : p === scope;
    });
    const touches = files.reduce((a, [, n]) => a + n, 0);
    if (!touches) { addTo(scope === '_other' ? '(no files)' : '(work with no file edits)', tok * share); continue; }
    for (const [f, n] of files) addTo(f, tok * share * n / touches);
  }
  return [...out.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

// Git commits by you, per day, for every git repo among a project's folders.
// ponytail: one `git log` per repo every 10 minutes; fine for tens of repos.
function gitDays(dir, authors) {
  return new Promise(res => {
    if (!fs.existsSync(path.join(dir, '.git'))) return res(null);
    const args = ['log', '--since=400.days', '--date=short', '--pretty=%ad', '--regexp-ignore-case', ...authors.map(a => '--author=' + a)];
    execFile('git', args, { cwd: dir, windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return res(null);
      const days = {};
      for (const l of out.split('\n')) if (/^\d{4}-\d{2}-\d{2}$/.test(l.trim())) days[l.trim()] = (days[l.trim()] || 0) + 1;
      res(days);
    });
  });
}
async function commitsByProject(ravi, dirMap, authors) {
  const out = {};
  for (const [dir, proj] of dirMap) {
    const days = await gitDays(path.join(ravi, dir), authors);
    if (!days) continue;
    const t = out[proj] || (out[proj] = {});
    for (const [d, n] of Object.entries(days)) t[d] = (t[d] || 0) + n;
  }
  return out;
}

module.exports = { projectDirs, shares, build, fileBubbles, commitsByProject, dayOf, N };
