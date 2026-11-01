// Aiodize desktop app: runs the local server inside the app, shows it in its own window, lives in the tray.
// Installed copies keep notes config and data in the app's data folder (not inside the app), so updates never touch them.
'use strict';
const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CHITTA_PORT || 4848), URL = `http://127.0.0.1:${PORT}/`;
const ICON = path.join(__dirname, '..', 'extension', 'icon.png');
let win = null, tray = null, quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => show());
  if (app.isPackaged) {
    const ud = app.getPath('userData');
    process.env.AIODIZE_DATA = process.env.AIODIZE_DATA || path.join(ud, 'data');
    process.env.AIODIZE_CONFIG = process.env.AIODIZE_CONFIG || path.join(ud, 'workspaces.json');
  }
  app.whenReady().then(start);
}

const alive = () => new Promise(ok => { const r = http.get(URL, { timeout: 700 }, res => { res.resume(); ok(true); }); r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); }); });

async function start() {
  if (!(await alive())) require('../server.js'); // a copy already running (e.g. `npm start`) is simply reused
  for (let i = 0; i < 40 && !(await alive()); i++) await new Promise(r => setTimeout(r, 150));
  makeTray();
  if (!process.argv.includes('--hidden')) show();
}

function show() {
  if (!win) {
    win = new BrowserWindow({ width: 1440, height: 900, minWidth: 720, minHeight: 520, title: 'Aiodize', icon: ICON, backgroundColor: '#141517', autoHideMenuBar: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true } });
    win.loadURL(URL);
    win.once('ready-to-show', () => win.show());
    // Links to websites, VS Code and Obsidian open outside the app.
    win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(URL)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL)) { e.preventDefault(); shell.openExternal(url); } });
    win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } }); // closing keeps Aiodize in the tray
  }
  win.show(); win.focus();
}

function makeTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Aiodize: your brain for AI');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Aiodize', click: show },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Quit Aiodize', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', show);
  tray.on('right-click', () => tray.setContextMenu(menu()));
}

app.on('window-all-closed', e => e.preventDefault()); // stay in the tray
app.on('before-quit', () => { quitting = true; });
