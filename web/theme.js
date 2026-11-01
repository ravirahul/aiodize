// Theme = a base (the greys) + an accent. Loaded in <head> so the page paints in the right colours.
// Accents are written as hex custom properties because the canvases read them and append alpha.
(function () {
  var BASES = {
    graphite: { name: 'Graphite', light: false, night: '#141517', surface: '#1B1C1F', line: '#2F3136', text: '#E6E4DF', muted: '#9C9A94' },
    ink:      { name: 'Ink',      light: false, night: '#0B0B0C', surface: '#131315', line: '#29292D', text: '#E8E6E1', muted: '#96948E' },
    dusk:     { name: 'Dusk',     light: false, night: '#14161F', surface: '#1A1D28', line: '#2E3243', text: '#E4E2DA', muted: '#9A9CAE' },
    paper:    { name: 'Paper',    light: true,  night: '#F6F5F2', surface: '#FFFFFF', line: '#E1DFD9', text: '#23221F', muted: '#66645E' },
    mist:     { name: 'Mist',     light: true,  night: '#F1F3F5', surface: '#FFFFFF', line: '#DCE0E5', text: '#1E2226', muted: '#5E656D' }
  };
  // [on dark, on light]
  var ACCENTS = {
    iodine: { name: 'Iodine', c: ['#B884FF', '#6B3FB8'] },
    amber: { name: 'Amber', c: ['#D6A85C', '#8C5F1E'] },
    sage:  { name: 'Sage',  c: ['#94B89A', '#3F7350'] },
    teal:  { name: 'Teal',  c: ['#62B3A6', '#1F6F65'] },
    steel: { name: 'Steel', c: ['#86A9D6', '#2F5C94'] },
    clay:  { name: 'Clay',  c: ['#D58C70', '#A14B2E'] },
    rose:  { name: 'Rose',  c: ['#DB8FA6', '#A03E5D'] },
    lilac: { name: 'Lilac', c: ['#AFA2DC', '#5A4AA3'] },
    mono:  { name: 'Mono',  c: ['#CFCCC5', '#33322E'] }
  };
  function rgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  function hex(a) { return '#' + a.map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join(''); }
  function mix(a, b, t) { var x = rgb(a), y = rgb(b); return hex(x.map(function (v, i) { return v + (y[i] - v) * t; })); }
  function lum(h) { var c = rgb(h); return c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; }
  function accentOf(base, accent) { return ACCENTS[accent].c[BASES[base].light ? 1 : 0]; }
  function apply(base, accent) {
    if (!BASES[base]) base = matchMedia('(prefers-color-scheme: light)').matches ? 'paper' : 'graphite';
    if (!ACCENTS[accent]) accent = 'iodine';
    var root = document.documentElement, b = BASES[base], a = accentOf(base, accent), heat0 = b.light ? mix(b.night, b.line, 0.5) : mix(b.surface, b.line, 0.4);
    var p = { '--accent': a, '--accent-ink': a, '--c1': a, '--on-accent': lum(a) > 140 ? '#16150F' : '#FFFFFF', '--heat-0': heat0 };
    for (var k = 1; k <= 4; k++) p['--heat-' + k] = mix(heat0, a, [0.22, 0.45, 0.7, 1][k - 1]);
    for (var n in p) root.style.setProperty(n, p[n]);
    root.dataset.theme = base; root.dataset.accent = accent; // observers repaint the canvases on these
    return { base: base, accent: accent };
  }
  // settings saved under the old name (Chitta) carry over once
  try { var old = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('chitta-') === 0) old.push(k); }
    old.forEach(function (k) { var n = 'aiodize-' + k.slice(7); if (localStorage.getItem(n) === null) localStorage.setItem(n, localStorage.getItem(k)); }); } catch (e) {}
  var s = {}; try { s.b = localStorage.getItem('aiodize-theme'); s.a = localStorage.getItem('aiodize-accent');
    if (!localStorage.getItem('aiodize-brand')) { localStorage.setItem('aiodize-brand', '1'); if (!s.a || s.a === 'amber') { s.a = 'iodine'; localStorage.setItem('aiodize-accent', 'iodine'); } } } catch (e) {}
  window.AiodizeTheme = { BASES: BASES, ACCENTS: ACCENTS, apply: apply, accentOf: accentOf, current: apply(s.b, s.a) };
})();
