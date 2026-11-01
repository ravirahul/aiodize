// Activity charts: GitHub-style 2D map, 3D skyline (ported from the Smart History extension), token bubbles.
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = t => 1 - (1 - t) ** 3;
const rad = d => d * Math.PI / 180;
const pad = n => String(n).padStart(2, '0');
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return dayKey(d); };
const rowOf = k => (parse(k).getDay() + 6) % 7; // Monday first
const weekIndex = (k, start) => Math.floor(Math.round((parse(k) - parse(start)) / 864e5) / 7); // whole days first, then whole weeks
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const longDate = k => { const d = parse(k); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };

// The 97th percentile, so one huge day doesn't flatten the rest (same rule as Smart History).
export function capOf(values) { const v = values.filter(n => n > 0).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.97))] : 0; }
export const level = (n, cap) => !n ? 0 : n >= cap ? 4 : 1 + Math.min(3, Math.floor(n / cap * 4));

function keysBetween(first, last) { const out = []; for (let k = first; k <= last; k = addDays(k, 1)) out.push(k); return out; }
const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();

// ---------- tooltip shared by all charts ----------
export function makeTip() {
  const el = document.createElement('div');
  el.className = 'tip'; el.hidden = true; el.setAttribute('role', 'tooltip');
  document.body.append(el);
  return { show(text, x, y) { el.textContent = text; el.hidden = false; const w = el.offsetWidth; el.style.left = clamp(x - w / 2, 8, innerWidth - w - 8) + 'px'; el.style.top = Math.max(8, y - el.offsetHeight - 6) + 'px'; }, hide() { el.hidden = true; } };
}

