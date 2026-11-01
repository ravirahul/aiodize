// First-run state (data/setup.json), what Aiodize can find on this computer, the context pack for chat-only AIs,
// and the AI's setup proposal (made over MCP, applied only when the person accepts it in the app).
'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./workspace');
const V = require('./vault');
const B = require('./board');
const Apps = require('./apps');

const FILE = path.join(W.DATA, 'setup.json');
const PROPOSAL = path.join(W.DATA, 'proposal.json');
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function state() { return Object.assign({ agreedAt: 0, backup: { on: false, dir: defaultBackupDir(), keep: 14 }, apps: [] }, read(FILE) || {}); }
function save(s) { fs.mkdirSync(W.DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 1)); return s; }
function defaultBackupDir() { return path.join(Apps.HOME(), 'Documents', 'Aiodize Backups'); }

// Obsidian keeps a list of every vault it has opened.
function obsidianVaults() {
  const j = read(path.join(Apps.SUPPORT(), 'obsidian', 'obsidian.json'));
  return Object.values((j && j.vaults) || {}).map(v => v.path).filter(p => p && fs.existsSync(p));
}

// A Markdown summary of one workspace to paste or upload into an AI that can't connect over MCP.
function contextPack(config, ws, activity) {
  const notes = V.readNotes(ws.vault), board = B.read(W.DATA, ws.id), label = id => (board.statuses.find(s => s.id === id) || {}).label || id || '';
  const projects = notes.filter(n => n.type === 'project').sort((a, b) => String(b.props.last_worked || '').localeCompare(String(a.props.last_worked || '')));
  const L = [`# ${ws.name}: context from Aiodize`, '', `Exported ${new Date().toISOString().slice(0, 10)}. This is my notes brain: my rules for AI, my projects and what happened recently. Use it as background and follow the rules.`, '',
    '## Rules', W.instructionsText(ws, W.readRules(ws.id)), '', `## Projects (${projects.length})`];
  for (const n of projects) {
    const sum = (/^>\s*(.+)$/m.exec(n.body) || [])[1] || '';
    L.push(`### ${n.title}`, `Status: ${label(n.props.status) || 'none'}${n.props.last_worked ? ` · last worked ${n.props.last_worked}` : ''}${n.props.url ? ` · ${n.props.url}` : ''}`);
    if (sum) L.push(sum);
    const pend = require('./context').pendingLines(n.body); if (pend.length) L.push('Pending:', ...pend);
    L.push('');
  }
  const ideas = notes.filter(n => n.type === 'idea' || /^ideas\//i.test(n.rel)).slice(-20);
  if (ideas.length) L.push('## Recent ideas', ...ideas.map(n => '- ' + n.title), '');
  const recent = activity.slice(0, 20).filter(e => e.path || e.summary);
  if (recent.length) L.push('## Recent work', ...recent.map(e => `- ${new Date(e.ts).toISOString().slice(0, 10)} ${e.who}: ${e.summary || e.action}${e.path ? ' (' + e.path + ')' : ''}`), '');
  return L.join('\n');
}

// What an AI needs to propose a setup: what exists now, and which project folders have no note yet.
function setupStatus(config) {
  const covered = new Set();
  const workspaces = config.workspaces.map(w => {
    const notes = V.readNotes(w.vault);
    for (const n of notes) for (const f of String(n.props.folder || '').split(/[;\n]/)) { const p = f.replace(/\(.*\)/, '').trim(); if (p) covered.add(path.resolve(p).toLowerCase()); }
    return { id: w.id, name: w.name, vault: w.vault, folders: w.folders, notes: notes.length, projects: notes.filter(n => n.type === 'project').length, rules: W.readRules(w.id).body.slice(0, 600), statuses: B.read(W.DATA, w.id).statuses.map(s => s.id) };
  });
  let folders = [];
  try { folders = fs.readdirSync(config.ravi, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name); } catch {}
  const withoutNote = folders.filter(f => !covered.has(path.resolve(config.ravi, f).toLowerCase())).slice(0, 80);
  return { projects_root: config.ravi, workspaces, project_folders_without_a_note: withoutNote, connected_apps: Apps.list().filter(a => a.connected).map(a => a.name), pending_proposal: !!read(PROPOSAL),
    how_to: 'Look at the folders and notes, ask the person anything unclear, then call propose_setup. Nothing changes until they accept it in Aiodize.' };
}

// The proposal is stored as-is (shapes checked lightly) and checked fully when accepted.
function propose(p, from) {
  const arr = v => Array.isArray(v) ? v : [];
  const clean = {
    from: String(from || 'agent'), ts: Date.now(), summary: String(p.summary || '').slice(0, 1200),
    workspaces: arr(p.workspaces).slice(0, 12),
    rules: Object.fromEntries(Object.entries(p.rules || {}).slice(0, 12).map(([k, v]) => [String(k), String(v).slice(0, 4000)])),
    statuses: Object.fromEntries(Object.entries(p.statuses || {}).slice(0, 12).map(([k, v]) => [String(k), arr(v).slice(0, 12)])),
    project_notes: arr(p.project_notes).slice(0, 100).map(n => ({ workspace: String(n.workspace || ''), title: String(n.title || '').slice(0, 80), category: String(n.category || 'Other').slice(0, 50), folder: String(n.folder || '').slice(0, 300), status: String(n.status || ''), summary: String(n.summary || '').slice(0, 400) })).filter(n => n.title),
  };
  if (!clean.workspaces.length && !Object.keys(clean.rules).length && !Object.keys(clean.statuses).length && !clean.project_notes.length) throw new Error('The proposal is empty: include workspaces, rules, statuses or project_notes.');
  fs.writeFileSync(PROPOSAL, JSON.stringify(clean, null, 1));
  return 'Proposal saved. Tell the person to open Aiodize and review it (Mission Control shows it at the top). Nothing changes until they accept.';
}
function proposal() { return read(PROPOSAL); }
function dropProposal() { try { fs.unlinkSync(PROPOSAL); } catch {} }

module.exports = { state, save, defaultBackupDir, obsidianVaults, contextPack, setupStatus, propose, proposal, dropProposal, PROPOSAL };
