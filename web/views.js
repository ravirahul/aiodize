// Extra graph views: Mind map, Sunburst, Solar system (2D, shared pan/zoom camera) and Globe (3D).
// Every view also feeds the minimap: bounds(), paintMini(), viewport(), goTo().
import { ST } from './status.js';
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const TAU = Math.PI * 2;
const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const fmtTok = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));

export function themeOf() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  const t = { bg: v('--night'), bg2: v('--surface'), raised: v('--raised'), line: v('--line'), text: v('--text'), muted: v('--muted'),
    accent: v('--accent'), onAccent: v('--on-accent'), holo: v('--c7'),
    status: ST.colors(v) };
  const m = /^#?([0-9a-f]{6})$/i.exec(t.bg);
  t.dark = !m || parseInt(m[1].slice(0, 2), 16) * 0.3 + parseInt(m[1].slice(2, 4), 16) * 0.59 + parseInt(m[1].slice(4), 16) * 0.11 < 128;
  return t;
}
const sprites = new Map();
function sprite(color) { // soft round glow, cached per colour (#rrggbb)
  let s = sprites.get(color);
  if (!s) {
    s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, color); gr.addColorStop(0.3, color + '88'); gr.addColorStop(1, color + '00');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites.set(color, s);
  }
  return s;
}
function text(g, t, s, x, y, { size = 12, weight = 500, color, align = 'left', halo = true, k = 1 } = {}) {
  g.font = `${weight} ${size / k}px ${FONT}`; g.textAlign = align; g.textBaseline = 'middle';
  if (halo) { g.lineWidth = 3.5 / k; g.strokeStyle = t.bg; g.lineJoin = 'round'; g.strokeText(s, x, y); }
  g.fillStyle = color || t.text; g.fillText(s, x, y);
}
const statusColor = (t, s) => t.status[s] || t.muted;

// ---------- shared 2D scene: canvas, camera, input, render loop ----------
class Scene {
  constructor(host, o) {
    this.o = o;
    const cv = this.cv = document.createElement('canvas');
    cv.className = 'viewcv'; cv.tabIndex = 0; cv.hidden = true; cv.setAttribute('aria-label', this.aria());
    host.prepend(cv); this.g = cv.getContext('2d');
    this.cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 };
    this.w = this.h = 0; this.dpr = 1; this.hover = null; this.running = false; this.data = null; this.fitted = false; this.lastDraw = 0;
    this.t = themeOf();
    new ResizeObserver(() => this.resize()).observe(cv);
    new MutationObserver(() => { this.t = themeOf(); this.wake(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'data-statuses'] });
    document.addEventListener('visibilitychange', () => this.wake());
    this.bind();
  }
  aria() { return 'Graph view'; }
  hint() { return ''; }
  canBack() { return false; }
  get active() { return !this.cv.hidden; }
  show(on) { this.cv.hidden = !on; if (on) { this.resize(); this.wake(); } }
  resize() {
    const r = this.cv.getBoundingClientRect(); this.w = r.width; this.h = r.height; this.dpr = devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(this.w * this.dpr)); this.cv.height = Math.max(1, Math.round(this.h * this.dpr));
    // Until you pan or zoom yourself, every resize (panel opening, sidebar folding) re-fits the view.
    if (this.active && this.data && (!this.fitted || !this.userMoved) && this.w > 10) { this.fit(true); this.fitted = true; }
    this.wake();
  }
  setData(d, { reset = false } = {}) {
    this.data = d;
    if (reset) { this.fitted = false; this.userMoved = false; this.reset(); }
    this.build(d);
    if (this.active && this.w > 10 && !this.fitted) { this.fit(true); this.fitted = true; }
    this.wake();
  }
  reset() {}
  // Live search dims what doesn't match; the timeline hides what didn't exist yet on that day.
  setMatch(set) { this.match = set; this.wake(); }
  setTime(day) { this.day = day || null; if (this.onFilter && this.data) this.onFilter(); this.wake(); }
  seen(n) { return !this.day || !n.born || n.born <= this.day; }
  isFit() { return this.fitted && !this.userMoved; }
  burst(ids) { const t0 = performance.now(); (this.bursts = this.bursts || []).push(...ids.map((id, i) => ({ id, t0: t0 + i * 60 }))); this.wake(); }
  worldOf() { return null; }
  screenOf(id) { const w = this.worldOf(id); if (!w) return null; const c = this.cam; return [(w[0] - c.x) * c.k + this.w / 2, (w[1] - c.y) * c.k + this.h / 2]; }
  drawBursts(g, now) {
    if (!this.bursts || !this.bursts.length || reduce.matches) { this.bursts = []; return false; }
    this.bursts = this.bursts.filter(b => now - b.t0 < 1300);
    for (const b of this.bursts) {
      const u = (now - b.t0) / 1300; if (u < 0) continue;
      const p = this.screenOf(b.id); if (!p) continue;
      const e = 1 - Math.pow(1 - u, 3);
      for (let r = 0; r < 3; r++) { const v = Math.max(0, e - r * 0.12); g.globalAlpha = (1 - u) * 0.8; g.strokeStyle = this.t.accent; g.lineWidth = 2 - r * 0.5; g.beginPath(); g.arc(p[0], p[1], 6 + v * 46, 0, TAU); g.stroke(); }
      for (let i = 0; i < 10; i++) { const a = i / 10 * TAU + b.t0, d = 8 + e * 54; g.globalAlpha = (1 - u); g.fillStyle = i % 2 ? this.t.accent : this.t.text; g.beginPath(); g.arc(p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d, 2 * (1 - u) + 0.5, 0, TAU); g.fill(); }
    }
    g.globalAlpha = 1;
    return this.bursts.length > 0;
  }
  lit(n) { return !this.match || this.match.has(n.id); }
  toWorld(sx, sy) { return [(sx - this.w / 2) / this.cam.k + this.cam.x, (sy - this.h / 2) / this.cam.k + this.cam.y]; }
  fit(instant) {
    const b = this.bounds(); if (!b || !this.w) return;
    this.follow = null; this.userMoved = false;
    const k = clamp(Math.min(this.w / (b.x1 - b.x0 + 60), (this.h - 70) / (b.y1 - b.y0 + 60)), 0.06, 2.4);
    Object.assign(this.cam, { tx: (b.x0 + b.x1) / 2, ty: (b.y0 + b.y1) / 2 - 18 / k, tk: k });
    if (instant) Object.assign(this.cam, { x: this.cam.tx, y: this.cam.ty, k });
    this.wake();
  }
  viewport() { const c = this.cam; return { x0: c.x - this.w / 2 / c.k, y0: c.y - this.h / 2 / c.k, x1: c.x + this.w / 2 / c.k, y1: c.y + this.h / 2 / c.k }; }
  goTo(x, y) { this.follow = null; this.userMoved = true; this.cam.tx = x; this.cam.ty = y; this.wake(); }
  panBy(dx, dy) { const c = this.cam; this.follow = null; this.userMoved = true; c.x -= dx / c.k; c.y -= dy / c.k; c.tx = c.x; c.ty = c.y; this.wake(); }
  zoomAt(sx, sy, f) {
    const c = this.cam, wx = (sx - this.w / 2) / c.tk + c.tx, wy = (sy - this.h / 2) / c.tk + c.ty, k = clamp(c.tk * f, 0.06, 6);
    this.userMoved = true; c.tk = k; if (!this.follow) { c.tx = wx - (sx - this.w / 2) / k; c.ty = wy - (sy - this.h / 2) / k; } this.wake();
  }
  setHover(h) {
    if ((h && this.hover && h.key === this.hover.key) || (!h && !this.hover)) return;
    this.hover = h; this.cv.style.cursor = h ? 'pointer' : 'grab';
    this.o.onHover(h && h.node ? h.node : null); this.wake();
  }
  bind() {
    const cv = this.cv, pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => { const [sx, sy] = pos(e); this.drag = { lx: sx, ly: sy, moved: 0 }; try { cv.setPointerCapture(e.pointerId); } catch {} });
    cv.addEventListener('pointermove', e => {
      const [sx, sy] = pos(e), d = this.drag;
      if (d) { d.moved += Math.abs(sx - d.lx) + Math.abs(sy - d.ly); if (d.moved > 3) this.dragBy(sx - d.lx, sy - d.ly); d.lx = sx; d.ly = sy; return; }
      this.setHover(this.hitScreen(sx, sy));
    });
    cv.addEventListener('pointerup', e => { const d = this.drag; this.drag = null; this.dragEnd && this.dragEnd(); if (d && d.moved < 5) { const [sx, sy] = pos(e); this.click(this.hitScreen(sx, sy)); } });
    cv.addEventListener('pointercancel', () => { this.drag = null; });
    cv.addEventListener('pointerleave', () => { if (!this.drag) this.setHover(null); });
    cv.addEventListener('wheel', e => { e.preventDefault(); const [sx, sy] = pos(e); this.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))); }, { passive: false });
    cv.addEventListener('dblclick', e => { const [sx, sy] = pos(e); const h = this.hitScreen(sx, sy); if (h) this.dbl(h); else this.fit(); });
    cv.addEventListener('keydown', e => this.key(e));
  }
  dragBy(dx, dy) { this.panBy(dx, dy); }
  key(e) {
    const s = 60, m = { ArrowLeft: () => this.panBy(s, 0), ArrowRight: () => this.panBy(-s, 0), ArrowUp: () => this.panBy(0, s), ArrowDown: () => this.panBy(0, -s),
      '+': () => this.zoomAt(this.w / 2, this.h / 2, 1.25), '=': () => this.zoomAt(this.w / 2, this.h / 2, 1.25), '-': () => this.zoomAt(this.w / 2, this.h / 2, 0.8), '0': () => this.fit() };
    if (m[e.key]) { e.preventDefault(); m[e.key](); }
  }
  hitScreen(sx, sy) { const [x, y] = this.toWorld(sx, sy); return this.hit(x, y); }
  dbl(h) { if (h.node) this.o.onOpen(h.node); }
  // The loop runs while something moves (camera, layout, orbits) and sleeps otherwise; wake() forces one redraw.
  wake() { this.dirty = true; if (!this.running && this.active) { this.running = true; requestAnimationFrame(t => this.frame(t)); } }
  frame(now) {
    if (!this.active || document.hidden || !this.data) { this.running = false; return; }
    const c = this.cam, s = reduce.matches ? 1 : 0.18; let busy = false;
    for (const k of ['x', 'y', 'k']) { const tk = 't' + k; if (Math.abs(c[tk] - c[k]) > (k === 'k' ? 1e-4 : 0.05)) { c[k] = lerp(c[k], c[tk], s); busy = true; } else c[k] = c[tk]; }
    if (this.tick(now)) busy = true;
    if (this.bursts && this.bursts.length) busy = true;
    if (busy || this.dirty) {
      const g = this.g; g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.fillStyle = this.t.bg; g.fillRect(0, 0, this.w, this.h);
      if (this.underlay) this.underlay(g, now);
      g.save(); g.translate(this.w / 2, this.h / 2); g.scale(c.k, c.k); g.translate(-c.x, -c.y);
      this.draw(g, now); g.restore();
      if (this.overlay) this.overlay(g, now);
      this.drawBursts(g, now);
      this.dirty = false;
      if (this.o.onFrame) this.o.onFrame(this);
    }
    if (busy) requestAnimationFrame(t => this.frame(t)); else this.running = false;
  }
  tick() { return false; }
}

