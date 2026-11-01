import { Graph } from './graph.js';
import { render } from './md.js';
import { heatmap2d, skyline, bubbles, makeTip, dayKey, addDays, longDate } from './charts.js';
import { MindmapView, SunburstView, GlobeView, SolarView, Minimap } from './views.js';
import { ST, COLOR_VAR, SHAPES, STAGES, DEFAULT_STATUSES } from './status.js';

const TOKEN = document.querySelector('meta[name="aiodize-token"]').content;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
async function api(p, opts = {}) {
  const r = await fetch(p, Object.assign({}, opts, { headers: Object.assign({ 'X-Aiodize-Token': TOKEN, 'Content-Type': 'application/json' }, opts.headers) }));
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !sessionStorage.getItem('aiodize-reloaded')) { sessionStorage.setItem('aiodize-reloaded', '1'); location.reload(); } // server restarted: new token
  if (r.ok) sessionStorage.removeItem('aiodize-reloaded');
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const q = (p, extra = '') => `${p}?ws=${encodeURIComponent(S.ws)}${extra}`;
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

const S = { ws: null, workspaces: [], notes: [], graph: null, view: 'graph', open: null, editing: false };
// Status as one same-size circle (outer edge always 13px of 16); each status picks a shape and colour (status.js).
function statusIcon(s, label, look) {
  const sh = look ? look.shape : ST.shape(s), c = look ? `var(${COLOR_VAR[look.color] || '--muted'})` : `var(${ST.cssVar(s)})`, ring = extra => `<circle cx="8" cy="8" r="5.5" fill="none" stroke="${c}" stroke-width="2"${extra || ''}/>`;
  const shapes = { full: `<circle cx="8" cy="8" r="6.5" fill="${c}"/>`, half: ring() + `<path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="${c}"/>`,
    dot: ring() + `<circle cx="8" cy="8" r="2.4" fill="${c}"/>`, dashed: ring(' stroke-dasharray="2.6 2"'), ring: ring() };
  const a11y = label ? `role="img" aria-label="${esc(ST.label(s))}"><title>${esc(ST.label(s))}</title` : 'aria-hidden="true"';
  return `<svg class="st" viewBox="0 0 16 16" ${a11y}>${shapes[sh] || `<circle cx="8" cy="8" r="6.5" fill="none" stroke="${c}" stroke-width="1.5" opacity=".5"/>`}</svg>`;
}
// Favicon when the note's site has one, otherwise its first letter, always the same size.
const noteIcon = n => n.host ? `<img class="nico" src="${iconSrc(n.host)}" alt="">` : `<span class="nico mono">${esc(((n.title || '').match(/[A-Za-z0-9]/) || ['•'])[0].toUpperCase())}</span>`;
const agentKey = who => !who || who === 'you' ? 'you' : /claude/i.test(who) ? 'claude' : /cursor|gpt|openai|codex|chatgpt/i.test(who) ? 'gpt' : /gemini/i.test(who) ? 'gemini' : 'local';
const agentColor = who => getComputedStyle(document.documentElement).getPropertyValue('--' + agentKey(who)).trim();
const avatar = who => `<span class="av" style="background:var(--${agentKey(who)})">${esc((who === 'you' ? 'R' : who || '?')[0].toUpperCase())}</span>`;
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const ACTION = { create: 'created', edit: 'edited', append: 'added to', properties: 'updated properties of', replace: 'rewrote', revert: 'reverted', run: 'logged a run', rules: 'applied rules' };
const titleOf = p => (S.notes.find(n => n.path === p) || {}).title || (p || '').replace(/\.md$/, '').split('/').pop();

// ---------- theme ----------
// The theme is set before paint by the inline script in index.html; this keeps the picker in step.
const TH = window.AiodizeTheme;
function setTheme(base, accent) {
  TH.current = TH.apply(base, accent); store.set('aiodize-theme', TH.current.base); store.set('aiodize-accent', TH.current.accent);
  drawThemePicker(); if (S.view === 'activity') renderActivity();
  setTimeout(legend, 50); // graph re-reads colours on the attribute change first
}
function drawThemePicker() {
  const { base, accent } = TH.current;
  $('#baseGrid').innerHTML = Object.entries(TH.BASES).map(([id, b]) => { const a = TH.accentOf(id, accent);
    return `<button type="button" role="radio" class="basecard" aria-checked="${id === base}" data-base="${id}">
      <svg viewBox="0 0 120 72" aria-hidden="true"><rect width="120" height="72" fill="${b.night}"/><rect width="30" height="72" fill="${b.surface}"/><rect x="30" width="1" height="72" fill="${b.line}"/>
        <rect x="6" y="9" width="18" height="6" rx="2" fill="${a}"/><rect x="6" y="22" width="15" height="3" rx="1.5" fill="${b.text}"/><rect x="6" y="30" width="12" height="3" rx="1.5" fill="${b.muted}"/><rect x="6" y="38" width="14" height="3" rx="1.5" fill="${b.muted}"/>
        <path d="M52 48L72 28L96 42L80 58" stroke="${b.muted}" stroke-width="1" fill="none" opacity=".6"/><circle cx="72" cy="28" r="7" fill="${a}"/><circle cx="52" cy="48" r="4" fill="${b.text}"/><circle cx="96" cy="42" r="4.5" fill="${b.muted}"/><circle cx="80" cy="58" r="3.5" fill="${a}" opacity=".7"/></svg>
      <span>${b.name}<small>${b.light ? 'Light' : 'Dark'}</small></span></button>`; }).join('');
  $('#accGrid').innerHTML = Object.entries(TH.ACCENTS).map(([id, a]) => `<button type="button" role="radio" class="swatch" aria-checked="${id === accent}" data-acc="${id}" title="${a.name}"><i style="background:${TH.accentOf(base, id)}"></i><span>${a.name}</span></button>`).join('');
}
$('#baseGrid').onclick = e => { const b = e.target.closest('[data-base]'); if (b) setTheme(b.dataset.base, TH.current.accent); };
$('#accGrid').onclick = e => { const b = e.target.closest('[data-acc]'); if (b) setTheme(TH.current.base, b.dataset.acc); };
for (const g of ['#baseGrid', '#accGrid']) $(g).onkeydown = e => { // arrow keys move through a radio group
  const items = [...$(g).children], i = items.findIndex(x => x.getAttribute('aria-checked') === 'true'), d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!d) return; e.preventDefault(); items[(i + d + items.length) % items.length].click(); $(g).querySelector('[aria-checked="true"]').focus();
};
drawThemePicker();

