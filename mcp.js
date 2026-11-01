#!/usr/bin/env node
// Aiodize MCP server (stdio). One process = one workspace:
//   node mcp.js --workspace bliink
// It can only open that workspace's vault, sends WORKSPACE.md as its instructions,
// and logs every write (with the old text, so it can be reverted in the app).
'use strict';
const fs = require('fs');
const path = require('path');
const V = require('./lib/vault');
const W = require('./lib/workspace');
const C = require('./lib/context');

const argWs = (() => { const i = process.argv.indexOf('--workspace'); return i > 0 ? process.argv[i + 1] : (process.env.AIODIZE_WORKSPACE || process.env.CHITTA_WORKSPACE); })();
const config = W.loadConfig();
const ws = W.getWs(config, argWs || '');
const root = ws.vault;
let client = 'agent';

const notes = () => V.readNotes(root);
const findNote = (list, ref) => {
  if (!ref) return null;
  const r = String(ref).toLowerCase().replace(/\\/g, '/');
  return list.find(n => n.rel.toLowerCase() === r || n.rel.toLowerCase() === r + '.md') ||
    list.find(n => n.title.toLowerCase() === r || n.aliases.some(a => a.toLowerCase() === r));
};
const log = (action, rel, before, extra = {}) => W.logActivity(ws.id, Object.assign({ who: client, action, path: rel, before }, extra));

function writeNote(rel, text, action) {
  const full = V.safePath(root, rel);
  let before = null; try { before = fs.readFileSync(full, 'utf8'); } catch {}
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  log(action, rel, before);
}