// ---------- 2D: one square per day. A year reads like GitHub (weeks as columns);
// a week or a month becomes a calendar (weekdays as columns) with big squares that show the date. ----------
export function heatmap2d(counts, first, last, { tip, fmt, onPick, selected }) {
  const NS = 'http://www.w3.org/2000/svg';
  const start = addDays(first, -rowOf(first));
  const keys = keysBetween(first, last);
  const weeks = weekIndex(addDays(last, -rowOf(last)), start) + 1;
  const cal = keys.length <= 31;
  const C = cal ? 40 : 12, G = cal ? 6 : 3, L = cal ? 52 : 28, T = cal ? 20 : 18;
  const cap = capOf(keys.map(k => counts[k] || 0)) || 1;
  const svg = document.createElementNS(NS, 'svg');
  const W = cal ? L + 7 * (C + G) : L + weeks * (C + G), H = cal ? T + weeks * (C + G) : T + 7 * (C + G);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'heat2d' + (cal ? ' cal' : '')); svg.setAttribute('tabindex', '0');
  // Squares grow with the space but stop at a comfortable size; labels stay ~11px on screen at any scale.
  svg.style.maxWidth = (cal ? W * 1.9 : keys.length <= 100 ? W * 2.6 : W * 2.4) + 'px';
  new ResizeObserver(() => { const s = svg.clientWidth / W || 1; svg.style.setProperty('--hs', (11 / s) + 'px'); svg.style.setProperty('--hd', (12 / s) + 'px'); }).observe(svg);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Daily activity from ${longDate(first)} to ${longDate(last)}. Use arrow keys to move between days and Enter to open one.`);
  const mk = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text) e.textContent = text; svg.append(e); return e; };
  if (cal) ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => mk('text', { x: L + i * (C + G) + C / 2, y: 12, class: 'hl', 'text-anchor': 'middle' }, d));
  else ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((d, i) => d && mk('text', { x: 0, y: T + i * (C + G) + C - 2, class: 'hl' }, d));
  let lastMonth = -1;
  const rects = new Map();
  for (const k of keys) {
    const wi = weekIndex(k, start), m = parse(k).getMonth();
    const x = cal ? L + rowOf(k) * (C + G) : L + wi * (C + G), y = cal ? T + wi * (C + G) : T + rowOf(k) * (C + G);
    if (cal && (rowOf(k) === 0 || k === first)) { const d = parse(k); mk('text', { x: 0, y: y + C / 2 + 4, class: 'hl' }, `${d.getDate()} ${MONTHS[d.getMonth()]}`); }
    if (!cal && rowOf(k) === 0 && m !== lastMonth) { lastMonth = m; mk('text', { x, y: 11, class: 'hl' }, MONTHS[m]); }
    const lv = level(counts[k] || 0, cap);
    const r = mk('rect', { x, y, width: C, height: C, rx: cal ? 6 : 2.5, class: 'hc l' + lv + (k === selected ? ' sel' : '') });
    r.dataset.k = k; rects.set(k, r);
    if (cal) { const t = mk('text', { x: x + 7, y: y + 15, class: 'hd' + (lv >= 3 ? ' on' : '') }, String(parse(k).getDate())); t.dataset.k = k; }
  }
  let focus = selected || last;
  const showTip = k => { const r = rects.get(k); if (!r) return; const b = r.getBoundingClientRect(); tip.show(`${fmt(counts[k] || 0)} · ${longDate(k)}`, b.left + b.width / 2, b.top); };
  svg.addEventListener('pointermove', e => { const k = e.target.dataset && e.target.dataset.k; k ? showTip(k) : tip.hide(); });
  svg.addEventListener('pointerleave', () => tip.hide());
  svg.addEventListener('click', e => { const k = e.target.dataset && e.target.dataset.k; if (k) onPick(k); });
  svg.addEventListener('keydown', e => {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (step) { e.preventDefault(); const n = addDays(focus, step); if (rects.has(n)) { rects.get(focus).classList.remove('kf'); focus = n; rects.get(n).classList.add('kf'); showTip(n); } }
    if (e.key === 'Enter') onPick(focus);
  });
  svg.addEventListener('blur', () => tip.hide());
  return svg;
}

// ---------- 3D skyline: same data as bars you can turn ----------
const S = 11, MAXH = 78, BASE = 2.5, INSET = 0.1;
const DEFAULT = { yaw: 34, pitch: 40 };
export const view = { ...DEFAULT };
const EDGES = [[0, 0, 1, 0, 0, -1], [1, 0, 1, 1, 1, 0], [1, 1, 0, 1, 0, 1], [0, 1, 0, 0, -1, 0]];
function inside(pts, x, y) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }

export function skyline(counts, first, last, { tip, fmt, onPick, selected }) {
  const start = addDays(first, -rowOf(first));
  const keys = keysBetween(first, last);
  const cols = weekIndex(addDays(last, -rowOf(last)), start) + 1;
  const cap = capOf(keys.map(k => counts[k] || 0)) || 1;
  const cx = cols / 2, cy = 3.5;
  const cells = keys.map(k => { const n = counts[k] || 0; return { k, n, lvl: level(n, cap), x: weekIndex(k, start), y: rowOf(k), h: BASE + (n ? 4 + Math.min(1, n / cap) * MAXH : 0) }; });
  const cv = document.createElement('canvas');
  cv.className = 'sky'; cv.tabIndex = 0;
  cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', `3D chart of daily activity from ${longDate(first)} to ${longDate(last)}. Drag to turn it, double-click to reset.`);
  const g = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, hover = null, rise = reduced() ? 1 : 0, sorted = cells;
  function draw() {
    if (!W) return;
    const cs = Math.cos(rad(view.yaw)), sn = Math.sin(rad(view.yaw)), sp = Math.sin(rad(view.pitch)), cp = Math.cos(rad(view.pitch));
    const P = (x, y, z) => { const X = (x - cx) * cs - (y - cy) * sn, D = (x - cx) * sn + (y - cy) * cs; return [X * S, D * S * sp - z * cp]; };
    const foot = [[0, 0], [cols, 0], [cols, 7], [0, 7]].map(([x, y]) => P(x, y, 0));
    const x0 = Math.min(...foot.map(p => p[0])) - 8, x1 = Math.max(...foot.map(p => p[0])) + 8;
    const y0 = Math.min(...foot.map(p => p[1])) - (BASE + 4 + MAXH) * cp - 8, y1 = Math.max(...foot.map(p => p[1])) + 8;
    const k = Math.min(W / (x1 - x0), H / (y1 - y0));
    const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
    const Q = (x, y, z) => { const p = P(x, y, z); return [p[0] * k + ox, p[1] * k + oy]; };
    for (const c of cells) {
      const grow = rise >= 1 ? 1 : easeOut(clamp(rise * 1.7 - c.x / cols * 0.7, 0, 1));
      const z = BASE + (c.h - BASE) * grow;
      const xa = c.x + INSET, xb = c.x + 1 - INSET, ya = c.y + INSET, yb = c.y + 1 - INSET;
      const X = u => u ? xb : xa, Y = u => u ? yb : ya;
      c.top = [Q(xa, ya, z), Q(xb, ya, z), Q(xb, yb, z), Q(xa, yb, z)];
      const faces = [];
      for (const [ax, ay, bx, by, nx, ny] of EDGES) { if (nx * sn + ny * cs <= 0) continue; faces.push([Q(X(ax), Y(ay), z), Q(X(bx), Y(by), z), Q(X(bx), Y(by), 0), Q(X(ax), Y(ay), 0)]); }
      faces.sort((p, q) => p[0][0] + p[1][0] - (q[0][0] + q[1][0]));
      c.faces = faces; c.depth = (c.x + 0.5 - cx) * sn + (c.y + 0.5 - cy) * cs;
    }
    sorted = [...cells].sort((p, q) => p.depth - q.depth);
    const heat = [0, 1, 2, 3, 4].map(i => css(cv, '--heat-' + i)), ink = css(cv, '--text'), edge = css(cv, '--line');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); g.lineJoin = 'round'; g.lineWidth = 0.5;
    const poly = pts => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); };
    for (const c of sorted) {
      const fill = heat[c.lvl];
      c.faces.forEach((f, i) => { poly(f); g.fillStyle = fill; g.fill(); g.fillStyle = `rgba(0,0,0,${i ? 0.34 : 0.18})`; g.fill(); g.strokeStyle = edge; g.stroke(); });
      poly(c.top); g.fillStyle = fill; g.fill();
      if (c === hover || c.k === selected) { g.fillStyle = 'rgba(255,255,255,0.32)'; g.fill(); }
      g.strokeStyle = c.k === selected ? ink : edge; g.lineWidth = c.k === selected ? 1.5 : 0.5; g.stroke(); g.lineWidth = 0.5;
    }
  }
  function resize() { const r = cv.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); draw(); }
  const ro = new ResizeObserver(resize); ro.observe(cv);
  let raf = 0, spin = 0, tween = null, drag = null, lastX = 0, lastT = 0;
  const kick = () => { raf ||= requestAnimationFrame(frame); };
  function frame(now) {
    raf = 0; let more = false;
    if (rise < 1) { rise = Math.min(1, rise + 1 / 42); more = true; }
    if (tween) { const t = Math.min(1, (now - tween.t0) / tween.ms); view.yaw = tween.from.yaw + (tween.to.yaw - tween.from.yaw) * easeOut(t); view.pitch = tween.from.pitch + (tween.to.pitch - tween.from.pitch) * easeOut(t); if (t < 1) more = true; else tween = null; }
    else if (Math.abs(spin) > 0.05 && !drag) { view.yaw += spin; spin *= 0.92; more = true; }
    draw(); if (more) kick();
  }
  const go = (to, ms = 450) => { spin = 0; if (reduced()) { Object.assign(view, to); draw(); return; } tween = { from: { ...view }, to, t0: performance.now(), ms }; kick(); };
  const hit = (x, y) => { for (let i = sorted.length - 1; i >= 0; i--) { const c = sorted[i]; if (c.top && (inside(c.top, x, y) || c.faces.some(f => inside(f, x, y)))) return c; } return null; };
  const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', e => { if (e.button !== 0) return; tween = null; spin = 0; drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, moved: false }; lastX = e.clientX; lastT = e.timeStamp; });
  cv.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { drag.moved = true; try { cv.setPointerCapture(e.pointerId); } catch {} tip.hide(); hover = null; }
      view.yaw = drag.yaw + dx * 0.45; view.pitch = clamp(drag.pitch + dy * 0.3, 12, 88);
      spin = (e.clientX - lastX) * 0.45 / Math.max(1, (e.timeStamp - lastT) / 16); lastX = e.clientX; lastT = e.timeStamp; kick(); return;
    }
    if (raf) return;
    const c = hit(...local(e));
    if (c !== hover) { hover = c; draw(); }
    if (!c) return tip.hide();
    const r = cv.getBoundingClientRect(), xs = c.top.map(p => p[0]), ys = c.top.map(p => p[1]);
    tip.show(`${fmt(c.n)} · ${longDate(c.k)}`, r.left + (Math.min(...xs) + Math.max(...xs)) / 2, r.top + Math.min(...ys));
  });
  const end = e => { if (!drag) return; const was = drag.moved; drag = null; if (!was) { const c = hit(...local(e)); if (c) onPick(c.k); return; } if (reduced() || e.timeStamp - lastT > 80) spin = 0; if (spin) kick(); };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', () => { drag = null; });
  cv.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; draw(); } tip.hide(); });
  cv.addEventListener('dblclick', () => go({ ...DEFAULT }));
  cv.addEventListener('keydown', e => {
    const m = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
    if (m) { e.preventDefault(); go({ yaw: view.yaw + m[0], pitch: clamp(view.pitch + m[1], 12, 88) }, 250); }
    if (e.key === '0') go({ ...DEFAULT });
  });
  kick();
  cv.stop = () => { cancelAnimationFrame(raf); ro.disconnect(); };
  return cv;
}

// Circle packing: radius ~ sqrt(value), pulled to the centre while pushing apart, then push-only passes
// until nothing overlaps. ponytail: O(n²) per pass, fine for the ~160 bubbles we draw.
export function pack(items) {
  const max = Math.max(1, ...items.map(i => i.value));
  const B = items.filter(i => i.value > 0).map((i, n) => ({ ...i, r: Math.sqrt(i.value / max), x: Math.cos(n * 2.4) * Math.sqrt(n) * 0.3, y: Math.sin(n * 2.4) * Math.sqrt(n) * 0.3, ph: n * 1.7 }));
  for (let it = 0; it < 900; it++) {
    if (it < 350) for (const a of B) { a.x *= 0.985; a.y *= 0.985; }
    let moved = false;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1e-6, min = a.r + b.r + 0.01;
      if (d < min) { const p = (min - d) / d / 2; a.x -= dx * p; a.y -= dy * p; b.x += dx * p; b.y += dy * p; moved = true; }
    }
    if (it >= 350 && !moved) break;
  }
  return B;
}

// ---------- token bubbles: one circle per project (or per file inside a project), area = tokens.
// Wheel or pinch to zoom, drag to pan, double-click a bubble to zoom to it, double-click empty space to reset.
export function bubbles(items, { tip, fmt, onPick, iconSrc, colorOf }) {
  const cv = document.createElement('canvas');
  cv.className = 'bubbles'; cv.tabIndex = 0;
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Token use: ' + items.slice(0, 8).map(i => `${i.title} ${fmt(i.value)}`).join(', ') + '. Scroll to zoom, drag to move, plus and minus keys zoom.');
  const g = cv.getContext('2d');
  const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  const B = pack(items);
  const icons = new Map();
  const iconOf = host => { if (!host) return null; let e = icons.get(host); if (!e) { e = new Image(); e.onload = () => wake(); e.src = iconSrc(host); icons.set(host, e); } return e.complete && e.naturalWidth ? e : null; };
  let W = 0, H = 0, dpr = 1, hover = null, k = 1, ox = 0, oy = 0;
  const t0 = performance.now();
  const cam = { z: 1, x: 0, y: 0, tz: 1, tx: 0, ty: 0 };
  function layout() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of B) { x0 = Math.min(x0, b.x - b.r); y0 = Math.min(y0, b.y - b.r); x1 = Math.max(x1, b.x + b.r); y1 = Math.max(y1, b.y + b.r); }
    k = Math.max(0.01, Math.min((W - 16) / (x1 - x0), (H - 16) / (y1 - y0))); ox = W / 2 - (x0 + x1) / 2 * k; oy = H / 2 - (y0 + y1) / 2 * k;
  }
  // packed units -> screen: first fit to the canvas, then the zoom camera
  const at = (b, now) => {
    const f = reduced() ? 0 : 1.4;
    const fx = ox + b.x * k + Math.sin(now * 0.0005 + b.ph) * f, fy = oy + b.y * k + Math.cos(now * 0.00043 + b.ph) * f;
    return [fx * cam.z + cam.x, fy * cam.z + cam.y, b.r * k * cam.z];
  };
  function draw(now) {
    if (W < 40 || H < 40) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const grow = reduced() ? 1 : easeOut(Math.min(1, (now - t0) / 700));
    const bg = css(cv, '--surface'), text = css(cv, '--text'), muted = css(cv, '--muted');
    for (const b of B) {
      const [x, y, R0] = at(b, now), R = R0 * grow, col = colorOf(b);
      if (x + R < 0 || x - R > W || y + R < 0 || y - R > H) continue;
      g.globalAlpha = hover === b ? 0.36 : 0.2; g.fillStyle = col; g.beginPath(); g.arc(x, y, Math.max(0.5, R), 0, 6.283); g.fill();
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = hover === b ? 2 : 1.1; g.stroke();
      const img = R > 18 ? iconOf(b.host) : null;
      let ly = y - 6;
      if (img) { const s = Math.min(28, R * 0.5), iy = y - (R > 40 ? 10 : 0); g.fillStyle = bg; g.beginPath(); g.arc(x, iy, s * 0.75, 0, 6.283); g.fill(); g.drawImage(img, x - s / 2, iy - s / 2, s, s); ly = iy + s * 0.5 + 10; }
      if (R > 22) { // label only when it fits inside the circle
        const fs1 = clamp(R / 4.5, 11, 15), fs2 = clamp(R / 5.5, 10, 13);
        const room = 2 * Math.sqrt(Math.max(0, R * R - (ly + fs1 + 2 - y) ** 2)) - 8;
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `600 ${fs1}px ${FONT}`;
        let label = b.title; while (g.measureText(label).width > room && label.length > 4) label = label.slice(0, -2) + '…';
        if (g.measureText(label).width <= room) {
          g.fillStyle = text; g.fillText(label, x, ly);
          const v = fmt(b.value).replace(' tokens', '');
          g.font = `500 ${fs2}px ${FONT}`;
          if (g.measureText(v).width <= room) { g.fillStyle = muted; g.fillText(v, x, ly + fs1 + 2); }
        }
      }
    }
    if (cam.tz > 1.01) {
      const msg = `${cam.tz.toFixed(1)}× · double-click empty space to reset`;
      g.font = `500 12px ${FONT}`; const tw = g.measureText(msg).width;
      g.fillStyle = bg; g.globalAlpha = 0.92; g.beginPath(); g.roundRect(W - tw - 22, 6, tw + 14, 22, 11); g.fill(); g.globalAlpha = 1;
      g.fillStyle = muted; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(msg, W - 15, 17);
    }
  }
  function resize() { const r = cv.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); layout(); wake(); }
  const ro = new ResizeObserver(resize); ro.observe(cv);
  let raf = 0, last = 0;
  const moving = () => Math.abs(cam.tz - cam.z) > 1e-3 || Math.abs(cam.tx - cam.x) > 0.3 || Math.abs(cam.ty - cam.y) > 0.3;
  function loop(now) {
    raf = 0; if (!cv.isConnected) return;
    const s = reduced() ? 1 : 0.2;
    cam.z += (cam.tz - cam.z) * s; cam.x += (cam.tx - cam.x) * s; cam.y += (cam.ty - cam.y) * s;
    const busy = moving() || now - t0 < 800;
    if (busy || now - last > 32) { draw(now); last = now; }
    if (busy || (!reduced() && !document.hidden)) raf = requestAnimationFrame(loop);
  }
  function wake() { if (!raf && cv.isConnected) raf = requestAnimationFrame(loop); }
  requestAnimationFrame(() => wake());
  document.addEventListener('visibilitychange', wake);
  const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const hit = (mx, my) => { const now = performance.now(); let best = null; for (const b of B) { const [x, y, R] = at(b, now); if (Math.hypot(mx - x, my - y) < R && (!best || R < best.R)) best = { b, R }; } return best && best.b; };
  const zoomAt = (mx, my, f) => { const z = clamp(cam.tz * f, 1, 60); cam.tx = mx - (mx - cam.tx) * z / cam.tz; cam.ty = my - (my - cam.ty) * z / cam.tz; cam.tz = z; if (z === 1) { cam.tx = 0; cam.ty = 0; } wake(); };
  cv.addEventListener('wheel', e => { e.preventDefault(); const [mx, my] = local(e); zoomAt(mx, my, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))); }, { passive: false });
  let drag = null; const ptrs = new Map();
  const pd = () => { const p = [...ptrs.values()]; return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1; };
  cv.addEventListener('pointerdown', e => { const [mx, my] = local(e); ptrs.set(e.pointerId, [mx, my]); drag = { mx, my, moved: 0, d0: ptrs.size === 2 ? pd() : 0, z0: cam.tz }; });
  cv.addEventListener('pointermove', e => {
    const [mx, my] = local(e);
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [mx, my]);
    if (drag && ptrs.size === 2 && drag.d0) { const p = [...ptrs.values()]; zoomAt((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2, drag.z0 * pd() / drag.d0 / cam.tz); return; }
    if (drag && ptrs.size === 1) {
      const dx = mx - drag.mx, dy = my - drag.my; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4 && cam.tz > 1) { try { cv.setPointerCapture(e.pointerId); } catch {} cam.tx += dx; cam.ty += dy; cam.x = cam.tx; cam.y = cam.ty; tip.hide(); wake(); }
      drag.mx = mx; drag.my = my; return;
    }
    const b = hit(mx, my); if (b !== hover) { hover = b; cv.style.cursor = b ? 'pointer' : cam.tz > 1 ? 'grab' : 'default'; wake(); }
    if (b) tip.show(`${b.path || b.title} · ${fmt(b.value)}`, e.clientX, e.clientY - 8); else tip.hide();
  });
  const up = e => { ptrs.delete(e.pointerId); if (drag && drag.moved < 5 && ptrs.size === 0) { const [mx, my] = local(e); const b = hit(mx, my); if (b) onPick(b); } if (!ptrs.size) drag = null; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { hover = null; tip.hide(); });
  cv.addEventListener('dblclick', e => {
    const [mx, my] = local(e), b = hit(mx, my);
    if (!b) { cam.tz = 1; cam.tx = 0; cam.ty = 0; wake(); return; }
    const [x, y, R] = at(b, performance.now()), z = clamp(cam.tz * Math.min(W, H) * 0.32 / R, 1, 60);
    cam.tx = W / 2 - (x - cam.x) / cam.z * z; cam.ty = H / 2 - (y - cam.y) / cam.z * z; cam.tz = z; wake();
  });
  cv.addEventListener('keydown', e => { if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, 1.4); if (e.key === '-') zoomAt(W / 2, H / 2, 1 / 1.4); if (e.key === '0') cv.reset(); });
  cv.zoom = f => zoomAt(W / 2, H / 2, f);
  cv.reset = () => { cam.tz = 1; cam.tx = cam.ty = 0; wake(); };
  cv.stop = () => { cancelAnimationFrame(raf); raf = 0; ro.disconnect(); };
  return cv;
}
