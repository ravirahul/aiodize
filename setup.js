#!/usr/bin/env node
// One command to get Aiodize running: `node setup.js` (or `npm run setup`).
// Starts the app in the background if it isn't running and opens the onboarding in the browser.
// It changes nothing else: connecting AI apps and backups happen only after the person agrees on the onboarding cards.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.AIODIZE_PORT || process.env.CHITTA_PORT || 4848), URL = `http://127.0.0.1:${PORT}/`;
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { console.error(`Aiodize needs Node.js 20 or newer (this is ${process.versions.node}). Get it from https://nodejs.org and run this again.`); process.exit(1); }

const up = () => new Promise(ok => { const r = http.get(URL, { timeout: 800 }, res => { res.resume(); ok(res.statusCode < 500); }); r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); }); });
const open = url => {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch {}
};

(async () => {
  if (!(await up())) {
    spawn(process.execPath, [path.join(__dirname, 'server.js')], { detached: true, stdio: 'ignore', cwd: __dirname, env: process.env }).unref();
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 250));
    if (!(await up())) { console.error(`Aiodize didn't start. Run "node server.js" in ${__dirname} to see why.`); process.exit(1); }
  }
  if (!process.argv.includes('--no-open')) open(URL);
  console.log([
    `Aiodize is running at ${URL}`,
    'Your browser shows a one-minute setup: where your notes live, backups, and which AI apps to connect.',
    'Nothing outside the app changes until you press "Agree & let my AI set it up" there.',
    'After that, ask your AI: "Set up Aiodize for me."',
  ].join('\n'));
})();
