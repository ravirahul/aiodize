// Aiodize local server: serves the app on http://127.0.0.1:4848 and its API. No dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const V = require('./lib/vault');
const W = require('./lib/workspace');
const { RunIndex } = require('./lib/runs');
const Fav = require('./lib/favicon');
const Act = require('./lib/activity');
const Ins = require('./lib/insights');
const B = require('./lib/board');
const boardOf = id => B.read(W.DATA, id);
const Apps = require('./lib/apps');
const Bk = require('./lib/backup');
const Setup = require('./lib/setup');
const VERSION = require('./package.json').version;
// Apps connected through setup learn about new or renamed workspaces (new servers, updated instructions).
function refreshConnections() { const ids = Setup.state().apps || []; if (ids.length) Apps.run('connect', ids, config.workspaces); }
const SETUP_PROMPT = 'Set up Aiodize for me. Start with the setup_status tool, look at my notes and project folders, ask me anything unclear, then call propose_setup so I can review it in Aiodize.';
const { execFileSync, execFile } = require('child_process');
const today = () => V.dayOf(Date.now());

const PORT = Number(process.env.CHITTA_PORT || 4848);
const TOKEN = crypto.randomBytes(16).toString('hex');
const WEB = path.join(__dirname, 'web');
let config = W.loadConfig();
require('./lib/runs').setRoot(config.ravi);
const runs = new RunIndex(path.join(W.DATA, 'runs-cache.json'), config.ravi);

// ---------- per-workspace graph cache + live events ----------
const cache = new Map(); // id -> { notes, graph }
function load(id) {
  if (!cache.has(id)) {
    const w = W.getWs(config, id); const notes = V.readNotes(w.vault);
    cache.set(id, { notes, graph: V.buildGraph(notes, config.workspaces.map(x => x.id).filter(x => x !== id)) });
    warmIcons(id);
  }
  return cache.get(id);
}
// Fetch missing favicons in the background; tell the page when each one lands.
async function warmIcons(id) {
  const sites = [...new Set(cache.get(id).graph.nodes.filter(n => n.site).map(n => n.site))];
  for (const s of sites) {
    const host = new URL(s).hostname;
    if (Fav.cached(host)) continue;
    const e = await Fav.fetchIcon(s).catch(() => null);
    if (e && e.file) emit('favicon', { host });
  }
}
function raviDirs() { try { return fs.readdirSync(config.ravi, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } }
// Git commits by you, per project, refreshed every 10 minutes.
const commitsMemo = {};
let authors = []; // your git name and email, so only your commits count
try { const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', windowsHide: true }).trim(); if (n) authors.push(n.replace(/[.+*?()[\]\\]/g, '\\$&')); } catch {}
try { const e = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true }).trim(); if (e) authors.push(e.replace(/[.+]/g, '\\$&')); } catch {}
async function refreshGit() {
  for (const w of config.workspaces) {
    const dm = Act.projectDirs(load(w.id).notes, raviDirs());
    commitsMemo[w.id] = await Act.commitsByProject(config.ravi, dm, authors).catch(() => ({}));
  }
  emit('runs', { git: true });
}
setTimeout(refreshGit, 1500);
setInterval(refreshGit, 10 * 60_000);

function activityFor(id) {
  const { notes } = load(id);
  const { series } = Act.build((runsMemo || []).filter(s => s.ws === id), notes, raviDirs(), W.readActivity(id, 100000), commitsMemo[id] || {});
  const projects = notes.filter(n => n.type === 'project').map(n => {
    const t = [0, 0, 0, 0]; for (const v of Object.values(series[n.rel] || {})) for (let i = 0; i < 4; i++) t[i] += v[i];
    const site = V.siteOf(n.props);
    const host = site ? new URL(site).hostname : '';
    return { path: n.rel, title: n.title, category: n.category, status: n.props.status || '', host: host && Fav.has(host) ? host : '', total: t };
  });
  return { projects, series, health: Ins.health(notes, series, today(), boardOf(id).statuses) };
}
function slug(s) { return String(s).replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Idea'; }
const clients = new Set();
function emit(type, data) { const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); }

