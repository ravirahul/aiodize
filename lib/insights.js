// Insights from notes + activity: project health, "pick next" ranking, and the weekly digest note.
'use strict';
const { extractLinks } = require('./vault');

const DAY = 864e5;
const pad = n => String(n).padStart(2, '0');
const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
const { DEFAULT } = require('./board');
// What each status means for insights: open work, its label, how much it pulls a project up "pick next".
const WEIGHT = { 'live-partial': 3, 'built-not-deployed': 3, 'in-progress': 2 };
function meta(statuses = DEFAULT.statuses) {
  const m = { open: new Set(), parked: new Set(), label: {}, weight: {} };
  for (const s of statuses) {
    m.label[s.id] = s.label.toLowerCase();
    if (s.stage === 'active') { m.open.add(s.id); m.weight[s.id] = WEIGHT[s.id] || 2.5; }
    else if (s.stage === 'done') m.weight[s.id] = 0.3;
    else m.parked.add(s.id);
  }
  return m;
}

// Count bullet items under a "pending" heading ("## What's pending", "## Pending", ...).
function pendingCount(body) {
  const m = /^#{2,4}\s+[^\n]*pending[^\n]*$/im.exec(body);
  if (!m) return null;
  const after = body.slice(m.index + m[0].length), next = /^#{1,4}\s/m.exec(after);
  return (next ? after.slice(0, next.index) : after).split('\n').filter(l => /^\s*([-*]|\d+\.)\s+\S/.test(l)).length;
}

// Last day anything happened on a project: last_worked, Claude sessions, edits or commits.
function health(notes, series, today, statuses) {
  const M = meta(statuses), out = {};
  for (const n of notes) {
    if (n.type !== 'project') continue;
    let last = /^\d{4}-\d{2}-\d{2}$/.test(String(n.props.last_worked || '')) ? n.props.last_worked : '';
    let first = '';
    for (const [d, v] of Object.entries(series[n.rel] || {})) if (v.some(x => x > 0)) { if (d > last) last = d; if (!first || d < first) first = d; }
    const idle = last ? daysBetween(last, today) : null;
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(n.props.deadline || '')) ? n.props.deadline : '';
    out[n.rel] = { last, first, idle, stale: idle !== null && idle >= 30 && !M.parked.has(n.props.status), deadline, daysLeft: deadline ? daysBetween(today, deadline) : null };
  }
  return out;
}

