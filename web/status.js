// The workspace's project statuses (from /api/board), shared by the app, the graph and the views.
export const COLOR_VAR = { green: '--s-ship', amber: '--s-grow', blue: '--s-build', accent: '--accent', grey: '--s-drop', rose: '--rose', clay: '--c2', teal: '--c3', violet: '--c6', sky: '--c7', sand: '--c8' };
export const SHAPES = { full: 'Filled', half: 'Half', dot: 'Ring and dot', dashed: 'Dashed ring', ring: 'Ring' };
export const STAGES = { active: 'Open work', done: 'Done', parked: 'Parked' };
export const DEFAULT_STATUSES = [
  { id: 'live', label: 'Live', color: 'green', shape: 'full', stage: 'done' },
  { id: 'live-partial', label: 'Live, partly', color: 'amber', shape: 'half', stage: 'active' },
  { id: 'built-not-deployed', label: 'Built, not deployed', color: 'blue', shape: 'dot', stage: 'active' },
  { id: 'in-progress', label: 'In progress', color: 'accent', shape: 'dashed', stage: 'active' },
  { id: 'parked', label: 'Parked', color: 'grey', shape: 'ring', stage: 'parked' }
];

export const ST = {
  list: [], by: {},
  set(list) {
    this.list = list; this.by = Object.fromEntries(list.map((s, i) => [s.id, { ...s, i }]));
    document.documentElement.dataset.statuses = String(Date.now()); // canvases re-read colours on this
  },
  label(id) { return this.by[id] ? this.by[id].label : id; },
  shape(id) { return this.by[id] ? this.by[id].shape : 'none'; },
  stage(id) { return this.by[id] ? this.by[id].stage : ''; },
  cssVar(id) { return this.by[id] ? COLOR_VAR[this.by[id].color] || '--muted' : '--muted'; },
  colors(v) { return Object.fromEntries(this.list.map(s => [s.id, v(COLOR_VAR[s.color] || '--muted')])); },
  rank(id) { const s = this.by[id]; return !s ? 50 : s.stage === 'parked' ? 99 : s.i; } // inner orbits first in Solar
};
ST.set(DEFAULT_STATUSES);