const timers = {};
function watchWs(w) {
  const fire = (kind, file) => {
    clearTimeout(timers[w.id + kind]);
    timers[w.id + kind] = setTimeout(() => {
      if (kind === 'vault') { cache.delete(w.id); emit('graph', { ws: w.id, path: file }); }
      else emit('activity', { ws: w.id, entry: W.readActivity(w.id, 1)[0] || null });
    }, 150);
  };
  try { fs.watch(w.vault, { recursive: true }, (_, f) => { if (f && !/^\.(obsidian|git|trash)/.test(f) && /\.md$/i.test(f)) fire('vault', String(f).split(path.sep).join('/')); }); }
  catch (e) { console.warn('Cannot watch', w.vault, e.message); }
  try { fs.watch(path.join(W.DATA, w.id), (_, f) => { if (f === 'activity.jsonl') fire('activity'); }); } catch {}
}
config.workspaces.forEach(watchWs);

// ---------- runs ----------
let runsMemo = null;
async function rescan() {
  const changed = await runs.scan(st => emit('runs-progress', st));
  if (changed || !runsMemo) { runsMemo = runs.sessions(config.workspaces); emit('runs', { done: true }); }
}
setTimeout(rescan, 300);
setInterval(rescan, 60_000);

function runsFor(id) {
  const all = runsMemo || [];
  const list = all.filter(s => s.ws === id);
  const now = Date.now(), DAY = 864e5;
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(now - i * DAY); days.push({ day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, tokens: 0, cost: 0 }); }
  const byModel = {}, skills = {}, tools = {};
  let t7 = 0, c7 = 0, s7 = 0;
  for (const s of list) {
    for (const d of days) { const v = s.days[d.day]; if (v) { d.tokens += v[0]; d.cost += v[1]; } }
    if (s.last > now - 7 * DAY) { s7++; for (const [k, v] of Object.entries(s.days)) if (new Date(k + 'T00:00') > now - 7 * DAY) { t7 += v[0]; c7 += v[1]; } }
    for (const [m, v] of Object.entries(s.models)) { const b = byModel[m] || (byModel[m] = [0, 0]); b[0] += v[0]; b[1] += v[1]; }
    for (const [k, n] of Object.entries(s.skills)) skills[k] = (skills[k] || 0) + n;
    for (const [k, n] of Object.entries(s.mcp)) tools[k] = (tools[k] || 0) + n;
  }
  const slim = s => ({ sid: s.sid, title: s.title, cwd: s.cwd, first: s.first, last: s.last, model: s.model, tokens: s.tokens, cost: s.cost,
    skills: s.skills, mcp: s.mcp, folders: Object.entries(s.folders).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]), subagents: s.subagents });
  return { indexing: runs.state, sessions: list.slice(0, 60).map(slim), totalSessions: list.length,
    unassigned: all.filter(s => !s.ws).length, days, byModel, skills, tools, week: { tokens: t7, cost: c7, sessions: s7 } };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) { bad(new Error('Too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Bad host' }); // blocks DNS rebinding
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      const file = p === '/' ? 'index.html' : p.slice(1);
      const full = path.resolve(WEB, file);
      if (!full.startsWith(WEB + path.sep) || !fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
      let body = fs.readFileSync(full, 'utf8');
      if (file === 'index.html') body = body.replace('__TOKEN__', TOKEN);
      return send(res, 200, body, MIME[path.extname(full)] || 'text/plain');
    }
    if ((req.headers['x-chitta-token'] || url.searchParams.get('t')) !== TOKEN) return send(res, 401, { error: 'Missing token' });
    const wsId = url.searchParams.get('ws');
    if (p === '/api/favicon') {
      const f = Fav.cached(String(url.searchParams.get('host') || ''));
      if (!f) return send(res, 404, { error: 'No icon' });
      // Served as a plain image: a hostile SVG opened directly can't run anything here.
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return res.end(f.buf);
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (p === '/api/state') {
      return send(res, 200, { version: require('./package.json').version, ravi: config.ravi, workspaces: config.workspaces.map(w => ({ id: w.id, name: w.name, color: w.color, vault: w.vault, notes: load(w.id).notes.length })) });
    }
    if (p === '/api/mcp' && req.method === 'GET') {
      // Per workspace: is it added to Claude Code, and when did an agent last connect?
      let cc = {}; try { cc = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.claude.json'), 'utf8')); } catch {}
      const names = new Set(Object.keys(cc.mcpServers || {}));
      for (const pr of Object.values(cc.projects || {})) for (const k of Object.keys(pr.mcpServers || {})) names.add(k);
      return send(res, 200, config.workspaces.map(w => {
        let seen = null; try { seen = JSON.parse(fs.readFileSync(path.join(W.DATA, w.id, 'mcp-seen.json'), 'utf8')); } catch {}
        return { id: w.id, name: w.name, server: names.has('chitta-' + w.id) && !names.has('aiodize-' + w.id) ? 'chitta-' + w.id : 'aiodize-' + w.id, added: names.has('aiodize-' + w.id) || names.has('chitta-' + w.id), seen,
          cmd: `claude mcp add -s user aiodize-${w.id} -- node "${path.join(__dirname, 'mcp.js')}" --workspace ${w.id}` };
      }));
    }
    if (p === '/api/mcp/add' && req.method === 'POST') {
      // Same connector as Settings > Agents (works from the desktop app too, where there is no plain node).
      const r = Apps.run('connect', ['claude-code'], config.workspaces).results[0];
      if (r.ok) { const s = Setup.state(); s.apps = [...new Set([...(s.apps || []), 'claude-code'])]; Setup.save(s); }
      return send(res, r.ok ? 200 : 400, { ok: r.ok, text: r.ok ? 'Added to Claude Code. Start a new Claude Code session to use it.' : r.error });
    }
    if (p === '/api/workspaces' && req.method === 'GET') return send(res, 200, { ravi: config.ravi, workspaces: config.workspaces });
    if (p === '/api/workspaces' && req.method === 'PUT') {
      const b = await readBody(req);
      const next = W.validateWorkspaces(b.workspaces, config.ravi);
      fs.writeFileSync(W.CONFIG, JSON.stringify({ ravi: config.ravi, workspaces: next }, null, 2) + '\n');
      const known = new Set(config.workspaces.map(w => w.id));
      config = W.loadConfig(); cache.clear(); runsMemo = runs.sessions(config.workspaces);
      config.workspaces.filter(w => !known.has(w.id)).forEach(watchWs);
      refreshConnections(); emit('workspaces', {});
      return send(res, 200, { workspaces: config.workspaces });
    }
    // ---------- onboarding, AI apps, backups, the AI's setup proposal ----------
    if (p === '/api/setup' && req.method === 'GET') {
      const s = Setup.state();
      return send(res, 200, { done: !!s.agreedAt, agreedAt: s.agreedAt, backup: s.backup, apps: Apps.list(), vaults: config.workspaces.map(w => w.vault), obsidian: Setup.obsidianVaults(), projectsRoot: config.ravi, prompt: SETUP_PROMPT, version: VERSION });
    }
    if (p === '/api/setup' && req.method === 'POST') {
      const b = await readBody(req), s = Setup.state();
      // notes folder + projects folder (first run only changes the single default workspace)
      if (b.projectsRoot && path.isAbsolute(b.projectsRoot) && fs.existsSync(b.projectsRoot)) { config.ravi = path.resolve(b.projectsRoot); require('./lib/runs').setRoot(config.ravi); runs.ravi = config.ravi; }
      if (b.vault && config.workspaces.length === 1 && path.isAbsolute(b.vault) && fs.existsSync(b.vault)) config.workspaces[0].vault = path.resolve(b.vault);
      fs.writeFileSync(W.CONFIG, JSON.stringify({ ravi: config.ravi, workspaces: config.workspaces.map(({ ...w }) => w) }, null, 2) + '\n');
      config = W.loadConfig(); cache.clear();
      s.backup = Object.assign(s.backup, { on: !!(b.backup && b.backup.on), dir: String((b.backup && b.backup.dir) || s.backup.dir) });
      const apps = Array.isArray(b.apps) ? b.apps.map(String) : [];
      const conn = apps.length ? Apps.run('connect', apps, config.workspaces) : { results: [], backup: '' };
      let backupMade = '';
      if (s.backup.on) { try { backupMade = Bk.snapshot(config, s.backup.dir, { version: VERSION }); } catch (e) { backupMade = 'error: ' + e.message; } }
      Setup.save(Object.assign(s, { agreedAt: Date.now(), apps: conn.results.filter(r => r.ok).map(r => r.id) }));
      for (const w of config.workspaces) W.logActivity(w.id, { who: 'you', action: 'setup', path: '', summary: `Set up Aiodize: connected ${conn.results.filter(r => r.ok).length} AI app(s)${s.backup.on ? ', backups on' : ''}` });
      emit('workspaces', {});
      return send(res, 200, { connect: conn, backup: backupMade });
    }
    if (p === '/api/apps' && req.method === 'GET') return send(res, 200, Apps.list());
    if (p === '/api/apps' && req.method === 'POST') {
      const b = await readBody(req), op = b.op === 'disconnect' ? 'disconnect' : 'connect';
      const r = Apps.run(op, (Array.isArray(b.ids) ? b.ids : []).map(String), config.workspaces);
      const s = Setup.state(), ok = r.results.filter(x => x.ok).map(x => x.id); // remembered, so new workspaces reach these apps too
      s.apps = op === 'connect' ? [...new Set([...(s.apps || []), ...ok])] : (s.apps || []).filter(id => !ok.includes(id)); Setup.save(s);
      for (const w of config.workspaces) W.logActivity(w.id, { who: 'you', action: 'setup', path: '', summary: `${op === 'connect' ? 'Connected' : 'Disconnected'} ${r.results.filter(x => x.ok).map(x => x.id).join(', ')}` });
      return send(res, 200, r);
    }
    if (p === '/api/extension' && req.method === 'POST') {
      // Builds the Claude Desktop extension (dist/aiodize.mcpb) and shows it in Explorer / Finder.
      try { require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'tools', 'build-mcpb.js')], { stdio: 'ignore', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) }); } catch (e) { return send(res, 500, { error: 'Could not build the extension: ' + e.message }); }
      const file = path.join(__dirname, 'dist', 'aiodize.mcpb');
      if (process.platform === 'win32') spawn('explorer.exe', ['/select,' + file], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { file, folder: __dirname });
    }
    if (p === '/api/launch' && req.method === 'POST') {
      // Opens Claude Code in a new terminal with the setup prompt (other apps: copy the prompt).
      if (process.platform !== 'win32') return send(res, 400, { error: 'Copy the prompt into your AI app.' });
      spawn('cmd.exe', ['/c', `start "Aiodize setup" cmd /k claude "${SETUP_PROMPT}"`], { cwd: config.ravi, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/backups' && req.method === 'GET') { const s = Setup.state(); return send(res, 200, { settings: s.backup, list: Bk.list(s.backup.dir) }); }
    if (p === '/api/backups' && req.method === 'PUT') {
      const b = await readBody(req), s = Setup.state();
      const dir = String(b.dir || s.backup.dir).trim();
      if (!path.isAbsolute(dir)) return send(res, 400, { error: 'Use a full folder path, like D:\\Backups\\Aiodize' });
      s.backup = { on: !!b.on, dir, keep: Math.max(1, Math.min(90, Number(b.keep) || s.backup.keep || 14)) };
      Setup.save(s); return send(res, 200, s.backup);
    }
    if (p === '/api/backups/now' && req.method === 'POST') {
      const s = Setup.state();
      try { const name = Bk.snapshot(config, s.backup.dir, { version: VERSION }); Bk.prune(s.backup.dir, s.backup.keep); return send(res, 200, { name }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/backups/restore' && req.method === 'POST') {
      const b = await readBody(req), s = Setup.state();
      try { const r = Bk.restore(config, s.backup.dir, String(b.name || ''), String(b.ws || ''), VERSION); cache.clear(); emit('workspaces', {}); return send(res, 200, r); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/proposal' && req.method === 'GET') return send(res, 200, Setup.proposal() || {});
    if (p === '/api/proposal' && req.method === 'DELETE') { Setup.dropProposal(); return send(res, 200, { ok: true }); }
    if (p === '/api/proposal/accept' && req.method === 'POST') {
      const pr = Setup.proposal(); if (!pr) return send(res, 400, { error: 'There is no proposal to accept' });
      const b = await readBody(req), want = Object.assign({ workspaces: true, rules: true, statuses: true, notes: true }, b.parts || {}), done = [];
      const s = Setup.state(); try { if (s.backup.on) Bk.snapshot(config, s.backup.dir, { label: '-before-restore', version: VERSION }); } catch {}
      try {
        if (want.workspaces && pr.workspaces.length) {
          const byId = new Map(config.workspaces.map(w => [w.id, w]));
          const merged = pr.workspaces.map(w => Object.assign({}, byId.get(String(w.id || '').toLowerCase()) || {}, w));
          for (const w of config.workspaces) if (!merged.some(m => String(m.id).toLowerCase() === w.id)) merged.push(w); // never drop a workspace
          const next = W.validateWorkspaces(merged, config.ravi);
          fs.writeFileSync(W.CONFIG, JSON.stringify({ ravi: config.ravi, workspaces: next }, null, 2) + '\n');
          const known = new Set(config.workspaces.map(w => w.id));
          config = W.loadConfig(); cache.clear(); runsMemo = runs.sessions(config.workspaces);
          config.workspaces.filter(w => !known.has(w.id)).forEach(watchWs);
          done.push(`${pr.workspaces.length} workspace(s)`);
        }
        const has = id => config.workspaces.some(w => w.id === id);
        if (want.rules) for (const [id, text] of Object.entries(pr.rules)) if (has(id)) { W.writeRules(id, /^---\n/.test(text) ? text : `---\nai_write: write\n---\n${text}\n`); done.push('rules for ' + id); }
        if (want.statuses) for (const [id, list] of Object.entries(pr.statuses)) if (has(id)) { B.write(W.DATA, id, { statuses: list, board: boardOf(id).board }); done.push('statuses for ' + id); }
        if (want.notes) {
          let made = 0;
          for (const n of pr.project_notes) {
            const w = config.workspaces.find(x => x.id === n.workspace) || config.workspaces[0];
            const cat = n.category.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || 'Other', title = slug(n.title), rel = `Projects/${cat}/${title}.md`;
            if (fs.existsSync(V.safePath(w.vault, rel))) continue;
            const bd = boardOf(w.id), props = { title, status: bd.statuses.some(x => x.id === n.status) ? n.status : bd.board.newStatus, category: cat, last_worked: today(), tags: ['project'] };
            if (n.folder) props.folder = n.folder;
            const full = V.safePath(w.vault, rel); fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, V.serializeFrontmatter(props) + `\n# ${title}\n\n> ${n.summary || 'One line on what it is.'}\n\n## What it is\n\n## What's done\n\n## What's pending\n- \n\n## Log\n`);
            W.logActivity(w.id, { who: pr.from, action: 'create', path: rel, before: null, summary: 'From the setup proposal' }); made++;
          }
          if (made) done.push(made + ' project note(s)');
        }
      } catch (e) { return send(res, 400, { error: e.message }); }
      Setup.dropProposal(); cache.clear(); refreshConnections(); emit('workspaces', {});
      return send(res, 200, { done });
    }
    const ws = W.getWs(config, wsId || '');
    if (p === '/api/graph') {
      // Nodes carry health (last activity, stale, deadline) and the day they first appeared (for time-travel).
      const g = load(ws.id).graph, hl = activityFor(ws.id).health;
      return send(res, 200, { edges: g.edges, nodes: g.nodes.map(n => {
        const x = Object.assign({}, n);
        if (n.host && Fav.has(n.host)) x.icon = 1;
        const h = hl[n.id];
        if (h) { Object.assign(x, { last: h.last, idle: h.idle, stale: h.stale, daysLeft: h.daysLeft }); if (h.first && (!x.born || h.first < x.born)) x.born = h.first; }
        return x;
      }) });
    }
    if (p === '/api/bubbles') {
      // Token bubbles for a scope and period: projects for the whole workspace, files inside one project.
      const scope = url.searchParams.get('scope') || '_all', days = Math.max(1, Math.min(400, Number(url.searchParams.get('days')) || 90));
      const from = V.dayOf(Date.now() - (days - 1) * 864e5);
      const a = activityFor(ws.id);
      if (scope === '_all') {
        const items = a.projects.map(pr => ({ key: pr.path, title: pr.title, host: pr.host, category: pr.category, kind: 'project',
          value: Object.entries(a.series[pr.path] || {}).reduce((s, [d, v]) => s + (d >= from ? v[0] : 0), 0) }));
        const other = Object.entries(a.series._other || {}).reduce((s, [d, v]) => s + (d >= from ? v[0] : 0), 0);
        if (other) items.push({ key: '_other', title: 'No project', kind: 'project', value: other });
        return send(res, 200, items.filter(i => i.value > 0).sort((x, y) => y.value - x.value));
      }
      const dm = Act.projectDirs(load(ws.id).notes, raviDirs());
      const files = Act.fileBubbles((runsMemo || []).filter(s => s.ws === ws.id), dm, scope, from);
      const top = files.slice(0, 160), rest = files.slice(160).reduce((s, f) => s + f.value, 0);
      const items = top.map(f => ({ key: f.key, title: f.key.startsWith('(') ? f.key.slice(1, -1) : f.key.split('/').pop(), path: f.key.startsWith('(') ? '' : f.key, kind: 'file', value: f.value }));
      if (rest) items.push({ key: '_rest', title: `${files.length - 160} more files`, kind: 'file', value: rest });
      return send(res, 200, items);
    }
    if (p === '/api/picknext') return send(res, 200, Ins.pickNext(load(ws.id).notes, activityFor(ws.id).series, today(), 6, boardOf(ws.id).statuses));
    if (p === '/api/digest' && req.method === 'POST') {
      const d = Ins.digest(load(ws.id).notes, activityFor(ws.id).series, today(), boardOf(ws.id).statuses);
      const full = V.safePath(ws.vault, d.rel);
      let before = null; try { before = fs.readFileSync(full, 'utf8'); } catch {}
      fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, d.text);
      W.logActivity(ws.id, { who: 'aiodize', action: before == null ? 'create' : 'edit', path: d.rel, before, summary: 'Weekly digest' });
      return send(res, 200, { path: d.rel });
    }
    if (p === '/api/create' && req.method === 'POST') {
      // New note or project from the New menu. Projects follow the vault's shape: Projects/<Category>/<Title>.md.
      const b = await readBody(req);
      const title = slug(b.title || ''), kind = b.kind === 'project' ? 'project' : 'note';
      if (!String(b.title || '').trim()) return send(res, 400, { error: 'Give it a title' });
      const cat = String(b.category || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
      const dir = kind === 'project' ? `Projects/${cat || 'Other'}` : cat;
      const rel = (dir ? dir + '/' : '') + title + '.md';
      if (fs.existsSync(V.safePath(ws.vault, rel))) return send(res, 400, { error: `There is already a note at ${rel}` });
      const props = { title };
      if (kind === 'project') {
        const bd = boardOf(ws.id);
        Object.assign(props, { status: bd.statuses.some(s => s.id === b.status) ? b.status : bd.board.newStatus, category: cat || 'Other' });
        if (/^https?:\/\/\S+$/.test(String(b.url || '').trim())) props.url = String(b.url).trim();
        if (String(b.folder || '').trim()) props.folder = String(b.folder).trim().slice(0, 300);
        props.last_worked = today(); props.tags = ['project'];
      }
      const body = kind === 'project'
        ? `\n# ${title}\n\n> ${String(b.summary || 'One line on what it is.').trim()}\n\n## What it is\n\n## Why it exists\n\n## What's done\n\n## What's pending\n- \n`
        : `\n# ${title}\n\n${String(b.summary || '').trim()}\n`;
      const full = V.safePath(ws.vault, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, V.serializeFrontmatter(props) + body);
      W.logActivity(ws.id, { who: 'you', action: 'create', path: rel, before: null, summary: kind === 'project' ? 'New project' : 'New note' });
      return send(res, 200, { path: rel });
    }
    if (p === '/api/contextpack') return send(res, 200, Setup.contextPack(config, ws, W.readActivity(ws.id, 60)), 'text/markdown; charset=utf-8');
    if (p === '/api/board' && req.method === 'GET') return send(res, 200, boardOf(ws.id));
    if (p === '/api/board' && req.method === 'PUT') {
      try { const v = B.write(W.DATA, ws.id, await readBody(req)); W.logActivity(ws.id, { who: 'you', action: 'rules', path: '', summary: 'Changed project statuses / board' }); return send(res, 200, v); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p === '/api/setstatus' && req.method === 'POST') {
      // Kanban move: change only the status line of the note's frontmatter (logged, revertible).
      const b = await readBody(req), rel = String(b.path || ''), st = String(b.status || '');
      if (!boardOf(ws.id).statuses.some(s => s.id === st)) return send(res, 400, { error: 'Unknown status ' + st });
      const full = V.safePath(ws.vault, rel), before = fs.readFileSync(full, 'utf8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(before);
      let text;
      if (!fm) text = `---\nstatus: ${st}\n---\n` + before;
      else if (/^status:.*$/m.test(fm[1])) text = before.slice(0, fm.index) + fm[0].replace(/^status:.*$/m, 'status: ' + st) + before.slice(fm.index + fm[0].length);
      else text = before.replace(/^---\r?\n/, m => m + 'status: ' + st + '\n');
      if (text !== before) { fs.writeFileSync(full, text); W.logActivity(ws.id, { who: 'you', action: 'edit', path: rel, before, summary: 'Status → ' + st }); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/capture' && req.method === 'POST') {
      // Quick capture: a new idea note in Ideas/, optionally linked to a project.
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) return send(res, 400, { error: 'Write or say something first' });
      const title = slug(text.split(/\s+/).slice(0, 8).join(' '));
      let rel = `Ideas/${title}.md`, i = 2;
      while (fs.existsSync(V.safePath(ws.vault, rel))) rel = `Ideas/${title} ${i++}.md`;
      const proj = b.project ? load(ws.id).notes.find(n => n.rel === b.project) : null;
      const md = V.serializeFrontmatter({ title, type: 'idea', status: 'seed', captured: today(), source: b.source === 'voice' ? 'voice' : 'typed', tags: ['idea'] }) +
        `\n${text}\n` + (proj ? `\nFor [[${proj.title}]]\n` : '');
      fs.mkdirSync(path.join(ws.vault, 'Ideas'), { recursive: true });
      fs.writeFileSync(V.safePath(ws.vault, rel), md);
      W.logActivity(ws.id, { who: 'you', action: 'create', path: rel, before: null, summary: 'Captured an idea' });
      return send(res, 200, { path: rel });
    }
    if (p === '/api/notes') return send(res, 200, load(ws.id).notes.map(n => {
      const site = V.siteOf(n.props), host = site ? new URL(site).hostname : '';
      return { path: n.rel, title: n.title, type: n.type, status: n.props.status || '', category: n.category, updated: n.props.last_worked || '', deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(n.props.deadline || '')) ? n.props.deadline : '', host: host && Fav.has(host) ? host : '' };
    }));
    if (p === '/api/note' && req.method === 'GET') {
      const full = V.safePath(ws.vault, url.searchParams.get('path'));
      const text = fs.readFileSync(full, 'utf8'); const { props, body } = V.parseFrontmatter(text);
      const rel = url.searchParams.get('path');
      return send(res, 200, { path: rel, text, props, body, history: W.readActivity(ws.id, 400).filter(e => e.path === rel).slice(0, 20).map(({ before, ...e }) => e) });
    }
    if (p === '/api/note' && req.method === 'PUT') {
      const b = await readBody(req); const rel = url.searchParams.get('path');
      const full = V.safePath(ws.vault, rel);
      let before = null; try { before = fs.readFileSync(full, 'utf8'); } catch {}
      if (before === b.text) return send(res, 200, { ok: true });
      fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, String(b.text));
      W.logActivity(ws.id, { who: 'you', action: before == null ? 'create' : 'edit', path: rel, before });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/search') return send(res, 200, V.search(load(ws.id).notes, url.searchParams.get('q'), 12));
    if (p === '/api/activity') return send(res, 200, W.readActivity(ws.id, 100).map(({ before, ...e }) => e));
    if (p === '/api/revert' && req.method === 'POST') {
      const b = await readBody(req);
      const e = W.readActivity(ws.id, 5000).find(x => x.id === b.id);
      if (!e || !e.path) return send(res, 404, { error: 'Change not found' });
      const full = V.safePath(ws.vault, e.path);
      const cur = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
      if (e.before == null) fs.unlinkSync(full); else fs.writeFileSync(full, e.before);
      W.logActivity(ws.id, { who: 'you', action: 'revert', path: e.path, before: cur, summary: `Reverted ${e.who}'s ${e.action}` });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/runs') return send(res, 200, runsFor(ws.id));
    if (p === '/api/activitymap') return send(res, 200, Object.assign(activityFor(ws.id), { indexing: runs.state }));
    if (p === '/api/day') {
      // Sessions active on one day, with that day's tokens and the projects they touched.
      const day = String(url.searchParams.get('day') || ''), proj = url.searchParams.get('project') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(res, 400, { error: 'Bad day' });
      const dirMap = Act.projectDirs(load(ws.id).notes, raviDirs());
      const list = (runsMemo || []).filter(s => s.ws === ws.id && s.days[day]).map(s => {
        const sh = Act.shares(s, dirMap);
        return { title: s.title || 'Untitled session', model: s.model, tokens: s.days[day][0], cost: s.days[day][1], last: s.last,
          projects: Object.keys(sh).filter(Boolean).map(k => ({ path: k, title: (load(ws.id).notes.find(n => n.rel === k) || {}).title || k })), share: proj ? (sh[proj] || 0) : 1 };
      }).filter(s => s.share > 0).sort((a, b) => b.tokens - a.tokens);
      return send(res, 200, list);
    }
    if (p === '/api/rules' && req.method === 'GET') { const r = W.readRules(ws.id); return send(res, 200, { text: r.text, apply_to: ws.apply_to || [], ...W.compileRules(config, ws.id, false) }); }
    if (p === '/api/rules' && req.method === 'PUT') { const b = await readBody(req); W.writeRules(ws.id, String(b.text || '')); return send(res, 200, W.compileRules(config, ws.id, false)); }
    if (p === '/api/rules/apply' && req.method === 'POST') { const r = W.compileRules(config, ws.id, true); W.logActivity(ws.id, { who: 'you', action: 'rules', path: '', summary: `Applied rules to ${r.plan.filter(x => !x.error).length} folders` }); return send(res, 200, r); }
    if (p === '/api/open' && req.method === 'POST') {
      // Opens a project folder that a note points at in Explorer. (VS Code opens via a vscode:// link in the page, no shell needed.)
      const b = await readBody(req);
      const dir = path.resolve(String(b.folder || ''));
      if (!dir.startsWith(path.resolve(config.ravi) + path.sep) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: 'That folder is not inside your projects folder or does not exist' });
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Unknown route' });
  } catch (e) { send(res, 400, { error: e.message }); }
});

setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);
// Daily backup: checked at start and every hour; one snapshot a day when backups are on.
function dailyBackup() {
  const s = Setup.state(); if (!s.backup.on) return;
  try { if (!Bk.hasToday(s.backup.dir)) { Bk.snapshot(config, s.backup.dir, { version: VERSION }); Bk.prune(s.backup.dir, s.backup.keep); } } catch (e) { console.error('Backup failed:', e.message); }
}
setTimeout(dailyBackup, 20000); setInterval(dailyBackup, 3600e3).unref();
server.listen(PORT, '127.0.0.1', () => console.log(`Aiodize running at http://127.0.0.1:${PORT}`));