// Which projects are closest to "live and usable", with the reasons in plain words.
function pickNext(notes, series, today, limit = 6, statuses) {
  const M = meta(statuses), h = health(notes, series, today, statuses);
  const home = notes.find(n => n.type === 'hub' || /^home\.md$/i.test(n.rel));
  const onHome = new Set();
  if (home) { const m = /^#{1,4}[^\n]*pick next[^\n]*$/im.exec(home.body); if (m) { const after = home.body.slice(m.index); const end = after.slice(m[0].length).search(/^#{1,4}\s/m); for (const l of extractLinks(end < 0 ? after : after.slice(0, m[0].length + end))) onHome.add(l.toLowerCase()); } }
  const ranked = [];
  for (const n of notes) {
    if (n.type !== 'project') continue;
    const st = n.props.status || '', hh = h[n.rel], why = [];
    let score = M.weight[st] || 0;
    if (!score) continue;
    why.push(M.label[st] || st);
    const pend = pendingCount(n.body);
    if (pend !== null) { score += Math.max(0, 3 - pend) * 0.5; why.push(pend === 0 ? 'nothing pending' : `${pend} pending item${pend === 1 ? '' : 's'}`); }
    if (hh.daysLeft !== null && hh.daysLeft >= 0) { score += hh.daysLeft <= 30 ? 6 : hh.daysLeft <= 90 ? 4 : 1; why.push(`deadline in ${hh.daysLeft} days`); }
    if (onHome.has(n.title.toLowerCase()) || n.aliases.some(a => onHome.has(a.toLowerCase()))) { score += 2; why.push('on your Home "pick next" list'); }
    if (hh.idle !== null && hh.idle <= 7) { score += 1; why.push('worked on this week'); }
    else if (hh.idle !== null && hh.idle >= 30 && M.open.has(st)) { score += 0.5; why.push(`untouched for ${hh.idle} days`); }
    ranked.push({ path: n.rel, title: n.title, status: st, score: Math.round(score * 10) / 10, why });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ISO week of a day key: [year, week, mondayKey, sundayKey].
function isoWeek(k) {
  const d = parse(k), dow = (d.getDay() + 6) % 7;
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const thu = new Date(mon); thu.setDate(mon.getDate() + 3);
  const jan4 = new Date(thu.getFullYear(), 0, 4, 12);
  const week = 1 + Math.round(((thu - jan4) / DAY - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [thu.getFullYear(), week, key(mon), key(sun)];
}

const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = k => { const d = parse(k); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };

// The digest note for the ISO week containing `today` (week to date).
function digest(notes, series, today, statuses) {
  const M = meta(statuses);
  const [y, w, mon] = isoWeek(today);
  const inWeek = d => d >= mon && d <= today;
  const sum = (k, i) => Object.entries(series[k] || {}).reduce((a, [d, v]) => a + (inWeek(d) ? v[i] : 0), 0);
  const projects = notes.filter(n => n.type === 'project');
  const rows = projects.map(n => ({ n, tok: sum(n.rel, 0), cost: sum(n.rel, 1), sess: sum(n.rel, 2), edits: sum(n.rel, 3), commits: sum(n.rel, 4) }))
    .filter(r => r.tok || r.edits || r.commits).sort((a, b) => b.tok - a.tok);
  const h = health(notes, series, today, statuses);
  const stalled = projects.filter(n => M.open.has(n.props.status) && h[n.rel].idle !== null && h[n.rel].idle >= 14).sort((a, b) => h[b.rel].idle - h[a.rel].idle);
  const deadlines = projects.filter(n => h[n.rel].deadline && h[n.rel].daysLeft >= 0).sort((a, b) => h[a.rel].daysLeft - h[b.rel].daysLeft);
  const next = pickNext(notes, series, today, 5, statuses);
  const L = [];
  L.push('---', `title: Week ${w}, ${y}`, 'type: digest', 'tags: [digest]', `week: ${y}-W${pad(w)}`, `written: ${today}`, '---', '');
  L.push(`# Week ${w}: ${nice(mon)} to ${nice(today)}`, '', 'Written by Aiodize from your notes, Claude session logs and git history. Token cost is an API-price estimate.', '');
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  L.push('## Numbers', `- ${pl(Math.round(sum('_all', 2)), 'Claude session')}, ${fmtTok(sum('_all', 0))} tokens, $${sum('_all', 1).toFixed(2)}`, `- ${pl(sum('_all', 3), 'note change')} in Chitta, ${pl(sum('_all', 4), 'git commit')}`, '');
  L.push('## Where the work went');
  if (rows.length) { L.push('| Project | Tokens | Sessions | Commits | Status |', '|---|---|---|---|---|'); for (const r of rows.slice(0, 15)) L.push(`| [[${r.n.title}]] | ${fmtTok(r.tok)} | ${Math.round(r.sess)} | ${r.commits} | ${M.label[r.n.props.status] || r.n.props.status || ''} |`); }
  else L.push('No project activity this week.');
  L.push('');
  L.push('## Stalled', ...(stalled.length ? stalled.slice(0, 10).map(n => `- [[${n.title}]]: ${M.label[n.props.status]}, nothing for ${h[n.rel].idle} days`) : ['Nothing stalled for two weeks or more.']), '');
  if (deadlines.length) L.push('## Deadlines', ...deadlines.map(n => `- [[${n.title}]]: ${nice(h[n.rel].deadline)} (${h[n.rel].daysLeft} days left)`), '');
  L.push('## Pick next', ...(next.length ? next.map((p, i) => `${i + 1}. [[${p.title}]]: ${p.why.join(', ')}`) : ['Nothing open.']), '');
  return { rel: `Digests/${y}-W${pad(w)}.md`, text: L.join('\n') };
}

module.exports = { pendingCount, health, pickNext, isoWeek, digest };
