// Vault: reads a folder of Markdown notes (Obsidian-compatible) into notes + a graph.
'use strict';
const fs = require('fs');
const path = require('path');

const pad = n => String(n).padStart(2, '0');
const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const SKIP_DIRS =new Set(['.obsidian', '.git', '.trash', 'node_modules', '.chitta']);

// ---------- frontmatter (small YAML subset: key: value, key: [a, b], key:\n  - a) ----------
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { props: {}, body: text };
  const props = {};
  let lastKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && lastKey) {
      if (!Array.isArray(props[lastKey])) props[lastKey] = [];
      props[lastKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    lastKey = kv[1];
    const v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) props[lastKey] = v.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean);
    else props[lastKey] = v === '' ? '' : unquote(v);
  }
  return { props, body: text.slice(m[0].length) };
}
const unquote = s => s.replace(/^["']|["']$/g, '');

function serializeFrontmatter(props) {
  const lines = Object.entries(props).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
}

// ---------- links and tags ----------
const LINK_RE = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const TAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)/g;
function extractLinks(s) { const out = []; let m; LINK_RE.lastIndex = 0; while ((m = LINK_RE.exec(s))) out.push(m[1].trim()); return out; }
function extractTags(body) {
  const clean = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const out = new Set(); let m; TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(clean))) out.add(m[1].toLowerCase());
  return [...out];
}

// ---------- path safety: every note path must stay inside the vault ----------
function safePath(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Bad path');
  const full = path.resolve(root, rel);
  const r = path.resolve(root);
  if (full !== r && !full.startsWith(r + path.sep)) throw new Error('Path is outside the vault');
  if (!full.toLowerCase().endsWith('.md')) throw new Error('Only .md notes can be opened');
  return full;
}

function walk(root, dir = root, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, path.join(dir, e.name), out); }
    else if (e.name.toLowerCase().endsWith('.md')) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
  }
  return out;
}

function noteType(rel, props) {
  if (props.type) return String(props.type).toLowerCase();
  const top = rel.split('/')[0].toLowerCase();
  if (top === 'projects') return 'project';
  if (top === 'ideas') return 'idea';
  if (top === 'infrastructure') return 'infra';
  if (/^home\.md$/i.test(rel)) return 'hub';
  return 'note';
}

function readNotes(root) {
  return walk(root).map(rel => {
    let text = '', st = null; try { text = fs.readFileSync(path.join(root, rel), 'utf8'); st = fs.statSync(path.join(root, rel)); } catch {}
    const { props, body } = parseFrontmatter(text);
    const title = props.title || path.basename(rel, '.md');
    const aliases = Array.isArray(props.aliases) ? props.aliases : props.aliases ? [props.aliases] : [];
    const tags = new Set([...(Array.isArray(props.tags) ? props.tags : []).map(t => String(t).toLowerCase()), ...extractTags(body)]);
    return { rel, title, aliases, props, body, tags: [...tags], links: extractLinks(body), born: st ? dayOf(Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs)) : '',
      type: noteType(rel, props), category: props.category || rel.split('/').slice(0, -1).pop() || 'Root' };
  });
}

// First http(s) URL in a note's url property (its live site), or ''.
function siteOf(props) {
  const m = /https?:\/\/[^\s,)]+/.exec(String(props.url || ''));
  try { return m ? new URL(m[0]).href : ''; } catch { return ''; }
}

