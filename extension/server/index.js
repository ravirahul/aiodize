// Aiodize extension for Claude Desktop: starts the MCP server of the Aiodize installed on this computer.
// Your notes never live inside the extension; it only points Claude at your Aiodize folder and one workspace.
'use strict';
const fs = require('fs');
const path = require('path');
const i = process.argv.indexOf('--app'), app = i > 0 ? process.argv[i + 1] : '';
const entry = app && path.join(app, 'mcp.js');
if (!entry || !fs.existsSync(entry)) {
  process.stderr.write(`Aiodize isn't installed at "${app}". Install it (node setup.js) and set its folder in this extension's settings.\n`);
  process.exit(1);
}
require(entry); // mcp.js reads --workspace from the same arguments