const READ_TOOLS = [
  { name: 'search', description: 'Search notes in this workspace by words. Returns paths, titles, status and a snippet.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    run: a => V.search(notes(), a.query, a.limit || 10) },
  { name: 'read_note', description: 'Read one note by path (e.g. "Projects/Apps/My App.md"), title or alias.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    run: a => { const n = findNote(notes(), a.note); if (!n) throw new Error('No note called ' + a.note); return { path: n.rel, title: n.title, properties: n.props, body: n.body }; } },
  { name: 'list_statuses', description: 'The project statuses this workspace uses (id, label, stage). Use these ids when setting a status.',
    inputSchema: { type: 'object', properties: {} },
    run: () => require('./lib/board').read(W.DATA, ws.id).statuses },
  { name: 'list_projects', description: 'List project notes with status, category, folder and last_worked. Optional status filter.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    run: a => notes().filter(n => n.type === 'project' && (!a.status || n.props.status === a.status))
      .map(n => ({ path: n.rel, title: n.title, status: n.props.status || '', category: n.category, folder: n.props.folder || '', last_worked: n.props.last_worked || '' })) },
  { name: 'get_project_context', description: 'Everything needed to pick up a project: its note, linked notes, recent changes and the workspace rules.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    run: a => {
      const list = notes(), n = findNote(list, a.project);
      if (!n) throw new Error('No project called ' + a.project);
      const linked = n.links.map(l => findNote(list, l)).filter(Boolean).map(x => ({ path: x.rel, title: x.title, status: x.props.status || '' }));
      const recent = W.readActivity(ws.id, 200).filter(e => e.path === n.rel).slice(0, 5).map(e => ({ when: new Date(e.ts).toISOString(), who: e.who, action: e.action, summary: e.summary || '' }));
      return { note: { path: n.rel, properties: n.props, body: n.body }, linked, recent_changes: recent, rules: W.instructionsText(ws, W.readRules(ws.id)) };
    } },
  { name: 'get_context', description: 'Call this before starting work. Give the folder you are working in: returns this workspace\'s rules, the project note for that folder (status, summary, pending items) and recent work. Without a folder: rules and open projects.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Absolute path of the folder you are working in' } } },
    run: a => C.contextFor(config, ws, a.folder || '') },
  { name: 'setup_status', description: 'Use when setting Aiodize up: what exists now (workspaces, rules, statuses), the projects folder and which project folders have no note yet.',
    inputSchema: { type: 'object', properties: {} },
    run: () => require('./lib/setup').setupStatus(config) },
  { name: 'propose_setup', description: 'Propose a setup for the person to review in Aiodize; nothing changes until they accept. workspaces: [{id,name,folders:["glob"],tools:[connector names],apply_to:[folders]}]; rules: {workspaceId: "plain-language rules"}; statuses: {workspaceId: [{label,color,shape,stage}]}; project_notes: [{workspace,title,category,folder,status,summary}].',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' }, workspaces: { type: 'array', items: { type: 'object' } }, rules: { type: 'object' }, statuses: { type: 'object' }, project_notes: { type: 'array', items: { type: 'object' } } }, required: ['summary'] },
    run: a => require('./lib/setup').propose(a, client) },
  { name: 'log_run', description: 'Record what you did this session (summary, model, tokens) so it shows in Mission Control.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' }, model: { type: 'string' }, project: { type: 'string' }, tokens_in: { type: 'number' }, tokens_out: { type: 'number' } }, required: ['summary'] },
    run: a => { const n = a.project ? findNote(notes(), a.project) : null;
      W.logActivity(ws.id, { who: client, action: 'run', path: n ? n.rel : '', summary: String(a.summary).slice(0, 500), model: a.model || '', tokens: (a.tokens_in || 0) + (a.tokens_out || 0), reported: true });
      return 'Logged.'; } },
];
const WRITE_TOOLS = [
  { name: 'log_work', description: 'Call this when you finish meaningful work. Adds one line to the project note\'s Log (what changed + next steps), sets last_worked to today and optionally the status (ids from list_statuses). Find the project by name or by the folder you worked in.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' }, next: { type: 'string' }, status: { type: 'string' }, project: { type: 'string' }, folder: { type: 'string' } }, required: ['summary'] },
    run: a => {
      const list = notes(), n = a.project ? findNote(list, a.project) : a.folder ? C.projectForFolder(list, a.folder) : null;
      if (!n) { log('run', '', null, { summary: String(a.summary).slice(0, 500), reported: true }); return 'No project note matched, so this was logged as a run. Create a project note (Projects/<Category>/<Name>.md with a folder property) to keep a log there.'; }
      return C.logWork(ws, list, n, { summary: a.summary, next: a.next, status: a.status, who: client });
    } },
  { name: 'create_note', description: 'Create a note. folder e.g. "Ideas" or "Projects/Apps". properties become frontmatter (status, tags, ...).',
    inputSchema: { type: 'object', properties: { folder: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, properties: { type: 'object' } }, required: ['title', 'body'] },
    run: a => {
      const safeTitle = String(a.title).replace(/[\\/:*?"<>|]/g, '-').trim();
      const rel = (a.folder ? a.folder.replace(/\\/g, '/').replace(/\/+$/, '') + '/' : '') + safeTitle + '.md';
      if (fs.existsSync(V.safePath(root, rel))) throw new Error('A note already exists at ' + rel);
      writeNote(rel, V.serializeFrontmatter(Object.assign({ title: a.title }, a.properties || {})) + '\n' + a.body + '\n', 'create');
      return { created: rel };
    } },
  { name: 'append_to_note', description: 'Add text to the end of a note (or under a heading if given).',
    inputSchema: { type: 'object', properties: { note: { type: 'string' }, text: { type: 'string' }, heading: { type: 'string' } }, required: ['note', 'text'] },
    run: a => {
      const n = findNote(notes(), a.note); if (!n) throw new Error('No note called ' + a.note);
      const old = fs.readFileSync(V.safePath(root, n.rel), 'utf8');
      let next;
      const h = a.heading ? new RegExp('^#{1,6}\\s+' + a.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'mi').exec(old) : null;
      if (h) { const after = old.slice(h.index + h[0].length); const nx = /^#{1,6}\s/m.exec(after); const at = h.index + h[0].length + (nx ? nx.index : after.length);
        next = old.slice(0, at).replace(/\s*$/, '\n') + a.text + '\n\n' + old.slice(at); }
      else next = old.replace(/\s*$/, '\n\n') + a.text + '\n';
      writeNote(n.rel, next, 'append'); return 'Appended to ' + n.rel;
    } },
  { name: 'set_properties', description: 'Change frontmatter properties of a note, e.g. {"status":"live","last_worked":"2026-11-01"}.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' }, properties: { type: 'object' } }, required: ['note', 'properties'] },
    run: a => {
      const n = findNote(notes(), a.note); if (!n) throw new Error('No note called ' + a.note);
      const old = fs.readFileSync(V.safePath(root, n.rel), 'utf8');
      const { props, body } = V.parseFrontmatter(old);
      writeNote(n.rel, V.serializeFrontmatter(Object.assign(props, a.properties)) + body, 'properties');
      return 'Updated ' + n.rel;
    } },
  { name: 'replace_note', description: 'Replace a note\'s full text. Prefer append_to_note or set_properties for small changes.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' }, text: { type: 'string' } }, required: ['note', 'text'] },
    run: a => { const n = findNote(notes(), a.note); if (!n) throw new Error('No note called ' + a.note); writeNote(n.rel, a.text, 'replace'); return 'Replaced ' + n.rel; } },
];

