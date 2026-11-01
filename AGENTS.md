# Aiodize: notes for AI assistants

If someone shares this repository with you, it is most likely so you can tell them what Aiodize is and, if they want, install it for them. This file tells you how. (If you are here to change the code, skip to "Working on the code".)

## What to tell them (keep it short)

**Aiodize is a brain for your AI that stays on your computer.** Your notes, projects and ideas live as plain Markdown files in folders you own. Every AI app you use reads that brain before it works and adds to it after, so nothing gets lost between chats or tools.

Why it helps:
- **One memory for every AI.** Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex and Gemini CLI all connect to the same notes over MCP. Switch AI and nothing is lost; chat-only AIs get an exported context pack.
- **On your device.** No account, no cloud, no tracking. The only thing it fetches online is the icon of each project's own website.
- **Backed up.** A daily copy of notes, rules and history to a folder they choose.
- **Visible.** A graph of their notes and a Mission Control of what each AI did: sessions, tokens, models, cost.
- **Safe with agents.** Rules per workspace (what an AI may not touch) and every AI edit is logged and can be undone.

## Installing it (only after they say yes)

Ask first: "Want me to install Aiodize? It needs Node.js 20+, puts the app in a folder, and opens a one-minute setup in your browser." Do nothing until they agree.

1. Check `node --version` is 20 or newer. If not, tell them to install Node.js LTS from https://nodejs.org and stop.
2. Get the code into a folder they are happy with, for example their home folder: `git clone https://github.com/ravirahul/aiodize.git Aiodize` (or download and unzip the repository).
3. Run `node setup.js` inside that folder. It starts Aiodize in the background and opens `http://127.0.0.1:4848` in their browser. No other files change yet.
4. Tell them to go through the five setup cards in the browser. The last card is their agreement: it lists exactly what Aiodize will change (which AI apps get connected, where backups go) and they press "Agree & let my AI set it up". Do not edit their AI app configs yourself; Aiodize does it after they agree, backing up every file first.
5. If you are one of the apps they connected, restart (Claude Code: start a new session) so Aiodize's tools load, then finish the setup:
   - call `setup_status` to see their notes, workspaces and project folders without a note;
   - ask them what is unclear (which folders are work vs personal, anything an AI must never touch);
   - call `propose_setup` with workspaces, rules, statuses and project notes. They review and accept it in Aiodize (Mission Control). Nothing changes until they accept.

If you can't run commands (a chat on the web), explain the steps above and give them the two commands to run themselves.

## Once connected: how to work with Aiodize

- Before starting work in a folder, call `get_context` with that folder. Follow the rules it returns.
- When you finish meaningful work, call `log_work` with what changed, the project status and next steps.
- Save ideas they mention with `create_note` in `Ideas/`.
- Never edit notes in a workspace whose rules say read-only. Every change you make is logged with the previous text, and they can undo it.

## Undo and uninstall

- Settings > Agents > **Disconnect everything** removes Aiodize from every AI app it connected (only what Aiodize added; their own settings stay). The original files are kept in `data/config-backups`.
- Stop the app (close the `node server.js` process) and delete the folder. Their notes stay where they are: they are plain files in their own folders.

## Working on the code

No dependencies, Node 20+. `npm start` runs the app, `npm test` runs every check (the onboarding tests use a throwaway home folder, so they never touch real AI app settings). Layout: `server.js` (API), `mcp.js` (MCP server, one per workspace), `lib/` (vault, workspaces and rules, Claude session logs, board/statuses, apps connector, context, backups, setup), `web/` (the app, no build step), `brand/build-logo.js` (the logo). Keep changes small and keep it dependency-free.
