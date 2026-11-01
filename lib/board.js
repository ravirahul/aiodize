// Project statuses and kanban layout, per workspace (data/<ws>/board.json). The five built-in statuses are the default.
'use strict';
const fs = require('fs');
const path = require('path');

const COLORS = ['green', 'amber', 'blue', 'accent', 'grey', 'rose', 'clay', 'teal', 'violet', 'sky', 'sand'];
const SHAPES = ['full', 'half', 'dot', 'dashed', 'ring'];
const STAGES = ['active', 'done', 'parked']; // active = open work (Pick next, stale warnings); parked = dimmed
const FIELDS = ['category', 'updated', 'site', 'deadline'];
const DEFAULT = {
  statuses: [
    { id: 'live', label: 'Live', color: 'green', shape: 'full', stage: 'done' },
    { id: 'live-partial', label: 'Live, partly', color: 'amber', shape: 'half', stage: 'active' },
    { id: 'built-not-deployed', label: 'Built, not deployed', color: 'blue', shape: 'dot', stage: 'active' },
    { id: 'in-progress', label: 'In progress', color: 'accent', shape: 'dashed', stage: 'active' },
    { id: 'parked', label: 'Parked', color: 'grey', shape: 'ring', stage: 'parked' }
  ],
  board: { groupBy: 'status', sort: 'updated', fields: ['category', 'updated'], hidden: [], showOther: true, newStatus: 'in-progress' }
};

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
const file = (dataDir, id) => path.join(dataDir, id, 'board.json');

function validate(b) {
  const ids = new Set();
  const statuses = (Array.isArray(b.statuses) ? b.statuses : []).slice(0, 12).map(s => {
    const label = String(s.label || '').trim().slice(0, 30);
    if (!label) throw new Error('Every status needs a name');
    const id = slug(s.id || label);
    if (!id) throw new Error(`"${label}" needs some letters or digits`);
    if (ids.has(id)) throw new Error(`Two statuses are called "${id}"`); ids.add(id);
    return { id, label, color: COLORS.includes(s.color) ? s.color : 'grey', shape: SHAPES.includes(s.shape) ? s.shape : 'ring', stage: STAGES.includes(s.stage) ? s.stage : 'active' };
  });
  if (!statuses.length) throw new Error('Keep at least one status');
  const o = b.board || {};
  const board = {
    groupBy: o.groupBy === 'category' ? 'category' : 'status',
    sort: ['updated', 'title', 'deadline'].includes(o.sort) ? o.sort : 'updated',
    fields: (Array.isArray(o.fields) ? o.fields : []).filter(f => FIELDS.includes(f)),
    hidden: (Array.isArray(o.hidden) ? o.hidden : []).map(String).filter(h => ids.has(h)),
    showOther: o.showOther !== false,
    newStatus: ids.has(o.newStatus) ? o.newStatus : statuses[0].id
  };
  return { statuses, board };
}

function read(dataDir, id) {
  try { return validate(JSON.parse(fs.readFileSync(file(dataDir, id), 'utf8'))); } catch { return JSON.parse(JSON.stringify(DEFAULT)); }
}
function write(dataDir, id, b) {
  const v = validate(b);
  fs.mkdirSync(path.join(dataDir, id), { recursive: true });
  fs.writeFileSync(file(dataDir, id), JSON.stringify(v, null, 2));
  return v;
}

module.exports = { DEFAULT, COLORS, SHAPES, STAGES, FIELDS, validate, read, write };