// Build nodes + edges. Inspiration list lines ("- https://... [[Note]]") become their own nodes.
// Links written as [[swati:Note title]] point into another workspace; they become 'external' nodes.
function buildGraph(notes, otherWs = []) {
  const byName = new Map();
  for (const n of notes) for (const k of [n.title, path.basename(n.rel, '.md'), ...n.aliases]) {
    const key = String(k).toLowerCase();
    if (!byName.has(key)) byName.set(key, n.rel);
  }
  const nodes = [], edges = [], seen = new Set();
  const addEdge = (s, t, kind) => { const k = s < t ? s + '|' + t : t + '|' + s; if (s !== t && !seen.has(k)) { seen.add(k); edges.push({ s, t, kind }); } };
  for (const n of notes) { const site = siteOf(n.props); nodes.push({ id: n.rel, label: n.title, type: n.type, status: n.props.status || '',
    category: n.category, tags: n.tags, updated: n.props.last_worked || n.props.updated || '', site, host: site ? new URL(site).hostname : '',
    born: n.born, deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(n.props.deadline || '')) ? n.props.deadline : '' }); }
  const tagNodes = new Map();
  for (const n of notes) {
    for (const l of n.links) {
      const x = /^([a-z0-9_-]+):(.+)$/i.exec(l);
      if (x && otherWs.includes(x[1].toLowerCase())) {
        const id = `ext:${x[1].toLowerCase()}:${x[2].trim()}`;
        if (!tagNodes.has(id)) { tagNodes.set(id, true); nodes.push({ id, label: x[2].trim(), type: 'external', ws: x[1].toLowerCase(), status: '', category: 'Other workspaces', tags: [], born: n.born }); }
        addEdge(n.rel, id, 'external'); continue;
      }
      const t = byName.get(l.toLowerCase()); if (t) addEdge(n.rel, t, 'link');
    }
    for (const tag of n.tags) {
      if (tag === 'project') continue; // on every project note, so it says nothing
      const id = 'tag:' + tag;
      if (!tagNodes.has(id)) { tagNodes.set(id, true); nodes.push({ id, label: '#' + tag, type: 'tag', status: '', category: 'tag', tags: [], born: n.born }); }
      addEdge(n.rel, id, 'tag');
    }
    if (n.tags.includes('inspiration')) {
      for (const line of n.body.split(/\r?\n/)) {
        const m = /^\s*-\s+(https?:\/\/\S+)\s*(.*)$/.exec(line);
        if (!m) continue;
        const id = 'insp:' + m[1];
        let label = m[1].replace(/^https?:\/\/(www\.)?/, '').replace(/\/i\/\w+-/, ': ').replace(/[-_]/g, ' ');
        if (label.length > 42) label = label.slice(0, 40) + '…';
        nodes.push({ id, label, type: 'inspiration', status: '', category: 'Inspiration', tags: [], url: m[1], note: m[2].replace(/^[—-]\s*/, ''), born: n.born });
        addEdge(n.rel, id, 'inspiration');
        for (const l of extractLinks(m[2])) { const t = byName.get(l.toLowerCase()); if (t) addEdge(id, t, 'inspiration'); }
      }
    }
  }
  const deg = new Map();
  for (const e of edges) { deg.set(e.s, (deg.get(e.s) || 0) + 1); deg.set(e.t, (deg.get(e.t) || 0) + 1); }
  for (const n of nodes) n.deg = deg.get(n.id) || 0;
  return { nodes, edges };
}

function search(notes, q, limit = 10) {
  q = String(q || '').toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  return notes.map(n => {
    const hay = (n.title + ' ' + n.aliases.join(' ')).toLowerCase(), body = n.body.toLowerCase();
    let score = 0;
    const t = n.title.toLowerCase();
    if (t === q) score += 100; else if (t.startsWith(q)) score += 50; else if (hay.includes(q)) score += 30; // names beat mentions
    for (const w of words) { if (hay.includes(w)) score += 5; const c = body.split(w).length - 1; score += Math.min(c, 5); }
    if (!score) return null;
    const i = body.indexOf(words[0]);
    const snippet = i < 0 ? n.body.slice(0, 160) : n.body.slice(Math.max(0, i - 60), i + 120);
    return { path: n.rel, title: n.title, status: n.props.status || '', score, snippet: snippet.replace(/\s+/g, ' ').trim() };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { dayOf, siteOf, parseFrontmatter, serializeFrontmatter, extractLinks, extractTags, safePath, readNotes, buildGraph, search };
