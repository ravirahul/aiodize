// Aiodize graph: force layout + Canvas renderer tuned for smoothness.
// ponytail: O(n²) repulsion is fine to ~2k nodes; switch to a quadtree (Barnes-Hut) past that.

import { ST } from './status.js';
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => 1 - Math.pow(1 - t, 3);
const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const initial = s => ((String(s).match(/[A-Za-z0-9]/) || ['•'])[0]).toUpperCase();
// Status as a small shape: filled = live, half = live partly, ring+dot = built not deployed, dashed = in progress, hollow = parked.
function badge(g, x, y, br, st, t) {
  const col = t.status[st] || t.muted;
  g.fillStyle = t.bg2; g.beginPath(); g.arc(x, y, br * 1.4, 0, 6.283); g.fill();
  g.fillStyle = g.strokeStyle = col; g.lineWidth = br * 0.45; g.beginPath();
  const sh = ST.shape(st);
  if (sh === 'full') { g.arc(x, y, br, 0, 6.283); g.fill(); }
  else if (sh === 'half') { g.arc(x, y, br * 0.8, 0, 6.283); g.stroke(); g.beginPath(); g.arc(x, y, br * 0.8, -1.571, 1.571); g.fill(); }
  else if (sh === 'dot') { g.arc(x, y, br * 0.8, 0, 6.283); g.stroke(); g.beginPath(); g.arc(x, y, br * 0.35, 0, 6.283); g.fill(); }
  else if (sh === 'dashed') { g.setLineDash([br * 0.55, br * 0.4]); g.arc(x, y, br * 0.8, 0, 6.283); g.stroke(); g.setLineDash([]); }
  else { g.arc(x, y, br * 0.8, 0, 6.283); g.stroke(); }
}
// Favicons come in every shape: trim transparent margins, then fit each into the same square.
function normalizeIcon(img) {
  const S = 64, a = document.createElement('canvas'); a.width = a.height = S;
  const g = a.getContext('2d'); const k = Math.min(S / img.naturalWidth, S / img.naturalHeight);
  g.drawImage(img, (S - img.naturalWidth * k) / 2, (S - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
  let x0 = S, y0 = S, x1 = -1, y1 = -1;
  try {
    const d = g.getImageData(0, 0, S, S).data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (d[(y * S + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  } catch { return a; }
  if (x1 < 0) return a;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, side = Math.max(w, h);
  const b = document.createElement('canvas'); b.width = b.height = S;
  b.getContext('2d').drawImage(a, x0, y0, w, h, (S - w * S / side) / 2, (S - h * S / side) / 2, w * S / side, h * S / side);
  return b;
}
const INDEX = new Set(['hub', 'digest']); // notes that list many others (Home, weekly digests)
const SIZE = { hub: 11, digest: 5.5, project: 8.5, external: 7, note: 5.5, infra: 5.5, idea: 5.5, inspiration: 3.5, tag: 3 };
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };

export class Graph {
  constructor(canvas, { onSelect, onHover, iconSrc } = {}) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.iconSrc = iconSrc; this.icons = new Map(); this.iconHosts = new Set(); this.lastDraw = 0;
    document.addEventListener('visibilitychange', () => this.wake());
    this.onSelect = onSelect || (() => {}); this.onHover = onHover || (() => {});
    this.opts = { colorBy: 'category', showTags: false, showInsp: true };
    this.all = { nodes: [], edges: [] };
    this.nodes = []; this.edges = []; this.byId = new Map();
    this.cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1, vx: 0, vy: 0 };
    this.alpha = 0; this.hover = null; this.selected = null; this.focusMix = 0;
    this.pulses = []; this.intro = null; this.running = false; this.sprites = new Map();
    this.stars = Array.from({ length: 140 }, (_, i) => ({ x: hash('x' + i), y: hash('y' + i), z: 0.15 + hash('z' + i) * 0.6, r: 0.4 + hash('r' + i) * 1.1 }));
    this.pointers = new Map();
    this.readTheme();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    new MutationObserver(() => this.refreshTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'data-statuses'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.refreshTheme());
    this.resize();
  }

  // ---------- theme ----------
  readTheme() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    this.t = { bg: v('--night'), bg2: v('--surface'), text: v('--text'), muted: v('--muted'), accent: v('--accent'), line: v('--line'),
      cats: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v('--c' + i)), insp: v('--gemini'), tag: v('--muted'),
      status: ST.colors(v),
      agents: { you: v('--you'), claude: v('--claude'), gpt: v('--gpt'), gemini: v('--gemini'), local: v('--local') } };
    const m = /^#?([0-9a-f]{6})$/i.exec(this.t.bg);
    const lum = m ? (parseInt(m[1].slice(0, 2), 16) * 0.3 + parseInt(m[1].slice(2, 4), 16) * 0.59 + parseInt(m[1].slice(4), 16) * 0.11) : 0;
    this.dark = lum < 128;
  }
  refreshTheme() { this.readTheme(); this.sprites.clear(); this.colorize(); this.wake(); }
  sprite(color) {
    let s = this.sprites.get(color);
    if (!s) {
      s = document.createElement('canvas'); s.width = s.height = 64;
      const g = s.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, color); gr.addColorStop(0.25, color + 'aa'); gr.addColorStop(1, color + '00');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); this.sprites.set(color, s);
    }
    return s;
  }
  catColor(cat) {
    if (!this.catIndex) this.catIndex = new Map();
    if (!this.catIndex.has(cat)) this.catIndex.set(cat, this.catIndex.size);
    return this.t.cats[this.catIndex.get(cat) % this.t.cats.length];
  }
  colorize() {
    for (const n of this.nodes) {
      n.color = n.type === 'hub' ? this.t.accent : n.type === 'tag' || n.type === 'external' ? this.t.tag : n.type === 'inspiration' ? this.t.insp
        : this.opts.colorBy === 'status' ? (this.t.status[n.status] || this.t.muted) : this.catColor(n.category);
    }
  }

  // ---------- data ----------
  setData(data, { keep = false } = {}) {
    this.all = data;
    for (const n of data.nodes) if (n.icon && n.host) this.iconHosts.add(n.host);
    this.rebuild(keep);
  }
  setOptions(o) { Object.assign(this.opts, o); if (Object.keys(o).every(k => k === 'colorBy' || k === 'labels')) { this.colorize(); this.wake(); } else this.rebuild(true); }
  isFit() { return !this.userMoved; }
  burst(ids) { ids.forEach((id, i) => setTimeout(() => this.pulse(id, this.t.accent), i * 60)); }
  rebuild(keep) {
    const old = this.byId;
    const show = n => (this.opts.showTags || n.type !== 'tag') && (this.opts.showInsp || n.type !== 'inspiration') && (this.opts.showExternal || n.type !== 'external');
    this.nodes = this.all.nodes.filter(show).map(n => Object.assign({}, n));
    this.byId = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.edges = this.all.edges.map(e => ({ s: this.byId.get(e.s), t: this.byId.get(e.t), kind: e.kind, bend: hash(e.s + e.t) > 0.5 ? 1 : -1 }))
      .filter(e => e.s !== undefined && e.t !== undefined);
    const deg = new Array(this.nodes.length).fill(0);
    for (const e of this.edges) { deg[e.s]++; deg[e.t]++; }
    this.adj = this.nodes.map(() => []);
    for (const e of this.edges) { this.adj[e.s].push(e.t); this.adj[e.t].push(e.s); }
    const cats = [...new Set(this.nodes.filter(n => n.type !== 'tag').map(n => n.category))];
    // Same category, same colour, every time: assign by sorted name for this workspace.
    if (!keep) this.catIndex = new Map([...new Set(this.all.nodes.map(n => n.category))].sort().map((c, i) => [c, i]));
    // Clusters sit on an ellipse shaped like the screen, so a wide window is filled edge to edge.
    this.asp = this.w && this.h ? Math.max(1, Math.min(2.4, this.w / this.h)) : 1.7;
    const R = 130 + Math.sqrt(this.nodes.length) * 36;
    this.centers = new Map(cats.map((c, i) => [c, { x: Math.cos(i / cats.length * 6.283 - 1.2) * R * this.asp * 1.1, y: Math.sin(i / cats.length * 6.283 - 1.2) * R * 0.85 }]));
    this.nodes.forEach((n, i) => {
      n.deg = deg[i];
      n.r = SIZE[n.type] || SIZE.note; // one size per kind, so size never hints at importance it doesn't have
      n.ph = hash(n.id) * 6.283;
      n.vx = n.vy = 0; n.a = 1; n.la = 0;
      const o = keep && old.has(n.id) ? this.prevNodes[old.get(n.id)] : null;
      if (o) { n.x = o.x; n.y = o.y; n.a = o.a; n.la = o.la; }
      else {
        const nb = this.adj[i].map(j => keep && old.has(this.nodes[j].id) ? this.prevNodes[old.get(this.nodes[j].id)] : null).find(Boolean);
        const c = nb || this.centers.get(n.category) || { x: 0, y: 0 };
        const ang = hash(n.id) * 6.283, d = 20 + hash(n.id + 'd') * 60;
        n.x = c.x + Math.cos(ang) * d; n.y = c.y + Math.sin(ang) * d;
        if (keep && this.prevNodes) { n.a = 0; n.spawn = performance.now(); }
      }
    });
    this.prevNodes = this.nodes;
    this.colorize();
    if (!keep && !this.w) this.layoutLater = true; // built while hidden: lay out again once it has a size
    if (!keep) {
      for (let i = 0, a = 1; i < 320; i++, a *= 0.986) this.tick(a); // settle before the first frame
      // A wide screen with a tall layout leaves empty sides: stretch x to match the screen's shape (up to 1.6x).
      if (this.w && this.h && this.nodes.length > 2) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const n of this.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
        const f = Math.min(1.6, (this.w / this.h) / ((x1 - x0) / Math.max(1, y1 - y0)));
        if (f > 1.05) { const cx = (x0 + x1) / 2; for (const n of this.nodes) n.x = cx + (n.x - cx) * f; for (const c of this.centers.values()) c.x = cx + (c.x - cx) * f; }
      }
      this.alpha = 0.04;
      this.fit(true);
      this.intro = reduce.matches ? null : { t0: performance.now(), d: 1300 };
    } else this.alpha = Math.max(this.alpha, 0.25);
    this.wake();
  }

  // ---------- simulation ----------
  tick(alpha) {
    const N = this.nodes, n = N.length;
    for (let i = 0; i < n; i++) {
      const a = N[i];
      for (let j = i + 1; j < n; j++) {
        const b = N[j]; let dx = b.x - a.x, dy = b.y - a.y; let d2 = dx * dx + dy * dy;
        if (d2 > 250000) continue;
        if (d2 < 0.01) { dx = hash(a.id + b.id) - 0.5; dy = 0.5 - hash(b.id + a.id); d2 = 0.5; }
        const d = Math.sqrt(d2), f = (900 + (a.r + b.r) * 40) * alpha / (d2 + 80);
        const fx = dx / d * f, fy = dy / d * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        const min = a.r + b.r + 6;
        if (d < min) { const p = (min - d) / d * 0.25; a.x -= dx * p; a.y -= dy * p; b.x += dx * p; b.y += dy * p; }
      }
    }
    for (const e of this.edges) {
      const a = N[e.s], b = N[e.t]; const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const hub = INDEX.has(a.type) || INDEX.has(b.type); // index notes link to everything; keep them from crushing clusters
      const L = (hub ? 170 : e.kind === 'tag' ? 70 : 46) + a.r + b.r, k = (d - L) / d * (hub ? 0.012 : 0.06) * alpha;
      a.vx += dx * k; a.vy += dy * k; b.vx -= dx * k; b.vy -= dy * k;
    }
    for (const a of N) {
      const c = this.centers.get(a.category);
      if (c && a.type !== 'tag' && !INDEX.has(a.type)) { a.vx += (c.x - a.x) * 0.06 * alpha; a.vy += (c.y - a.y) * 0.06 * alpha; }
      a.vx -= a.x * 0.0015 * alpha / ((this.asp || 1) ** 2); a.vy -= a.y * 0.0015 * alpha;
      if (a.fixed) { a.vx = a.vy = 0; continue; }
      a.vx *= 0.58; a.vy *= 0.58; a.x += a.vx; a.y += a.vy;
    }
  }

  // ---------- camera ----------
  resize() {
    const r = this.cv.getBoundingClientRect(); this.w = r.width; this.h = r.height; this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(this.w * this.dpr)); this.cv.height = Math.max(1, Math.round(this.h * this.dpr));
    if (this.layoutLater && this.w > 10 && this.all.nodes.length) { this.layoutLater = false; this.rebuild(false); }
    this.wake();
  }
  fit(instant) {
    this.userMoved = false;
    if (!this.nodes.length || !this.w) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
    const k = Math.max(0.2, Math.min(2.2, Math.min(this.w / (x1 - x0 + 70), this.h / (y1 - y0 + 90))));
    Object.assign(this.cam, { tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, tk: k });
    if (instant) Object.assign(this.cam, { x: this.cam.tx, y: this.cam.ty, k });
    this.wake();
  }
  focus(id) {
    this.userMoved = true;
    const i = this.byId.get(id); if (i === undefined) return;
    const n = this.nodes[i];
    Object.assign(this.cam, { tx: n.x, ty: n.y, tk: Math.max(this.cam.tk, 1.7) });
    this.selected = i; this.pulse(id, this.t.accent); this.wake();
  }
  select(id) { const i = this.byId.get(id); this.selected = i === undefined ? null : i; this.wake(); }
  toScreen(x, y) { return [(x - this.cam.x) * this.cam.k + this.w / 2, (y - this.cam.y) * this.cam.k + this.h / 2]; }
  toWorld(sx, sy) { return [(sx - this.w / 2) / this.cam.k + this.cam.x, (sy - this.h / 2) / this.cam.k + this.cam.y]; }
  hit(sx, sy) {
    const [x, y] = this.toWorld(sx, sy); let best = null, bd = Infinity;
    this.nodes.forEach((n, i) => { if (n.a < 0.1) return; const d = Math.hypot(n.x - x, n.y - y), lim = n.r + 7 / this.cam.k; if (d < lim && d < bd) { bd = d; best = i; } });
    return best;
  }

  // Project favicons: loaded once per host, drawn inside the node when it's big enough on screen.
  icon(host) {
    if (!host || !this.iconSrc || !this.iconHosts.has(host)) return null;
    let e = this.icons.get(host);
    if (!e) {
      e = { img: new Image(), ok: false };
      e.img.onload = () => { if (e.img.naturalWidth > 0) { e.norm = normalizeIcon(e.img); e.ok = true; } this.wake(); };
      e.img.onerror = () => { e.ok = false; };
      e.img.src = this.iconSrc(host);
      this.icons.set(host, e);
    }
    return e.ok ? e.norm : null;
  }
  // ---------- minimap hooks ----------
  bounds() {
    if (!this.nodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
    return { x0: x0 - 30, y0: y0 - 30, x1: x1 + 30, y1: y1 + 30 };
  }
  paintMini(g, map) {
    g.lineWidth = 0.5; g.strokeStyle = this.t.muted; g.globalAlpha = 0.25; g.beginPath();
    for (const e of this.edges) { const a = map(this.nodes[e.s].x, this.nodes[e.s].y), b = map(this.nodes[e.t].x, this.nodes[e.t].y); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    g.stroke();
    for (const n of this.nodes) { const [x, y] = map(n.x, n.y); g.globalAlpha = Math.max(0.15, n.a); g.fillStyle = n.color; g.fillRect(x - 1.2, y - 1.2, n.type === 'project' ? 2.6 : 1.8, n.type === 'project' ? 2.6 : 1.8); }
    g.globalAlpha = 1;
  }
  viewport() { const c = this.cam; return { x0: c.x - this.w / 2 / c.k, y0: c.y - this.h / 2 / c.k, x1: c.x + this.w / 2 / c.k, y1: c.y + this.h / 2 / c.k }; }
  goTo(x, y) { this.cam.tx = x; this.cam.ty = y; this.cam.vx = this.cam.vy = 0; this.wake(); }

  // Time-travel: show only what existed on `day` (YYYY-MM-DD), or everything when null.
  setTime(day) { this.time = day || null; this.wake(); }
  setMatch(set) { this.match = set; this.wake(); }
  births() { return this.nodes.map(n => n.born).filter(Boolean).sort(); }
  reloadIcon(host) { this.iconHosts.add(host); this.icons.delete(host); this.wake(); }

  pulse(id, color) {
    const i = this.byId.get(id); if (i === undefined) return;
    this.pulses.push({ i, color: color || this.t.agents.claude, t0: performance.now() });
    this.wake();
  }

  // ---------- input ----------
  bind() {
    const cv = this.cv;
    const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      this.pointers.set(e.pointerId, { sx, sy });
      if (this.pointers.size === 2) { this.drag = { pinch: true, d0: this.pinchDist(), k0: this.cam.tk }; return; }
      const i = this.hit(sx, sy);
      this.drag = { i, sx, sy, moved: 0, lx: sx, ly: sy, t: performance.now() };
      this.cam.vx = this.cam.vy = 0;
      if (i !== null) this.nodes[i].fixed = true;
    });
    cv.addEventListener('pointermove', e => {
      const [sx, sy] = pos(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { sx, sy });
      const d = this.drag;
      if (d && d.pinch && this.pointers.size === 2) { this.cam.tk = this.cam.k = Math.max(0.15, Math.min(5, d.k0 * this.pinchDist() / d.d0)); this.wake(); return; }
      if (d) {
        d.moved += Math.abs(sx - d.lx) + Math.abs(sy - d.ly);
        if (d.i !== null) { const [x, y] = this.toWorld(sx, sy); const n = this.nodes[d.i]; n.x = x; n.y = y; this.alpha = Math.max(this.alpha, 0.12); }
        else {
          const dx = (sx - d.lx) / this.cam.k, dy = (sy - d.ly) / this.cam.k;
          this.userMoved = true; this.cam.x -= dx; this.cam.y -= dy; this.cam.tx = this.cam.x; this.cam.ty = this.cam.y;
          this.cam.vx = -dx; this.cam.vy = -dy;
        }
        d.lx = sx; d.ly = sy; this.wake(); return;
      }
      const h = this.hit(sx, sy);
      if (h !== this.hover) { this.hover = h; cv.style.cursor = h === null ? 'grab' : 'pointer'; this.onHover(h === null ? null : this.nodes[h]); this.wake(); }
    });
    const up = e => {
      this.pointers.delete(e.pointerId);
      const d = this.drag; this.drag = null;
      if (!d || d.pinch) return;
      if (d.i !== null) this.nodes[d.i].fixed = false;
      if (d.moved < 5) { this.selected = d.i; this.onSelect(d.i === null ? null : this.nodes[d.i]); }
      if (reduce.matches) this.cam.vx = this.cam.vy = 0;
      this.wake();
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (this.hover !== null && !this.drag) { this.hover = null; this.onHover(null); this.wake(); } });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const [wx, wy] = [(sx - this.w / 2) / this.cam.tk + this.cam.tx, (sy - this.h / 2) / this.cam.tk + this.cam.ty];
      const k = Math.max(0.15, Math.min(5, this.cam.tk * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))));
      this.userMoved = true; this.cam.tk = k; this.cam.tx = wx - (sx - this.w / 2) / k; this.cam.ty = wy - (sy - this.h / 2) / k;
      this.wake();
    }, { passive: false });
    cv.addEventListener('dblclick', e => { const [sx, sy] = pos(e); const i = this.hit(sx, sy); if (i !== null) this.focus(this.nodes[i].id); else this.fit(); });
    cv.addEventListener('keydown', e => {
      const step = 60 / this.cam.tk, c = this.cam;
      const map = { ArrowLeft: () => c.tx -= step, ArrowRight: () => c.tx += step, ArrowUp: () => c.ty -= step, ArrowDown: () => c.ty += step,
        '+': () => c.tk = Math.min(5, c.tk * 1.25), '=': () => c.tk = Math.min(5, c.tk * 1.25), '-': () => c.tk = Math.max(0.15, c.tk / 1.25),
        '0': () => this.fit(), Escape: () => { this.selected = null; this.onSelect(null); } };
      if (map[e.key]) { e.preventDefault(); if (e.key !== '0' && e.key !== 'Escape') this.userMoved = true; map[e.key](); this.wake(); }
    });
  }
  pinchDist() { const p = [...this.pointers.values()]; return Math.hypot(p[0].sx - p[1].sx, p[0].sy - p[1].sy) || 1; }

  // ---------- render loop (sleeps when nothing moves) ----------
  wake() { if (!this.running) { this.running = true; requestAnimationFrame(t => this.frame(t)); } }
  frame(now) {
    let busy = false;
    if (this.alpha > 0.003) { this.tick(this.alpha); this.alpha *= 0.985; busy = true; }
    const c = this.cam, s = reduce.matches ? 1 : 0.16;
    if (!this.drag && (Math.abs(c.vx) + Math.abs(c.vy) > 0.02)) { c.x += c.vx; c.y += c.vy; c.tx = c.x; c.ty = c.y; c.vx *= 0.9; c.vy *= 0.9; busy = true; }
    for (const k of ['x', 'y', 'k']) { const tk = 't' + k; if (Math.abs(c[tk] - c[k]) > (k === 'k' ? 1e-4 : 0.02)) { c[k] = lerp(c[k], c[tk], s); busy = true; } else c[k] = c[tk]; }
    const fm = this.hover !== null || this.selected !== null ? 1 : 0;
    if (Math.abs(this.focusMix - fm) > 0.01) { this.focusMix = lerp(this.focusMix, fm, reduce.matches ? 1 : 0.14); busy = true; } else this.focusMix = fm;
    this.pulses = this.pulses.filter(p => now - p.t0 < 1500); if (this.pulses.length) busy = true;
    if (this.intro && now - this.intro.t0 > this.intro.d) this.intro = null;
    if (this.intro) busy = true;
    if (this.hover !== null && !reduce.matches) busy = true; // signal dots travel along lit links
    // Idle: nodes drift a little and stars twinkle, at ~30 fps; stops when hidden or reduced motion is on.
    const idle = this.idleOn();
    if (busy || !idle || now - this.lastDraw > 32) { if (this.draw(now)) busy = true; this.lastDraw = now; if (this.onFrame) this.onFrame(this); }
    if (busy || idle) requestAnimationFrame(t => this.frame(t)); else this.running = false;
  }
  idleOn() { return !reduce.matches && !document.hidden && this.cv.offsetParent !== null && this.nodes.length > 0; }

  draw(now) {
    const g = this.ctx, t = this.t, c = this.cam, W = this.w, H = this.h;
    let moving = false;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // backdrop: soft radial light + parallax stars
    const bg = g.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.75);
    bg.addColorStop(0, t.bg2); bg.addColorStop(1, t.bg);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = t.text;
    const live = this.idleOn();
    for (const st of this.stars) {
      const x = ((st.x * W - c.x * c.k * st.z * 0.08) % W + W) % W, y = ((st.y * H - c.y * c.k * st.z * 0.08) % H + H) % H;
      const tw = live ? 0.65 + 0.35 * Math.sin(now * 0.0011 + st.x * 47) : 1;
      g.globalAlpha = (this.dark ? 0.32 : 0.12) * st.z * tw; g.beginPath(); g.arc(x, y, st.r, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1;

    // intro: nodes bloom outward from their cluster centre
    const it = this.intro ? Math.min(1, (now - this.intro.t0) / this.intro.d) : 1;
    const N = this.nodes, sel = this.hover !== null ? this.hover : this.selected;
    const lit = new Set(); if (sel !== null) { lit.add(sel); for (const j of this.adj[sel] || []) lit.add(j); }
    const drift = live ? 2.2 : 0;
    const pos = N.map(n => {
      if (it >= 1) return drift && !n.fixed ? [n.x + Math.sin(now * 0.00035 + n.ph) * drift, n.y + Math.cos(now * 0.0003 + n.ph * 1.3) * drift] : [n.x, n.y];
      const cc = this.centers.get(n.category) || { x: 0, y: 0 }, delay = hash(n.id) * 0.45, p = ease(Math.max(0, Math.min(1, (it - delay) / (1 - delay))));
      return [lerp(cc.x, n.x, p), lerp(cc.y, n.y, p), p];
    });
    for (let i = 0; i < N.length; i++) {
      const n = N[i];
      let target = sel === null ? (ST.stage(n.status) === 'parked' ? 0.55 : 1) : lit.has(i) ? 1 : 0.14;
      if (n.spawn) { const p = Math.min(1, (now - n.spawn) / 900); target *= p; if (p >= 1) delete n.spawn; moving = true; }
      if (this.time && n.born && n.born > this.time) target = 0; // time-travel: not born yet
      else if (n.stale && sel === null && !this.time) target *= 0.42; // no work for 30+ days
      if (this.match && !this.match.has(n.id)) target *= 0.12; // live search
      if (Math.abs(n.a - target) > 0.01) { n.a = lerp(n.a, target, reduce.matches ? 1 : 0.15); moving = true; } else n.a = target;
    }

    g.save();
    g.translate(W / 2, H / 2); g.scale(c.k, c.k); g.translate(-c.x, -c.y);

    // edges: gently curved, coloured end to end
    const fm = this.focusMix;
    g.lineCap = 'round';
    for (let ei = 0; ei < this.edges.length; ei++) {
      const e = this.edges[ei], A = N[e.s], B = N[e.t], pa = pos[e.s], pb = pos[e.t];
      const on = sel !== null && (e.s === sel || e.t === sel);
      const base = e.kind === 'tag' ? 0.12 : this.dark ? 0.26 : 0.32;
      let al = lerp(base, on ? 0.9 : 0.035, fm) * Math.min(A.a, B.a) * (it < 1 ? Math.min(pa[2] ?? 1, pb[2] ?? 1) : 1);
      if (sel !== null && on) al = Math.max(al, 0.5 * fm);
      if (al < 0.01) continue;
      const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2, dx = pb[0] - pa[0], dy = pb[1] - pa[1];
      const cx = mx - dy * 0.12 * e.bend, cy = my + dx * 0.12 * e.bend;
      g.globalAlpha = al;
      if (this.edges.length < 2500) { const gr = g.createLinearGradient(pa[0], pa[1], pb[0], pb[1]); gr.addColorStop(0, A.color); gr.addColorStop(1, B.color); g.strokeStyle = gr; }
      else g.strokeStyle = t.line;
      g.lineWidth = (on ? 1.8 : 1) / c.k;
      g.beginPath(); g.moveTo(pa[0], pa[1]); g.quadraticCurveTo(cx, cy, pb[0], pb[1]); g.stroke();
      if (on && !reduce.matches) { // signal dots flowing out of the focused node
        const from = e.s === sel ? pa : pb, to = e.s === sel ? pb : pa;
        for (let q = 0; q < 2; q++) {
          const u = ((now * 0.00045 + ei * 0.137 + q * 0.5) % 1);
          const x = (1 - u) * (1 - u) * from[0] + 2 * (1 - u) * u * cx + u * u * to[0], y = (1 - u) * (1 - u) * from[1] + 2 * (1 - u) * u * cy + u * u * to[1];
          g.globalAlpha = fm * Math.sin(u * Math.PI);
          g.drawImage(this.sprite(e.s === sel ? B.color : A.color), x - 5 / c.k, y - 5 / c.k, 10 / c.k, 10 / c.k);
        }
      }
    }

    // glow pass
    g.globalCompositeOperation = this.dark ? 'lighter' : 'source-over';
    for (let i = 0; i < N.length; i++) {
      const n = N[i], p = pos[i], sc = p[2] ?? 1; if (n.a * sc < 0.02 || n.type === 'tag') continue;
      const R = n.r * 3 * sc;
      g.globalAlpha = n.a * (this.dark ? 0.26 : 0.1) * (i === sel ? 1.6 : 1);
      g.drawImage(this.sprite(n.color), p[0] - R, p[1] - R, R * 2, R * 2);
    }
    g.globalCompositeOperation = 'source-over';

    // cores: every project looks the same (disc, category ring, favicon or first letter, status badge).
    // Notes, tags and inspiration are plain dots. Faded ring = no work for 30+ days; soft halo = deadline within 90 days.
    for (let i = 0; i < N.length; i++) {
      const n = N[i], p = pos[i], sc = p[2] ?? 1, r = n.r * sc; if (n.a * sc < 0.02) continue;
      g.globalAlpha = n.a;
      if (n.type === 'project' || n.type === 'external') {
        const sr = r * c.k, ring = n.stale ? t.muted : n.color;
        if (n.daysLeft != null && n.daysLeft >= 0 && n.daysLeft <= 90) {
          const u = live ? 0.5 + 0.5 * Math.sin(now * 0.0025) : 1;
          g.strokeStyle = t.accent; g.globalAlpha = n.a * (0.3 + 0.4 * u); g.lineWidth = 1.6 / c.k;
          g.beginPath(); g.arc(p[0], p[1], r + (4 + 2 * u) / c.k, 0, 6.283); g.stroke(); g.globalAlpha = n.a;
        }
        g.fillStyle = t.bg2; g.beginPath(); g.arc(p[0], p[1], r, 0, 6.283); g.fill();
        g.lineWidth = Math.max(1.2 / c.k, r * 0.16); g.strokeStyle = ring;
        if (n.type === 'external') g.setLineDash([r * 0.45, r * 0.3]);
        g.beginPath(); g.arc(p[0], p[1], r, 0, 6.283); g.stroke(); g.setLineDash([]);
        if (sr >= 5) {
          const img = sr >= 7 ? this.icon(n.host) : null;
          if (img) { const s = r * 1.12; g.drawImage(img, p[0] - s / 2, p[1] - s / 2, s, s); }
          else { g.fillStyle = ring; g.font = `600 ${r * 0.95}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(initial(n.label), p[0], p[1] + r * 0.05); }
        }
        if (n.status && n.type === 'project') badge(g, p[0] + r * 0.74, p[1] + r * 0.74, r * 0.32, n.status, t);
      } else { g.fillStyle = n.color; g.beginPath(); g.arc(p[0], p[1], r, 0, 6.283); g.fill(); }
      if (i === this.selected) { g.globalAlpha = 1; g.strokeStyle = t.accent; g.lineWidth = 2 / c.k; g.beginPath(); g.arc(p[0], p[1], r + 5 / c.k, 0, 6.283); g.stroke(); }
    }
    // pulses: an agent touched this note
    for (const pu of this.pulses) {
      const n = N[pu.i]; if (!n) continue;
      const u = (now - pu.t0) / 1500, p = pos[pu.i];
      g.globalAlpha = reduce.matches ? 0.9 : (1 - u) * 0.9; g.strokeStyle = pu.color; g.lineWidth = 2.2 / c.k;
      g.beginPath(); g.arc(p[0], p[1], n.r + (reduce.matches ? 6 : ease(u) * 34) / c.k * Math.max(1, c.k * 0.6), 0, 6.283); g.stroke();
    }
    g.restore();
    g.globalAlpha = 1;

    // cluster names: visible when zoomed out, fade as you zoom in
    const ca = Math.max(0, Math.min(1, (1.05 - c.k) / 0.45)) * (1 - fm * 0.7) * it;
    if (ca > 0.02) {
      const sums = new Map();
      for (const n of N) { if (n.type === 'tag' || n.type === 'hub' || n.type === 'inspiration') continue; const s = sums.get(n.category) || [0, 0, 0, 0]; s[0] += n.x; s[1] += n.y; s[2]++; s[3] = Math.min(s[3] || Infinity, n.y - n.r); sums.set(n.category, s); }
      g.font = '600 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';

      for (const [cat, s] of sums) {
        if (s[2] < 2) continue;
        const [x, y] = this.toScreen(s[0] / s[2], s[3] - 26);
        g.globalAlpha = ca * 0.8; g.fillStyle = this.catColor(cat); g.fillText(cat, x, y);
      }

    }

    // labels: priority order, no overlaps, faded in and out
    const want = [];
    for (let i = 0; i < N.length; i++) {
      const n = N[i]; if (n.a < 0.2) continue;
      const near = lit.has(i) || (this.match && this.match.has(n.id)), sr = n.r * c.k;
      if (this.opts.labels === false && i !== sel && !(this.match && this.match.has(n.id))) continue; // names off: only the hovered or matching ones
      const show = near || i === this.selected || sr > 6.5 || (n.type === 'project' && c.k > 0.85) || n.type === 'hub';
      if (show) want.push({ i, pri: (i === sel ? 1e6 : near ? 1e5 : 0) + n.r * 10 + n.deg });
    }
    want.sort((a, b) => b.pri - a.pri);
    const boxes = [], shown = new Set();
    g.textAlign = 'left'; g.textBaseline = 'middle';
    for (const w of want) {
      const n = N[w.i], [x, y] = this.toScreen(pos[w.i][0], pos[w.i][1]);
      if (x < -150 || x > W + 50 || y < -20 || y > H + 20) continue;
      const big = w.i === sel;
      g.font = `${big ? 600 : 500} ${big ? 13.5 : 12}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
      const tw = g.measureText(n.label).width, bx = x + n.r * c.k + 6, box = [bx - 2, y - 9, bx + tw + 2, y + 9];
      if (boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      boxes.push(box); shown.add(w.i);
    }
    for (let i = 0; i < N.length; i++) {
      const n = N[i], target = shown.has(i) ? 1 : 0;
      if (Math.abs(n.la - target) > 0.02) { n.la = lerp(n.la, target, reduce.matches ? 1 : 0.2); moving = true; } else n.la = target;
      if (n.la < 0.02) continue;
      const [x, y] = this.toScreen(pos[i][0], pos[i][1]), big = i === sel;
      g.font = `${big ? 600 : 500} ${big ? 13.5 : 12}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
      const bx = x + n.r * c.k + 6;
      g.globalAlpha = n.la * Math.max(0.35, n.a) * it;
      g.lineWidth = 4; g.strokeStyle = t.bg; g.lineJoin = 'round'; g.strokeText(n.label, bx, y);
      g.fillStyle = lit.has(i) || n.type !== 'tag' ? t.text : t.muted; g.fillText(n.label, bx, y);
    }
    g.globalAlpha = 1;
    return moving;
  }
}
