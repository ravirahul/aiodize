// Packs extension/ into dist/aiodize.mcpb (a zip) for Claude Desktop: double-click it, or drag it onto Settings > Extensions.
// Uses the tar that ships with Windows 10+ and macOS (it writes zip); on Linux install zip and run: cd extension && zip -r ../dist/aiodize.mcpb .
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), src = path.join(root, 'extension'), out = path.join(root, 'dist', 'aiodize.mcpb');
const m = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
m.version = require(path.join(root, 'package.json')).version; // keep the extension in step with the app
for (const k of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) if (!m[k]) throw new Error('manifest.json is missing ' + k);
if (!fs.existsSync(path.join(src, m.server.entry_point))) throw new Error('missing ' + m.server.entry_point);
fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.rmSync(out, { force: true });
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'; // bsdtar (writes zip), not a GNU tar from Git Bash
execFileSync(tar, ['--format', 'zip', '-cf', out, '-C', src, 'manifest.json', 'icon.png', 'server'], { stdio: 'inherit' });
console.log(`Built ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB), version ${m.version}`);