// ---------- graph ----------
const iconSrc = host => `/api/favicon?host=${encodeURIComponent(host)}&t=${TOKEN}`;
const graph = new Graph($('#graph'), {
  iconSrc,
  onSelect: n => { if (!n) return closePanel(); if (n.type === 'tag') return; if (n.type === 'external') return openExternal(n); openNode(n); },
  onHover: n => {
    const c = $('#hovercard');
    if (!n) { c.hidden = true; return; }
    const kind = n.type === 'inspiration' ? 'Inspiration' : n.type === 'tag' ? 'Tag' : n.type === 'project' ? 'Project' : n.type === 'hub' ? 'Index' : n.type === 'external' ? 'In ' + (S.workspaces.find(w => w.id === n.ws) || {}).name : 'Note';
    const health = n.type !== 'project' ? '' : [
      n.idle != null ? (n.idle === 0 ? 'worked on today' : `last work ${n.idle} day${n.idle === 1 ? '' : 's'} ago`) : 'no work recorded',
      n.stale ? 'quiet for 30+ days' : '', n.daysLeft != null && n.daysLeft >= 0 ? `deadline in ${n.daysLeft} days` : ''].filter(Boolean).join(' · ');
    c.innerHTML = `<b>${esc(n.label)}</b><span class="muted">${esc(kind)}${n.status ? ' · ' + esc(ST.label(n.status)) : ''}${n.category && !['tag', 'external'].includes(n.type) ? ' · ' + esc(n.category) : ''} · ${n.deg} link${n.deg === 1 ? '' : 's'}</span>${health ? `<br><span class="muted">${esc(health)}</span>` : ''}${n.note ? `<br><span class="muted">${esc(n.note)}</span>` : ''}`;
    c.hidden = false;
  },
});
function legend() {
  const g = graph, el = $('#glegend');
  if (g.opts.colorBy === 'status') el.innerHTML = ST.list.map(s => `<span class="lg">${statusIcon(s.id)}${esc(s.label)}</span>`).join('');
  else { const cats = [...new Set(g.nodes.filter(n => !['tag', 'hub', 'inspiration'].includes(n.type)).map(n => n.category))];
    el.innerHTML = cats.map(c => `<span class="lg"><i style="background:${g.catColor(c)}"></i>${esc(c)}</span>`).join(''); }
}
document.querySelectorAll('#colorSeg button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#colorSeg button').forEach(x => x.setAttribute('aria-pressed', x === b));
  graph.setOptions({ colorBy: b.dataset.color }); legend(); for (const v of Object.values(VIEWS)) v.wake(); mini.request();
});
$('#tTags').onchange = e => { graph.setOptions({ showTags: e.target.checked }); legend(); };
$('#tInsp').onchange = e => { graph.setOptions({ showInsp: e.target.checked }); legend(); };
$('#tExt').onchange = e => { graph.setOptions({ showExternal: e.target.checked }); legend(); };
S.labels = store.get('aiodize-labels') !== '0';
$('#tLabels').checked = S.labels; graph.opts.labels = S.labels;
$('#tLabels').onchange = e => { S.labels = e.target.checked; store.set('aiodize-labels', S.labels ? '1' : '0'); graph.setOptions({ labels: S.labels }); for (const v of Object.values(VIEWS)) v.wake(); };
function moreOpen(open) { $('#morePanel').hidden = !open; $('#moreBtn').setAttribute('aria-expanded', String(open)); }
$('#moreBtn').onclick = () => moreOpen($('#morePanel').hidden);
document.addEventListener('pointerdown', e => { if (!$('#morePanel').hidden && !e.target.closest('.morepick')) moreOpen(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#morePanel').hidden) { moreOpen(false); $('#moreBtn').focus(); } });
// ---------- graph views: Neurons (the force graph), Mind map, Sunburst, Globe, Solar; one minimap for all ----------
const vo = {
  colorOf: n => graph.opts.colorBy === 'status' ? (graph.t.status[n.status] || graph.t.muted) : graph.catColor(n.category),
  catColor: c => graph.catColor(c),
  labels: () => S.labels,
  iconOf: h => graph.icon(h),
  onHover: n => graph.onHover(n),
  onOpen: n => { graph.select(n.id); n.type === 'inspiration' ? openNode(n) : openPreferred(n.id); },
  onChange: () => syncViewBar(),
  onFrame: v => { if (mini.view === v) { mini.request(); syncFit(); } },
};
const VIEWS = { mindmap: new MindmapView($('#v-graph'), vo), sunburst: new SunburstView($('#v-graph'), vo), globe: new GlobeView($('#v-graph'), vo), solar: new SolarView($('#v-graph'), vo) };
const mini = new Minimap($('#minimap'));
graph.onFrame = () => { if (mini.view === graph) { mini.request(); syncFit(); } };
function gMenu(open) { $('.gbar').classList.toggle('open', open); $('#gMenuBtn').setAttribute('aria-expanded', String(open)); }
$('#gMenuBtn').onclick = () => gMenu(!$('.gbar').classList.contains('open'));
$('#gCollapse').addEventListener('click', e => { if (e.target.closest('button')) gMenu(false); });
document.addEventListener('pointerdown', e => { if ($('.gbar').classList.contains('open') && !e.target.closest('#gCollapse, #gMenuBtn')) gMenu(false); });
function syncFit() { const v = activeView(), fit = v.isFit ? v.isFit() : false; if ($('#fitBtn').hidden !== fit) $('#fitBtn').hidden = fit; }
let gview = VIEWS[store.get('aiodize-gview')] ? store.get('aiodize-gview') : 'neurons';
const activeView = () => gview === 'neurons' ? graph : VIEWS[gview];
function syncViewBar() {
  const v = activeView();
  $('#vBack').hidden = !(v.canBack && v.canBack());
  $('#vHint').textContent = v.hint ? v.hint() : '';
}
function setGView(v) {
  gview = v; store.set('aiodize-gview', v);
  $('#v-graph').dataset.mode = v;
  $('#graph').hidden = v !== 'neurons';
  for (const [k, view] of Object.entries(VIEWS)) view.show(k === v);
  document.querySelectorAll('#viewSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  graph.onHover(null);
  if (v === 'neurons') graph.resize();
  const av = activeView(); av.setMatch(S.match || null); av.setTime(TT.day || null);
  for (const x of [graph, ...Object.values(VIEWS)]) if (x !== av) x.setTime(null);
  mini.attach(av); syncViewBar(); syncFit();
}
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => setGView(b.dataset.v));
$('#vBack').onclick = () => { const v = activeView(); if (v.back) v.back(); syncViewBar(); };
// The extra views use projects and notes (not tags, links or index notes), with token use from Activity.
async function feedViews(reset) {
  const d = await activityData().catch(() => null);
  const tok = new Map(((d && d.projects) || []).map(p => [p.path, p.total[0]]));
  const nodes = graph.all.nodes.filter(n => !['tag', 'inspiration', 'hub', 'external', 'digest'].includes(n.type)).map(n => Object.assign({}, n, { tokens: tok.get(n.id) || 0 }));
  const byId = new Map(nodes.map(n => [n.id, n])), adj = new Map(nodes.map(n => [n.id, new Set()]));
  const edges = graph.all.edges.filter(e => byId.has(e.s) && byId.has(e.t));
  for (const e of edges) { adj.get(e.s).add(e.t); adj.get(e.t).add(e.s); }
  for (const n of nodes) n.deg = adj.get(n.id).size;
  const cats = [...new Set(nodes.map(n => n.category))].sort().map(name => {
    const list = nodes.filter(n => n.category === name).sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
    return { name, nodes: list, tokens: list.reduce((s, n) => s + n.tokens, 0) };
  });
  const belt = graph.all.nodes.filter(n => n.type === 'inspiration' || n.type === 'tag'); // the Solar view's asteroid belt
  const data = { name: wsObj().name || 'Workspace', nodes, edges, byId, adj, cats, belt };
  for (const v of Object.values(VIEWS)) v.setData(data, { reset });
  syncViewBar();
}
$('#fitBtn').onclick = () => activeView().fit();
// A link into another workspace: switch there and open the note by title.
async function openExternal(n) {
  await switchWs(n.ws);
  const t = n.label.toLowerCase(), hit = S.notes.find(x => x.title.toLowerCase() === t || x.path.toLowerCase().replace(/\.md$/, '').split('/').pop() === t);
  if (hit) { graph.focus(hit.path); openNote(hit.path); } else toast(`No note called "${n.label}" in ${S.workspaces.find(w => w.id === n.ws).name}`);
}

// ---------- Timeline: play how the vault grew, first day to today, in whichever view is open ----------
const TT = { days: [], timer: null, day: null };
function timeDays() {
  const b = graph.all.nodes.map(n => n.born).filter(Boolean).sort(); if (!b.length) return [];
  const out = []; for (let k = b[0], end = dayKey(new Date()); k <= end; k = addDays(k, 1)) out.push(k);
  return out;
}
function setTimeIdx(i) {
  const k = TT.days[i]; if (!k) return;
  const last = i === TT.days.length - 1, prev = TT.shown || '';
  TT.day = last ? null : k;
  $('#timeRange').value = i; $('#timeRange').style.setProperty('--p', (TT.days.length > 1 ? i / (TT.days.length - 1) * 100 : 100) + '%');
  $('#timeDate').textContent = longDate(k); $('#tBigDate').textContent = longDate(k);
  const shown = graph.all.nodes.filter(n => !n.born || n.born <= k).length;
  $('#timeRange').setAttribute('aria-valuetext', `${longDate(k)}, ${shown} notes`);
  activeView().setTime(TT.day);
  // what appeared since the last frame: burst on the graph, name it in the ticker
  const fresh = k > prev ? graph.all.nodes.filter(n => n.born && n.born > prev && n.born <= k && !['tag', 'inspiration'].includes(n.type)) : [];
  TT.shown = k;
  if (fresh.length && TT.timer) {
    setTimeout(() => activeView().burst && activeView().burst(fresh.slice(0, 24).map(n => n.id)), 40);
    $('#tNew').textContent = `+${fresh.length} new · ${fresh.slice(0, 3).map(n => n.label).join(', ')}${fresh.length > 3 ? '…' : ''}`;
    clearTimeout(TT.newT); TT.newT = setTimeout(() => $('#tNew').textContent = '', 1600);
  }
  timeStatus(i);
}
function timeStatus(i) {
  const left = TT.days.length - 1 - i, on = !!TT.timer;
  $('#tStatus').classList.toggle('on', on);
  $('#tStatus span').textContent = on ? (left ? `Playing · ${left} day${left === 1 ? '' : 's'} left` : 'Playing · today') : left ? 'Paused' : 'Today';
}
function stopPlay() { clearInterval(TT.timer); TT.timer = null; $('#timePlay').innerHTML = '<svg aria-hidden="true"><use href="#i-play2"/></svg>'; $('#timePlay').setAttribute('aria-label', 'Play'); timeStatus(+$('#timeRange').value); }
function play() {
  if (TT.timer) return stopPlay();
  let i = +$('#timeRange').value; if (i >= TT.days.length - 1) i = 0;
  TT.shown = i ? TT.days[i - 1] : '';
  $('#timePlay').innerHTML = '<svg aria-hidden="true"><use href="#i-pause"/></svg>'; $('#timePlay').setAttribute('aria-label', 'Pause');
  const ms = Math.max(70, Math.min(220, 9000 / TT.days.length)); // about 9 seconds end to end, one day per frame
  TT.timer = setInterval(() => { i = Math.min(TT.days.length - 1, i + 1); setTimeIdx(i); if (i >= TT.days.length - 1) stopPlay(); }, ms);
  setTimeIdx(i);
}
function closeTimeline() {
  stopPlay(); TT.day = null; TT.shown = ''; $('#tNew').textContent = ''; activeView().setTime(null);
  $('#timebar').hidden = true; $('#tBig').hidden = true; $('#timeBtn').setAttribute('aria-pressed', 'false');
}
$('#timeBtn').onclick = () => {
  if (!$('#timebar').hidden) return closeTimeline();
  TT.days = timeDays(); if (!TT.days.length) return toast('No dates to play yet.');
  $('#timebar').hidden = false; $('#tBig').hidden = false; $('#timeBtn').setAttribute('aria-pressed', 'true');
  $('#timeRange').max = Math.max(0, TT.days.length - 1); $('#timeRange').value = 0;
  play(); // starts from the first day straight away
};
$('#timeClose').onclick = closeTimeline;
$('#timeRange').oninput = e => { stopPlay(); setTimeIdx(+e.target.value); };
$('#timePlay').onclick = play;

// ---------- search: live. Every view dims what doesn't match while you type; Enter or a click jumps to it ----------
let sTimer, sRes = [], sIdx = 0;
const gs = $('#gsearch'), gr = $('#gresults');
function applyMatch() { activeView().setMatch(S.match || null); mini.request(); }
gs.oninput = () => {
  const qv = gs.value.trim().toLowerCase();
  if (!qv) { S.match = null; applyMatch(); gr.hidden = true; return; }
  // instant: titles and labels; then the server adds notes whose text mentions it
  S.match = new Set(graph.all.nodes.filter(n => (n.label || '').toLowerCase().includes(qv)).map(n => n.id)); applyMatch();
  clearTimeout(sTimer); sTimer = setTimeout(async () => {
    sRes = await api(q('/api/search', '&q=' + encodeURIComponent(gs.value))).catch(() => []);
    if (gs.value.trim().toLowerCase() !== qv) return;
    for (const r of sRes) S.match.add(r.path); applyMatch();
    sIdx = 0; drawResults();
  }, 110);
};
function drawResults() {
  gr.innerHTML = sRes.length ? sRes.map((r, i) => `<button type="button" class="${i === sIdx ? 'on' : ''}" data-i="${i}">${esc(r.title)}<small>${esc(r.snippet)}</small></button>`).join('') : '<div class="empty">No notes match.</div>';
  gr.hidden = false;
  gr.querySelectorAll('button').forEach(b => b.onclick = () => pick(+b.dataset.i));
}
function clearSearch() { gs.value = ''; S.match = null; applyMatch(); gr.hidden = true; }
function pick(i) { const r = sRes[i]; if (!r) return; clearSearch(); go('graph'); const v = activeView(); v.focus && v.focus(r.path); openNote(r.path); }
gs.onkeydown = e => {
  if (e.key === 'ArrowDown') { sIdx = Math.min(sRes.length - 1, sIdx + 1); drawResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sIdx = Math.max(0, sIdx - 1); drawResults(); e.preventDefault(); }
  else if (e.key === 'Enter') pick(sIdx);
  else if (e.key === 'Escape') { clearSearch(); gs.blur(); }
};
gs.onblur = () => setTimeout(() => gr.hidden = true, 150);

// ---------- workspaces ----------
const WS_ICONS = ["dot","leaf","spark","bolt","book","bag","heart","home","code","flower","globe","star","cup","moon","camera","letter"];
function wsIcon(w) {
  const c = WS_COLOR[w.color] || WS_COLOR.marigold, ic = WS_ICONS.includes(w.icon) ? w.icon : 'dot';
  return ic === 'letter' ? `<span class="wsicon letter" style="--wc:${c}">${esc((w.name || '?')[0].toUpperCase())}</span>`
    : `<span class="wsicon" style="--wc:${c}"><svg aria-hidden="true"><use href="#w-${ic}"/></svg></span>`;
}
const WS_COLOR = { marigold: 'var(--marigold)', rose: 'var(--rose)', teal: 'var(--c3)', blue: 'var(--c4)', green: 'var(--c5)', violet: 'var(--c6)' };
// Workspace dropdown: one button showing the current workspace, a menu listing all of them.
function drawWs() {
  const w = S.workspaces.find(x => x.id === S.ws) || S.workspaces[0];
  if (!w) return;
  $('#wsDot').outerHTML = wsIcon(w).replace('class="wsicon', 'id="wsDot" class="wsicon');
  $('#wsName').textContent = w.name; $('#wsBtn').title = `${w.name} workspace (click to switch)`;
  $('#wsMenu').innerHTML = S.workspaces.map((x, i) => `<button type="button" role="option" aria-selected="${x.id === S.ws}" data-ws="${x.id}">${wsIcon(x)}<span class="n">${esc(x.name)}</span><span class="c">${x.notes} notes · Ctrl+${i + 1}</span></button>`).join('');
  $('#wsMenu').querySelectorAll('button').forEach(b => b.onclick = () => { wsMenu(false); switchWs(b.dataset.ws); });
}
function wsMenu(open) {
  $('#wsMenu').hidden = !open; $('#wsBtn').setAttribute('aria-expanded', open);
  if (open) ($('#wsMenu [aria-selected="true"]') || $('#wsMenu button')).focus();
}
$('#wsBtn').onclick = () => wsMenu($('#wsMenu').hidden);
$('#wsMenu').onkeydown = e => {
  const items = [...$('#wsMenu').querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { wsMenu(false); $('#wsBtn').focus(); }
};
document.addEventListener('pointerdown', e => { if (!$('#wsMenu').hidden && !e.target.closest('.wspick')) wsMenu(false); });
async function switchWs(id) {
  if (id === S.ws && S.notes.length) return;
  S.ws = id; store.set('aiodize-ws', id); drawWs(); closePanel();
  if (!$('#timebar').hidden) closeTimeline();
  const [g, notes, board] = await Promise.all([api(q('/api/graph')), api(q('/api/notes')), api(q('/api/board'))]);
  S.notes = notes; applyBoard(board); graph.setData(g); legend(); feedViews(true);
  const w = S.workspaces.find(x => x.id === id);
  for (const el of ['#mcWs', '#rulesWs']) $(el).textContent = w.name;
  $('#notesTitle').textContent = `${w.name} notes`;
  refreshView();
}

// ---------- views (hash routing) ----------
function go(v) { if (location.hash !== '#' + v) location.hash = v; else show(v); }
function show(v) {
  const VIEWS = ['graph', 'mission', 'activity', 'notes', 'rules', 'settings'];
  const guide = v === 'guide'; if (guide) { v = 'settings'; setTab('about'); }
  if (v === 'agents' || v === 'backups') { setTab(v); v = 'settings'; } // #agents, #backups open those Settings tabs
  if (!VIEWS.includes(v)) v = 'graph';
  if (guide) setTimeout(() => { $('#guide').scrollIntoView({ block: 'start' }); $('#guideH').focus({ preventScroll: true }); }, 30);
  S.view = v;
  for (const id of VIEWS) $('#v-' + id).hidden = id !== v;
  document.querySelectorAll('.nav a, a.navlike').forEach(a => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (v === 'graph') { if (gview === 'neurons') graph.resize(); else activeView().resize(); mini.request(); }
  refreshView();
}
addEventListener('hashchange', () => show(location.hash.slice(1)));
function refreshView() { if (!S.ws) return; if (S.view === 'mission') loadMission(); if (S.view === 'activity') loadActivity(); if (S.view === 'notes') drawNotes(); if (S.view === 'rules') loadRules(); if (S.view === 'settings') loadSettings(); }

// ---------- opening notes: side panel, new window, Obsidian or VS Code (Settings → default) ----------
const wsObj = () => S.workspaces.find(w => w.id === S.ws) || {};
const absPath = p => (wsObj().vault + '/' + p).replace(/\\/g, '/');
function openWindow(p) {
  const url = `/?solo=1&ws=${encodeURIComponent(S.ws)}&note=${encodeURIComponent(p)}`;
  const w = window.open(url, '_blank', `popup,left=0,top=0,width=${screen.availWidth},height=${screen.availHeight}`);
  if (!w) toast('The browser blocked the new window. Allow pop-ups for this page.');
}
function openPreferred(p) {
  const how = store.get('aiodize-open') || 'panel';
  if (how === 'window') return openWindow(p);
  if (how === 'obsidian') { graph.select(p); location.href = 'obsidian://open?path=' + encodeURIComponent(absPath(p)); return; }
  if (how === 'vscode') { graph.select(p); location.href = 'vscode://file/' + absPath(p); return; }
  openNote(p);
}

// ---------- note panel ----------
function openNode(n) {
  if (n.type === 'inspiration') {
    S.open = null; $('#panel').hidden = false; $('#pedit').hidden = true; $('#pbody').hidden = false; $('#phist').innerHTML = ''; $('#pact').hidden = true;
    $('#pmeta').innerHTML = '<span class="chip">Inspiration</span>';
    $('#ptitle').textContent = n.label;
    $('#pactions').innerHTML = `<a class="btn" href="${esc(n.url)}" target="_blank" rel="noopener">Open link</a>`;
    $('#pbody').innerHTML = n.note ? `<p>${esc(n.note)}</p>` : '<p class="muted">No comment saved with this link.</p>';
    return;
  }
  openPreferred(n.id);
}
async function openNote(p) {
  let d; try { d = await api(q('/api/note', '&path=' + encodeURIComponent(p))); } catch (e) { return toast(e.message); }
  S.open = d; S.editing = false;
  $('#panel').hidden = false; $('#pedit').hidden = true; $('#pbody').hidden = false;
  const pr = d.props;
  $('#pmeta').innerHTML = [pr.status ? `<span class="chip">${statusIcon(pr.status)}${esc(ST.label(pr.status))}</span>` : '',
    pr.category ? `<span class="chip">${esc(pr.category)}</span>` : '', pr.last_worked ? `<span class="chip">Worked ${esc(pr.last_worked)}</span>` : ''].join('');
  $('#ptitle').textContent = pr.title || p.replace(/\.md$/, '').split('/').pop();
  const acts = ['<button class="btn" id="pEditBtn" type="button">Edit</button>'];
  const folder = String(pr.folder || '').split(/[;(]/)[0].trim();
  if (folder) acts.push(`<button class="btn" id="pFolder" type="button">Open folder</button>`, `<a class="btn" href="vscode://file/${esc(folder.replace(/\\/g, '/'))}">Open in VS Code</a>`);
  for (const u of String(pr.url || '').match(/https?:\/\/[^\s,)]+/g) || []) acts.push(`<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`);
  const chips = $('#pmeta').innerHTML;
  $('#pactions').innerHTML = acts[0] + (acts.length > 1 || chips ? `<button class="btn pmorebtn" id="pMoreBtn" type="button" aria-expanded="false" aria-label="More actions"><svg aria-hidden="true"><use href="#i-dots"/></svg></button><div class="pextra" id="pExtra">${acts.slice(1).join('')}<div class="pchips">${chips}</div></div>` : '');
  $('#pEditBtn').onclick = startEdit;
  if ($('#pMoreBtn')) $('#pMoreBtn').onclick = () => { const o = $('#pactions').classList.toggle('open'); $('#pMoreBtn').setAttribute('aria-expanded', String(o)); };
  if (folder) $('#pFolder').onclick = () => api(q('/api/open'), { method: 'POST', body: JSON.stringify({ folder }) }).catch(e => toast(e.message));
  $('#pbody').innerHTML = render(d.body);
  $('#pbody').querySelectorAll('.wl').forEach(a => a.onclick = e => { e.preventDefault(); const t = a.dataset.note.toLowerCase();
    const n = S.notes.find(x => x.title.toLowerCase() === t || x.path.toLowerCase().replace(/\.md$/, '').split('/').pop() === t);
    if (n) { graph.focus(n.path); openNote(n.path); } else toast('No note called ' + a.dataset.note); });
  drawHistory(d.history);
  graph.select(p);
  drawProjectStrip(p);
}

// Last 26 weeks of Claude work on this project, as a small 2D map. Click a day to open it in Activity.
async function drawProjectStrip(p) {
  const box = $('#pact');
  const note = S.notes.find(n => n.path === p);
  if (!note || note.type !== 'project') { box.hidden = true; return; }
  const data = await activityData().catch(() => null);
  if (!data || !S.open || S.open.path !== p) return;
  const series = data.series[p] || {};
  const today = dayKey(new Date()), first = addDays(today, -181);
  const counts = {}; let tok = 0, sess = 0, cost = 0;
  for (const [k, v] of Object.entries(series)) { if (k >= first) { counts[k] = v[0]; tok += v[0]; cost += v[1]; sess += v[2]; } }
  box.hidden = false;
  const closed = store.get('aiodize-pact') === '1';
  box.classList.toggle('collapsed', closed);
  box.innerHTML = `<button class="h" type="button" aria-expanded="${!closed}"><span><b>Claude work, 6 months</b></span><span>${Math.round(sess)} session${Math.round(sess) === 1 ? '' : 's'} · ${fmtTok(tok)} tokens · $${cost.toFixed(2)}</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="pbody2"></div>`;
  box.querySelector('.h').onclick = () => { const c = !box.classList.contains('collapsed'); box.classList.toggle('collapsed', c); box.querySelector('.h').setAttribute('aria-expanded', !c); store.set('aiodize-pact', c ? '1' : '0'); };
  const inner = box.querySelector('.pbody2');
  if (!tok) { inner.innerHTML = '<p class="empty">No Claude sessions touched this project\'s folder yet. Add its folder to the note\'s "folder:" line to track it.</p>'; return; }
  inner.append(heatmap2d(counts, first, today, { tip, fmt: n => fmtTok(n) + ' tokens', onPick: k => { A.scope = p; A.day = k; if (S.solo) return; go('activity'); } }));
}
function drawHistory(h) {
  const el = $('#phist');
  if (!h || !h.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<h3>Changes</h3>' + h.map(e => `<div class="hrow"><span>${avatar(e.who)} ${esc(e.who === 'you' ? 'You' : e.who)} ${esc(ACTION[e.action] || e.action)} · ${ago(e.ts)}</span>${e.action !== 'revert' ? `<button class="btn" type="button" data-id="${e.id}">Revert</button>` : ''}</div>`).join('');
  el.querySelectorAll('button').forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Confirm revert'; b.classList.add('warn'); return; }
    try { await api(q('/api/revert'), { method: 'POST', body: JSON.stringify({ id: b.dataset.id }) }); toast('Reverted'); } catch (e) { toast(e.message); }
  });
}
function startEdit() { S.editing = true; $('#ptext').value = S.open.text; $('#pedit').hidden = false; $('#pbody').hidden = true; $('#ptext').focus(); }
$('#pcancel').onclick = () => { stopMic(); S.editing = false; $('#pedit').hidden = true; $('#pbody').hidden = false; };
$('#psave').onclick = async () => {
  stopMic();
  try { await api(q('/api/note', '&path=' + encodeURIComponent(S.open.path)), { method: 'PUT', body: JSON.stringify({ text: $('#ptext').value }) }); toast('Saved'); S.editing = false; openNote(S.open.path); }
  catch (e) { toast('Not saved: ' + e.message); }
};
function closePanel() { if (S.solo) return window.close(); $('#panel').hidden = true; S.open = null; graph.select(null); }
$('#pclose').onclick = closePanel;
$('#pwin').onclick = () => S.open && openWindow(S.open.path);

// Resizable note panel: drag its left edge (or focus it and use the arrow keys). Width is remembered.
function setPanelWidth(px) {
  const w = Math.round(Math.max(340, Math.min(window.innerWidth * 0.8, px)));
  $('#panel').style.width = w + 'px'; store.set('aiodize-pw', w); graph.resize();
}
{ const w = +store.get('aiodize-pw'); if (w) $('#panel').style.width = Math.min(w, window.innerWidth * 0.8) + 'px'; }
$('#presize').onpointerdown = e => {
  e.preventDefault(); try { $('#presize').setPointerCapture(e.pointerId); } catch {} document.body.classList.add('resizing');
  const move = ev => setPanelWidth(window.innerWidth - ev.clientX);
  const up = () => { $('#presize').removeEventListener('pointermove', move); document.body.classList.remove('resizing'); };
  $('#presize').addEventListener('pointermove', move); $('#presize').addEventListener('pointerup', up, { once: true });
};
$('#presize').onkeydown = e => { const w = $('#panel').getBoundingClientRect().width; if (e.key === 'ArrowLeft') setPanelWidth(w + 32); if (e.key === 'ArrowRight') setPanelWidth(w - 32); };

// ---------- Mission Control ----------
async function loadPicks() {
  const picks = await api(q('/api/picknext')).catch(() => []);
  const hosts = new Map(graph.all.nodes.filter(n => n.icon).map(n => [n.id, n.host]));
  $('#picks').innerHTML = picks.length ? picks.map((p, i) => `<button class="pick" type="button" data-p="${esc(p.path)}"><span class="t">${hosts.get(p.path) ? `<img src="${iconSrc(hosts.get(p.path))}" alt="">` : `<span class="mono">${esc(p.title[0])}</span>`}${esc(p.title)}<span class="n">#${i + 1}</span></span><ul>${p.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul></button>`).join('')
    : '<p class="empty">No open projects. Give a project a status that counts as open work (Settings, Project statuses).</p>';
  $('#picks').querySelectorAll('.pick').forEach(b => b.onclick = () => openPreferred(b.dataset.p));
}
$('#digestBtn').onclick = async () => {
  try { const r = await api(q('/api/digest'), { method: 'POST' }); $('#digestMsg').textContent = 'Saved ' + r.path; openNote(r.path); }
  catch (e) { $('#digestMsg').textContent = e.message; }
};

async function loadMission() {
  loadPicks(); drawProposal();
  const [r, act] = await Promise.all([api(q('/api/runs')), api(q('/api/activity'))]);
  const today = new Date().toDateString();
  const st = r.indexing;
  $('#mcIndex').textContent = st.running ? `Reading Claude session logs… ${st.done} of ${st.total}` : `${r.totalSessions} Claude sessions matched to this workspace` + (r.unassigned ? ` · ${r.unassigned} couldn't be matched` : '');
  $('#kpis').innerHTML = [[r.week.sessions, 'sessions, last 7 days'], [fmtTok(r.week.tokens), 'tokens, last 7 days'], ['$' + r.week.cost.toFixed(2), 'API-price estimate, 7 days'],
    [act.filter(e => new Date(e.ts).toDateString() === today).length, 'note changes today']].map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('');
  const items = act.slice(0, 40).map(e => ({ ts: e.ts, html: `${avatar(e.who)}<span class="t"><b>${esc(e.who === 'you' ? 'You' : e.who)}</b> ${esc(ACTION[e.action] || e.action)} ${e.path ? '<b>' + esc(titleOf(e.path)) + '</b>' : ''}${e.summary ? ': ' + esc(e.summary) : ''}<span class="meta">${e.model ? esc(e.model) + ' · ' : ''}${e.tokens ? fmtTok(e.tokens) + ' tok (reported) · ' : ''}${ago(e.ts)}</span></span>`, path: e.path }))
    .concat(r.sessions.slice(0, 30).map(s => ({ ts: s.last, html: `${avatar('claude')}<span class="t"><b>Claude Code</b> ${esc(s.title || 'Untitled session')}<span class="meta">${esc(s.model.replace(/^claude-/, ''))} · ${fmtTok(s.tokens)} tok · $${s.cost.toFixed(2)}${s.folders.length ? ' · ' + esc(s.folders.join(', ')) : ''}${Object.keys(s.skills).length ? ' · skills: ' + esc(Object.keys(s.skills).join(', ')) : ''} · ${ago(s.last)}</span></span>` })))
    .sort((a, b) => b.ts - a.ts).slice(0, 40);
  $('#feed').innerHTML = items.length ? items.map((it, i) => it.path ? `<button class="ev" type="button" data-p="${esc(it.path)}">${it.html}</button>` : `<div class="ev">${it.html}</div>`).join('') : '<p class="empty">Nothing yet. Connect an agent from the Rules page, or edit a note.</p>';
  $('#feed').querySelectorAll('button.ev').forEach(b => b.onclick = () => openNote(b.dataset.p));
  const bars = (obj, color, fmt) => { const e = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 7); const max = e[0] ? e[0][1] : 1;
    return e.length ? `<div class="bars">${e.map(([k, v]) => `<div class="bar"><span title="${esc(k)}">${esc(k)}</span><span class="tr"><i style="width:${Math.max(3, v / max * 100)}%;background:${color}"></i></span><span class="v">${fmt(v)}</span></div>`).join('')}</div>` : '<p class="empty">None yet.</p>'; };
  $('#models').innerHTML = bars(Object.fromEntries(Object.entries(r.byModel).map(([m, v]) => [m.replace(/^claude-/, ''), v[0]])), 'var(--claude)', fmtTok);
  $('#skills').innerHTML = bars(r.skills, 'var(--accent)', v => v + '×');
  $('#connectors').innerHTML = bars(Object.fromEntries(Object.entries(r.tools).map(([k, v]) => [k.replace(/^claude_ai_|^plugin_\w+?_/, ''), v])), 'var(--gemini)', v => v + '×');
  drawBoard();
}

// ---------- kanban: columns by status (drag or Alt+arrows to move) or by category ----------
function drawBoard() {
  const B = S.board.board, byStatus = B.groupBy === 'status', f = new Set(B.fields);
  const projects = S.notes.filter(n => n.type === 'project');
  const sorter = { updated: (a, b) => (b.updated || '').localeCompare(a.updated || ''), title: (a, b) => a.title.localeCompare(b.title),
    deadline: (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.title.localeCompare(b.title) }[B.sort];
  const card = p => { const meta = [f.has('category') && !(B.groupBy === 'category') ? esc(p.category) : '', f.has('updated') && p.updated ? esc(p.updated) : '',
      f.has('deadline') && p.deadline ? 'due ' + esc(p.deadline) : '', f.has('site') && p.host ? esc(p.host) : ''].filter(Boolean).join(' · ');
    return `<button class="pc" type="button" data-p="${esc(p.path)}" ${byStatus ? 'draggable="true"' : ''}>${noteIcon(p)}<span class="t">${esc(p.title)}${meta ? `<small>${meta}</small>` : ''}</span>${byStatus ? '' : statusIcon(p.status, true)}</button>`; };
  const col = (key, head, list) => `<div class="colm" data-col="${esc(key)}"><h3>${head} <span class="cnt">${list.length}</span></h3><div class="cards">${list.sort(sorter).map(card).join('') || '<p class="empty">None</p>'}</div></div>`;
  let cols;
  if (byStatus) {
    cols = ST.list.filter(s => !B.hidden.includes(s.id)).map(s => col(s.id, statusIcon(s.id) + esc(s.label), projects.filter(p => p.status === s.id)));
    const other = projects.filter(p => !ST.by[p.status]);
    if (B.showOther && other.length) cols.push(col('', 'No status', other));
  } else {
    const cats = [...new Set(projects.map(p => p.category))].sort();
    cols = cats.map(c => col(c, `<i class="dotc" style="background:${graph.catColor(c)}"></i>${esc(c)}`, projects.filter(p => p.category === c)));
  }
  const keep = document.activeElement?.closest?.('#board .pc')?.dataset.p || S.boardFocus; S.boardFocus = null;
  $('#board').innerHTML = cols.join('') || '<p class="empty">No projects yet.</p>';
  $('#board').style.setProperty('--cols', cols.length);
  $('#boardHint').textContent = byStatus ? 'Drag a card to another column to change its status, or focus it and press Alt + ← / →.' : '';
  document.querySelectorAll('#boardGroup button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.g === B.groupBy)));
  $('#boardSort').value = B.sort;
  $('#board').querySelectorAll('.pc').forEach(b => {
    b.onclick = () => openPreferred(b.dataset.p);
    if (!byStatus) return;
    b.ondragstart = e => { e.dataTransfer.setData('text/plain', b.dataset.p); e.dataTransfer.effectAllowed = 'move'; b.classList.add('dragging'); };
    b.ondragend = () => b.classList.remove('dragging');
    b.onkeydown = e => {
      if (!e.altKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const keys = [...$('#board').querySelectorAll('.colm')].map(c => c.dataset.col).filter(Boolean), cur = keys.indexOf(b.closest('.colm').dataset.col);
      const to = keys[cur + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (to) moveCard(b.dataset.p, to, true);
    };
  });
  if (keep) [...$('#board').querySelectorAll('.pc')].find(x => x.dataset.p === keep)?.focus(); // redraws (live refresh) keep your place
  if (byStatus) $('#board').querySelectorAll('.colm[data-col]:not([data-col=""])').forEach(c => {
    c.ondragover = e => { e.preventDefault(); c.classList.add('over'); };
    c.ondragleave = e => { if (!c.contains(e.relatedTarget)) c.classList.remove('over'); };
    c.ondrop = e => { e.preventDefault(); c.classList.remove('over'); moveCard(e.dataTransfer.getData('text/plain'), c.dataset.col); };
  });
}
async function moveCard(path, status, refocus) {
  const n = S.notes.find(x => x.path === path); if (!n || n.status === status) return;
  const was = n.status; n.status = status; if (refocus) S.boardFocus = path; drawBoard();
  try { await api(q('/api/setstatus'), { method: 'POST', body: JSON.stringify({ path, status }) }); toast(`${n.title} → ${ST.label(status)}`); }
  catch (e) { n.status = was; drawBoard(); toast(e.message); }
}
function saveBoardView(patch) {
  Object.assign(S.board.board, patch); drawBoard();
  api(q('/api/board'), { method: 'PUT', body: JSON.stringify(S.board) }).then(v => { S.board = v; }).catch(e => toast(e.message));
}
document.querySelectorAll('#boardGroup button').forEach(b => b.onclick = () => saveBoardView({ groupBy: b.dataset.g }));
$('#boardSort').onchange = e => saveBoardView({ sort: e.target.value });
function applyBoard(b) {
  S.board = b; ST.set(b.statuses);
  $('#stPrev').innerHTML = b.statuses.map(s => `<span class="chip">${statusIcon(s.id)}${esc(s.label)}</span>`).join('');
  legend();
  if (S.view === 'mission') drawBoard();
}

// ---------- statuses + board dialog ----------
const bd = $('#boardDlg'); let draft = null;
const FIELD_LABEL = { category: 'Category', updated: 'Last worked', site: 'Site', deadline: 'Deadline' };
function openBoardDlg() {
  draft = JSON.parse(JSON.stringify(S.board)); $('#bMsg').textContent = '';
  drawStRows(); bd.showModal();
}
function drawStRows() {
  const opt = (obj, v) => Object.entries(obj).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  const colors = Object.fromEntries(Object.keys(COLOR_VAR).map(k => [k, k[0].toUpperCase() + k.slice(1)]));
  $('#stRows').innerHTML = draft.statuses.map((s, i) => { const shown = !draft.board.hidden.includes(s.id);
    return `<div class="strow" data-i="${i}">
      <div class="stmove"><button type="button" class="iconbtn sm" data-act="up" aria-label="Move ${esc(s.label)} up" ${i ? '' : 'disabled'}>↑</button><button type="button" class="iconbtn sm" data-act="down" aria-label="Move ${esc(s.label)} down" ${i < draft.statuses.length - 1 ? '' : 'disabled'}>↓</button></div>
      <span class="stico">${statusIcon('', false, s)}</span>
      <label class="sr" for="st-l-${i}">Name</label><input id="st-l-${i}" data-k="label" value="${esc(s.label)}" placeholder="Status name" maxlength="30">
      <label class="sr" for="st-c-${i}">Colour</label><select id="st-c-${i}" data-k="color">${opt(colors, s.color)}</select>
      <label class="sr" for="st-s-${i}">Shape</label><select id="st-s-${i}" data-k="shape">${opt(SHAPES, s.shape)}</select>
      <label class="sr" for="st-g-${i}">Counts as</label><select id="st-g-${i}" data-k="stage" title="Open work shows in Pick next and gets stale warnings; parked is dimmed">${opt(STAGES, s.stage)}</select>
      <button type="button" class="iconbtn sm" data-act="eye" aria-pressed="${shown}" aria-label="${shown ? 'Hide' : 'Show'} ${esc(s.label)} on the board" title="${shown ? 'Shown' : 'Hidden'} on the board">${shown ? '◉' : '○'}</button>
      <button type="button" class="iconbtn sm" data-act="del" aria-label="Delete ${esc(s.label)}" ${draft.statuses.length > 1 ? '' : 'disabled'}><svg aria-hidden="true"><use href="#i-close"/></svg></button>
    </div>`; }).join('');
  $('#bFields').innerHTML = Object.entries(FIELD_LABEL).map(([k, l]) => `<label class="chk2"><input type="checkbox" data-f="${k}" ${draft.board.fields.includes(k) ? 'checked' : ''}> ${l}</label>`).join('');
  $('#bOther').checked = draft.board.showOther;
  $('#bNew').innerHTML = draft.statuses.map(s => `<option value="${esc(s.id || '')}" ${s.id === draft.board.newStatus ? 'selected' : ''}>${esc(s.label || 'New status')}</option>`).join('');
}
$('#stRows').addEventListener('input', e => { const r = e.target.closest('.strow'), k = e.target.dataset.k; if (!r || !k) return;
  const s = draft.statuses[+r.dataset.i]; s[k] = e.target.value;
  if (k !== 'label') r.querySelector('.stico').innerHTML = statusIcon('', false, s); });
$('#stRows').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (!b) return;
  const i = +b.closest('.strow').dataset.i, L = draft.statuses, s = L[i];
  if (b.dataset.act === 'up') [L[i - 1], L[i]] = [L[i], L[i - 1]];
  if (b.dataset.act === 'down') [L[i + 1], L[i]] = [L[i], L[i + 1]];
  if (b.dataset.act === 'del') L.splice(i, 1);
  if (b.dataset.act === 'eye') { const h = draft.board.hidden; s.id && (h.includes(s.id) ? h.splice(h.indexOf(s.id), 1) : h.push(s.id)); }
  drawStRows();
  const again = $(`#stRows .strow[data-i="${b.dataset.act === 'up' ? i - 1 : b.dataset.act === 'down' ? i + 1 : Math.min(i, L.length - 1)}"] [data-act="${b.dataset.act === 'del' ? 'del' : b.dataset.act}"]`);
  (again && !again.disabled ? again : $('#stAdd')).focus();
});
$('#stAdd').onclick = () => { draft.statuses.push({ label: '', color: 'teal', shape: 'ring', stage: 'active' }); drawStRows(); $('#stRows .strow:last-child input').focus(); };
$('#stReset').onclick = () => { draft.statuses = JSON.parse(JSON.stringify(DEFAULT_STATUSES)); draft.board.hidden = []; drawStRows(); };
$('#bFields').onchange = e => { const k = e.target.dataset.f; if (!k) return; const F = draft.board.fields; e.target.checked ? F.push(k) : F.splice(F.indexOf(k), 1); };
$('#bOther').onchange = e => { draft.board.showOther = e.target.checked; };
$('#bNew').onchange = e => { draft.board.newStatus = e.target.value; };
$('#boardForm').onsubmit = async e => {
  if (!e.submitter || e.submitter.value !== 'save') return;
  e.preventDefault();
  try { applyBoard(await api(q('/api/board'), { method: 'PUT', body: JSON.stringify(draft) })); bd.close(); toast('Statuses saved'); refreshView(); }
  catch (err) { $('#bMsg').textContent = err.message; }
};
$('#boardEdit').onclick = openBoardDlg;
$('#boardEdit2').onclick = openBoardDlg;

// ---------- Activity: 2D/3D map, token bubbles, day detail ----------
const tip = makeTip();
const A = Object.assign({ scope: '_all', metric: 0, mode: '2d', range: 90 }, (() => { try { return JSON.parse(store.get('aiodize-act')) || {}; } catch { return {}; } })(),
  { day: null, data: null, dataWs: null, chart: null, bub: null });
const syncSeg = () => {
  for (const [sel, key, v] of [['#actMetric', 'm', A.metric], ['#actMode', 'mode', A.mode], ['#actRange', 'r', A.range]])
    document.querySelectorAll(sel + ' button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset[key]) === String(v)));
};
syncSeg();
const METRIC = { 0: ['tokens', n => fmtTok(n) + ' tokens'], 1: ['cost', n => '$' + n.toFixed(2)], 2: ['sessions', n => `${Math.round(n)} session${Math.round(n) === 1 ? '' : 's'}`], 3: ['edits', n => `${n} note edit${n === 1 ? '' : 's'}`], 4: ['commits', n => `${n} commit${n === 1 ? '' : 's'}`] };
async function activityData(force) {
  if (force || !A.data || A.dataWs !== S.ws) { A.data = await api(q('/api/activitymap')); A.dataWs = S.ws; }
  return A.data;
}
async function loadActivity(force) {
  const d = await activityData(force);
  const ranked = [...d.projects].sort((a, b) => b.total[0] - a.total[0]);
  const ws = S.workspaces.find(w => w.id === S.ws);
  $('#actScope').innerHTML = `<option value="_all">All of ${esc(ws.name)}</option>` + ranked.map(p => `<option value="${esc(p.path)}">${esc(p.title)}${p.total[0] ? '' : ' (no sessions)'}</option>`).join('') +
    (d.series._other ? '<option value="_other">Sessions with no project</option>' : '');
  if (![...$('#actScope').options].some(o => o.value === A.scope)) A.scope = '_all';
  $('#actScope').value = A.scope;
  renderActivity();
  if (A.day) pickDay(A.day);
}
function scopeName() { return A.scope === '_all' ? 'all of ' + S.workspaces.find(w => w.id === S.ws).name : A.scope === '_other' ? 'sessions with no project' : titleOf(A.scope); }
const RANGE_LABEL = { 7: 'last 7 days', 30: 'last 30 days', 90: 'last 90 days', 365: 'last year' };
// One period drives everything on this page: the map, the 3D skyline and the bubbles.
function renderActivity() {
  const d = A.data; if (!d) return;
  store.set('aiodize-act', JSON.stringify({ scope: A.scope, metric: A.metric, mode: A.mode, range: A.range }));
  const [mName, fmt] = METRIC[A.metric];
  const series = d.series[A.scope] || {};
  const today = dayKey(new Date()), first = addDays(today, -(A.range - 1));
  const counts = {};
  for (const [k, v] of Object.entries(series)) if (k >= first) counts[k] = v[A.metric] || 0;
  $('#actTitle').textContent = A.scope === '_all' ? 'Your work' : titleOf(A.scope);
  let total = 0, active = 0, best = null, streak = 0, run = 0;
  for (let k = first; k <= today; k = addDays(k, 1)) { const n = counts[k] || 0; total += n; if (n) { active++; run++; streak = Math.max(streak, run); if (!best || n > counts[best]) best = k; } else run = 0; }
  $('#actSummary').innerHTML = total ? `<b>${fmt(total)}</b> in the ${RANGE_LABEL[A.range]} on ${esc(scopeName())} · <b>${active}</b> active day${active === 1 ? '' : 's'} · longest streak <b>${streak}</b> · busiest <b>${longDate(best)}</b> (${fmt(counts[best])})`
    : `No ${mName} recorded for ${esc(scopeName())} in the ${RANGE_LABEL[A.range]}.`;
  if (A.chart && A.chart.stop) A.chart.stop();
  const opts = { tip, fmt, selected: A.day, onPick: pickDay };
  A.chart = A.mode === '3d' ? skyline(counts, first, today, opts) : heatmap2d(counts, first, today, opts);
  $('#actChart').replaceChildren(A.chart);
  $('#actHint').textContent = A.mode === '3d' ? 'Drag to turn · double-click to reset · arrow keys work too' : 'Arrow keys move between days';
  renderBubbles();
}
// Bubbles: projects for the whole workspace; inside one project, the files its tokens went into.
const EXT_VAR = { js: '--c1', ts: '--c1', jsx: '--c1', tsx: '--c1', php: '--c4', py: '--c3', css: '--c6', html: '--c2', md: '--c5', json: '--c8', sql: '--c7' };
let bubSeq = 0;
async function renderBubbles() {
  const seq = ++bubSeq, scope = A.scope;
  const items = await api(q('/api/bubbles', `&scope=${encodeURIComponent(scope)}&days=${A.range}`)).catch(() => []);
  if (seq !== bubSeq) return; // a newer request replaced this one
  const files = scope !== '_all';
  $('#bubBack').hidden = !files;
  $('#bubTitle').textContent = files ? `Where ${scope === '_other' ? 'unassigned' : titleOf(scope)} tokens went, by file` : 'Where the tokens went';
  if (A.bub && A.bub.stop) A.bub.stop();
  const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const colorOf = b => b.kind === 'file' ? cssVar(EXT_VAR[(b.path || '').split('.').pop().toLowerCase()] || '--muted') : b.key === '_other' ? cssVar('--muted') : graph.catColor(b.category);
  if (!items.length) { $('#bubbleBox').innerHTML = `<p class="empty">${files ? 'No file-level token use for this project in this period. Sessions only count files they read or edited inside the project\'s folders.' : 'No token use in this period.'}</p>`; A.bub = null; }
  else {
    A.bub = bubbles(items, { tip, fmt: n => fmtTok(n) + ' tokens', iconSrc, colorOf, onPick: b => {
      if (b.kind === 'project') { A.scope = b.key; $('#actScope').value = b.key; renderActivity(); if (b.key !== '_other') openNote(b.key); }
      else if (b.path) location.href = 'vscode://file/' + (S.ravi + '/' + b.path).replace(/\\/g, '/');
    } });
    $('#bubbleBox').replaceChildren(A.bub);
  }
  const max = items[0] ? items[0].value : 1, total = items.reduce((s, i) => s + i.value, 0) || 1;
  $('#projRank').innerHTML = items.slice(0, 12).map(i => `<button class="rk" type="button" data-k="${esc(i.key)}" data-kind="${i.kind}" title="${esc(i.path || i.title)}">${i.host ? `<img src="${iconSrc(i.host)}" alt="">` : `<span class="ph" style="background:${esc(colorOf(i))}"></span>`}<span class="t">${esc(i.kind === 'file' && i.path ? i.path.split('/').slice(-2).join('/') : i.title)}</span><span class="tr"><i style="width:${Math.max(2, i.value / max * 100)}%;background:${esc(colorOf(i))}"></i></span><span class="v">${Math.round(i.value / total * 100)}%</span></button>`).join('');
  $('#projRank').querySelectorAll('.rk').forEach(b => b.onclick = () => {
    const it = items.find(x => x.key === b.dataset.k);
    if (it.kind === 'project') { A.scope = it.key; $('#actScope').value = A.scope; renderActivity(); }
    else if (it.path) location.href = 'vscode://file/' + (S.ravi + '/' + it.path).replace(/\\/g, '/');
  });
}
$('#bubIn').onclick = () => A.bub && A.bub.zoom(1.5);
$('#bubOut').onclick = () => A.bub && A.bub.zoom(1 / 1.5);
$('#bubBack').onclick = () => { A.scope = '_all'; $('#actScope').value = '_all'; A.day = null; renderActivity(); };
async function pickDay(k) {
  A.day = k;
  if (A.chart && !A.chart.stop) $('#actChart').querySelectorAll('.hc').forEach(r => r.classList.toggle('sel', r.dataset.k === k));
  $('#dayTitle').textContent = `${longDate(k)}${A.scope === '_all' ? '' : ' · ' + scopeName()}`;
  const list = await api(q('/api/day', `&day=${k}${A.scope.startsWith('_') ? '' : '&project=' + encodeURIComponent(A.scope)}`));
  $('#dayList').innerHTML = list.length ? list.map(s => `<div class="dsess"><b>${esc(s.title)}</b><span class="meta">${esc((s.model || '').replace(/^claude-/, ''))} · ${fmtTok(s.tokens)} tokens that day · $${s.cost.toFixed(2)}</span>${s.projects.length ? `<div class="chips">${s.projects.map(p => `<button type="button" data-p="${esc(p.path)}">${esc(p.title)}</button>`).join('')}</div>` : ''}</div>`).join('')
    : '<p class="empty">No Claude sessions on this day.</p>';
  $('#dayList').querySelectorAll('.chips button').forEach(b => b.onclick = () => openNote(b.dataset.p));
}
$('#actScope').onchange = e => { A.scope = e.target.value; A.day = null; $('#dayTitle').textContent = 'Pick a day on the map'; $('#dayList').innerHTML = '<p class="empty">Click any square to see the sessions from that day.</p>'; renderActivity(); };
const segPick = (sel, key, fn) => document.querySelectorAll(sel + ' button').forEach(b => b.onclick = () => { document.querySelectorAll(sel + ' button').forEach(x => x.setAttribute('aria-pressed', x === b)); fn(b.dataset[key]); });
segPick('#actMetric', 'm', v => { A.metric = +v; renderActivity(); });
segPick('#actMode', 'mode', v => { A.mode = v; renderActivity(); });
segPick('#actRange', 'r', v => { A.range = +v; renderActivity(); });

// ---------- notes list ----------
function drawNotes() {
  const f = $('#nfilter').value.toLowerCase();
  const groups = {};
  for (const n of S.notes) if (!f || n.title.toLowerCase().includes(f) || n.path.toLowerCase().includes(f)) (groups[n.category] = groups[n.category] || []).push(n);
  const isOpen = g => f || store.get('aiodize-ng-' + S.ws + '-' + g) !== '0';
  $('#notelist').innerHTML = Object.keys(groups).sort().map(g => `<details class="ngroup" data-g="${esc(g)}"${isOpen(g) ? ' open' : ''}><summary><span class="dotc" style="background:${graph.catColor(g)}"></span>${esc(g)} <span class="cnt">${groups[g].length}</span></summary>${groups[g].sort((a, b) => (b.type === 'project') - (a.type === 'project') || a.title.localeCompare(b.title)).map(n =>
    `<button class="nrow" type="button" data-p="${esc(n.path)}">${noteIcon(n)}<span class="t">${esc(n.title)}</span><span class="s">${n.status ? statusIcon(n.status, true) : ''}</span></button>`).join('')}</details>`).join('') || '<p class="empty">No notes match.</p>';
  $('#notelist').querySelectorAll('details').forEach(d => d.ontoggle = () => { if (!f) store.set('aiodize-ng-' + S.ws + '-' + d.dataset.g, d.open ? '1' : '0'); });
  $('#notelist').querySelectorAll('.nrow').forEach(b => b.onclick = () => openPreferred(b.dataset.p));
}
$('#nfilter').oninput = drawNotes;

// ---------- rules ----------
function drawPlan(r) {
  $('#rulesBlock').textContent = r.block;
  $('#denyList').innerHTML = r.deny.length ? r.deny.map(d => `<li>${esc(d)}</li>`).join('') : '<li class="muted">Nothing blocked.</li>';
  $('#plan').innerHTML = r.plan.length ? r.plan.map(p => `<div class="planrow"><b>${esc(p.folder)}</b>${p.error ? `<span class="err">${esc(p.error)}</span>` :
    `<span class="muted">CLAUDE.md: ${p.claudeMd === 'create' ? 'will be created' : p.claudeMd === 'update' ? 'managed section updated' : 'section added at the end (your text stays)'} · settings: ${p.add.length ? p.add.length + ' blocks added' : 'up to date'}${p.remove.length ? ', ' + p.remove.length + ' removed' : ''}</span>`}</div>`).join('') : '<p class="empty">No linked folders. Add folder names to "apply_to" in workspaces.json.</p>';
}
async function loadRules() {
  const r = await api(q('/api/rules'));
  if (document.activeElement !== $('#rulesText')) $('#rulesText').value = r.text;
  drawPlan(r);
  api('/api/mcp').then(list => { const m = list.find(x => x.id === S.ws); if (m) $('#mcpCmd').textContent = m.cmd; }).catch(() => {});
  const b = $('#rulesApply'); b.dataset.armed = ''; b.textContent = 'Apply to linked folders'; b.classList.remove('warn'); $('#applyMsg').textContent = '';
}
$('#rulesSave').onclick = async () => { try { drawPlan(await api(q('/api/rules'), { method: 'PUT', body: JSON.stringify({ text: $('#rulesText').value }) })); $('#rulesMsg').textContent = 'Saved. Agents get the new rules on their next connection.'; } catch (e) { $('#rulesMsg').textContent = e.message; } };
$('#rulesApply').onclick = async () => {
  const b = $('#rulesApply');
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Confirm: write to these folders'; b.classList.add('warn'); $('#applyMsg').textContent = 'This edits CLAUDE.md and .claude/settings.json in each folder listed above.'; return; }
  try { const r = await api(q('/api/rules/apply'), { method: 'POST' }); drawPlan(r); $('#applyMsg').textContent = `Applied to ${r.plan.filter(p => !p.error).length} folders.`; }
  catch (e) { $('#applyMsg').textContent = e.message; }
  b.dataset.armed = ''; b.textContent = 'Apply to linked folders'; b.classList.remove('warn');
};
$('#copyCmd').onclick = () => navigator.clipboard.writeText($('#mcpCmd').textContent).then(() => toast('Copied'), () => { const r = document.createRange(); r.selectNodeContents($('#mcpCmd')); getSelection().removeAllRanges(); getSelection().addRange(r); });

// ---------- live updates ----------
const es = new EventSource('/api/events?t=' + TOKEN);
// After a server restart the old token is refused: reload once the server is back, so the page picks up a fresh one.
es.onerror = () => setTimeout(async () => {
  const r = await fetch('/api/state', { headers: { 'X-Aiodize-Token': TOKEN } }).catch(() => null);
  if (r && r.status === 401) location.reload();
}, 1500);
es.addEventListener('graph', async e => {
  const d = JSON.parse(e.data); if (d.ws !== S.ws) return;
  const [g, notes] = await Promise.all([api(q('/api/graph')), api(q('/api/notes'))]);
  S.notes = notes; graph.setData(g, { keep: true }); feedViews(false);
  if (d.path) setTimeout(() => graph.pulse(d.path, agentColor('you')), 60);
  if (S.open && S.open.path === d.path && !S.editing) openNote(d.path);
  if (S.view === 'mission') loadMission(); if (S.view === 'notes') drawNotes();
});
es.addEventListener('activity', e => {
  const d = JSON.parse(e.data); if (d.ws !== S.ws || !d.entry) return;
  if (d.entry.path) graph.pulse(d.entry.path, agentColor(d.entry.who));
  if (d.entry.who !== 'you') toast(`${d.entry.who} ${ACTION[d.entry.action] || d.entry.action} ${d.entry.path ? titleOf(d.entry.path) : ''}`);
  if (S.view === 'mission') loadMission();
});
es.addEventListener('runs', () => { A.data = null; feedViews(false); if (S.view === 'mission') loadMission(); if (S.view === 'activity') loadActivity(true); });
es.addEventListener('favicon', e => { const { host } = JSON.parse(e.data); graph.reloadIcon(host); });
let rpT; es.addEventListener('runs-progress', e => { const st = JSON.parse(e.data); if (S.view === 'mission' && st.running) { clearTimeout(rpT); rpT = setTimeout(() => $('#mcIndex').textContent = `Reading Claude session logs… ${st.done} of ${st.total}`, 50); } });

// ---------- quick capture (Alt+N or the New idea button) ----------
const cap = $('#capture');
// Dictation into any textarea, at the cursor. Uses the browser's speech service (Chrome/Edge send audio to their cloud).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recBtn = null;
let amb = null;
function ambient(ta, btn) {
  ta.classList.add('listening'); btn.insertAdjacentHTML('afterbegin', '<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>');
  amb = { ta, btn, stop: false };
  const a = amb;
  navigator.mediaDevices?.getUserMedia({ audio: true }).then(stream => {
    if (a.stop) return stream.getTracks().forEach(t => t.stop());
    const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 256; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount); a.stream = stream; a.ctx = ctx;
    let lvl = 0;
    const tick = () => { if (a.stop) return; an.getByteFrequencyData(buf); let s = 0; for (const v of buf) s += v; lvl = lvl * 0.7 + Math.min(1, s / buf.length / 70) * 0.3;
      ta.style.setProperty('--lvl', lvl.toFixed(3)); btn.style.setProperty('--lvl', lvl.toFixed(3)); requestAnimationFrame(tick); };
    tick();
  }).catch(() => {}); // no level: the CSS breathing animation still runs
}
function stopAmbient() {
  if (!amb) return; amb.stop = true; amb.stream?.getTracks().forEach(t => t.stop()); amb.ctx?.close();
  amb.ta.classList.remove('listening'); amb.ta.style.removeProperty('--lvl'); amb.btn.querySelector('.eq')?.remove(); amb = null;
}
function stopMic() {
  stopAmbient();
  if (rec) { rec.onend = null; try { rec.stop(); } catch {} rec = null; }
  if (recBtn) { recBtn.setAttribute('aria-pressed', 'false'); recBtn.querySelector('span').textContent = 'Speak'; recBtn = null; }
}
function dictate(ta, btn, note, onVoice) {
  if (rec) { const same = recBtn === btn; stopMic(); if (same) return; }
  rec = new SR(); rec.lang = 'en-IN'; rec.continuous = true; rec.interimResults = true; recBtn = btn;
  const at = ta.selectionStart ?? ta.value.length, before = ta.value.slice(0, at), after = ta.value.slice(ta.selectionEnd ?? at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  rec.onresult = e => {
    let t = ''; for (const r of e.results) t += r[0].transcript;
    ta.value = before + lead + t + after; const pos = (before + lead + t).length; ta.setSelectionRange(pos, pos);
    if (onVoice) onVoice();
  };
  rec.onerror = e => { note.textContent = e.error === 'not-allowed' ? 'Microphone blocked. Allow it in the browser to dictate.' : 'Dictation stopped: ' + e.error; stopMic(); };
  rec.onend = () => stopMic();
  rec.start(); ambient(ta, btn); btn.setAttribute('aria-pressed', 'true'); btn.querySelector('span').textContent = 'Stop';
  note.textContent = "Listening. Your browser's speech service turns it into text.";
}
for (const id of ['#capMic', '#pmic']) $(id).hidden = !SR;

// ---------- quick capture (Alt+N or the New idea button) ----------
function openCapture() {
  $('#capProj').innerHTML = '<option value="">No project</option>' + S.notes.filter(n => n.type === 'project').sort((a, b) => a.title.localeCompare(b.title)).map(n => `<option value="${esc(n.path)}">${esc(n.title)}</option>`).join('');
  if (S.open && S.notes.some(n => n.path === S.open.path && n.type === 'project')) $('#capProj').value = S.open.path;
  $('#capText').value = ''; cap.dataset.source = 'typed';
  cap.showModal(); $('#capText').focus();
}
function newMenu(open) { $('#newMenu').hidden = !open; $('#newBtn').setAttribute('aria-expanded', String(open)); if (open) $('#newMenu button').focus(); }
$('#newBtn').onclick = () => newMenu($('#newMenu').hidden);
document.addEventListener('pointerdown', e => { if (!$('#newMenu').hidden && !e.target.closest('.newpick')) newMenu(false); });
$('#newMenu').onkeydown = e => {
  const items = [...$('#newMenu').querySelectorAll('button')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Escape') { newMenu(false); $('#newBtn').focus(); }
};
document.querySelectorAll('[data-new]').forEach(b => b.onclick = () => { newMenu(false); b.dataset.new === 'idea' ? openCapture() : openNew(b.dataset.new); });
// New note / project: a small form, then the note opens ready to write in
const nd = $('#newDlg');
function openNew(kind) {
  nd.classList.toggle('project', kind === 'project'); nd.dataset.kind = kind;
  $('#newTitle').textContent = kind === 'project' ? 'New project' : 'New note';
  const cats = [...new Set(S.notes.filter(n => kind !== 'project' || n.type === 'project').map(n => n.category))].sort();
  $('#nCats').innerHTML = cats.map(c => `<option value="${esc(c)}"></option>`).join('');
  for (const id of ['#nTitle', '#nCat', '#nUrl', '#nFolder', '#nSum']) $(id).value = '';
  $('#nStatus').innerHTML = ST.list.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  $('#nStatus').value = S.board.board.newStatus; $('#nMsg').textContent = '';
  nd.showModal(); $('#nTitle').focus();
}
$('#newForm').onsubmit = async e => {
  if (!e.submitter || e.submitter.value !== 'save') return;
  e.preventDefault();
  try {
    const r = await api(q('/api/create'), { method: 'POST', body: JSON.stringify({ kind: nd.dataset.kind, title: $('#nTitle').value, category: $('#nCat').value, status: $('#nStatus').value, url: $('#nUrl').value, folder: $('#nFolder').value, summary: $('#nSum').value }) });
    nd.close(); toast('Created ' + r.path);
    setTimeout(async () => { S.notes = await api(q('/api/notes')); await openNote(r.path); startEdit(); }, 350);
  } catch (err) { $('#nMsg').textContent = err.message; }
};
$('#capMic').onclick = () => dictate($('#capText'), $('#capMic'), $('#capNote'), () => { cap.dataset.source = 'voice'; });
$('#pmic').onclick = () => dictate($('#ptext'), $('#pmic'), $('#pmicNote'));
$('#capText').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#capSave').click(); } };
$('#capForm').onsubmit = async e => {
  const save = e.submitter && e.submitter.value === 'save';
  stopMic();
  if (!save) return;
  e.preventDefault();
  try {
    const r = await api(q('/api/capture'), { method: 'POST', body: JSON.stringify({ text: $('#capText').value, project: $('#capProj').value, source: cap.dataset.source }) });
    cap.close(); toast('Saved to ' + r.path);
  } catch (err) { $('#capNote').textContent = err.message; }
};
cap.addEventListener('close', stopMic);

// ---------- collapsible sidebar: the button collapses it, the logo expands it (remembered per browser) ----------
function setRail(mini, keep = true) {
  $('#app').classList.toggle('mini', mini);
  $('#logoBtn').setAttribute('aria-label', mini ? 'Expand sidebar' : 'Aiodize, go to the graph');
  $('#logoBtn').title = mini ? 'Expand sidebar' : '';
  if (keep) store.set('aiodize-rail', mini ? '1' : '0');
  if (mini) wsMenu(false);
  setTimeout(() => graph.resize(), 220);
}
// small windows start with the slim sidebar (unless you expand it)
const narrow = matchMedia('(max-width:1000px)');
narrow.addEventListener('change', e => setRail(e.matches || store.get('aiodize-rail') === '1', false));
document.addEventListener('pointerdown', e => { const p = $('#pactions'); if (p.classList.contains('open') && !e.target.closest('#pactions')) { p.classList.remove('open'); $('#pMoreBtn')?.setAttribute('aria-expanded', 'false'); } });
$('#railBtn').onclick = () => { setRail(true); $('#logoBtn').focus(); };
$('#logoBtn').onclick = () => $('#app').classList.contains('mini') ? setRail(false) : go('graph');
document.querySelectorAll('.nav a, a.navlike').forEach(a => { if (!a.title) a.title = a.textContent.trim(); });
setRail(store.get('aiodize-rail') === '1' || narrow.matches, false);
const CHEV = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
document.querySelectorAll('.view:not(#v-settings) .card').forEach((card, i) => { // settings cards stay open
  const h = card.querySelector('h2.ch'); if (!h) return;
  let head = h.parentElement;
  if (head === card) { head = document.createElement('div'); head.className = 'cardhead'; card.insertBefore(head, h); head.append(h); }
  const id = 'aiodize-card-' + (card.closest('.view') || {}).id + '-' + i;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'ctoggle'; b.innerHTML = CHEV;
  const set = c => { card.classList.toggle('collapsed', c); b.setAttribute('aria-expanded', !c); b.setAttribute('aria-label', (c ? 'Expand ' : 'Collapse ') + h.textContent); store.set(id, c ? '1' : '0'); };
  b.onclick = () => { set(!card.classList.contains('collapsed')); if (S.view === 'activity' && !card.classList.contains('collapsed')) renderActivity(); };
  head.append(b); set(store.get(id) === '1');
});

// ---------- settings ----------
$('#openSel').value = store.get('aiodize-open') || 'panel';
$('#openSel').onchange = e => { store.set('aiodize-open', e.target.value); toast('Notes will open in ' + e.target.selectedOptions[0].textContent); };
$('#startWs').onchange = e => store.set('aiodize-startws', e.target.value);
const COLORS = ['marigold', 'rose', 'teal', 'blue', 'green', 'violet'];
let wsDraft = [];
// settings sections: one tab at a time, remembered; arrow keys move between tabs
function setTab(t) {
  const tabs = [...document.querySelectorAll('#setTabs [role="tab"]')];
  if (!tabs.some(b => b.dataset.tab === t)) t = 'look';
  for (const b of tabs) { const on = b.dataset.tab === t; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; $('#sp-' + b.dataset.tab).hidden = !on; }
  $('#setTitle').textContent = t === 'about' ? 'About & guide' : tabs.find(b => b.dataset.tab === t).textContent;
  store.set('aiodize-settab', t);
}
$('#setTabs').onclick = e => { const b = e.target.closest('[role="tab"]'); if (b) setTab(b.dataset.tab); };
$('#setTabs').onkeydown = e => {
  const tabs = [...document.querySelectorAll('#setTabs [role="tab"]')], i = tabs.indexOf(document.activeElement);
  const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]; let j = d ? (i + d + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  if (j < 0) return; e.preventDefault(); setTab(tabs[j].dataset.tab); tabs[j].focus();
};
setTab(store.get('aiodize-settab') || 'look');
async function loadSettings() {
  $('#aboutData').textContent = 'Your vaults: ' + S.workspaces.map(w => `${w.name} in ${w.vault}`).join(' · ') + '.';
  api('/api/state').then(st => { if (st.version) $('#aboutVer').textContent = `Version ${st.version} · local preview`; }).catch(() => {});
  $('#startWs').innerHTML = '<option value="">The one I used last</option>' + S.workspaces.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  $('#startWs').value = store.get('aiodize-startws') || '';
  const [mcp, cfg] = await Promise.all([api('/api/mcp'), api('/api/workspaces')]);
  $('#mcpList').innerHTML = mcp.map(m => `<div class="mcprow">
    <div class="mh">${wsIcon(S.workspaces.find(w => w.id === m.id) || m)}<b>${esc(m.name)}</b><code>${esc(m.server)}</code>
      <span class="pill ${m.added ? 'ok' : ''}">${m.added ? 'Added to Claude Code' : 'Not added'}</span></div>
    <p class="muted small">${m.seen ? `Last connection: ${esc(m.seen.client)}, ${ago(m.seen.ts)}` : 'No agent has connected yet.'}</p>
    <div class="row0">${m.added ? '' : `<button class="btn" type="button" data-add="${m.id}">Add to Claude Code</button>`}<button class="btn" type="button" data-copy="${esc(m.cmd)}">Copy command</button><span class="muted small" role="status"></span></div></div>`).join('');
  $('#mcpList').querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied'), () => toast(b.dataset.copy)));
  $('#mcpList').querySelectorAll('[data-add]').forEach(b => b.onclick = async () => {
    const msg = b.parentElement.querySelector('[role=status]');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Confirm: run claude mcp add'; b.classList.add('warn'); msg.textContent = 'Adds this server to your user-level Claude Code settings.'; return; }
    b.disabled = true; msg.textContent = 'Adding…';
    try { const r = await api('/api/mcp/add', { method: 'POST', body: JSON.stringify({ ws: b.dataset.add }) }); toast(r.text || 'Added'); loadSettings(); }
    catch (e) { msg.textContent = e.message; b.disabled = false; }
  });
  wsDraft = cfg.workspaces.map(w => Object.assign({}, w));
  drawWsForms();
}
function drawWsForms() {
  const list = arr => (arr || []).join(', ');
  $('#wsForms').innerHTML = wsDraft.map((w, i) => `<fieldset class="wsform"><legend>${esc(w.name || 'New workspace')}</legend>
    <div class="fgrid">
      <div class="field"><label for="wf-id-${i}">Id</label><input id="wf-id-${i}" data-k="id" data-i="${i}" value="${esc(w.id)}" ${w._new ? '' : 'readonly'} spellcheck="false"></div>
      <div class="field"><label for="wf-name-${i}">Name</label><input id="wf-name-${i}" data-k="name" data-i="${i}" value="${esc(w.name)}"></div>
      <div class="field"><label for="wf-color-${i}">Colour</label><select id="wf-color-${i}" data-k="color" data-i="${i}">${COLORS.map(c => `<option ${c === w.color ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field wide"><span class="flabel" id="wf-icl-${i}">Icon</span><div class="iconpick" role="radiogroup" aria-labelledby="wf-icl-${i}">${WS_ICONS.map(ic => `<button type="button" role="radio" aria-checked="${(w.icon || 'dot') === ic}" data-icon="${ic}" data-i="${i}" title="${ic}">${wsIcon({ ...w, icon: ic })}</button>`).join('')}</div></div>
      <div class="field wide"><label for="wf-vault-${i}">Vault folder (full path; leave empty for a new one inside Aiodize)</label><input id="wf-vault-${i}" data-k="vault" data-i="${i}" value="${esc(w.vault)}" spellcheck="false"></div>
      <div class="field wide"><label for="wf-folders-${i}">Project folders that belong here (* wildcards)</label><input id="wf-folders-${i}" data-k="folders" data-i="${i}" value="${esc(list(w.folders))}" spellcheck="false"></div>
      <div class="field wide"><label for="wf-tools-${i}">Connectors that belong here</label><input id="wf-tools-${i}" data-k="tools" data-i="${i}" value="${esc(list(w.tools))}" spellcheck="false"></div>
      <div class="field wide"><label for="wf-apply-${i}">Folders that get this workspace's rules</label><input id="wf-apply-${i}" data-k="apply_to" data-i="${i}" value="${esc(list(w.apply_to))}" spellcheck="false"></div>
      <label class="chk2"><input type="checkbox" data-k="fallback" data-i="${i}" ${w.fallback ? 'checked' : ''}> Collect sessions from folders that match no workspace</label>
    </div></fieldset>`).join('') + '<div class="row"><button class="btn pri" id="wsSave" type="button">Save workspaces</button></div>';
  $('#wsForms').querySelectorAll('[data-k]').forEach(el => el.oninput = el.onchange = () => {
    const w = wsDraft[+el.dataset.i], k = el.dataset.k;
    w[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'fallback' && el.checked) wsDraft.forEach((x, j) => { if (j !== +el.dataset.i) x.fallback = false; });
  });
  $('#wsForms').querySelectorAll('[data-icon]').forEach(b => b.onclick = () => { wsDraft[+b.dataset.i].icon = b.dataset.icon; drawWsForms(); });
  $('#wsSave').onclick = async () => {
    try {
      const r = await api('/api/workspaces', { method: 'PUT', body: JSON.stringify({ workspaces: wsDraft.map(({ _new, ...w }) => w) }) });
      $('#wsMsg').textContent = `Saved ${r.workspaces.length} workspaces.`;
      await reloadWorkspaces(); loadSettings();
    } catch (e) { $('#wsMsg').textContent = e.message; }
  };
}
$('#wsAdd').onclick = () => { wsDraft.push({ _new: true, id: '', name: '', color: 'teal', vault: '', folders: [], tools: [], apply_to: [] }); drawWsForms(); $('#wsForms fieldset:last-of-type input').focus(); };
async function reloadWorkspaces() {
  const st = await api('/api/state'); S.workspaces = st.workspaces; drawWs();
  if (!S.workspaces.some(w => w.id === S.ws)) return switchWs(S.workspaces[0].id);
  const w = S.workspaces.find(x => x.id === S.ws); // renamed: keep page titles in step
  for (const el of ['#mcWs', '#rulesWs']) $(el).textContent = w.name; $('#notesTitle').textContent = `${w.name} notes`;
}
es.addEventListener('workspaces', () => reloadWorkspaces());

// ---------- keys ----------
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) { const w = S.workspaces[+e.key - 1]; if (w) { e.preventDefault(); switchWs(w.id); } return; }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); go('settings'); return; }
  if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); if (!cap.open) openCapture(); return; }
  if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); if (!nd.open) openNew('note'); return; }
  if (e.altKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); if (!nd.open) openNew('project'); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); go('graph'); gs.focus(); }
  if (e.key === '?' && !typing && !ob.open) { e.preventDefault(); go('guide'); }
  if (e.key === 'Escape' && !typing && !$('#panel').hidden) closePanel();
});

// ---------- boot ----------
(async () => {
  const st = await api('/api/state');
  S.workspaces = st.workspaces; S.ravi = st.ravi;
  const params = new URLSearchParams(location.search);
  if (params.get('solo')) { // a note opened in its own window: just the note, full size
    S.solo = true; document.body.classList.add('solo');
    const id = params.get('ws'), p = params.get('note');
    S.ws = S.workspaces.some(w => w.id === id) ? id : S.workspaces[0].id;
    S.notes = await api(q('/api/notes')); applyBoard(await api(q('/api/board')));
    await openNote(p);
    document.title = (S.open && (S.open.props.title || p.split('/').pop().replace(/\.md$/, ''))) + ' · Aiodize';
    $('#pclose').setAttribute('aria-label', 'Close window');
    return;
  }
  api('/api/setup').then(s => { if (!s.done) openOnboarding(); }).catch(() => {}); // first run
  const pick = store.get('aiodize-startws') || store.get('aiodize-ws');
  show(location.hash.slice(1) || 'graph');
  setGView(gview);
  await switchWs(S.workspaces.some(w => w.id === pick) ? pick : S.workspaces[0].id);
})().catch(e => toast('Could not load: ' + e.message));


// ---------- onboarding: five short cards, which are also the agreement; then the AI takes over ----------
const OB = { step: 0, data: null, choice: { apps: new Set(), backup: { on: true, dir: '' }, vault: '', projectsRoot: '' }, result: null };
const ob = $('#onboard');
const OB_STEPS = ['Your brain for AI', 'On your device', 'Backed up', 'Moves with you', 'Ready'];
async function openOnboarding() {
  OB.data = await api('/api/setup'); OB.step = 0; OB.result = null;
  OB.choice.apps = new Set(OB.data.apps.filter(a => a.found).map(a => a.id)); // connecting again only adds what's missing
  OB.choice.backup = { on: true, dir: OB.data.backup.dir };
  OB.choice.vault = OB.data.vaults[0] || ''; OB.choice.projectsRoot = OB.data.projectsRoot;
  drawOb(); if (!ob.open) ob.showModal();
}
function obCard() {
  const d = OB.data, c = OB.choice, single = d.vaults.length === 1;
  const vaultOpts = [...new Set([...d.vaults, ...d.obsidian])];
  switch (OB.step) {
    case 0: return `<div class="obhero"><img src="brand/aiodize-mark.svg" width="120" height="120" alt=""></div>
      <h2 id="obTitle">Your brain for AI</h2>
      <p class="oblede">Your notes, projects and ideas in one graph. Your AI reads it before it works and updates it after, so nothing you think or build gets lost between chats.</p>
      <ul class="obpts"><li>See what every AI did on each project: sessions, tokens, models.</li><li>Rules per workspace, so an agent only touches what it should.</li><li>Plain Markdown files. Works with Obsidian.</li></ul>`;
    case 1: return `<h2 id="obTitle">On your device</h2>
      <p class="oblede">Everything stays on this computer. No account, no cloud, no tracking.</p>
      <ul class="obpts"><li><b>What leaves it:</b> only requests for your projects' own website icons.</li><li>Your AI apps talk to Aiodize locally on this computer.</li></ul>
      <div class="field"><label for="obVault">Your notes folder</label>${single ? `<select id="obVault">${vaultOpts.map(v => `<option ${v === c.vault ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>` : `<p class="muted small">${S.workspaces.map(w => esc(w.name)).join(', ')} workspaces are set up. Change their folders in Settings, Workspaces.</p>`}</div>
      <div class="field"><label for="obRoot">Where your projects live</label><input id="obRoot" value="${esc(c.projectsRoot)}" spellcheck="false"><p class="muted small">Aiodize matches your AI's work to projects by these folders.</p></div>`;
    case 2: return `<h2 id="obTitle">Backed up</h2>
      <p class="oblede">A copy of your notes, rules and work history every day, to a folder you choose. Plain files you can open without Aiodize.</p>
      <label class="obtoggle"><input type="checkbox" id="obBk" ${c.backup.on ? 'checked' : ''}><span>Back up every day (keeps 14 days)</span></label>
      <div class="field"><label for="obBkDir">Backup folder</label><input id="obBkDir" value="${esc(c.backup.dir)}" spellcheck="false"><p class="muted small">Another drive, a USB stick or a synced folder like OneDrive is safest.</p></div>`;
    case 3: return `<h2 id="obTitle">Moves with you</h2>
      <p class="oblede">Connect the AI apps on this computer. Switch AI whenever you like: your notes, rules and history stay here and the next AI picks them up.</p>
      <div class="obapps">${d.apps.map(a => `<label class="obapp ${a.found ? '' : 'off'}"><input type="checkbox" data-app="${a.id}" ${!a.found ? 'disabled' : ''} ${c.apps.has(a.id) ? 'checked' : ''}><span><b>${esc(a.name)}</b><small>${a.connected ? 'Connected · adds what\'s missing' : a.found ? (a.hook ? 'Tool + instructions + session context' : a.instructions ? 'Tool + instructions' : 'Tool') : 'Not on this computer'}</small></span></label>`).join('')}</div>
      <p class="muted small">Each app gets Aiodize as a tool and a few lines: read your context before working, log what changed after. Files are backed up first and Settings, Agents undoes it. Chat-only AIs: export a context pack from Settings.</p>`;
    case 4: {
      const apps = d.apps.filter(a => c.apps.has(a.id)).map(a => a.name);
      return `<h2 id="obTitle">Ready</h2>
      <p class="oblede">Here is what happens when you agree:</p>
      <ul class="obsum">
        <li>Your notes: <b>${esc(single ? c.vault : S.workspaces.map(w => w.name).join(', '))}</b>; projects in <b>${esc(c.projectsRoot)}</b>.</li>
        <li>${c.backup.on ? `Daily backups to <b>${esc(c.backup.dir)}</b>, starting now.` : 'No backups (you can turn them on in Settings).'}</li>
        <li>${apps.length ? `Connect <b>${esc(apps.join(', '))}</b>, backing up each file it changes.` : 'No AI apps connected yet.'}</li>
        <li>Your AI then looks at your folders and proposes workspaces, rules and project notes. Nothing changes until you accept it.</li>
      </ul>
      <p class="muted small">You can undo any of this in Settings. Aiodize never sends your notes anywhere.</p>`;
    }
    case 5: {
      const r = OB.result, ok = r.connect.results.filter(x => x.ok), bad = r.connect.results.filter(x => !x.ok);
      const cc = d.apps.some(a => a.id === 'claude-code' && (a.connected || ok.some(x => x.id === 'claude-code')));
      return `<h2 id="obTitle">Now let your AI finish</h2>
      <ul class="obsum">${ok.map(x => `<li class="ok">Connected ${esc(d.apps.find(a => a.id === x.id).name)}</li>`).join('')}${bad.map(x => `<li class="bad">${esc(d.apps.find(a => a.id === x.id).name)}: ${esc(x.error)}</li>`).join('')}
        ${r.backup ? `<li class="${r.backup.startsWith('error') ? 'bad' : 'ok'}">${r.backup.startsWith('error') ? 'Backup ' + esc(r.backup) : 'First backup saved'}</li>` : ''}</ul>
      <p class="oblede">Ask your AI to set Aiodize up. It looks at your folders, asks what it needs, and sends a proposal you review in Mission Control.</p>
      <div class="obprompt"><code id="obPrompt">${esc(d.prompt)}</code></div>
      <div class="row">${cc ? '<button class="btn pri" type="button" id="obLaunch">Open Claude Code with this</button>' : ''}<button class="btn" type="button" id="obCopy">Copy the prompt</button></div>
      <p class="muted small" id="obWait">Restart any AI app that was open so it picks up Aiodize. Waiting for a proposal…</p>`;
    }
  }
}
function drawOb() {
  $('#obBody').innerHTML = obCard();
  $('#obDots').innerHTML = OB_STEPS.map((t, i) => `<li class="${i < OB.step ? 'done' : i === OB.step ? 'on' : ''}" aria-current="${i === OB.step ? 'step' : 'false'}"><span class="sr">${t}</span></li>`).join('');
  $('#obBack').hidden = OB.step === 0 || OB.step === 5;
  $('#obNext').textContent = OB.step === 4 ? 'Agree & let my AI set it up' : OB.step === 5 ? 'Done' : 'Next';
  $('#obMsg').textContent = OB.step < 5 ? `${OB.step + 1} of 5` : '';
  const c = OB.choice;
  $('#obVault') && ($('#obVault').onchange = e => c.vault = e.target.value);
  $('#obRoot') && ($('#obRoot').oninput = e => c.projectsRoot = e.target.value.trim());
  $('#obBk') && ($('#obBk').onchange = e => c.backup.on = e.target.checked);
  $('#obBkDir') && ($('#obBkDir').oninput = e => c.backup.dir = e.target.value.trim());
  $('#obBody').querySelectorAll('[data-app]').forEach(b => b.onchange = () => b.checked ? c.apps.add(b.dataset.app) : c.apps.delete(b.dataset.app));
  $('#obCopy') && ($('#obCopy').onclick = () => navigator.clipboard.writeText(OB.data.prompt).then(() => toast('Prompt copied'), () => toast('Select the prompt and copy it')));
  $('#obLaunch') && ($('#obLaunch').onclick = () => api('/api/launch', { method: 'POST' }).then(() => toast('Opening Claude Code…'), e => toast(e.message)));
  if (OB.step === 5) waitProposal();
  $('#obBody').querySelector('h2').focus?.();
}
let obPoll = null;
function waitProposal() {
  clearInterval(obPoll);
  obPoll = setInterval(async () => {
    if (!ob.open) return clearInterval(obPoll);
    const p = await api('/api/proposal').catch(() => ({}));
    if (p.ts) { clearInterval(obPoll); $('#obWait').innerHTML = `<b>${esc(p.from)} sent a proposal.</b> <button class="btn pri" type="button" id="obReview">Review it</button>`; $('#obReview').onclick = () => { ob.close(); go('mission'); }; }
  }, 4000);
}
$('#obBack').onclick = () => { OB.step = Math.max(0, OB.step - 1); drawOb(); };
$('#obNext').onclick = async () => {
  if (OB.step < 4) { OB.step++; return drawOb(); }
  if (OB.step === 5) { ob.close(); return; }
  const c = OB.choice; $('#obNext').disabled = true; $('#obMsg').textContent = 'Setting up…';
  try {
    OB.result = await api('/api/setup', { method: 'POST', body: JSON.stringify({ apps: [...c.apps], backup: c.backup, vault: c.vault, projectsRoot: c.projectsRoot }) });
    OB.data = await api('/api/setup'); OB.step = 5; drawOb();
    await reloadWorkspaces();
  } catch (e) { $('#obMsg').textContent = e.message; }
  finally { $('#obNext').disabled = false; }
};
$('#obLater').onclick = () => ob.close();
ob.addEventListener('cancel', e => { if (OB.step === 5) return; }); // Esc closes like Later
$('#rerunSetup').onclick = openOnboarding;

// ---------- Settings: AI apps, context pack, backups ----------
async function drawApps() {
  const list = await api('/api/apps');
  $('#appList').innerHTML = list.map(a => `<div class="approw ${a.found ? '' : 'off'}"><b>${esc(a.name)}</b>
    <span class="pill ${a.connected ? 'ok' : ''}">${a.connected ? 'Connected' : a.found ? 'Not connected' : 'Not on this computer'}</span>
    ${a.found ? `<button class="btn" type="button" data-op="${a.connected ? 'disconnect' : 'connect'}" data-app="${a.id}">${a.connected ? 'Disconnect' : 'Connect'}</button>` : ''}</div>`).join('');
  $('#appList').querySelectorAll('[data-op]').forEach(b => b.onclick = () => appsOp(b.dataset.op, [b.dataset.app]));
  $('#packWs').innerHTML = S.workspaces.map(w => `<option value="${w.id}" ${w.id === S.ws ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
}
async function appsOp(op, ids) {
  try {
    const r = await api('/api/apps', { method: 'POST', body: JSON.stringify({ op, ids }) });
    const bad = r.results.filter(x => !x.ok);
    $('#appsMsg').textContent = bad.length ? bad.map(x => x.error).join(' ') : `${op === 'connect' ? 'Connected' : 'Disconnected'}. Restart the app to pick it up.${r.backup ? ' Originals saved in ' + r.backup : ''}`;
  } catch (e) { $('#appsMsg').textContent = e.message; }
  drawApps();
}
$('#appsOff').onclick = async () => { const list = await api('/api/apps'); appsOp('disconnect', list.filter(a => a.connected).map(a => a.id)); };
$('#packBtn').onclick = async () => {
  const id = $('#packWs').value, r = await fetch(`/api/contextpack?ws=${encodeURIComponent(id)}`, { headers: { 'X-Aiodize-Token': TOKEN } });
  if (!r.ok) return toast('Could not export');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([await r.text()], { type: 'text/markdown' }));
  a.download = `aiodize-${id}-context-${new Date().toISOString().slice(0, 10)}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Context pack saved to your downloads');
};
async function drawBackups() {
  const b = await api('/api/backups');
  $('#bkOn').checked = b.settings.on; $('#bkDir').value = b.settings.dir; $('#bkKeep').value = String(b.settings.keep || 14);
  $('#bkList').innerHTML = b.list.length ? b.list.map(s => `<div class="bkrow"><span>${s.created ? new Date(s.created).toLocaleString() : esc(s.name)}${s.beforeRestore ? ' <span class="pill">safety copy</span>' : ''}</span>
    <span class="row0">${s.workspaces.map(id => `<button class="btn" type="button" data-restore="${esc(s.name)}" data-ws="${esc(id)}">Restore ${esc((S.workspaces.find(w => w.id === id) || { name: id }).name)}</button>`).join('')}</span></div>`).join('')
    : '<p class="empty">No backups yet.</p>';
  $('#bkList').querySelectorAll('[data-restore]').forEach(btn => btn.onclick = () => {
    if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Click again to restore'; return; } // two clicks, no browser dialog
    api('/api/backups/restore', { method: 'POST', body: JSON.stringify({ name: btn.dataset.restore, ws: btn.dataset.ws }) })
      .then(r => { $('#bkMsg').textContent = `Restored. A safety copy of how things were is saved as ${r.safety}.`; drawBackups(); }, e => $('#bkMsg').textContent = e.message);
  });
}
$('#bkSave').onclick = () => api('/api/backups', { method: 'PUT', body: JSON.stringify({ on: $('#bkOn').checked, dir: $('#bkDir').value, keep: $('#bkKeep').value }) })
  .then(() => { $('#bkMsg').textContent = 'Saved.'; drawBackups(); }, e => $('#bkMsg').textContent = e.message);
$('#bkNow').onclick = () => { $('#bkMsg').textContent = 'Backing up…'; api('/api/backups/now', { method: 'POST' }).then(r => { $('#bkMsg').textContent = 'Saved ' + r.name; drawBackups(); }, e => $('#bkMsg').textContent = e.message); };
document.querySelector('#tab-agents').addEventListener('click', drawApps);
document.querySelector('#tab-backups').addEventListener('click', drawBackups);

// ---------- the AI's setup proposal, reviewed on Mission Control ----------
async function drawProposal() {
  const p = await api('/api/proposal').catch(() => ({})), el = $('#proposal');
  if (!p.ts) { el.hidden = true; return; }
  const sec = (key, title, items) => items.length ? `<label class="psec"><input type="checkbox" data-part="${key}" checked><span><b>${title}</b><small>${items.map(esc).join(' · ')}</small></span></label>` : '';
  el.innerHTML = `<div class="cardhead"><h2 class="ch">${esc(p.from)} proposes a setup</h2><span class="muted small">${ago(p.ts)}</span></div>
    ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
    ${sec('workspaces', 'Workspaces', p.workspaces.map(w => w.name || w.id))}
    ${sec('rules', 'Rules', Object.keys(p.rules).map(id => 'for ' + id))}
    ${sec('statuses', 'Project statuses', Object.entries(p.statuses).map(([id, l]) => `${id}: ${l.map(s => s.label).join(', ')}`))}
    ${sec('notes', 'Project notes', p.project_notes.map(n => n.title))}
    <div class="row"><button class="btn pri" type="button" id="prAccept">Accept selected</button><button class="btn" type="button" id="prDrop">Dismiss</button><span class="muted small" id="prMsg" role="status">Nothing changes until you accept. A backup is taken first when backups are on.</span></div>`;
  el.hidden = false;
  $('#prAccept').onclick = async () => {
    const parts = {}; el.querySelectorAll('[data-part]').forEach(c => parts[c.dataset.part] = c.checked);
    try { const r = await api('/api/proposal/accept', { method: 'POST', body: JSON.stringify({ parts }) }); toast('Applied: ' + (r.done.join(', ') || 'nothing')); await reloadWorkspaces(); el.hidden = true; refreshView(); }
    catch (e) { $('#prMsg').textContent = e.message; }
  };
  $('#prDrop').onclick = () => api('/api/proposal', { method: 'DELETE' }).then(() => { el.hidden = true; });
}

$('#extBtn').onclick = () => { $('#extMsg').textContent = 'Building…'; api('/api/extension', { method: 'POST' }).then(r => { $('#extMsg').textContent = `Ready: ${r.file}. Folder to pick in the extension settings: ${r.folder}`; }, e => $('#extMsg').textContent = e.message); };