// One-click actions (Claude Desktop shows them in the + menu; other MCP apps as slash commands).
const PROMPTS = [
  { name: 'load_context', title: 'Load my Aiodize context', description: 'Your rules, the project, its pending items and recent work, as background for this chat.',
    arguments: [{ name: 'folder', description: 'Folder you are working in (leave empty for the whole workspace)', required: false }],
    text: a => 'Here is my Aiodize context. Use it as background for this conversation and follow the rules in it.\n\n' + C.contextText(C.contextFor(config, ws, a.folder || '')) },
  { name: 'log_this_work', title: 'Log this work', description: 'Saves what was done in this chat to the project note.',
    arguments: [{ name: 'project', description: 'Project name (optional)', required: false }],
    text: a => `Summarise what we did in this conversation in one or two sentences, then call the log_work tool with that summary, the next steps and the status if it changed${a.project ? ` for the project "${a.project}"` : ', using the project we worked on (ask me if it is unclear)'}.` },
  { name: 'set_up_aiodize', title: 'Set up Aiodize', description: 'Looks at your notes and folders and proposes workspaces, rules and project notes for you to review.',
    arguments: [], text: () => 'Set up Aiodize for me. Start with the setup_status tool, look at my notes and project folders, ask me anything unclear, then call propose_setup so I can review it in Aiodize.' },
];
function tools() { return W.readRules(ws.id).aiWrite === 'read' ? READ_TOOLS : READ_TOOLS.concat(WRITE_TOOLS); }

function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    client = (params.clientInfo && params.clientInfo.name) || 'agent';
    if (!process.env.AIODIZE_TEST && !process.env.CHITTA_TEST) try { fs.writeFileSync(path.join(W.DATA, ws.id, 'mcp-seen.json'), JSON.stringify({ client, ts: Date.now() })); } catch {} // shown on the Settings page
    return { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: 'aiodize-' + ws.id, version: require('./package.json').version }, instructions: W.instructionsText(ws, W.readRules(ws.id)) +
        "\n\nAiodize is this person's brain for AI on their device. Before starting work in a folder, call get_context with that folder. When you finish meaningful work, call log_work (what changed, status, next steps)." };
  }
  if (method === 'ping') return {};
  if (method === 'prompts/list') return { prompts: PROMPTS.map(({ text, ...p }) => p) };
  if (method === 'prompts/get') {
    const p = PROMPTS.find(x => x.name === params.name);
    if (!p) throw Object.assign(new Error('Unknown prompt: ' + params.name), { code: -32602 });
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(params.arguments || {}) } }] };
  }
  if (method === 'tools/list') return { tools: tools().map(({ run, ...t }) => t) };
  if (method === 'tools/call') {
    const t = tools().find(x => x.name === params.name);
    if (!t) return { content: [{ type: 'text', text: 'Unknown or disabled tool: ' + params.name }], isError: true };
    try { const r = t.run(params.arguments || {}); return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] }; }
    catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
  }
  if (id === undefined) return undefined; // notification
  throw Object.assign(new Error('Method not found: ' + method), { code: -32601 });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    let reply;
    try { const result = handle(msg); if (msg.id === undefined) continue; reply = { jsonrpc: '2.0', id: msg.id, result }; }
    catch (e) { if (msg.id === undefined) continue; reply = { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }; }
    process.stdout.write(JSON.stringify(reply) + '\n');
  }
});
