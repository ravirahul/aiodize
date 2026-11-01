// One self-check for the logic that matters: parsing, path safety, rules, attribution, MCP.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const V = require('./lib/vault');
const W = require('./lib/workspace');
const { attribute } = require('./lib/runs');

// frontmatter + links + tags
const fm = V.parseFrontmatter('---\ntitle: Acme App\naliases: [Old Name, acme]\nstatus: live\ntags:\n  - project\n  - apps\n---\n# Body\nSee [[Main Server|the server]] and [[Keel#Plan]]. #growth `#notatag`\n');
assert.equal(fm.props.title, 'Acme App');
assert.deepEqual(fm.props.aliases, ['Old Name', 'acme']);
assert.deepEqual(fm.props.tags, ['project', 'apps']);
assert.deepEqual(V.extractLinks(fm.body), ['Main Server', 'Keel']);
assert.deepEqual(V.extractTags(fm.body), ['growth']);
assert.equal(V.parseFrontmatter(V.serializeFrontmatter({ a: '1', b: ['x', 'y'] }) + 'body').props.b[1], 'y');

// path safety
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiodize-'));
assert.throws(() => V.safePath(root, '../outside.md'));
assert.throws(() => V.safePath(root, 'notes/x.exe'));
assert.ok(V.safePath(root, 'Projects/A.md').startsWith(root));

// graph: aliases resolve, inspiration lines become nodes
fs.mkdirSync(path.join(root, 'Projects'));
fs.writeFileSync(path.join(root, 'Projects', 'Bookshelf.md'), '---\naliases: [shelf]\nstatus: live\n---\nlinks to [[Camera]]');
fs.writeFileSync(path.join(root, 'Projects', 'Camera.md'), 'x');
fs.writeFileSync(path.join(root, 'Inspiration.md'), '---\ntags: [inspiration]\n---\n- https://recent.design/i/abc-page-turn - for [[shelf]]\n');
const g = V.buildGraph(V.readNotes(root));
assert.ok(g.edges.some(e => e.s === 'Projects/Bookshelf.md' && e.t === 'Projects/Camera.md'));
assert.ok(g.edges.some(e => e.s.startsWith('insp:') && e.t === 'Projects/Bookshelf.md'));

// rules: CLAUDE.md merge keeps the user's text, deny entries
assert.equal(W.mergeClaudeMd(null, 'X').action, 'create');
const m1 = W.mergeClaudeMd('# Mine\n', 'A'); assert.equal(m1.action, 'append'); assert.ok(m1.text.startsWith('# Mine'));
const m2 = W.mergeClaudeMd(m1.text, 'B'); assert.equal(m2.action, 'update'); assert.ok(m2.text.includes('B') && !m2.text.includes('\nA\n'));
const deny = W.denyEntries({ denyConnectors: ['claude_ai_Gmail'], denyBrowser: true, denyDomains: ['client.example.com'], denyFolders: ['client-*'] }, 'C:\\Users\\me\\Projects');
assert.ok(deny.includes('mcp__claude_ai_Gmail') && deny.includes('mcp__playwright') && deny.includes('WebFetch(domain:client.example.com)'));
assert.ok(deny.includes('Read(//c/Users/me/Projects/client-*/**)'), deny.join(' '));

require('./lib/runs').setRoot('C:\\Users\\me\\Projects'); // attribution: sessions are matched under the projects folder
const wss = [{ id: 'studio', fallback: true, folders: ['*'], tools: ['hosting'] }, { id: 'clients', folders: ['client-*', 'invoices'], tools: ['Analytics_Tool'] }];
const run = (folders, mcp = {}, cwd = 'C:\\Users\\me\\Projects') => attribute({ folders, mcp, cwd }, wss);
assert.equal(run({ 'client-seo': 4, keel: 1 }), 'clients');
assert.equal(run({ keel: 3 }), 'studio');
assert.equal(run({}, { claude_ai_Analytics_Tool: 2 }), 'clients');
assert.equal(run({}), '');
assert.equal(run({}, {}, 'C:\\Users\\me\\Projects\\invoices'), 'clients');