// ---------- Mind map: workspace -> categories -> notes; click a note to make it the centre ----------
export class MindmapView extends Scene {
  constructor(h, o) { super(h, o); this.root = null; this.closed = new Set(); this.nodes = new Map(); }
  aria() { return 'Mind map. Click a category to fold it, click a project to centre it, double-click to open it. Drag to pan, scroll to zoom.'; }
  hint() { return this.root ? 'Click a note to centre it · double-click to open' : 'Click a category to fold it · click a note to centre it · double-click to open'; }
  canBack() { return !!this.root; }
  back() { this.root = null; this.layout(); this.fit(); this.o.onChange(); }
  reset() { this.root = null; this.closed.clear(); this.nodes.clear(); }
  build() { if (this.root && !this.data.byId.has(this.root)) this.root = null; this.layout(); }
  onFilter() { this.layout(); }
  layout() {
    const d = this.data; if (!d) return;
    const g = this.g;
    const measure = (s, kind) => { g.font = kind === 'root' ? `600 16px ${FONT}` : kind === 'cat' ? `600 13.5px ${FONT}` : `500 13px ${FONT}`; return Math.ceil(g.measureText(s).width); };
    let root;
    if (!this.root) root = { key: 'root', label: d.name, kind: 'root', kids: d.cats.filter(c => c.nodes.some(n => this.seen(n))).map(c => ({ key: 'cat:' + c.name, label: c.name, kind: 'cat', cat: c.name,
      kids: this.closed.has(c.name) ? [] : c.nodes.filter(n => this.seen(n)).map(n => ({ key: n.id, label: n.label, kind: 'note', node: n, kids: [] })) })) };
    else {
      const r = d.byId.get(this.root), seen = new Set([r.id]), k1 = [...d.adj.get(r.id)];
      k1.forEach(x => seen.add(x));
      root = { key: r.id, label: r.label, kind: 'root', node: r, kids: k1.map(id => {
        const k2 = [...d.adj.get(id)].filter(x => !seen.has(x)); k2.forEach(x => seen.add(x));
        return { key: id, label: d.byId.get(id).label, kind: 'note', node: d.byId.get(id), kids: k2.map(x => ({ key: x, label: d.byId.get(x).label, kind: 'note', node: d.byId.get(x), kids: [] })) };
      }) };
    }
    const size = n => { n.w = measure(n.label, n.kind) + (n.kind === 'note' ? 54 : n.kind === 'cat' ? 40 : 40); n.h = n.kind === 'root' ? 42 : n.kind === 'cat' ? 34 : 30; n.kids.forEach(size); };
    size(root);
    const sides = [[], []];
    if (!this.root) { let a = 0, b = 0; for (const k of root.kids) { const wgt = Math.max(1, k.kids.length) + 0.6; if (a <= b) { sides[0].push(k); a += wgt; } else { sides[1].push(k); b += wgt; } } }
    else root.kids.forEach((k, i) => sides[i % 2].push(k));
    const ROW = 36, GAP = 18, out = [];
    const keep = n => ({ key: n.key, label: n.label, kind: n.kind, node: n.node, cat: n.cat, w: n.w, h: n.h, closed: n.kind === 'cat' && this.closed.has(n.cat) });
    out.push(Object.assign(keep(root), { tx: 0, ty: 0, parent: null, side: 1 }));
    sides.forEach((list, si) => {
      const sign = si === 0 ? 1 : -1, maxW1 = Math.max(0, ...list.map(k => k.w)), edge2 = root.w / 2 + 70 + maxW1 + 80;
      const rows = list.reduce((a, k) => a + Math.max(1, k.kids.length), 0) + Math.max(0, list.length - 1) * GAP / ROW;
      let y = -rows * ROW / 2 + ROW / 2;
      for (const k of list) {
        const n = Math.max(1, k.kids.length);
        out.push(Object.assign(keep(k), { tx: sign * (root.w / 2 + 70 + k.w / 2), ty: y + (n - 1) * ROW / 2, parent: root.key, side: sign }));
        k.kids.forEach((c, j) => out.push(Object.assign(keep(c), { tx: sign * (edge2 + c.w / 2), ty: y + j * ROW, parent: k.key, side: sign })));
        y += n * ROW + GAP;
      }
    });
    const prev = this.nodes, next = new Map();
    for (const o of out) {
      const p = prev.get(o.key), par = o.parent && next.get(o.parent);
      next.set(o.key, Object.assign(o, p ? { x: p.x, y: p.y, a: p.a } : par ? { x: par.x, y: par.y, a: 0 } : { x: o.tx, y: o.ty, a: 0 }));
    }
    this.nodes = next; this.wake();
  }
  tick() {
    let m = false; const k = reduce.matches ? 1 : 0.16;
    for (const n of this.nodes.values()) {
      if (Math.abs(n.x - n.tx) + Math.abs(n.y - n.ty) > 0.3 || n.a < 0.99) { n.x = lerp(n.x, n.tx, k); n.y = lerp(n.y, n.ty, k); n.a = lerp(n.a, 1, k); m = true; }
      else { n.x = n.tx; n.y = n.ty; n.a = 1; }
    }
    return m;
  }
  worldOf(id) { const n = this.nodes.get(id); return n ? [n.x, n.y] : null; }
  colorFor(n) { return n.kind === 'note' ? this.o.colorOf(n.node) : n.kind === 'cat' ? this.o.catColor(n.cat) : this.t.accent; }
  draw(g) {
    const t = this.t, hov = this.hover && this.hover.key, k = this.cam.k;
    for (const n of this.nodes.values()) {
      if (!n.parent) continue;
      const p = this.nodes.get(n.parent); if (!p) continue;
      const s = n.side, x1 = p.x + s * p.w / 2, x2 = n.x - s * n.w / 2, mx = (x1 + x2) / 2, lit = hov === n.key || hov === p.key;
      g.globalAlpha = (lit ? 1 : 0.5) * n.a; g.strokeStyle = lit ? t.accent : this.colorFor(n); g.lineWidth = lit ? 2.2 : 1.4;
      g.beginPath(); g.moveTo(x1, p.y); g.bezierCurveTo(mx, p.y, mx, n.y, x2, n.y); g.stroke();
    }
    for (const n of this.nodes.values()) {
      const col = this.colorFor(n), lit = hov === n.key, x0 = n.x - n.w / 2;
      g.globalAlpha = n.a * (n.node ? (this.lit(n.node) ? 1 : 0.15) : this.match ? 0.55 : 1);
      g.beginPath(); g.roundRect(x0, n.y - n.h / 2, n.w, n.h, n.h / 2);
      if (n.kind === 'root') { g.fillStyle = t.accent; g.fill(); }
      else {
        g.fillStyle = n.kind === 'cat' ? col + '2e' : t.bg2; g.fill();
        g.setLineDash(n.closed ? [5, 4] : []); g.strokeStyle = lit ? t.accent : col; g.lineWidth = lit ? 2.4 : 1.3; g.stroke(); g.setLineDash([]);
      }
      if (n.kind === 'note') {
        const img = n.node.icon && this.o.iconOf(n.node.host);
        if (img) g.drawImage(img, x0 + 9, n.y - 8, 16, 16);
        else { g.fillStyle = col; g.font = `600 11px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText((n.label.match(/[A-Za-z0-9]/) || ['•'])[0].toUpperCase(), x0 + 17, n.y + 0.5); }
        if (n.node.status) { g.fillStyle = statusColor(t, n.node.status); g.beginPath(); g.arc(x0 + n.w - 13, n.y, 4, 0, TAU); g.fill(); }
        g.fillStyle = t.text; g.font = `500 13px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(n.label, x0 + 30, n.y + 0.5);
      } else {
        g.fillStyle = n.kind === 'root' ? t.onAccent : t.text; g.font = n.kind === 'root' ? `600 16px ${FONT}` : `600 13.5px ${FONT}`;
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(n.label, n.x, n.y + 0.5);
      }
    }
    g.globalAlpha = 1;
  }
  hit(x, y) {
    const list = [...this.nodes.values()];
    for (let i = list.length - 1; i >= 0; i--) { const n = list[i]; if (Math.abs(x - n.x) <= n.w / 2 && Math.abs(y - n.y) <= n.h / 2) return { key: n.key, kind: n.kind, node: n.node, cat: n.cat }; }
    return null;
  }
  click(h) {
    if (!h) return;
    if (h.kind === 'cat') { this.closed.has(h.cat) ? this.closed.delete(h.cat) : this.closed.add(h.cat); this.layout(); return; }
    if (h.kind === 'root') { if (h.node) this.o.onOpen(h.node); return; }
    this.root = h.key; this.layout(); this.cam.tx = 0; this.cam.ty = 0; this.o.onChange(); this.o.onSelect && this.o.onSelect(h.node);
  }
  bounds() {
    if (!this.nodes.size) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes.values()) { x0 = Math.min(x0, n.tx - n.w / 2); x1 = Math.max(x1, n.tx + n.w / 2); y0 = Math.min(y0, n.ty - n.h / 2); y1 = Math.max(y1, n.ty + n.h / 2); }
    return { x0, y0, x1, y1 };
  }
  paintMini(g, map, s) {
    for (const n of this.nodes.values()) { const [x, y] = map(n.x - n.w / 2, n.y - n.h / 2); g.fillStyle = this.colorFor(n); g.globalAlpha = 0.85; g.fillRect(x, y, Math.max(1.5, n.w * s), Math.max(1.5, n.h * s * 0.7)); }
    g.globalAlpha = 1;
  }
  focus(id) {
    const d = this.data, n = d && d.byId.get(id); if (!n) return;
    if (!this.root && this.closed.has(n.category)) { this.closed.delete(n.category); this.layout(); }
    const m = this.nodes.get(id); if (m) { this.cam.tx = m.tx; this.cam.ty = m.ty; this.cam.tk = Math.max(this.cam.tk, 1.3); this.wake(); }
  }
}

