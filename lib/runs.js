// Runs: reads Claude Code session logs (~/.claude/projects/**.jsonl) incrementally and
// works out model, tokens, cost, skills, tools and which workspace each session belongs to.
// Parsing approach and prices follow the Claude Pulse tray widget.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(process.env.AIODIZE_HOME || os.homedir(), '.claude', 'projects'); // AIODIZE_HOME: tests and demos never read real sessions
const PRICES = [ // $ per 1M tokens: input, output, cache read (same table as Claude Pulse)
  [/fable|mythos/, 10, 50, 0.25], [/opus-5-5/, 4, 20, 0.2], [/opus/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2], [/sonnet/, 3, 15, 0.3], [/haiku-5/, 0.1, 0.5, 0.01], [/haiku/, 1, 5, 0.1],
];
const price = m => PRICES.find(p => p[0].test(m)) || [null, 4, 20, 0.2];
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Sessions match projects by the folder names right under the projects folder, found by its last path part (e.g. "Projects").
let ROOT = 'Projects', FOLDER_RE = null, FOLDER_SRC = '';
const setRoot = p => { ROOT = path.basename(path.resolve(String(p || '.'))).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || 'Projects'; };
const rootPat = () => ROOT;
const folderRe = () => { if (FOLDER_SRC !== ROOT) { FOLDER_SRC = ROOT; FOLDER_RE = new RegExp(ROOT + '(?:\\\\\\\\|/)+([A-Za-z0-9._-]+)', 'gi'); } return FOLDER_RE; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? ((c.find(x => x && x.type === 'text') || {}).text || '') : '';
function cleanTitle(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (!s || s.startsWith('<') || s.startsWith('[Request interrupted') || s.startsWith('Caveat:')) return '';
  return s.length > 90 ? s.slice(0, 88) + '…' : s;
}

function emptyAgg(sid, proj) {
  return { sid, proj, title: '', cwd: '', first: 0, last: 0, tin: 0, tout: 0, tcache: 0, cost: 0, msgs: 0,
    days: {}, models: {}, tools: {}, skills: {}, mcp: {}, folders: {}, files: {}, offset: 0, size: 0, mtime: 0, lastId: '' };
}

function handleLine(agg, line, dirs) {
  const isAsst = line.includes('"type":"assistant"');
  const isUser = !isAsst && line.includes('"type":"user"');
  if (!isAsst && !isUser) {
    if (!agg.customTitle && line.includes('"type":"custom-title"')) { const t = cleanTitle(JSON.parse(line).customTitle); if (t) agg.customTitle = t; }
    return;
  }
  if (isUser) {
    if (agg.title || line.length > 200000 || line.includes('"tool_result"') || line.includes('"isMeta":true')) return;
    const j = JSON.parse(line);
    if (!agg.cwd && j.cwd) agg.cwd = j.cwd;
    const t = cleanTitle(textOf(j.message && j.message.content));
    if (t) agg.title = t;
    return;
  }
  let m; const re = folderRe(); re.lastIndex = 0;
  while ((m = re.exec(line))) if (dirs.has(m[1])) agg.folders[m[1]] = (agg.folders[m[1]] || 0) + 1;
  const j = JSON.parse(line);
  const ts = j.timestamp ? new Date(j.timestamp) : null;
  if (!ts || isNaN(ts)) return;
  const t = ts.getTime();
  if (!agg.first || t < agg.first) agg.first = t;
  if (t > agg.last) agg.last = t;
  if (!agg.cwd && j.cwd) agg.cwd = j.cwd;
  const msg = j.message || {};
  const id = msg.id || j.uuid;
  const fresh = !(id && id === agg.lastId); // one API message can be split across lines
  agg.lastId = id || '';
  const model = msg.model || 'unknown';
  if (model === '<synthetic>') return;
  if (fresh && msg.usage) {
    const u = msg.usage, inp = u.input_tokens || 0, out = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0;
    const cwAll = u.cache_creation_input_tokens || 0, cw1h = (u.cache_creation || {}).ephemeral_1h_input_tokens || 0;
    const [, pi, po, pr] = price(model);
    const cost = (inp * pi + out * po + cr * pr + Math.max(0, cwAll - cw1h) * pi * 1.25 + cw1h * pi * 2) / 1e6;
    const tok = inp + out + cr + cwAll;
    agg.tin += inp + cwAll; agg.tout += out; agg.tcache += cr; agg.cost += cost; agg.msgs++;
    const d = dayKey(ts), day = agg.days[d] || (agg.days[d] = [0, 0]); day[0] += tok; day[1] += cost;
    const mm = agg.models[model] || (agg.models[model] = [0, 0]); mm[0] += tok; mm[1] += cost;
  }
  if (Array.isArray(msg.content)) for (const c of msg.content) {
    if (!c || c.type !== 'tool_use') continue;
    const name = c.name || '?';
    agg.tools[name] = (agg.tools[name] || 0) + 1;
    if (name === 'Skill' && c.input && c.input.skill) agg.skills[c.input.skill] = (agg.skills[c.input.skill] || 0) + 1;
    if (name.startsWith('mcp__')) { const s = name.split('__')[1]; agg.mcp[s] = (agg.mcp[s] || 0) + 1; }
    // Files under the projects folder that the session read or changed (for per-file token bubbles).
    const fp = c.input && (c.input.file_path || c.input.notebook_path || c.input.path);
    const fm = typeof fp === 'string' && new RegExp(ROOT + '[\\\\/]+(.+\\.[A-Za-z0-9]{1,8})$', 'i').exec(fp);
    if (fm) {
      const rel = fm[1].replace(/\\/g, '/');
      if (dirs.has(rel.split('/')[0]) && (agg.files[rel] || Object.keys(agg.files).length < 400)) agg.files[rel] = (agg.files[rel] || 0) + 1;
    }
  }
}

// Score a session against each workspace by the project folders and connectors it touched.
// Folders that match no workspace count toward the one marked "fallback".
function globRe(g) { return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'); }
function attribute(agg, workspaces) {
  const score = {};
  const fb = workspaces.find(w => w.fallback);
  const pats = workspaces.filter(w => !w.fallback).map(w => ({ id: w.id, re: (w.folders || []).map(globRe), tools: (w.tools || []).map(t => t.toLowerCase()) }));
  const fol = Object.assign({}, agg.folders);
  const cwdM = new RegExp(ROOT + '[\\\\/]+([^\\\\/]+)', 'i').exec(agg.cwd || '');
  if (cwdM) fol[cwdM[1]] = (fol[cwdM[1]] || 0) + 5;
  for (const [f, n] of Object.entries(fol)) {
    const hit = pats.find(p => p.re.some(r => r.test(f)));
    const id = hit ? hit.id : fb && fb.id;
    if (id) score[id] = (score[id] || 0) + n;
  }
  const allWs = workspaces.map(w => ({ id: w.id, tools: (w.tools || []).map(t => t.toLowerCase()) }));
  for (const [s, n] of Object.entries(agg.mcp)) for (const w of allWs) if (w.tools.some(t => s.toLowerCase().includes(t))) score[w.id] = (score[w.id] || 0) + n * 3;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return '';
  return ranked[0][0];
}

class RunIndex {
  constructor(cacheFile, raviRoot) {
    this.cacheFile = cacheFile; this.ravi = raviRoot;
    try { this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { this.cache = { v: 2, files: {} }; }
    if (this.cache.v !== 2) this.cache = { v: 2, files: {} };
    this.state = { running: false, done: 0, total: 0, lastScan: 0 };
  }
  dirs() { try { return new Set(fs.readdirSync(this.ravi, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)); } catch { return new Set(); } }
  discover() {
    const out = [];
    const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
    for (const p of ls(PROJECTS)) {
      if (!p.isDirectory()) continue;
      const pd = path.join(PROJECTS, p.name);
      for (const f of ls(pd)) {
        if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: path.join(pd, f.name), sid: f.name.slice(0, -6), proj: p.name });
        else if (f.isDirectory()) for (const s of ls(path.join(pd, f.name, 'subagents')))
          if (s.isFile() && s.name.endsWith('.jsonl')) out.push({ file: path.join(pd, f.name, 'subagents', s.name), sid: f.name, proj: p.name, sub: true });
      }
    }
    return out;
  }
  async scan(onProgress) {
    if (this.state.running) return;
    const list = this.discover(), dirs = this.dirs();
    this.state = { running: true, done: 0, total: list.length, lastScan: this.state.lastScan };
    let changed = false;
    for (const d of list) {
      let st; try { st = fs.statSync(d.file); } catch { this.state.done++; continue; }
      let agg = this.cache.files[d.file];
      if (agg && agg.size === st.size && agg.mtime === st.mtimeMs) { this.state.done++; continue; }
      if (!agg || st.size < agg.offset) agg = emptyAgg(d.sid, d.proj);
      agg.sub = !!d.sub;
      const fd = fs.openSync(d.file, 'r');
      try {
        const CH = 8 << 20; let pos = agg.offset, carry = Buffer.alloc(0);
        while (pos < st.size) {
          const buf = Buffer.alloc(Math.min(CH, st.size - pos));
          const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) break;
          pos += n;
          const all = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
          let start = 0;
          for (;;) {
            const nl = all.indexOf(10, start); if (nl < 0) break;
            const line = all.toString('utf8', start, nl); start = nl + 1;
            if (line.length > 20) try { handleLine(agg, line, dirs); } catch {}
          }
          carry = Buffer.from(all.subarray(start));
          await new Promise(r => setImmediate(r)); // keep the server responsive
        }
        agg.offset = pos - carry.length;
      } finally { fs.closeSync(fd); }
      agg.size = st.size; agg.mtime = st.mtimeMs;
      this.cache.files[d.file] = agg; changed = true;
      this.state.done++;
      if (onProgress && this.state.done % 25 === 0) onProgress(this.state);
    }
    if (changed) { try { fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache)); } catch {} }
    this.state.running = false; this.state.lastScan = Date.now();
    if (onProgress) onProgress(this.state);
    return changed;
  }
  // Merge subagent logs into their parent session, then attribute.
  sessions(workspaces) {
    const by = new Map();
    for (const a of Object.values(this.cache.files)) {
      let s = by.get(a.sid);
      if (!s) { s = emptyAgg(a.sid, a.proj); s.subagents = 0; by.set(a.sid, s); }
      if (a.sub) s.subagents++; else { s.title = a.customTitle || a.title || s.title; s.cwd = a.cwd || s.cwd; }
      if (a.first && (!s.first || a.first < s.first)) s.first = a.first;
      if (a.last > s.last) s.last = a.last;
      for (const k of ['tin', 'tout', 'tcache', 'cost', 'msgs']) s[k] += a[k];
      for (const k of ['tools', 'skills', 'mcp', 'folders', 'files']) for (const [x, n] of Object.entries(a[k] || {})) s[k][x] = (s[k][x] || 0) + n;
      for (const [m, v] of Object.entries(a.models)) { const t = s.models[m] || (s.models[m] = [0, 0]); t[0] += v[0]; t[1] += v[1]; }
      for (const [d, v] of Object.entries(a.days)) { const t = s.days[d] || (s.days[d] = [0, 0]); t[0] += v[0]; t[1] += v[1]; }
    }
    const out = [];
    for (const s of by.values()) {
      if (!s.msgs) continue;
      s.ws = attribute(s, workspaces);
      s.model = Object.entries(s.models).sort((a, b) => b[1][0] - a[1][0]).map(x => x[0])[0] || '';
      s.tokens = s.tin + s.tout + s.tcache;
      out.push(s);
    }
    return out.sort((a, b) => b.last - a.last);
  }
}

module.exports = { RunIndex, attribute, globRe, setRoot, rootPat };
