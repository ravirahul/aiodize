// Connect Aiodize to the AI apps on this computer: MCP servers, a short standing-instructions block, and
// (Claude Code) a session-start hook. Every file is backed up before its first change; disconnect removes
// only what Aiodize added. AIODIZE_HOME points everything at a test folder.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const W = require('./workspace');

const HOME = () => process.env.AIODIZE_HOME || os.homedir();
const SUPPORT = () => process.env.AIODIZE_HOME ? path.join(HOME(), 'AppSupport')
  : process.platform === 'win32' ? (process.env.APPDATA || path.join(HOME(), 'AppData', 'Roaming'))
  : process.platform === 'darwin' ? path.join(HOME(), 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME || path.join(HOME(), '.config'));
const MCP_JS = path.join(W.ROOT, 'mcp.js');
const HOOK_JS = path.join(W.ROOT, 'aiodize-hook.js');
const BACKUPS = path.join(W.DATA, 'config-backups');
const START = '<!-- aiodize:start (added by Aiodize; Settings > Agents > Disconnect removes it) -->', END = '<!-- aiodize:end -->';
const TSTART = '# aiodize:start (added by Aiodize)', TEND = '# aiodize:end';
const ours = name => /^(aiodize|chitta)-/.test(name);

// What every connected AI is told, wherever its global instructions live.
function standingInstructions(workspaces) {
  return ['## Aiodize: this person\'s brain for AI, on this device',
    `Aiodize keeps their notes, projects, rules and work history on this computer. You reach it through MCP servers named ${workspaces.map(w => 'aiodize-' + w.id).join(', ')} (one per workspace).`,
    '- Before starting work in a folder, call get_context with that folder and follow the rules it returns.',
    '- When you finish meaningful work, call log_work with what changed, the project status and next steps (one or two sentences).',
    '- Save new ideas they mention with create_note in Ideas/. Never edit a workspace whose rules say read-only.',
    '- Every change you make in Aiodize is logged and they can undo it.'].join('\n');
}
// How an AI app starts Aiodize's MCP server. In the desktop app, process.execPath is Aiodize.exe, which runs as plain
// Node with ELECTRON_RUN_AS_NODE; data and config live in the app's own folder, so their paths travel along too.
function runEnv() {
  const env = {};
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (process.env.AIODIZE_DATA) env.AIODIZE_DATA = W.DATA;
  if (process.env.AIODIZE_CONFIG) env.AIODIZE_CONFIG = W.CONFIG;
  return env;
}
const serverEntry = id => { const env = runEnv(), e = { command: process.execPath, args: [MCP_JS, '--workspace', id] }; if (Object.keys(env).length) e.env = env; return e; };
// The session-start hook is a shell command with no env field, so when env is needed it goes through a small launcher script.
function hookCommand() {
  const env = runEnv();
  if (!Object.keys(env).length) return `"${process.execPath}" "${HOOK_JS}"`;
  const win = process.platform === 'win32', f = path.join(W.DATA, win ? 'aiodize-hook.cmd' : 'aiodize-hook.sh');
  const body = win ? ['@echo off', ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`), `"${process.execPath}" "${HOOK_JS}"`].join('\r\n') + '\r\n'
    : ['#!/bin/sh', ...Object.entries(env).map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`), `exec "${process.execPath}" "${HOOK_JS}"`].join('\n') + '\n';
  fs.mkdirSync(W.DATA, { recursive: true }); fs.writeFileSync(f, body); if (!win) fs.chmodSync(f, 0o755);
  return `"${f}"`;
}

// ---------- small file helpers ----------
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function readJson(f) { const t = read(f); if (t == null || !t.trim()) return {}; try { return JSON.parse(t); } catch { throw new Error(`${f} isn't plain JSON (it may have comments), so Aiodize left it alone. Add the server by hand.`); } }
function backup(file, stamp, app, done) {
  if (done.has(file) || !fs.existsSync(file)) return; done.add(file);
  const dest = path.join(BACKUPS, stamp, app, path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(file, dest);
}
function write(file, text, ctx) { backup(file, ctx.stamp, ctx.app, ctx.done); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); ctx.changed.push(file); }
function withBlock(text, block, s = START, e = END) {
  const managed = `${s}\n${block}\n${e}`;
  if (text == null || !text.trim()) return managed + '\n';
  const a = text.indexOf(s), b = text.indexOf(e);
  if (a >= 0 && b > a) return text.slice(0, a) + managed + text.slice(b + e.length);
  return text.replace(/\s*$/, '\n\n') + managed + '\n';
}
function withoutBlock(text, s = START, e = END) {
  if (text == null) return null;
  const a = text.indexOf(s), b = text.indexOf(e);
  return a >= 0 && b > a ? (text.slice(0, a).replace(/\s*$/, '') + '\n' + text.slice(b + e.length).replace(/^\s*/, '\n')).replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n') : text;
}

