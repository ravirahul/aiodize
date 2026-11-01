// The first vault a new person sees: a few linked notes so the graph isn't empty and the ideas are explained by example.
'use strict';
const fs = require('fs');
const path = require('path');

const today = () => new Date().toISOString().slice(0, 10);
const NOTES = () => ({
  'Welcome.md': `---\ntitle: Welcome\n---\n\n# Welcome to Aiodize\n\nThis is your brain for AI, on your device. Every note is a plain Markdown file in this folder.\n\n- Read [[How Aiodize works]] (two minutes).\n- Your first project: [[Example project]].\n- Ideas go in Ideas/, like [[My first idea]]. Press Alt+N to add one by typing or speaking.\n\nDelete these notes whenever you like.\n`,
  'How Aiodize works.md': `---\ntitle: How Aiodize works\ntags: [guide]\n---\n\n# How Aiodize works\n\n1. Your notes live here, in folders you own. Aiodize draws them as a graph.\n2. Your AI apps connect to Aiodize. Before they work they read your context (rules, the project, what's pending); after, they log what changed.\n3. Mission Control shows what every AI did: sessions, tokens, models.\n4. Rules per workspace tell agents what they may not touch. Every edit is logged and can be undone.\n5. Backups copy everything to a folder you choose, every day.\n\nBack to [[Welcome]].\n`,
  'Ideas/My first idea.md': `---\ntitle: My first idea\ntype: idea\nstatus: seed\ncaptured: ${today()}\ntags: [idea]\n---\n\nWrite ideas the moment you have them. Link them to projects, like [[Example project]], and your AI will find them later.\n`,
  'Projects/Example/Example project.md': `---\ntitle: Example project\nstatus: in-progress\ncategory: Example\nlast_worked: ${today()}\ntags: [project]\n---\n\n# Example project\n\n> One line on what it is. Set a "folder" property to the project's code folder and your AI's work there is logged here.\n\n## What's done\n- Installed Aiodize\n\n## What's pending\n- Connect an AI app\n- Ask it: "Set up Aiodize for me"\n\n## Log\n`,
});

function seed(vault) {
  fs.mkdirSync(vault, { recursive: true });
  if (fs.readdirSync(vault).some(f => !f.startsWith('.'))) return; // never write into a folder that already has notes
  for (const [rel, text] of Object.entries(NOTES())) { const f = path.join(vault, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
}
module.exports = { seed };
