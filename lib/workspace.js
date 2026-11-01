// Workspaces: config, per-workspace rules (WORKSPACE.md), activity log, and the rules compiler
// that turns WORKSPACE.md into CLAUDE.md + Claude Code permission denies in linked folders.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseFrontmatter } = require('./vault');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.AIODIZE_DATA || path.join(ROOT, 'data');
const CONFIG = process.env.AIODIZE_CONFIG || path.join(ROOT, 'workspaces.json'); // tests point both at a temp folder

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    const home = process.env.AIODIZE_HOME || require('os').homedir(), vault = path.join(home, 'Documents', 'Aiodize Notes'); // a visible notes folder, like an Obsidian vault
    require('./starter').seed(vault);
    fs.writeFileSync(CONFIG, JSON.stringify({ ravi: path.join(home, 'Documents'), workspaces: [{ id: 'personal', name: 'Personal', color: 'violet', vault, folders: ['*'], tools: [], apply_to: [], fallback: true }] }, null, 2) + '\n');
  }
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  for (const w of c.workspaces) fs.mkdirSync(path.join(DATA, w.id), { recursive: true });
  return c;
}
function getWs(config, id) {
  const w = config.workspaces.find(x => x.id === id);
  if (!w) throw new Error('Unknown workspace: ' + id);
  return w;
}
const dataDir = id => path.join(DATA, id);

// Check workspaces sent from the Settings page before they replace workspaces.json.
const COLORS = ['marigold', 'rose', 'teal', 'blue', 'green', 'violet'];
const ICONS = ["dot","leaf","spark","bolt","book","bag","heart","home","code","flower","globe","star","cup","moon","camera","letter"];
function validateWorkspaces(list, ravi) {
  if (!Array.isArray(list) || !list.length) throw new Error('Keep at least one workspace');
  const ids = new Set(), strs = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean).slice(0, 200);
  const out = list.map(w => {
    const id = String(w.id || '').toLowerCase().trim();
    if (!/^[a-z0-9-]{2,20}$/.test(id)) throw new Error(`"${id}" isn't a valid id: use 2-20 lowercase letters, digits or dashes`);
    if (ids.has(id)) throw new Error(`Two workspaces are called "${id}"`); ids.add(id);
    const name = String(w.name || id).trim().slice(0, 40);
    let vault = String(w.vault || '').trim();
    if (!vault) { vault = path.join(ROOT, 'vaults', id); fs.mkdirSync(vault, { recursive: true }); }
    if (!path.isAbsolute(vault) || !fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) throw new Error(`Vault folder for ${name} doesn't exist: ${vault}`);
    for (const f of strs(w.apply_to)) if (f.includes('..') || path.isAbsolute(f)) throw new Error(`Linked folders must be names inside your projects folder: ${f}`);
    const o = { id, name, color: COLORS.includes(w.color) ? w.color : 'marigold', vault, folders: strs(w.folders), tools: strs(w.tools), apply_to: strs(w.apply_to) };
    if (ICONS.includes(w.icon) && w.icon !== 'dot') o.icon = w.icon;
    if (w.fallback) o.fallback = true;
    const rules = path.join(DATA, id, 'WORKSPACE.md');
    if (!fs.existsSync(rules)) { fs.mkdirSync(path.dirname(rules), { recursive: true }); fs.writeFileSync(rules, `---\nai_write: write\n---\n${name} workspace.\n`); }
    return o;
  });
  if (out.filter(w => w.fallback).length > 1) throw new Error('Only one workspace can collect unmatched folders');
  return out;
}

// ---------- rules ----------
function rulesPath(id) { return path.join(dataDir(id), 'WORKSPACE.md'); }
function readRules(id) {
  let text = ''; try { text = fs.readFileSync(rulesPath(id), 'utf8'); } catch {}
  const { props, body } = parseFrontmatter(text);
  const arr = v => Array.isArray(v) ? v : v ? [v] : [];
  return { text, body: body.trim(), aiWrite: props.ai_write === 'read' ? 'read' : 'write',
    denyConnectors: arr(props.deny_connectors), denyBrowser: String(props.deny_browser) === 'true',
    denyDomains: arr(props.deny_domains), denyFolders: arr(props.deny_folders), askFirst: arr(props.ask_first) };
}
function writeRules(id, text) { fs.writeFileSync(rulesPath(id), text); }

const posixAbs = p => '//' + p.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).split(path.sep).join('/');

function denyEntries(rules, raviRoot) {
  const out = [];
  for (const c of rules.denyConnectors) out.push('mcp__' + c);
  if (rules.denyBrowser) out.push('mcp__playwright', 'mcp__claude-in-chrome', 'Bash(playwright *)', 'Bash(npx playwright *)');
  for (const d of rules.denyDomains) out.push(`WebFetch(domain:${d})`);
  for (const f of rules.denyFolders) {
    const p = posixAbs(path.join(raviRoot, f));
    out.push(`Read(${p}/**)`, `Edit(${p}/**)`);
  }
  return out;
}

