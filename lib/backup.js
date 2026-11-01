// Backups: a dated copy of every vault, the workspace data (rules, statuses, activity log) and workspaces.json,
// into a folder the person picks (another drive, OneDrive, a USB stick). Plain files, so any copy can be opened by hand.
'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./workspace');

const NAME = /^aiodize-(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?(-before-restore)?$/;
const day = (d = new Date()) => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const hm = (d = new Date()) => String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
const skip = src => !/[\\/](node_modules|\.git|\.trash)([\\/]|$)/.test(src);

function snapshot(config, dir, { label = '', version = '' } = {}) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('Pick a full folder path for backups');
  const name = `aiodize-${day()}-${hm()}${label}`, dest = path.join(dir, name);
  if (path.resolve(dest).startsWith(path.resolve(W.ROOT) + path.sep) && !process.env.AIODIZE_HOME) throw new Error('Keep backups outside the app folder');
  fs.mkdirSync(dest, { recursive: true });
  for (const w of config.workspaces) {
    if (fs.existsSync(w.vault)) fs.cpSync(w.vault, path.join(dest, 'vaults', w.id), { recursive: true, filter: skip });
    const d = path.join(W.DATA, w.id); if (fs.existsSync(d)) fs.cpSync(d, path.join(dest, 'data', w.id), { recursive: true });
  }
  const cfg = W.CONFIG; if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(dest, 'workspaces.json'));
  fs.writeFileSync(path.join(dest, 'README.txt'), `Aiodize backup, ${new Date().toString()}\nvaults/<workspace> = your notes (Markdown). data/<workspace> = rules, statuses, activity log.\nRestore from Aiodize: Settings > Backups, or copy the vault folder back by hand.\n`);
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ created: Date.now(), version, workspaces: config.workspaces.map(w => ({ id: w.id, name: w.name, vault: w.vault })) }, null, 1));
  return name;
}

function list(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => NAME.test(n) && fs.existsSync(path.join(dir, n, 'manifest.json'))).sort().reverse().map(n => {
    let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(dir, n, 'manifest.json'), 'utf8')); } catch {}
    return { name: n, created: m.created || 0, workspaces: (m.workspaces || []).map(w => w.id), beforeRestore: n.endsWith('-before-restore') };
  });
}

// Keep the newest `keep` regular snapshots (safety copies made before a restore are kept too, up to the same number).
function prune(dir, keep = 14) {
  const all = list(dir), regular = all.filter(s => !s.beforeRestore), safety = all.filter(s => s.beforeRestore);
  for (const s of [...regular.slice(keep), ...safety.slice(keep)]) fs.rmSync(path.join(dir, s.name), { recursive: true, force: true });
}

function hasToday(dir) { return list(dir).some(s => !s.beforeRestore && s.name.startsWith('aiodize-' + day())); }

// Put one workspace back as it was in a snapshot. A safety snapshot is taken first; files added since are kept.
function restore(config, dir, name, wsId, version) {
  if (!NAME.test(name)) throw new Error('Not an Aiodize backup: ' + name);
  const src = path.join(dir, name), w = W.getWs(config, wsId);
  if (!fs.existsSync(path.join(src, 'vaults', wsId))) throw new Error(`That backup has no ${w.name} notes`);
  const safety = snapshot(config, dir, { label: '-before-restore', version });
  fs.cpSync(path.join(src, 'vaults', wsId), w.vault, { recursive: true });
  const d = path.join(src, 'data', wsId); if (fs.existsSync(d)) fs.cpSync(d, path.join(W.DATA, wsId), { recursive: true });
  W.logActivity(wsId, { who: 'you', action: 'restore', path: '', summary: `Restored ${w.name} from ${name} (safety copy: ${safety})` });
  return { restored: name, safety };
}

module.exports = { snapshot, list, prune, restore, hasToday, day };
