#!/usr/bin/env node
// Claude Code SessionStart hook: prints the Aiodize context for the session's folder (Claude Code adds it to the conversation).
// It never blocks a session: any problem means it prints nothing and exits 0.
'use strict';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const W = require('./lib/workspace'), C = require('./lib/context');
    const cwd = (JSON.parse(input || '{}').cwd) || process.cwd();
    const config = W.loadConfig(), ws = C.wsForFolder(config, cwd);
    if (ws) return process.stdout.write(C.contextText(C.contextFor(config, ws, cwd)).slice(0, 6000) + '\n', () => process.exit(0)); // exit only once flushed
  } catch {}
  process.exit(0);
});
setTimeout(() => process.exit(0), 8000).unref();