// Text served to agents: MCP instructions and the managed CLAUDE.md block.
function instructionsText(ws, rules) {
  const lines = [`# Workspace: ${ws.name}`, '', rules.body || '(No instructions written yet.)', ''];
  const hard = [];
  if (rules.denyConnectors.length) hard.push('Do not use these connectors: ' + rules.denyConnectors.join(', '));
  if (rules.denyBrowser) hard.push('Do not use a browser (Playwright or Chrome).');
  if (rules.denyDomains.length) hard.push('Do not fetch or open: ' + rules.denyDomains.join(', '));
  if (rules.denyFolders.length) hard.push('Do not read or edit these folders: ' + rules.denyFolders.join(', '));
  if (hard.length) lines.push('## Hard limits', ...hard.map(h => '- ' + h), '');
  if (rules.askFirst.length) lines.push('## Ask me before', ...rules.askFirst.map(a => '- ' + a), '');
  lines.push(`AI write access in Aiodize: ${rules.aiWrite === 'read' ? 'read-only' : 'can edit notes (every change is logged and can be reverted)'}.`);
  return lines.join('\n');
}

const START = '<!-- chitta:start (managed by Chitta, edit WORKSPACE.md instead) -->';
const END = '<!-- chitta:end -->';
function mergeClaudeMd(existing, block) {
  const managed = `${START}\n${block}\n${END}`;
  if (existing == null) return { action: 'create', text: managed + '\n' };
  const a = existing.indexOf(START), b = existing.indexOf(END);
  if (a >= 0 && b > a) return { action: 'update', text: existing.slice(0, a) + managed + existing.slice(b + END.length) };
  return { action: 'append', text: existing.replace(/\s*$/, '\n\n') + managed + '\n' };
}

function appliedFile(id) { return path.join(dataDir(id), 'applied.json'); }
function readApplied(id) { try { return JSON.parse(fs.readFileSync(appliedFile(id), 'utf8')); } catch { return {}; } }

// Plan (dry run) or apply rules to every folder in ws.apply_to.
function compileRules(config, id, apply = false) {
  const ws = getWs(config, id), rules = readRules(id);
  const deny = denyEntries(rules, config.ravi);
  const block = instructionsText(ws, rules);
  const applied = readApplied(id);
  const plan = [];
  for (const f of ws.apply_to || []) {
    const dir = path.resolve(config.ravi, f);
    const item = { folder: f, claudeMd: '', add: [], remove: [], error: '' };
    plan.push(item);
    if (!dir.startsWith(path.resolve(config.ravi) + path.sep) || !fs.existsSync(dir)) { item.error = 'Folder not found'; continue; }
    const mdFile = path.join(dir, 'CLAUDE.md');
    let md = null; try { md = fs.readFileSync(mdFile, 'utf8'); } catch {}
    const merged = mergeClaudeMd(md, block);
    item.claudeMd = merged.action;
    const setFile = path.join(dir, '.claude', 'settings.json');
    let settings = {};
    if (fs.existsSync(setFile)) {
      try { settings = JSON.parse(fs.readFileSync(setFile, 'utf8')); }
      catch { item.error = '.claude/settings.json is not valid JSON, so it was left alone'; continue; }
    }
    const before = new Set(((settings.permissions || {}).deny) || []);
    const prev = new Set(applied[f] || []);
    const next = new Set([...before].filter(x => !prev.has(x) || deny.includes(x)));
    for (const d of deny) next.add(d);
    item.add = deny.filter(d => !before.has(d));
    item.remove = [...before].filter(x => !next.has(x));
    if (apply) {
      fs.writeFileSync(mdFile, merged.text);
      settings.permissions = Object.assign({}, settings.permissions, { deny: [...next] });
      fs.mkdirSync(path.dirname(setFile), { recursive: true });
      fs.writeFileSync(setFile, JSON.stringify(settings, null, 2) + '\n');
      applied[f] = deny;
    }
  }
  if (apply) fs.writeFileSync(appliedFile(id), JSON.stringify(applied, null, 1));
  return { deny, block, plan };
}

// ---------- activity log (append-only; "before" lets you revert) ----------
function activityFile(id) { return path.join(dataDir(id), 'activity.jsonl'); }
function logActivity(id, entry) {
  const e = Object.assign({ id: crypto.randomBytes(6).toString('hex'), ts: Date.now() }, entry);
  fs.appendFileSync(activityFile(id), JSON.stringify(e) + '\n');
  return e;
}
// ponytail: reads the whole log each time; tail-read when logs pass a few MB
function readActivity(id, limit = 300) {
  let lines = []; try { lines = fs.readFileSync(activityFile(id), 'utf8').split('\n'); } catch {}
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) { if (lines[i]) try { out.push(JSON.parse(lines[i])); } catch {} }
  return out;
}

module.exports = { CONFIG, COLORS, validateWorkspaces, ROOT, DATA, loadConfig, getWs, readRules, writeRules, instructionsText, compileRules, mergeClaudeMd,
  denyEntries, logActivity, readActivity };
