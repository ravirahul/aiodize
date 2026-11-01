// Onboarding pieces, tested in a throwaway folder: AI app connect/disconnect, context + log_work, backups, the setup
// proposal, the context pack and the session-start hook. test.js runs this with AIODIZE_HOME/DATA/CONFIG set.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const T = process.env.AIODIZE_TMP;
if (!T || !process.env.AIODIZE_HOME) throw new Error('Run through test.js (it sets a sandbox)');
const home = process.env.AIODIZE_HOME, put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const rd = f => fs.readFileSync(f, 'utf8');

// a small world: one workspace, one project folder with a note, another folder without one
const vault = path.join(T, 'vault'), projects = path.join(T, 'projects');
put(path.join(projects, 'alpha', 'index.js'), '//'); put(path.join(projects, 'beta', 'x.txt'), '');
put(path.join(vault, 'Projects', 'Work', 'Alpha.md'), `---\ntitle: Alpha\nstatus: in-progress\ncategory: Work\nfolder: ${path.join(projects, 'alpha')}\n---\n\n# Alpha\n\n> A tiny test app.\n\n## What's pending\n- ship it\n`);
put(process.env.AIODIZE_CONFIG, JSON.stringify({ ravi: projects, workspaces: [{ id: 'work', name: 'Work', vault, folders: ['*'], fallback: true }] }));
// apps on this "computer": Claude Code (with other servers, a hook and a CLAUDE.md of its own), Cursor, Codex, VS Code (JSON with comments)
put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } }, numStartups: 3 }));
put(path.join(home, '.claude', 'CLAUDE.md'), '# My rules\nBe brief.\n');
put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'x' }));
fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
put(path.join(home, '.codex', 'config.toml'), 'model = "gpt"\n');
put(path.join(home, 'AppSupport', 'Code', 'User', 'mcp.json'), '{ // my servers\n "servers": {} }');
put(path.join(home, 'AppSupport', 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: { a: { path: vault } } }));

const W = require('./lib/workspace'), Apps = require('./lib/apps'), C = require('./lib/context'), Bk = require('./lib/backup'), Setup = require('./lib/setup'), V = require('./lib/vault');
const config = W.loadConfig(), ws = config.workspaces[0];

// --- apps: found, connect (twice: no duplicates), errors stay per app, disconnect removes only ours ---
const found = Object.fromEntries(Apps.list().map(a => [a.id, a.found]));
assert.deepEqual([found['claude-code'], found.cursor, found.codex, found.vscode, found['claude-desktop']], [true, true, true, true, false]);
Apps.run('connect', ['claude-code', 'cursor', 'codex', 'vscode'], config.workspaces);
const r = Apps.run('connect', ['claude-code', 'cursor', 'codex', 'vscode'], config.workspaces);
assert.equal(r.results.find(x => x.id === 'vscode').ok, false, 'JSON with comments is left alone');
assert.ok(rd(path.join(home, 'AppSupport', 'Code', 'User', 'mcp.json')).includes('// my servers'));
const cj = JSON.parse(rd(path.join(home, '.claude.json')));
assert.ok(cj.mcpServers.other && cj.mcpServers['aiodize-work'] && cj.numStartups === 3);
assert.ok(cj.mcpServers['aiodize-work'].args.includes('--workspace'));
const md = rd(path.join(home, '.claude', 'CLAUDE.md'));
assert.ok(md.startsWith('# My rules') && md.split(Apps.START).length === 2 && md.includes('get_context'));
const st = JSON.parse(rd(path.join(home, '.claude', 'settings.json')));
assert.equal(st.hooks.SessionStart.length, 2); assert.equal(st.model, 'x');
assert.ok(JSON.parse(rd(path.join(home, '.cursor', 'mcp.json'))).mcpServers['aiodize-work']);
const toml = rd(path.join(home, '.codex', 'config.toml'));
assert.ok(toml.startsWith('model = "gpt"') && toml.split('[mcp_servers.aiodize-work]').length === 2);
assert.ok(fs.existsSync(r.backup) && fs.readdirSync(r.backup).includes('claude-code'), 'originals backed up');
assert.ok(Apps.list().find(a => a.id === 'claude-code').connected);
Apps.run('connect', ['cursor', 'codex'], [...config.workspaces, { id: 'clients', name: 'Clients' }]); // a workspace added later
assert.deepEqual(Object.keys(JSON.parse(rd(path.join(home, '.cursor', 'mcp.json'))).mcpServers).sort(), ['aiodize-clients', 'aiodize-work']);
assert.ok(rd(path.join(home, '.codex', 'config.toml')).includes('[mcp_servers.aiodize-clients]') && rd(path.join(home, '.codex', 'config.toml')).split('# aiodize:start').length === 2);
Apps.run('disconnect', ['claude-code', 'cursor', 'codex'], config.workspaces);
assert.deepEqual(Object.keys(JSON.parse(rd(path.join(home, '.claude.json'))).mcpServers), ['other']);
assert.equal(rd(path.join(home, '.claude', 'CLAUDE.md')).trim(), '# My rules\nBe brief.');
assert.deepEqual(JSON.parse(rd(path.join(home, '.claude', 'settings.json'))).hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
assert.equal(rd(path.join(home, '.codex', 'config.toml')).trim(), 'model = "gpt"');
assert.ok(!Apps.list().find(a => a.id === 'cursor').connected);

// --- context and log_work ---
assert.equal(C.wsForFolder(config, path.join(projects, 'alpha', 'src')).id, 'work');
const ctx = C.contextFor(config, ws, path.join(projects, 'alpha', 'src'));
assert.equal(ctx.project.title, 'Alpha'); assert.deepEqual(ctx.project.pending, ['- ship it']); assert.equal(ctx.project.summary, 'A tiny test app.');
assert.ok(C.contextFor(config, ws, path.join(projects, 'beta')).note.includes('No project note'));
const notes = V.readNotes(vault), alpha = notes.find(n => n.title === 'Alpha');
assert.throws(() => C.logWork(ws, notes, alpha, { summary: 'x', status: 'nope' }), /Unknown status/);
C.logWork(ws, notes, alpha, { summary: 'Added login.', next: 'Deploy.', status: 'live', who: 'Claude Code' });
C.logWork(ws, V.readNotes(vault), alpha, { summary: 'Fixed a bug.', who: 'Cursor' });
const after = rd(path.join(vault, alpha.rel));
assert.ok(/status: live/.test(after) && after.split('## Log').length === 2);
assert.ok(after.indexOf('Fixed a bug.') < after.indexOf('Added login.'), 'newest log line first');
assert.ok(W.readActivity('work', 5).some(e => e.action === 'log_work' && e.before));
const hook = spawnSync(process.execPath, [path.join(__dirname, 'aiodize-hook.js')], { input: JSON.stringify({ cwd: path.join(projects, 'alpha') }), env: process.env, encoding: 'utf8' });
assert.ok(hook.stdout.includes('Project: Alpha') && hook.stdout.includes('log_work'), 'hook prints the context');
assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'aiodize-hook.js')], { input: 'not json', env: process.env, encoding: 'utf8' }).status, 0);