// activity: project folders from notes, session shares
const Act = require('./lib/activity');
const pn = [{ type: 'project', rel: 'P/Acme.md', props: { folder: 'C:\\Users\\me\\Projects\\acme-source (source); C:\\Users\\me\\Projects\\acme' } },
  { type: 'project', rel: 'P/Blue.md', props: { folder: 'C:\\Users\\me\\Projects\\Blue Garden\\site' } }];
const dm = Act.projectDirs(pn, ['acme-source', 'acme-source-backup-v3.5', 'acme', 'acme-cloud', 'Blue Garden']);
assert.equal(dm.get('acme-source'), 'P/Acme.md');
assert.equal(dm.get('acme'), 'P/Acme.md');
assert.equal(dm.has('acme-cloud'), false);
assert.equal(dm.get('Blue Garden'), 'P/Blue.md');
const sh = Act.shares({ folders: { acme: 3, keel: 9 }, cwd: '' }, dm);
assert.deepEqual(sh, { 'P/Acme.md': 1 });
assert.deepEqual(Act.shares({ folders: { keel: 2 }, cwd: '' }, dm), { '': 1 });
const built = Act.build([{ folders: { acme: 1 }, cwd: '', days: { '2026-10-30': [100, 1] } }], pn, ['acme'], []);
const built2 = Act.build([{ folders: { acme: 1 }, cwd: '', days: { '2026-10-30': [100, 1] } }], pn, ['acme'], [], { 'P/Acme.md': { '2026-10-30': 3 } });
assert.deepEqual(built2.series['P/Acme.md']['2026-10-30'], [100, 1, 1, 0, 3]);
assert.deepEqual(built2.series._all['2026-10-30'], [100, 1, 1, 0, 3]);
// per-file bubbles: a session's project tokens split by file touches
const fb = Act.fileBubbles([{ folders: { acme: 4 }, cwd: '', days: { '2026-10-30': [100, 1] }, files: { 'acme/a.js': 3, 'acme/b.js': 1, 'keel/x.js': 5 } }], dm, 'P/Acme.md', '2026-10-01');
assert.deepEqual(fb.map(f => [f.key, Math.round(f.value)]), [['acme/a.js', 75], ['acme/b.js', 25]]);
assert.equal(Act.fileBubbles([{ folders: { acme: 4 }, cwd: '', days: { '2026-09-01': [100, 1] }, files: {} }], dm, 'P/Acme.md', '2026-10-01').length, 0);

// insights: pending items, ISO weeks, pick-next ranking
const Ins = require('./lib/insights');
assert.equal(Ins.pendingCount("## What is done\n- a\n## What's pending\n- x\n- y\n## Where\n- z"), 2);
assert.equal(Ins.pendingCount('no heading'), null);
assert.deepEqual(Ins.isoWeek('2026-11-01'), [2026, 44, '2026-10-26', '2026-11-01']);
assert.deepEqual(Ins.isoWeek('2027-01-01').slice(0, 2), [2026, 53]);
const pnotes = [
  { type: 'project', rel: 'A.md', title: 'A', aliases: [], body: '## Pending\n- one', props: { status: 'built-not-deployed', deadline: '2026-11-20' } },
  { type: 'project', rel: 'B.md', title: 'B', aliases: [], body: '', props: { status: 'parked' } },
  { type: 'project', rel: 'C.md', title: 'C', aliases: [], body: '', props: { status: 'live' } }];
const ranked = Ins.pickNext(pnotes, {}, '2026-11-01');
assert.equal(ranked[0].path, 'A.md'); assert.ok(ranked[0].why.includes('deadline in 19 days'));
assert.ok(!ranked.some(r => r.path === 'B.md'));
const hh = Ins.health(pnotes, { 'C.md': { '2026-09-01': [5, 0, 1, 0, 0] } }, '2026-11-01');
assert.equal(hh['C.md'].idle, 61); assert.equal(hh['C.md'].stale, true);
assert.ok(Ins.digest(pnotes, {}, '2026-11-01').text.includes('# Week 44'));

