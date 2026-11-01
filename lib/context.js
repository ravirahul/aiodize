// "Before you work" context and "after you work" logging, shared by the MCP server and the Claude Code hook.
'use strict';
const fs = require('fs');
const path = require('path');
const V = require('./vault');
const W = require('./workspace');
const { globRe } = require('./runs');
const Ins = require('./insights');
const B = require('./board');

const norm = p => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const today = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };

// Which workspace a folder belongs to: its first folder under the projects root matched against each workspace's folder patterns.
function wsForFolder(config, folder) {
  const root = norm(config.ravi), f = norm(folder);
  const top = f.startsWith(root + path.sep.toLowerCase()) || f.startsWith(root + '/') ? f.slice(root.length + 1).split(/[\\/]/)[0] : '';
  if (top) for (const w of config.workspaces) if (!w.fallback && (w.folders || []).some(p => globRe(p).test(top))) return w;
  return config.workspaces.find(w => w.fallback) || null;
}

// The project note for a folder: the note whose `folder` property is that folder or contains it (closest wins).
function projectForFolder(notes, folder) {
  const f = norm(folder); let best = null, bestLen = -1;
  for (const n of notes) {
    if (n.type !== 'project') continue;
    for (const raw of String(n.props.folder || '').split(/[;\n]/)) {
      const p = raw.replace(/\(.*\)/, '').trim(); if (!p || !path.isAbsolute(p)) continue;
      const q = norm(p);
      if ((f === q || f.startsWith(q + path.sep.toLowerCase()) || f.startsWith(q + '/')) && q.length > bestLen) { best = n; bestLen = q.length; }
    }
  }
  if (best) return best;
  const name = path.basename(f); // fall back to a project titled like the folder
  return notes.find(n => n.type === 'project' && n.title.toLowerCase().replace(/\s+/g, '-') === name) || null;
}

function pendingLines(body) {
  const m = /^#{2,4}\s+[^\n]*pending[^\n]*$/im.exec(body); if (!m) return [];
  const after = body.slice(m.index + m[0].length), nx = /^#{1,4}\s/m.exec(after);
  return (nx ? after.slice(0, nx.index) : after).split('\n').filter(l => /^\s*([-*]|\d+\.)\s+\S/.test(l)).map(l => l.trim()).slice(0, 8);
}

// Everything an agent should know before working in `folder` (or across the workspace if no folder).
function contextFor(config, ws, folder) {
  const notes = V.readNotes(ws.vault), rules = W.instructionsText(ws, W.readRules(ws.id));
  const statuses = B.read(W.DATA, ws.id).statuses, label = id => (statuses.find(s => s.id === id) || {}).label || id || 'no status';
  const out = { workspace: ws.name, wsId: ws.id, rules };
  const n = folder ? projectForFolder(notes, folder) : null;
  if (n) {
    out.project = { note: n.rel, title: n.title, status: label(n.props.status), last_worked: n.props.last_worked || '', summary: (/^>\s*(.+)$/m.exec(n.body) || [])[1] || '', pending: pendingLines(n.body) };
    out.recent = W.readActivity(ws.id, 300).filter(e => e.path === n.rel).slice(0, 5).map(e => `${new Date(e.ts).toISOString().slice(0, 10)} ${e.who}: ${e.summary || e.action}`);
  } else {
    const open = new Set(statuses.filter(s => s.stage === 'active').map(s => s.id));
    out.open_projects = notes.filter(x => x.type === 'project' && open.has(x.props.status)).map(x => `${x.title} (${label(x.props.status)})`).slice(0, 25);
    if (folder) out.note = 'No project note matches this folder yet. If this is a project, create one with create_note in Projects/<Category>/ and set its folder property.';
  }
  return out;
}

// Short plain-text version for the session-start hook.
function contextText(c) {
  const L = [`Aiodize context (workspace: ${c.workspace})`, '', c.rules, ''];
  if (c.project) {
    L.push(`Project: ${c.project.title} · ${c.project.status}${c.project.last_worked ? ' · last worked ' + c.project.last_worked : ''}`);
    if (c.project.summary) L.push(c.project.summary);
    if (c.project.pending.length) L.push('Pending:', ...c.project.pending);
    if (c.recent && c.recent.length) L.push('Recent:', ...c.recent.map(r => '- ' + r));
    L.push('', `When you finish meaningful work, call log_work on the aiodize-${slugId(c)} server with what changed, the status and next steps.`);
  } else {
    if (c.open_projects && c.open_projects.length) L.push('Open projects: ' + c.open_projects.join(', '));
    if (c.note) L.push(c.note);
  }
  return L.join('\n');
}
const slugId = c => c.wsId;

// After work: one line in the project's "## Log" section, last_worked = today, optional status. Logged and revertible.
function logWork(ws, notes, n, { summary, status, next, who }) {
  const full = V.safePath(ws.vault, n.rel), before = fs.readFileSync(full, 'utf8');
  const { props, body } = V.parseFrontmatter(before);
  props.last_worked = today();
  if (status) {
    const ok = B.read(W.DATA, ws.id).statuses.some(s => s.id === status);
    if (!ok) throw new Error('Unknown status ' + status + '. Call list_statuses for the ids.');
    props.status = status;
  }
  const line = `- ${today()} · ${who || 'agent'}: ${String(summary).trim()}${next ? ` Next: ${String(next).trim()}` : ''}`;
  let b = body;
  const h = /^##\s+Log\s*$/mi.exec(b);
  if (h) { const at = h.index + h[0].length; b = b.slice(0, at) + '\n' + line + b.slice(at); }
  else b = b.replace(/\s*$/, '\n\n## Log\n' + line + '\n');
  const text = V.serializeFrontmatter(props) + b;
  fs.writeFileSync(full, text);
  W.logActivity(ws.id, { who: who || 'agent', action: 'log_work', path: n.rel, before, summary: String(summary).slice(0, 300) });
  return { note: n.rel, line };
}

module.exports = { wsForFolder, projectForFolder, contextFor, contextText, logWork, pendingLines };