// --- backups: snapshot, change, restore (safety copy first), prune ---
const bdir = path.join(T, 'backups');
const snap = Bk.snapshot(config, bdir, { version: 't' });
assert.ok(fs.existsSync(path.join(bdir, snap, 'vaults', 'work', 'Projects', 'Work', 'Alpha.md')));
fs.writeFileSync(path.join(vault, alpha.rel), 'broken');
const res = Bk.restore(config, bdir, snap, 'work', 't');
assert.ok(rd(path.join(vault, alpha.rel)).includes('Fixed a bug.'));
assert.equal(rd(path.join(bdir, res.safety, 'vaults', 'work', alpha.rel)), 'broken');
assert.throws(() => Bk.restore(config, bdir, '../evil', 'work'), /Not an Aiodize backup/);
Bk.prune(bdir, 1); assert.equal(Bk.list(bdir).filter(s => !s.beforeRestore).length, 1);

// --- setup status, proposal, context pack, Obsidian vaults ---
const ss = Setup.setupStatus(config);
assert.deepEqual(ss.project_folders_without_a_note, ['beta']);
assert.throws(() => Setup.propose({ summary: 'nothing' }), /empty/);
Setup.propose({ summary: 'One more', project_notes: [{ workspace: 'work', title: 'Beta', category: 'Work', folder: path.join(projects, 'beta') }] }, 'Claude Code');
assert.equal(Setup.proposal().project_notes[0].title, 'Beta'); assert.equal(Setup.proposal().from, 'Claude Code');
const pack = Setup.contextPack(config, ws, W.readActivity('work', 20));
assert.ok(pack.includes('## Rules') && pack.includes('### Alpha') && pack.includes('Fixed a bug.'));
assert.deepEqual(Setup.obsidianVaults(), [vault]);
// --- LM Studio (Cursor-style mcp.json) and Zed (settings with comments: never rewritten, paste lines given) ---
fs.mkdirSync(path.join(home, '.lmstudio'), { recursive: true });
put(path.join(home, '.config', 'zed', 'settings.json'), '// Zed settings\n{ "theme": "One Dark" }');
const r2 = Apps.run('connect', ['lmstudio', 'zed'], config.workspaces);
assert.ok(JSON.parse(rd(path.join(home, '.lmstudio', 'mcp.json'))).mcpServers['aiodize-work']);
const z = r2.results.find(x => x.id === 'zed');
assert.ok(!z.ok && z.error.includes('"aiodize-work"') && z.error.includes('context_servers'));
assert.equal(rd(path.join(home, '.config', 'zed', 'settings.json')), '// Zed settings\n{ "theme": "One Dark" }');

// --- the + menu actions (MCP prompts) ---
const mcp = spawnSync(process.execPath, [path.join(__dirname, 'mcp.js'), '--workspace', 'work'], { env: process.env, encoding: 'utf8',
  input: [{ id: 1, method: 'initialize', params: { clientInfo: { name: 't' } } }, { id: 2, method: 'prompts/list' },
    { id: 3, method: 'prompts/get', params: { name: 'load_context', arguments: { folder: path.join(projects, 'alpha') } } }, { id: 4, method: 'prompts/get', params: { name: 'nope' } }]
    .map(m => JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m))).join('\n') + '\n' });
const out = Object.fromEntries(mcp.stdout.trim().split('\n').map(l => JSON.parse(l)).map(m => [m.id, m]));
assert.ok(out[1].result.capabilities.prompts);
assert.deepEqual(out[2].result.prompts.map(p => p.name), ['load_context', 'log_this_work', 'set_up_aiodize']);
assert.ok(out[3].result.messages[0].content.text.includes('Project: Alpha'));
assert.ok(out[4].error);
console.log('setup checks passed');