// custom statuses: validated, and insights follow their stage
const Bd = require('./lib/board');
const cust = Bd.validate({ statuses: [{ label: 'Idea' }, { label: 'Shipping now', stage: 'active', color: 'nope' }, { label: 'Retired', stage: 'parked' }], board: { hidden: ['idea', 'ghost'], newStatus: 'x' } });
assert.deepEqual(cust.statuses.map(s => s.id), ['idea', 'shipping-now', 'retired']);
assert.equal(cust.statuses[1].color, 'grey'); assert.deepEqual(cust.board.hidden, ['idea']); assert.equal(cust.board.newStatus, 'idea');
assert.throws(() => Bd.validate({ statuses: [{ label: 'A' }, { label: 'a' }] }), /Two statuses/);
assert.throws(() => Bd.validate({ statuses: [] }), /at least one/);
const cnotes = [{ type: 'project', rel: 'S.md', title: 'S', aliases: [], body: '', props: { status: 'shipping-now' } }, { type: 'project', rel: 'R.md', title: 'R', aliases: [], body: '', props: { status: 'retired' } }];
const cr = Ins.pickNext(cnotes, {}, '2026-11-01', 6, cust.statuses);
assert.deepEqual(cr.map(r => r.path), ['S.md']); assert.equal(cr[0].why[0], 'shipping now');
assert.equal(Ins.health(cnotes, { 'R.md': { '2026-08-01': [1, 0, 0, 0, 0] } }, '2026-11-01', cust.statuses)['R.md'].stale, false);

// favicon fetcher refuses private addresses
const { privateIp } = require('./lib/favicon');
for (const ip of ['127.0.0.1', '192.168.0.1', '10.1.2.3', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:192.168.1.1']) assert.ok(privateIp(ip), ip);
for (const ip of ['8.8.8.8', '84.32.84.32', '2606:4700::1111']) assert.ok(!privateIp(ip), ip);

// MCP server speaks JSON-RPC and is locked to its workspace
const input = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_note', arguments: { note: '../../private/Home.md' } } },
].map(x => JSON.stringify(x)).join('\n') + '\n';
const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiodize-mcp-'));
fs.writeFileSync(path.join(mcpDir, 'config.json'), JSON.stringify({ ravi: mcpDir, workspaces: [{ id: 'clients', name: 'Clients', vault: root, folders: ['*'], fallback: true }] }));
const r = spawnSync(process.execPath, [path.join(__dirname, 'mcp.js'), '--workspace', 'clients'], { input, encoding: 'utf8', env: Object.assign({}, process.env, { AIODIZE_TEST: '1', AIODIZE_CONFIG: path.join(mcpDir, 'config.json'), AIODIZE_DATA: path.join(mcpDir, 'data') }) });
fs.rmSync(mcpDir, { recursive: true, force: true });
const out = r.stdout.trim().split('\n').map(l => JSON.parse(l));
assert.equal(out.length, 3, r.stderr);
assert.ok(out[0].result.instructions.includes('Clients'));
assert.ok(out[1].result.tools.some(t => t.name === 'get_project_context'));
assert.ok(out[2].result.isError, 'reading outside the workspace vault must fail');

fs.rmSync(root, { recursive: true, force: true });

// bubble packing (browser module): 160 bubbles, no visible overlap
globalThis.matchMedia = () => ({ matches: true });
import('./web/charts.js').then(({ pack }) => {
  const B = pack(Array.from({ length: 160 }, (_, i) => ({ value: ((i * 7919) % 997 + 1) ** 3 })));
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    const a = B[i], b = B[j];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= (a.r + b.r) * 0.995, 'bubbles overlap');
  }
  // onboarding pieces run in their own sandbox (fake home, data, config), so nothing real is touched
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'aiodize-setup-'));
  const env = Object.assign({}, process.env, { AIODIZE_TMP: sb, AIODIZE_HOME: path.join(sb, 'home'), AIODIZE_DATA: path.join(sb, 'data'), AIODIZE_CONFIG: path.join(sb, 'config.json'), AIODIZE_TEST: '1' });
  const t = spawnSync(process.execPath, [path.join(__dirname, 'test-setup.js')], { env, encoding: 'utf8' });
  fs.rmSync(sb, { recursive: true, force: true });
  if (t.status !== 0) { console.error(t.stdout, t.stderr); process.exit(1); }
  console.log('All checks passed.');
});