// ---------- Sunburst: categories inside, notes outside, status band; click a category to open it ----------
const RINGS = { hub: 84, c0: 90, c1: 180, n0: 186, n1: 300, s0: 304, s1: 313 };
function ringPath(g, r0, r1, a0, a1) { const s = a0 - Math.PI / 2, e = a1 - Math.PI / 2; g.beginPath(); g.arc(0, 0, r1, s, e); g.arc(0, 0, r0, e, s, true); g.closePath(); }
export class SunburstView extends Scene {
  constructor(h, o) { super(h, o); this.drill = null; this.segs = new Map(); }
  aria() { return 'Sunburst of token use. Click a category to open it, click a slice to open its note, click the centre to go back.'; }
  hint() { return this.drill ? 'Click a slice to open its note · click the centre to go back' : 'Click a category to open it · click a slice to open its note'; }
  canBack() { return !!this.drill; }
  back() { this.drill = null; this.layout(); this.o.onChange(); }
  reset() { this.drill = null; this.segs.clear(); }
  build() { if (this.drill && !this.data.cats.some(c => c.name === this.drill)) this.drill = null; this.layout(); }
  onFilter() { this.layout(); }
  layout() {
    const d = this.data; if (!d) return;
    const total = d.nodes.reduce((a, n) => a + n.tokens, 0), base = Math.max(total * 0.006, 1), v = n => this.seen(n) ? n.tokens + base : 0;
    const shown = d.cats.filter(c => !this.drill || c.name === this.drill);
    const sum = shown.reduce((a, c) => a + c.nodes.reduce((b, n) => b + v(n), 0), 0) || 1;
    const next = new Map(); let a = 0;
    const put = (key, tg) => { const p = this.segs.get(key); next.set(key, Object.assign(tg, { key, t0: tg.a0, t1: tg.a1, a0: p ? p.a0 : tg.a0, a1: p ? p.a1 : tg.a0 })); };
    for (const c of d.cats) {
      const on = !this.drill || c.name === this.drill, cs = on ? c.nodes.reduce((b, n) => b + v(n), 0) / sum * TAU : 0;
      put('c:' + c.name, { a0: a, a1: a + cs, kind: 'cat', cat: c.name, tokens: c.tokens, count: c.nodes.length });
      let b = a;
      for (const n of c.nodes) { const s = on ? v(n) / sum * TAU : 0; put(n.id, { a0: b, a1: b + s, kind: 'note', node: n, cat: c.name }); b += s; }
      a += cs;
    }
    this.total = total; this.segs = next; this.wake();
  }
  tick() {
    let m = false; const k = reduce.matches ? 1 : 0.14;
    for (const s of this.segs.values()) {
      if (Math.abs(s.a0 - s.t0) > 1e-4 || Math.abs(s.a1 - s.t1) > 1e-4) { s.a0 = lerp(s.a0, s.t0, k); s.a1 = lerp(s.a1, s.t1, k); m = true; } else { s.a0 = s.t0; s.a1 = s.t1; }
    }
    return m;
  }
  draw(g) {
    const t = this.t, h = this.hover, k = this.cam.k;
    const dim = s => (s.kind === 'note' && !this.lit(s.node) ? 0.18 : 1) * (!h || h.key === 'hub' ? 1 : h.kind === 'cat' ? (s.cat === h.cat ? 1 : 0.28) : (s.key === h.key || (s.kind === 'cat' && s.cat === h.cat) ? 1 : 0.3));
    for (const s of this.segs.values()) {
      if (s.a1 - s.a0 < 0.0004) continue;
      const col = s.kind === 'cat' ? this.o.catColor(s.cat) : this.o.colorOf(s.node);
      g.globalAlpha = dim(s) * (s.kind === 'cat' ? 0.92 : 0.6);
      ringPath(g, s.kind === 'cat' ? RINGS.c0 : RINGS.n0, s.kind === 'cat' ? RINGS.c1 : RINGS.n1, s.a0, s.a1); g.fillStyle = col; g.fill();
      g.lineWidth = 1.5 / k; g.strokeStyle = t.bg; g.stroke();
      if (s.kind === 'note' && s.node.status) { g.globalAlpha = dim(s); ringPath(g, RINGS.s0, RINGS.s1, s.a0, s.a1); g.fillStyle = statusColor(t, s.node.status); g.fill(); }
    }
    g.globalAlpha = 1;
    // labels along the radius, flipped on the left so they never read upside down
    for (const s of this.segs.values()) {
      const span = s.a1 - s.a0, r0 = s.kind === 'cat' ? RINGS.c0 : RINGS.n0, r1 = s.kind === 'cat' ? RINGS.c1 : RINGS.n1;
      if (span * (r0 + r1) / 2 < (s.kind === 'cat' ? 15 : 11.5)) continue;
      const label = s.kind === 'cat' ? s.cat : s.node.label, m = (s.a0 + s.a1) / 2 - Math.PI / 2, room = r1 - r0 - 14;
      g.save(); g.rotate(m); let x = (r0 + r1) / 2;
      if (Math.cos(m) < 0) { g.rotate(Math.PI); x = -x; }
      g.font = `${s.kind === 'cat' ? 600 : 500} ${s.kind === 'cat' ? 12.5 : 11}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      let str = label; while (g.measureText(str).width > room && str.length > 3) str = str.slice(0, -2) + '…';
      g.globalAlpha = dim(s); g.fillStyle = s.kind === 'cat' ? t.bg : t.text; g.fillText(str, x, 0.5); g.restore();
    }
    g.globalAlpha = 1;
    g.beginPath(); g.arc(0, 0, RINGS.hub, 0, TAU); g.fillStyle = t.bg2; g.fill(); g.lineWidth = 1 / k; g.strokeStyle = t.line; g.stroke();
    const seg = h && h.key !== 'hub' ? this.segs.get(h.key) : null;
    const c = seg ? (seg.kind === 'cat' ? [seg.cat, fmtTok(seg.tokens) + ' tokens', `${seg.count} notes`] : [seg.node.label, fmtTok(seg.node.tokens) + ' tokens', seg.node.status || seg.cat])
      : [this.drill || this.data.name, fmtTok(this.drill ? this.data.cats.find(x => x.name === this.drill).tokens : this.total) + ' tokens', this.drill ? 'click to go back' : 'all categories'];
    // favicon (or first letter) of what's in focus, above its name
    const fn = seg && seg.kind === 'note' ? seg.node : null, img = fn && fn.icon && this.o.iconOf(fn.host);
    const badge = fn ? this.o.colorOf(fn) : seg ? this.o.catColor(seg.cat) : t.accent;
    g.beginPath(); g.arc(0, -40, 17, 0, TAU); g.fillStyle = t.raised; g.fill(); g.lineWidth = 1.6; g.strokeStyle = badge; g.stroke();
    if (img) g.drawImage(img, -11, -51, 22, 22);
    else text(g, t, ((fn ? fn.label : c[0]).match(/[A-Za-z0-9]/) || ['•'])[0].toUpperCase(), 0, -39.5, { size: 15, weight: 700, align: 'center', color: badge, halo: false });
    let title = c[0]; g.font = `600 15px ${FONT}`; while (g.measureText(title).width > 140 && title.length > 4) title = title.slice(0, -2) + '…';
    text(g, t, title, 0, -4, { size: 15, weight: 600, align: 'center', halo: false });
    text(g, t, c[1], 0, 16, { size: 12.5, align: 'center', color: t.muted, halo: false });
    text(g, t, c[2], 0, 33, { size: 11, align: 'center', color: t.muted, halo: false });
  }
  worldOf(id) { const s = this.segs.get(id); if (!s) return null; const m = (s.a0 + s.a1) / 2; return [Math.sin(m) * 243, -Math.cos(m) * 243]; }
  hit(x, y) {
    const r = Math.hypot(x, y); if (r <= RINGS.hub) return { key: 'hub', kind: 'hub' };
    const ang = ((Math.atan2(x, -y) % TAU) + TAU) % TAU;
    for (const s of this.segs.values()) {
      const inR = s.kind === 'cat' ? r >= RINGS.c0 && r <= RINGS.c1 : r >= RINGS.n0 && r <= RINGS.s1;
      if (inR && ang >= s.a0 && ang < s.a1 && s.a1 - s.a0 > 0.0004) return { key: s.key, kind: s.kind, node: s.node, cat: s.cat };
    }
    return null;
  }
  click(h) {
    if (!h) return;
    if (h.kind === 'hub') { if (this.drill) this.back(); return; }
    if (h.kind === 'cat') { this.drill = this.drill === h.cat ? null : h.cat; this.layout(); this.o.onChange(); return; }
    this.o.onOpen(h.node);
  }
  bounds() { const r = RINGS.s1 + 10; return { x0: -r, y0: -r, x1: r, y1: r }; }
  paintMini(g, map, s) {
    const [cx, cy] = map(0, 0);
    for (const sg of this.segs.values()) {
      if (sg.a1 - sg.a0 < 0.002) continue;
      g.beginPath(); g.arc(cx, cy, (sg.kind === 'cat' ? 135 : 243) * s, sg.a0 - Math.PI / 2, sg.a1 - Math.PI / 2);
      g.lineWidth = (sg.kind === 'cat' ? 90 : 114) * s * 0.92; g.strokeStyle = sg.kind === 'cat' ? this.o.catColor(sg.cat) : this.o.colorOf(sg.node); g.globalAlpha = 0.8; g.stroke();
    }
    g.globalAlpha = 1;
  }
  focus(id) {
    const s = this.segs.get(id); if (!s) return;
    const m = (s.t0 + s.t1) / 2; this.cam.tx = Math.sin(m) * 243; this.cam.ty = -Math.cos(m) * 243; this.cam.tk = Math.max(this.cam.tk, 1.8);
    this.hover = { key: s.key, kind: s.kind, node: s.node, cat: s.cat }; this.wake();
  }
}

// ---------- Solar system: workspace sun, an ideas belt, category planets with ring systems of notes ----------
// Categories share two rigid orbits (so they never collide), notes circle their planet on stacked rings,
// inspiration and tags drift in an asteroid belt. Hovering anything pauses the whole system.
const fr = x => { const v = Math.sin(x) * 43758.5453; return v - Math.floor(v); };
export class SolarView extends Scene {
  constructor(h, o) {
    super(h, o); this.clock = 0; this.last = 0; this.follow = null; this.sys = []; this.belt = []; this.dust = []; this.orbits = []; this.maxR = 400; this.byId = new Map();
    this.stars = Array.from({ length: 240 }, (_, i) => ({ x: fr(i * 12.9898), y: fr(i * 78.233), r: 0.3 + fr(i * 3.7) * 1.1, p: i * 1.3, z: 0.2 + fr(i * 5.1) * 0.6 }));
  }
  aria() { return 'Solar system. The workspace is the sun, categories are planets with their notes in rings, inspiration drifts in a belt. Hover to pause, click a planet to follow it, click a note to open it.'; }
  hint() { return 'Hover to pause · click a planet to follow it · click a note to open it'; }
  reset() { this.follow = null; }
  onFilter() { this.build(); }
  build() {
    const d = this.data, maxC = Math.max(1, ...d.cats.map(c => c.tokens)), maxN = Math.max(1, ...d.nodes.map(n => n.tokens));
    this.sunR = 48;
    const b0 = this.sunR + 46, bw = 70;
    this.belt = (d.belt || []).filter(n => this.seen(n)).map((n, i) => ({ n, r: b0 + 8 + fr(i * 7.1) * (bw - 16), a: fr(i * 3.3) * TAU, s: 0.04 + fr(i * 5.9) * 0.05, size: n.type === 'inspiration' ? 3 : 2 }));
    this.dust = Array.from({ length: 320 }, (_, i) => ({ r: b0 + fr(i * 1.7) * bw, a: fr(i * 9.1) * TAU, s: 0.03 + fr(i * 2.3) * 0.05, size: 0.5 + fr(i * 4.1) * 1.2 }));
    const cats = [...d.cats].filter(c => c.nodes.some(n => this.seen(n))).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    const sys = cats.map((c, i) => {
      const pr = 20 + 24 * Math.sqrt(c.tokens / maxC);
      const ms = c.nodes.filter(n => this.seen(n)).sort((a, b) => ST.rank(a.status) - ST.rank(b.status) || b.tokens - a.tokens);
      // two notes per ring, opposite each other, rings packed outward: live closest, parked furthest
      const moons = ms.map((n, j) => ({ n, r: 4.5 + 7 * Math.sqrt(n.tokens / maxN), orbit: pr + 16 + Math.floor(j / 2) * 10, phase: (j % 2) * Math.PI + Math.floor(j / 2) * 0.9 + i, speed: 0.5 / (1 + Math.floor(j / 2) * 0.18) }));
      const reach = (moons.length ? moons[moons.length - 1].orbit + moons[moons.length - 1].r : pr) + 10;
      return { c, pr, moons, reach, x: 0, y: 0 };
    });
    // categories share orbits: the biggest on an inner ring, the rest outside; each ring turns as one, so planets never meet
    const n = sys.length, rings = n <= 4 ? [sys] : [sys.slice(0, Math.ceil(n * 0.42)), sys.slice(Math.ceil(n * 0.42))];
    let R = b0 + bw + 24;
    rings.forEach((list, ri) => {
      if (!list.length) return;
      const maxReach = Math.max(...list.map(s => s.reach)), k = list.length;
      const need = k > 1 ? (2 * maxReach + 24) / (2 * Math.sin(Math.PI / k)) : 0;
      const r = Math.max(R + maxReach, need);
      list.forEach((s, j) => { s.orbit = r; s.phase = j / k * TAU + ri * 0.55; s.speed = 0.06 / (1 + ri * 0.7); });
      R = r + maxReach + 30;
    });
    this.sys = sys; this.orbits = [...new Set(sys.map(s => s.orbit))]; this.maxR = R;
    this.byId = new Map(); for (const s of sys) for (const m of s.moons) this.byId.set(m.n.id, m);
    this.place();
  }
  worldOf(id) { const m = this.byId.get(id); return m ? [m.x, m.y] : null; }
  place() {
    const t = this.clock;
    for (const s of this.sys) {
      s.ang = s.phase + t * s.speed; s.x = Math.cos(s.ang) * s.orbit; s.y = Math.sin(s.ang) * s.orbit;
      for (const m of s.moons) { const b = m.phase + t * m.speed; m.x = s.x + Math.cos(b) * m.orbit; m.y = s.y + Math.sin(b) * m.orbit; }
    }
    for (const b of this.belt) { const a = b.a + t * b.s; b.x = Math.cos(a) * b.r; b.y = Math.sin(a) * b.r; }
  }
  tick(now) {
    const dt = Math.min(60, now - (this.last || now)); this.last = now;
    const moving = !this.hover && !reduce.matches && !document.hidden;
    if (moving) { this.clock += dt / 1000; this.place(); }
    if (this.follow) { const s = this.sys.find(x => x.c.name === this.follow); if (s) { this.cam.tx = s.x; this.cam.ty = s.y; } }
    return moving;
  }
  underlay(g, now) { // stars with a little parallax
    const t = this.t, c = this.cam;
    g.fillStyle = t.text;
    for (const s of this.stars) {
      const x = ((s.x * this.w - c.x * c.k * s.z * 0.05) % this.w + this.w) % this.w, y = ((s.y * this.h - c.y * c.k * s.z * 0.05) % this.h + this.h) % this.h;
      g.globalAlpha = (t.dark ? 0.4 : 0.14) * s.z * (0.7 + 0.3 * Math.sin(now * 0.0012 + s.p)); g.beginPath(); g.arc(x, y, s.r, 0, TAU); g.fill();
    }
    g.globalAlpha = 1;
  }
  draw(g, now) {
    const t = this.t, k = this.cam.k, h = this.hover, d = this.data;
    // nebula behind each system
    for (const s of this.sys) { const col = this.o.catColor(s.c.name), r = s.reach * 1.6; g.globalAlpha = t.dark ? 0.1 : 0.06; g.drawImage(sprite(col), s.x - r, s.y - r, r * 2, r * 2); }
    // shared orbits
    g.globalAlpha = 1; g.lineWidth = 1 / k; g.strokeStyle = t.line;
    for (const o of this.orbits) { g.beginPath(); g.arc(0, 0, o, 0, TAU); g.stroke(); }
    // belt: dust and the inspiration/tag asteroids
    g.fillStyle = t.muted;
    for (const p of this.dust) { const a = p.a + this.clock * p.s; g.globalAlpha = 0.35; g.fillRect(Math.cos(a) * p.r, Math.sin(a) * p.r, p.size, p.size); }
    for (const b of this.belt) {
      g.globalAlpha = (h && h.key === b.n.id ? 1 : 0.8) * (this.lit(b.n) ? 1 : 0.2);
      g.fillStyle = b.n.type === 'inspiration' ? this.t.holo : t.muted; g.beginPath(); g.arc(b.x, b.y, b.size, 0, TAU); g.fill();
    }
    // sun with a breathing corona
    const pulse = reduce.matches ? 1 : 1 + 0.05 * Math.sin(now / 700), sr = this.sunR;
    g.globalAlpha = t.dark ? 0.6 : 0.35; g.drawImage(sprite(t.accent), -sr * 3.6 * pulse, -sr * 3.6 * pulse, sr * 7.2 * pulse, sr * 7.2 * pulse);
    g.globalAlpha = t.dark ? 0.25 : 0.15; g.drawImage(sprite(t.accent), -sr * 6, -sr * 6, sr * 12, sr * 12);
    g.globalAlpha = 1; g.beginPath(); g.arc(0, 0, sr, 0, TAU); g.fillStyle = t.accent; g.fill();
    // links between notes, faint; the hovered note's links lit
    const hm = h && this.byId.get(h.key);
    g.lineWidth = 1 / k;
    for (const e of d.edges) {
      const a = this.byId.get(e.s), b = this.byId.get(e.t); if (!a || !b) continue;
      const on = hm && (a === hm || b === hm);
      if (!on && hm) continue;
      g.globalAlpha = on ? 0.9 : 0.07; g.strokeStyle = on ? t.accent : t.text;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    for (const s of this.sys) {
      const col = this.o.catColor(s.c.name), lit = h && h.cat === s.c.name;
      // comet trail along the orbit, fading behind the planet
      for (let i = 0; i < 10; i++) { g.globalAlpha = 0.28 * (1 - i / 10); g.lineWidth = (s.pr * 0.5 * (1 - i / 10)) ; g.strokeStyle = col; g.beginPath(); g.arc(0, 0, s.orbit, s.ang - (i + 1) * 0.022, s.ang - i * 0.022); g.stroke(); }
      // ring system
      g.lineWidth = 1 / k; g.strokeStyle = col;
      for (const m of s.moons) { g.globalAlpha = 0.13; g.beginPath(); g.arc(s.x, s.y, m.orbit, 0, TAU); g.stroke(); }
      g.globalAlpha = t.dark ? 0.5 : 0.28; g.drawImage(sprite(col), s.x - s.pr * 2.6, s.y - s.pr * 2.6, s.pr * 5.2, s.pr * 5.2);
      g.globalAlpha = 1; g.beginPath(); g.arc(s.x, s.y, s.pr, 0, TAU); g.fillStyle = col; g.fill();
      g.beginPath(); g.arc(s.x - s.pr * 0.3, s.y - s.pr * 0.3, s.pr * 0.55, 0, TAU); g.fillStyle = '#ffffff'; g.globalAlpha = 0.12; g.fill(); g.globalAlpha = 1;
      if (lit || this.follow === s.c.name) { g.lineWidth = 2 / k; g.strokeStyle = t.accent; g.beginPath(); g.arc(s.x, s.y, s.pr + 5 / k, 0, TAU); g.stroke(); }
      for (const m of s.moons) {
        const on = h && h.key === m.n.id, ml = this.lit(m.n) ? 1 : 0.15, scr = m.r * k;
        g.globalAlpha = ml;
        g.beginPath(); g.arc(m.x, m.y, m.r, 0, TAU); g.fillStyle = t.bg2; g.fill();
        g.lineWidth = Math.max(1.3 / k, m.r * 0.3); g.strokeStyle = m.n.status ? statusColor(t, m.n.status) : this.o.colorOf(m.n); g.stroke();
        const img = scr > 7 && m.n.icon && this.o.iconOf(m.n.host);
        if (img) { const z = m.r * 1.3; g.drawImage(img, m.x - z / 2, m.y - z / 2, z, z); }
        else { g.beginPath(); g.arc(m.x, m.y, m.r * 0.45, 0, TAU); g.fillStyle = this.o.colorOf(m.n); g.fill(); }
        if (on) { g.globalAlpha = 1; g.lineWidth = 2 / k; g.strokeStyle = t.accent; g.beginPath(); g.arc(m.x, m.y, m.r + 4 / k, 0, TAU); g.stroke(); }
      }
      g.globalAlpha = 1;
    }
  }
  overlay(g) { // labels in screen space, biggest first, never overlapping
    const t = this.t, c = this.cam, k = c.k, h = this.hover, boxes = [];
    const S = (x, y) => [(x - c.x) * k + this.w / 2, (y - c.y) * k + this.h / 2];
    const put = (str, x, y, size, weight, color, align) => {
      g.font = `${weight} ${size}px ${FONT}`; const w = g.measureText(str).width, x0 = align === 'center' ? x - w / 2 : x;
      const box = [x0 - 2, y - size / 2 - 2, x0 + w + 2, y + size / 2 + 2];
      if (x0 > this.w || x0 + w < 0 || y < -10 || y > this.h + 10 || boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return;
      boxes.push(box); text(g, t, str, x, y, { size, weight, color, align });
    };
    const names = this.o.labels();
    const [sx, sy] = S(0, 0); if (names) put(this.data.name, sx, sy + this.sunR * k + 14, 14, 700, t.text, 'center');
    if (h) { const hm = this.byId.get(h.key) || (h.kind === 'belt' && this.belt.find(b => b.n.id === h.key)); if (hm) { const [x, y] = S(hm.x, hm.y); put(hm.n.label, x + (h.kind === 'belt' ? hm.size : hm.r) * k + 6, y, 12.5, 700, t.text, 'left'); } }
    if (names) for (const s of this.sys) { const [x, y] = S(s.x, s.y); put(s.c.name, x, y - s.pr * k - 12, 13, 700, t.text, 'center'); }
    const moons = names ? this.sys.flatMap(s => s.moons).filter(m => this.lit(m.n) && m.r * k >= 2.2).sort((a, b) => b.n.tokens - a.n.tokens) : [];
    for (const m of moons) { const [x, y] = S(m.x, m.y); put(m.n.label, x + m.r * k + 5, y, 11, 500, t.muted, 'left'); }
    if (h) put('Paused', this.w / 2, 68, 11.5, 500, t.muted, 'center');
  }
  hit(x, y) {
    const k = this.cam.k;
    for (const s of this.sys) for (const m of s.moons) if (Math.hypot(x - m.x, y - m.y) < m.r + 5 / k) return { key: m.n.id, kind: 'moon', node: m.n, cat: s.c.name };
    for (const s of this.sys) if (Math.hypot(x - s.x, y - s.y) < s.pr + 4 / k) return { key: 'p:' + s.c.name, kind: 'planet', cat: s.c.name };
    if (Math.hypot(x, y) < this.sunR + 4 / k) return { key: 'sun', kind: 'sun' };
    for (const b of this.belt) if (Math.hypot(x - b.x, y - b.y) < b.size + 5 / k) return { key: b.n.id, kind: 'belt', node: b.n };
    return null;
  }
  click(h) {
    if (!h) return;
    if (h.kind === 'sun') return this.fit();
    if (h.kind === 'planet') { this.follow = h.cat; this.cam.tk = Math.max(this.cam.tk, 1.6); this.wake(); return; }
    if (h.node && h.node.type !== 'tag') this.o.onOpen(h.node);
  }
  bounds() { const r = this.maxR + 10; return { x0: -r, y0: -r, x1: r, y1: r }; }
  paintMini(g, map, s) {
    const [cx, cy] = map(0, 0);
    g.strokeStyle = this.t.line; g.lineWidth = 1;
    for (const o of this.orbits) { g.beginPath(); g.arc(cx, cy, o * s, 0, TAU); g.stroke(); }
    g.fillStyle = this.t.muted; for (const b of this.belt) { const [x, y] = map(b.x, b.y); g.fillRect(x, y, 1, 1); }
    g.fillStyle = this.t.accent; g.beginPath(); g.arc(cx, cy, Math.max(2.5, this.sunR * s), 0, TAU); g.fill();
    for (const p of this.sys) {
      const [x, y] = map(p.x, p.y); g.fillStyle = this.o.catColor(p.c.name); g.beginPath(); g.arc(x, y, Math.max(2, p.pr * s), 0, TAU); g.fill();
      for (const m of p.moons) { const [a, b] = map(m.x, m.y); g.fillRect(a - 0.7, b - 0.7, 1.4, 1.4); }
    }
  }
  focus(id) {
    for (const s of this.sys) { const m = s.moons.find(x => x.n.id === id); if (m) { this.follow = s.c.name; this.cam.tk = Math.max(this.cam.tk, 2.2); this.hover = { key: id, kind: 'moon', node: m.n, cat: s.c.name }; this.wake(); } }
  }
}

// ---------- Globe: categories as continents on a 3D holographic planet ----------
export class GlobeView extends Scene {
  constructor(h, o) {
    super(h, o);
    this.yaw = 0.5; this.pitch = 0.38; this.zoom = 1; this.tzoom = 1; this.vy = 0; this.vp = 0; this.tyaw = null; this.tpitch = null; this.last = 0;
    this.pts = []; this.links = []; this.proj = []; this.cats = [];
    this.stars = Array.from({ length: 180 }, (_, i) => ({ x: (Math.sin(i * 91.7) * 0.5 + 0.5), y: (Math.sin(i * 37.3 + 1) * 0.5 + 0.5), r: 0.4 + (i % 5) * 0.25, p: i * 1.7 }));
  }
  aria() { return 'Globe. Drag to rotate and tilt, scroll to zoom, click a project to open it.'; }
  hint() { return 'Drag to rotate and tilt · scroll to zoom · hover to stop the spin · click to open'; }
  reset() { this.yaw = 0.5; this.pitch = 0.38; this.tzoom = 1; }
  build() {
    const d = this.data, n = Math.max(1, d.cats.length), maxN = Math.max(1, ...d.nodes.map(x => x.tokens));
    const byId = new Map();
    this.cats = d.cats.map((c, i) => {
      const lon0 = -Math.PI + (i + 0.5) * TAU / n, lat0 = (i % 2 ? 0.28 : -0.22);
      c.nodes.forEach((node, j) => {
        const ang = j * 2.39996, rad = 0.11 * Math.sqrt(j + 0.6), lat = clamp(lat0 + rad * Math.sin(ang), -1.3, 1.3), lon = lon0 + rad * Math.cos(ang) / Math.cos(lat0);
        byId.set(node.id, { node, lat, lon, v: [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)], hgt: 0.04 + 0.16 * Math.sqrt(node.tokens / maxN) });
      });
      return { name: c.name, lat: lat0, lon: lon0, v: [Math.cos(lat0) * Math.sin(lon0), Math.sin(lat0), Math.cos(lat0) * Math.cos(lon0)] };
    });
    this.pts = [...byId.values()];
    this.links = d.edges.filter(e => byId.has(e.s) && byId.has(e.t)).map((e, i) => ({ a: byId.get(e.s), b: byId.get(e.t), i }));
  }
  onFilter() {}
  rot(v) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x = v[0] * cy - v[2] * sy, z1 = v[0] * sy + v[2] * cy;
    return [x, v[1] * cp - z1 * sp, v[1] * sp + z1 * cp];
  }
  project(v, alt = 0) {
    const r = this.rot(v), s0 = 1 + alt, D = 3.4, p = D / (D - r[2] * s0), R = Math.min(this.w, this.h) * 0.34 * this.zoom;
    return [this.w / 2 + r[0] * s0 * R * p, this.h / 2 + 10 - r[1] * s0 * R * p, r[2], p];
  }
  dragBy(dx, dy) { this.userMoved = true; this.tyaw = null; this.vy = -dx * 0.0055; this.vp = dy * 0.0055; this.yaw += this.vy; this.pitch = clamp(this.pitch + this.vp, -1.35, 1.35); this.wake(); }
  dragEnd() { if (reduce.matches) this.vy = this.vp = 0; }
  zoomAt(sx, sy, f) { this.userMoved = true; this.tzoom = clamp(this.tzoom * f, 0.55, 4.5); this.wake(); }
  panBy(dx, dy) { this.dragBy(dx, dy); }
  key(e) {
    const m = { ArrowLeft: () => this.dragBy(30, 0), ArrowRight: () => this.dragBy(-30, 0), ArrowUp: () => this.dragBy(0, -30), ArrowDown: () => this.dragBy(0, 30),
      '+': () => this.zoomAt(0, 0, 1.25), '=': () => this.zoomAt(0, 0, 1.25), '-': () => this.zoomAt(0, 0, 0.8), '0': () => this.fit() };
    if (m[e.key]) { e.preventDefault(); m[e.key](); }
  }
  fit() { this.tzoom = 1; this.tpitch = 0.38; this.tyaw = this.yaw; this.userMoved = false; this.wake(); }
  isFit() { return !this.userMoved; }
  screenOf(id) { const p = this.proj.find(q => q.P.node.id === id); return p ? [p.x, p.y] : null; }
  frame(now) {
    if (!this.active || document.hidden || !this.data) { this.running = false; return; }
    const dt = Math.min(50, now - (this.last || now)); this.last = now;
    let busy = false;
    const spin = !this.hover && !this.drag && this.tyaw === null && !reduce.matches;
    if (spin) this.yaw += dt * 0.00007;
    if (!this.drag && Math.abs(this.vy) + Math.abs(this.vp) > 1e-5) { this.yaw += this.vy; this.pitch = clamp(this.pitch + this.vp, -1.35, 1.35); this.vy *= 0.92; this.vp *= 0.92; busy = true; }
    if (this.tyaw !== null) {
      const d = ((this.tyaw - this.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI, k = reduce.matches ? 1 : 0.12;
      this.yaw += d * k; this.pitch = lerp(this.pitch, this.tpitch, k);
      if (Math.abs(d) < 0.002 && Math.abs(this.pitch - this.tpitch) < 0.002) this.tyaw = null; busy = true;
    }
    if (Math.abs(this.zoom - this.tzoom) > 1e-3) { this.zoom = lerp(this.zoom, this.tzoom, reduce.matches ? 1 : 0.16); busy = true; } else this.zoom = this.tzoom;
    const idle = !reduce.matches; // link pulses keep moving
    if (this.bursts && this.bursts.length) busy = true;
    if (busy || this.dirty || (idle && now - this.lastDraw > 32)) { this.paint(now); this.drawBursts(this.g, now); this.lastDraw = now; this.dirty = false; if (this.o.onFrame) this.o.onFrame(this); }
    if (busy || idle) requestAnimationFrame(t => this.frame(t)); else this.running = false;
  }
  paint(now) {
    const g = this.g, t = this.t, W = this.w, H = this.h, cx = W / 2, cy = H / 2 + 10;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = t.bg; g.fillRect(0, 0, W, H);
    g.fillStyle = t.text;
    for (const s of this.stars) { g.globalAlpha = (t.dark ? 0.35 : 0.12) * (0.6 + 0.4 * Math.sin(now * 0.001 + s.p)); g.beginPath(); g.arc(s.x * W, s.y * H, s.r, 0, TAU); g.fill(); }
    const R = Math.min(W, H) * 0.34 * this.zoom, Rs = R * 3.4 / Math.sqrt(3.4 * 3.4 - 1);
    // atmosphere and body
    g.globalAlpha = 1;
    const atm = g.createRadialGradient(cx, cy, Rs * 0.92, cx, cy, Rs * 1.32);
    atm.addColorStop(0, t.holo + (t.dark ? '00' : '00')); atm.addColorStop(0.12, t.holo + (t.dark ? '55' : '30')); atm.addColorStop(1, t.holo + '00');
    g.fillStyle = atm; g.beginPath(); g.arc(cx, cy, Rs * 1.32, 0, TAU); g.fill();
    const body = g.createRadialGradient(cx - Rs * 0.35, cy - Rs * 0.4, Rs * 0.1, cx, cy, Rs);
    body.addColorStop(0, t.raised); body.addColorStop(1, t.bg);
    g.fillStyle = body; g.beginPath(); g.arc(cx, cy, Rs, 0, TAU); g.fill();
    g.lineWidth = 1.2; g.strokeStyle = t.holo; g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1;
    // holographic grid: bright on the near side, faint on the far side
    const vis = r => r[2] > 1 / 3.4;
    const poly = (pts, front) => { g.beginPath(); let pen = false; for (const v of pts) { const p = this.project(v); if (vis(p) === front) { pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); pen = true; } else pen = false; } g.stroke(); };
    const lat = (a) => Array.from({ length: 73 }, (_, i) => { const l = i / 72 * TAU; return [Math.cos(a) * Math.sin(l), Math.sin(a), Math.cos(a) * Math.cos(l)]; });
    const lon = (l) => Array.from({ length: 49 }, (_, i) => { const a = -Math.PI / 2 + i / 48 * Math.PI; return [Math.cos(a) * Math.sin(l), Math.sin(a), Math.cos(a) * Math.cos(l)]; });
    g.strokeStyle = t.holo; g.lineWidth = 0.8;
    for (const front of [false, true]) {
      g.globalAlpha = front ? (t.dark ? 0.2 : 0.3) : 0.05;
      for (let a = -75; a <= 75; a += 15) poly(lat(a * Math.PI / 180), front);
      for (let l = 0; l < 360; l += 15) poly(lon(l * Math.PI / 180), front);
    }
    g.globalAlpha = 1;
    // continent glow per category
    for (const c of this.cats) {
      const p = this.project(c.v); if (!vis(p)) continue;
      const rr = R * 0.42 * p[3], col = this.o.catColor(c.name);
      g.globalAlpha = (t.dark ? 0.32 : 0.18) * Math.min(1, (p[2] - 0.29) * 3); g.drawImage(sprite(col), p[0] - rr, p[1] - rr, rr * 2, rr * 2);
    }
    g.globalAlpha = 1;
    // links: arcs lifted off the surface, with a data pulse running along each
    const hov = this.hover && this.hover.key;
    for (const L of this.links) {
      if (!this.seen(L.a.node) || !this.seen(L.b.node)) continue;
      const a = L.a.v, b = L.b.v, dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1), th = Math.acos(dot), so = Math.sin(th) || 1e-6;
      const on = hov === L.a.node.id || hov === L.b.node.id, pts = [];
      for (let i = 0; i <= 24; i++) {
        const u = i / 24, w1 = Math.sin((1 - u) * th) / so, w2 = Math.sin(u * th) / so, alt = 0.02 + 0.13 * (th / Math.PI) * Math.sin(Math.PI * u);
        pts.push(this.project([a[0] * w1 + b[0] * w2, a[1] * w1 + b[1] * w2, a[2] * w1 + b[2] * w2], alt));
      }
      g.lineWidth = on ? 2 : 1.1; g.strokeStyle = on ? t.accent : this.o.colorOf(L.a.node);
      for (let i = 1; i < pts.length; i++) { const p = pts[i - 1], q = pts[i]; g.globalAlpha = (on ? 0.95 : 0.4) * (q[2] > 0.2 ? 1 : q[2] > 0 ? 0.35 : 0.04); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); }
      if (!reduce.matches) {
        const u = ((now * 0.00035 + L.i * 0.137) % 1), p = pts[Math.min(24, Math.floor(u * 24))];
        if (p[2] > 0) { g.globalAlpha = 0.9; const z = on ? 9 : 6; g.drawImage(sprite(on ? t.accent : this.o.colorOf(L.a.node)), p[0] - z, p[1] - z, z * 2, z * 2); }
      }
    }
    g.globalAlpha = 1;
    // projects: a beam rising from the surface with a glowing head
    const proj = this.pts.filter(P => this.seen(P.node)).map(P => { const base = this.project(P.v), tip = this.project(P.v, P.hgt); return { P, base, tip }; }).sort((a, b) => a.tip[2] - b.tip[2]);
    this.proj = [];
    for (const { P, base, tip } of proj) {
      const front = vis(tip), col = this.o.colorOf(P.node), on = hov === P.node.id, sc = tip[3] * this.zoom, ml = this.lit(P.node) ? 1 : 0.15;
      if (!front) { g.globalAlpha = 0.18; g.fillStyle = col; g.beginPath(); g.arc(base[0], base[1], 1.6, 0, TAU); g.fill(); continue; }
      const fade = Math.min(1, (tip[2] - 0.29) * 4) * ml;
      g.globalAlpha = 0.75 * fade; g.strokeStyle = col; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(base[0], base[1]); g.lineTo(tip[0], tip[1]); g.stroke();
      const r = (2.4 + 3.2 * Math.sqrt(P.hgt / 0.2)) * Math.min(1.8, sc);
      g.globalAlpha = (t.dark ? 0.7 : 0.4) * fade; g.drawImage(sprite(col), tip[0] - r * 3, tip[1] - r * 3, r * 6, r * 6);
      const img = P.node.icon && this.o.iconOf(P.node.host);
      if (img) { // favicon on a dark disc, ringed in the category colour
        const rr = Math.max(r, 8.5 * Math.min(1.6, sc));
        g.globalAlpha = fade; g.beginPath(); g.arc(tip[0], tip[1], rr, 0, TAU); g.fillStyle = t.bg2; g.fill();
        g.lineWidth = 1.6; g.strokeStyle = on ? t.accent : col; g.stroke();
        const z = rr * 1.25; g.drawImage(img, tip[0] - z / 2, tip[1] - z / 2, z, z);
        if (P.node.status) { g.lineWidth = 1.4; g.strokeStyle = statusColor(t, P.node.status); g.beginPath(); g.arc(tip[0], tip[1], rr + 2.5, 0, TAU); g.stroke(); }
        g.beginPath(); g.ellipse(base[0], base[1], 3.5 * sc, 1.6 * sc, 0, 0, TAU); g.globalAlpha = 0.5 * fade; g.fillStyle = col; g.fill();
        this.proj.push({ P, x: tip[0], y: tip[1], r: rr, fade });
        continue;
      }
      g.globalAlpha = fade; g.beginPath(); g.arc(tip[0], tip[1], r, 0, TAU); g.fillStyle = on ? t.accent : col; g.fill();
      if (P.node.status) { g.lineWidth = 1.4; g.strokeStyle = statusColor(t, P.node.status); g.beginPath(); g.arc(tip[0], tip[1], r + 2.5, 0, TAU); g.stroke(); }
      g.beginPath(); g.ellipse(base[0], base[1], 3.5 * sc, 1.6 * sc, 0, 0, TAU); g.globalAlpha = 0.5 * fade; g.fillStyle = col; g.fill();
      this.proj.push({ P, x: tip[0], y: tip[1], r, fade });
    }
    // labels: biggest first, no overlaps
    const boxes = []; g.globalAlpha = 1;
    const order = [...this.proj].sort((a, b) => (b.P.node.id === hov) - (a.P.node.id === hov) || b.P.node.tokens - a.P.node.tokens);
    for (const p of order) {
      if (p.fade < 0.5 || (!this.o.labels() && p.P.node.id !== hov) || (this.match && !this.match.has(p.P.node.id)) || (p.P.node.id !== hov && this.zoom < 1.35 && boxes.length >= 14)) continue;
      g.font = `${p.P.node.id === hov ? 600 : 500} 12px ${FONT}`;
      const w = g.measureText(p.P.node.label).width, box = [p.x + p.r + 4, p.y - 8, p.x + p.r + 8 + w, p.y + 8];
      if (boxes.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      boxes.push(box); text(g, t, p.P.node.label, p.x + p.r + 6, p.y, { size: 12, weight: p.P.node.id === hov ? 600 : 500 });
    }
  }
  hit(x, y) { return null; }
  hitScreen(sx, sy) {
    let best = null, bd = 12;
    for (const p of this.proj) { const d = Math.hypot(p.x - sx, p.y - sy); if (d < Math.max(bd, p.r + 4) && (!best || d < bd)) { best = p; bd = d; } }
    return best ? { key: best.P.node.id, kind: 'note', node: best.P.node } : null;
  }
  click(h) { if (h) this.o.onOpen(h.node); }
  dbl(h) { this.lookAt(h.node.id, 2); }
  lookAt(id, z) { const P = this.pts.find(p => p.node.id === id); if (!P) return; this.tyaw = -P.lon; this.tpitch = clamp(P.lat, -1.35, 1.35); if (z) this.tzoom = Math.max(this.tzoom, z); this.wake(); }
  focus(id) { this.lookAt(id, 1.8); const P = this.pts.find(p => p.node.id === id); if (P) this.hover = { key: id, kind: 'note', node: P.node }; }
  // minimap: a flat world map (longitude across, latitude down) with the view's centre and reach
  bounds() { return { x0: -Math.PI, y0: -Math.PI / 2, x1: Math.PI, y1: Math.PI / 2 }; }
  paintMini(g, map) {
    g.strokeStyle = this.t.holo; g.globalAlpha = 0.25; g.lineWidth = 0.6;
    for (let l = -150; l <= 180; l += 30) { const [x0, y0] = map(l * Math.PI / 180, -Math.PI / 2), [, y1] = map(0, Math.PI / 2); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0, y1); g.stroke(); }
    for (let a = -60; a <= 60; a += 30) { const [x0, y0] = map(-Math.PI, -a * Math.PI / 180), [x1] = map(Math.PI, 0); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y0); g.stroke(); }
    g.globalAlpha = 0.9;
    for (const P of this.pts) { let lon = ((P.lon + Math.PI) % TAU + TAU) % TAU - Math.PI; const [x, y] = map(lon, -P.lat); g.fillStyle = this.o.colorOf(P.node); g.beginPath(); g.arc(x, y, 1.6, 0, TAU); g.fill(); }
    g.globalAlpha = 1;
  }
  viewport() {
    const lon = ((-this.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI, half = Math.PI / 2 / this.zoom;
    return { x0: lon - half, x1: lon + half, y0: -this.pitch - half / 1.4, y1: -this.pitch + half / 1.4 };
  }
  goTo(x, y) { this.tyaw = -x; this.tpitch = clamp(-y, -1.35, 1.35); this.wake(); }
}

// ---------- Minimap: the whole view in miniature, with the visible area; click or drag to move ----------
export class Minimap {
  constructor(cv) {
    this.cv = cv; this.g = cv.getContext('2d'); this.view = null; this.pending = false; this.inv = null;
    const go = e => { if (!this.inv || !this.view) return; const r = cv.getBoundingClientRect(); const [x, y] = this.inv(e.clientX - r.left, e.clientY - r.top); this.view.goTo(x, y); this.request(); };
    cv.addEventListener('pointerdown', e => { this.down = true; try { cv.setPointerCapture(e.pointerId); } catch {} go(e); });
    cv.addEventListener('pointermove', e => { if (this.down) go(e); });
    cv.addEventListener('pointerup', () => { this.down = false; });
    cv.addEventListener('pointercancel', () => { this.down = false; });
  }
  attach(view) { this.view = view; this.request(); }
  request() { if (this.pending) return; this.pending = true; setTimeout(() => { this.pending = false; this.draw(); }, 66); }
  draw() {
    const v = this.view, cv = this.cv; if (!v || v.data === null || cv.offsetParent === null) return;
    const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1, W = r.width, H = r.height;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = this.g; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const b = v.bounds && v.bounds(); if (!b) return;
    const pad = 8, s = Math.min((W - pad * 2) / (b.x1 - b.x0 || 1), (H - pad * 2) / (b.y1 - b.y0 || 1));
    const ox = (W - (b.x1 - b.x0) * s) / 2, oy = (H - (b.y1 - b.y0) * s) / 2;
    const map = (x, y) => [ox + (x - b.x0) * s, oy + (y - b.y0) * s];
    this.inv = (mx, my) => [(mx - ox) / s + b.x0, (my - oy) / s + b.y0];
    v.paintMini(g, map, s);
    const vp = v.viewport(), [x0, y0] = map(vp.x0, vp.y0), [x1, y1] = map(vp.x1, vp.y1);
    const t = themeOf(), rx = clamp(x0, 1, W - 1), ry = clamp(y0, 1, H - 1), rw = clamp(x1, 1, W - 1) - rx, rh = clamp(y1, 1, H - 1) - ry;
    g.fillStyle = t.accent + '1f'; g.fillRect(rx, ry, rw, rh);
    g.strokeStyle = t.accent; g.lineWidth = 1.5; g.strokeRect(rx + 0.5, ry + 0.5, Math.max(2, rw - 1), Math.max(2, rh - 1));
  }
}
