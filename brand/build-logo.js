// Builds the Aiodize Geode mark: a raised dark stone, split open, a few glowing threads inside.
// One drawing for every size (16px to 1024px), so it stays simple: a shaded rim, the hollow, five threads with thin nodes.
// Run: node brand/build-logo.js
'use strict';
const fs = require('fs');
const path = require('path');

const GLOW = '#B884FF';
const OUT = path.join(__dirname, '..', 'web', 'brand');
fs.mkdirSync(OUT, { recursive: true });

const O = [[64, 10], [95, 18], [114, 44], [113, 78], [93, 104], [58, 110], [28, 96], [13, 66], [24, 32]]; // top face
const I = [[64, 29], [85, 35], [97, 52], [96, 75], [83, 91], [60, 94], [40, 85], [31, 64], [39, 43]]; // hollow
const pts = a => a.map(p => p.map(v => +v.toFixed(2)).join(' ')).join(' ');
const mix = (a, b, t) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * (1 - t) + parseInt(b.slice(1 + i, 3 + i), 16) * t).toString(16).padStart(2, '0')).join('');

// Five threads from the core, each ending in a small node well inside the hollow.
const C = [64, 62];
const threads = [
  { to: [62, 42], c: [56, 52] },
  { to: [85, 52], c: [78, 63] },
  { to: [80, 78], c: [80, 67] },
  { to: [56, 82], c: [67, 77] },
  { to: [44, 54], c: [55, 64] },
];
const threadPath = threads.map(t => `M${C[0]} ${C[1]}Q${t.c[0]} ${t.c[1]} ${t.to[0]} ${t.to[1]}`).join('');

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs>
  <linearGradient id="rim" x1="20" y1="14" x2="104" y2="108" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6A6280"/><stop offset=".5" stop-color="#3A3447"/><stop offset="1" stop-color="#1A1721"/></linearGradient>
  <linearGradient id="wall" x1="0" y1="70" x2="0" y2="120" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1C1924"/><stop offset="1" stop-color="#08070B"/></linearGradient>
  <radialGradient id="hollow" cx="64" cy="62" r="36" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${mix('#08070B', GLOW, 0.42)}"/><stop offset=".6" stop-color="${mix('#08070B', GLOW, 0.12)}"/><stop offset="1" stop-color="#07060A"/></radialGradient>
  <linearGradient id="lip" x1="0" y1="29" x2="0" y2="50" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
  <filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<polygon points="${pts(O.map(([x, y]) => [x, y + 9]))}" fill="url(#wall)"/>
<polygon points="${pts(O)}" fill="url(#rim)"/>
<polyline points="${pts([[16, 64], [26, 33], [64, 12], [93, 19]])}" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<polygon points="${pts(I)}" fill="url(#hollow)"/>
<polygon points="${pts(I)}" fill="url(#lip)"/>
<g filter="url(#gl)">
  <path d="${threadPath}" fill="none" stroke="${GLOW}" stroke-width="2.4" stroke-linecap="round"/>
  <g fill="${GLOW}">${threads.map(t => `<circle cx="${t.to[0]}" cy="${t.to[1]}" r="2.6"/>`).join('')}<circle cx="64" cy="62" r="5.6"/></g>
</g>
<circle cx="64" cy="62" r="2.3" fill="#fff"/>
</svg>`;

// One colour: the same drawing as outlines and lines in currentColor.
const mono = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round">
<polygon points="${pts(O)}" stroke-width="7"/><polygon points="${pts(I)}" stroke-width="4"/>
<path d="${threadPath}" stroke-width="3.6"/>
<g fill="currentColor" stroke="none">${threads.map(t => `<circle cx="${t.to[0]}" cy="${t.to[1]}" r="3.8"/>`).join('')}<circle cx="64" cy="62" r="7"/></g>
</svg>`;

fs.writeFileSync(path.join(OUT, 'aiodize-mark.svg'), mark);
fs.writeFileSync(path.join(OUT, 'aiodize-mark-small.svg'), mark); // same drawing; kept so existing links work
fs.writeFileSync(path.join(OUT, 'aiodize-mark-mono.svg'), mono);

// Check: every node sits well inside the hollow, so no thread looks cut off.
const inside = ([x, y]) => { let c = false; for (let i = 0, j = I.length - 1; i < I.length; j = i++) { const [xi, yi] = I[i], [xj, yj] = I[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const dist = ([x, y]) => Math.min(...I.map((a, i) => { const b = I[(i + 1) % I.length], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }));
for (const t of threads) if (!inside(t.to) || dist(t.to) < 8) throw new Error('node too close to the edge: ' + t.to);
console.log('wrote aiodize-mark.svg (all sizes), aiodize-mark-mono.svg');