// ---------- the apps ----------
// json: file holding the servers, the key they live under and how one entry looks. md: the global instructions file, if the app has one.
const APPS = [
  { id: 'claude-code', name: 'Claude Code', dir: () => path.join(HOME(), '.claude'), json: () => path.join(HOME(), '.claude.json'), key: 'mcpServers', md: () => path.join(HOME(), '.claude', 'CLAUDE.md'), hook: () => path.join(HOME(), '.claude', 'settings.json') },
  { id: 'claude-desktop', name: 'Claude Desktop', dir: () => path.join(SUPPORT(), 'Claude'), json: () => path.join(SUPPORT(), 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' },
  { id: 'cursor', name: 'Cursor', dir: () => path.join(HOME(), '.cursor'), json: () => path.join(HOME(), '.cursor', 'mcp.json'), key: 'mcpServers' },
  { id: 'vscode', name: 'VS Code', dir: () => path.join(SUPPORT(), 'Code', 'User'), json: () => path.join(SUPPORT(), 'Code', 'User', 'mcp.json'), key: 'servers', entry: e => Object.assign({ type: 'stdio' }, e) },
  { id: 'windsurf', name: 'Windsurf', dir: () => path.join(HOME(), '.codeium', 'windsurf'), json: () => path.join(HOME(), '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
  { id: 'codex', name: 'Codex CLI', dir: () => path.join(HOME(), '.codex'), toml: () => path.join(HOME(), '.codex', 'config.toml'), md: () => path.join(HOME(), '.codex', 'AGENTS.md') },
  { id: 'lmstudio', name: 'LM Studio', dir: () => path.join(HOME(), '.lmstudio'), json: () => path.join(HOME(), '.lmstudio', 'mcp.json'), key: 'mcpServers' },
  { id: 'cline', name: 'Cline (VS Code)', dir: () => path.join(SUPPORT(), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'), json: () => path.join(SUPPORT(), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), key: 'mcpServers' },
  { id: 'zed', name: 'Zed', dir: () => process.platform === 'win32' && !process.env.AIODIZE_HOME ? path.join(SUPPORT(), 'Zed') : path.join(HOME(), '.config', 'zed'), json: () => path.join(process.platform === 'win32' && !process.env.AIODIZE_HOME ? path.join(SUPPORT(), 'Zed') : path.join(HOME(), '.config', 'zed'), 'settings.json'), key: 'context_servers', entry: e => Object.assign({ env: {} }, e) },
  { id: 'gemini', name: 'Gemini CLI', dir: () => path.join(HOME(), '.gemini'), json: () => path.join(HOME(), '.gemini', 'settings.json'), key: 'mcpServers', md: () => path.join(HOME(), '.gemini', 'GEMINI.md') },
];

function serverNames(app) {
  if (app.toml) { const t = read(app.toml()) || ''; return [...t.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map(m => m[1].replace(/"/g, '')); }
  try { return Object.keys(readJson(app.json())[app.key] || {}); } catch { return []; }
}
function list() {
  return APPS.map(a => {
    const found = fs.existsSync(a.dir()), names = found ? serverNames(a) : [];
    return { id: a.id, name: a.name, found, connected: names.some(ours), servers: names.filter(ours), instructions: !!a.md, hook: !!a.hook };
  });
}

// Claude Code's own CLI, when installed (never in tests, which use a throwaway home). No args = is it there?
// Runs the real executable with no shell, so paths and JSON arrive intact. A script-only install (claude.cmd) falls back to editing the file.
let cliPath;
function claudeCli(args) {
  if (process.env.AIODIZE_HOME) return null;
  const { spawnSync } = require('child_process');
  if (cliPath === undefined) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    cliPath = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).find(p => p && (process.platform !== 'win32' || /\.exe$/i.test(p))) || null;
  }
  if (!cliPath) return null;
  if (!args) return true;
  return spawnSync(cliPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function connect(id, workspaces, ctx) {
  const app = APPS.find(a => a.id === id); if (!app) throw new Error('Unknown app ' + id);
  ctx.app = id;
  if (id === 'claude-code' && claudeCli()) {
    // Claude Code rewrites ~/.claude.json while it runs, so its own `claude mcp` command makes the change.
    backup(app.json(), ctx.stamp, ctx.app, ctx.done);
    for (const w of workspaces) {
      for (const n of ['chitta-' + w.id, 'aiodize-' + w.id]) claudeCli(['mcp', 'remove', '-s', 'user', n]); // old name goes, new one is re-added fresh
      const r = claudeCli(['mcp', 'add-json', '-s', 'user', 'aiodize-' + w.id, JSON.stringify(serverEntry(w.id))]);
      if (!r || r.status !== 0) throw new Error('Claude Code refused the server: ' + String((r && (r.stderr || r.stdout)) || '').trim().slice(0, 300));
    }
    ctx.changed.push(app.json());
  } else if (app.toml) {
    const f = app.toml();
    const body = workspaces.map(w => { const e = serverEntry(w.id);
      return `[mcp_servers.aiodize-${w.id}]\ncommand = ${JSON.stringify(e.command)}\nargs = ${JSON.stringify(e.args)}` +
        (e.env ? `\nenv = { ${Object.entries(e.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }` : ''); }).join('\n\n');
    write(f, withBlock(read(f), body, TSTART, TEND), ctx);
  } else {
    const f = app.json();
    let cfg; try { cfg = readJson(f); } catch (e) {
      const snippet = Object.fromEntries(workspaces.map(w => ['aiodize-' + w.id, (app.entry || (x => x))(serverEntry(w.id))]));
      throw new Error(e.message + ` Paste this inside "${app.key}": ${JSON.stringify(snippet).slice(1, -1)}`);
    }
    const servers = cfg[app.key] = cfg[app.key] || {};
    for (const w of workspaces) {
      if (servers['chitta-' + w.id] && JSON.stringify(servers['chitta-' + w.id]).includes('mcp.js')) delete servers['chitta-' + w.id]; // upgrade the old name
      servers['aiodize-' + w.id] = (app.entry || (e => e))(serverEntry(w.id));
    }
    write(f, JSON.stringify(cfg, null, 2) + '\n', ctx);
  }
  if (app.md) write(app.md(), withBlock(read(app.md()), standingInstructions(workspaces)), ctx);
  if (app.hook) {
    const f = app.hook(), cfg = readJson(f), hooks = cfg.hooks = cfg.hooks || {};
    const cmd = hookCommand();
    hooks.SessionStart = (hooks.SessionStart || []).filter(h => !JSON.stringify(h).includes('aiodize-hook'));
    hooks.SessionStart.push({ hooks: [{ type: 'command', command: cmd, timeout: 10 }] });
    write(f, JSON.stringify(cfg, null, 2) + '\n', ctx);
  }
}

function disconnect(id, ctx) {
  const app = APPS.find(a => a.id === id); if (!app) throw new Error('Unknown app ' + id);
  ctx.app = id;
  if (id === 'claude-code' && claudeCli()) {
    const gone = serverNames(app).filter(n => n.startsWith('aiodize-'));
    if (gone.length) { backup(app.json(), ctx.stamp, ctx.app, ctx.done); for (const n of gone) claudeCli(['mcp', 'remove', '-s', 'user', n]); ctx.changed.push(app.json()); }
  } else if (app.toml) { const f = app.toml(), t = read(f); if (t != null && t.includes(TSTART)) write(f, withoutBlock(t, TSTART, TEND), ctx); }
  else if (fs.existsSync(app.json())) {
    const f = app.json(), cfg = readJson(f), servers = cfg[app.key] || {};
    const gone = Object.keys(servers).filter(n => n.startsWith('aiodize-'));
    if (gone.length) { for (const n of gone) delete servers[n]; write(f, JSON.stringify(cfg, null, 2) + '\n', ctx); }
  }
  if (app.md) { const t = read(app.md()); if (t != null && t.includes(START)) write(app.md(), withoutBlock(t), ctx); }
  if (app.hook && fs.existsSync(app.hook())) {
    const f = app.hook(), cfg = readJson(f), ss = (cfg.hooks || {}).SessionStart;
    if (ss && ss.some(h => JSON.stringify(h).includes('aiodize-hook'))) {
      cfg.hooks.SessionStart = ss.filter(h => !JSON.stringify(h).includes('aiodize-hook'));
      if (!cfg.hooks.SessionStart.length) delete cfg.hooks.SessionStart;
      write(f, JSON.stringify(cfg, null, 2) + '\n', ctx);
    }
  }
}

// Run connect/disconnect for several apps; one backup folder per run; errors per app, never half the batch.
function run(op, ids, workspaces) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), done = new Set(), results = [];
  for (const id of ids) {
    const ctx = { stamp, done, changed: [], app: id };
    try { op === 'connect' ? connect(id, workspaces, ctx) : disconnect(id, ctx); results.push({ id, ok: true, changed: ctx.changed }); }
    catch (e) { results.push({ id, ok: false, error: e.message, changed: ctx.changed }); }
  }
  return { backup: done.size ? path.join(BACKUPS, stamp) : '', results };
}

module.exports = { APPS, list, run, standingInstructions, HOME, SUPPORT, withBlock, withoutBlock, START, END };
