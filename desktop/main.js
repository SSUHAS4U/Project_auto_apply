// JobPilot desktop — Electron shell.
//
// One window that IS the dashboard: it serves the built React app over a fixed loopback
// port (so login persists), injects the backend URL, and runs the local automation worker
// as a child process whose live output streams into the in-app terminal panel. No separate
// browser tab and no console — everything the website does, plus the worker, in one place.
const { app, BrowserWindow, ipcMain, shell, session, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startStaticServer } = require('./static-server');
const { WorkerManager } = require('./worker-manager');

const PORT = 41720; // fixed → stable origin → persistent localStorage (the login)
const TOKEN_FILE = path.join(app.getPath('userData'), 'worker-token');

// ---- config -----------------------------------------------------------------
function loadConfig() {
  for (const name of ['desktop.config.json', 'desktop.config.example.json']) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try next */ }
    }
  }
  return {};
}
const config = loadConfig();
const BACKEND_URL = (process.env.JOBPILOT_BACKEND_URL || config.backendUrl || '').replace(/\/$/, '');

// The built dashboard: packaged under resources/frontend, or ../frontend/dist from source.
function frontendDir() {
  const packaged = path.join(process.resourcesPath || '', 'frontend');
  if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  return path.join(__dirname, '..', 'frontend', 'dist');
}

let win = null;
let worker = null;
let tray = null;
let quitting = false;   // true only when the user picks Quit — otherwise close just hides
let hintShown = false;  // "still running in the tray" balloon, shown once per session

function savedToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}
function persistToken(t) {
  try { if (t) fs.writeFileSync(TOKEN_FILE, t); } catch { /* non-fatal */ }
}

// Keep a capped rolling buffer of worker output so the terminal can REPLAY it on mount —
// otherwise any line emitted before the renderer subscribed (or after a re-mount) is lost,
// which looked like "nothing is streaming" even though the worker was talking.
let logBuffer = '';
function sendLog(line) {
  logBuffer = (logBuffer + line).slice(-100000);
  if (win && !win.isDestroyed()) win.webContents.send('worker:log', line);
}
function sendStatus(s) { if (win && !win.isDestroyed()) win.webContents.send('worker:status', s); }

async function createWindow() {
  const dir = frontendDir();
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    // Nothing to show — tell the user how to build the dashboard.
    win = new BrowserWindow({ width: 720, height: 480 });
    win.loadURL('data:text/html,' + encodeURIComponent(
      `<body style="font:15px system-ui;padding:40px;background:#0b0f19;color:#e5e7eb">
       <h2>Dashboard not built yet</h2>
       <p>Run <code>npm run build:frontend</code> in the <code>desktop</code> folder, then start again.</p></body>`));
    return;
  }

  await startStaticServer(dir, PORT).catch((e) => sendLog(`static server error: ${e.message}\r\n`));

  worker = new WorkerManager({ onLog: sendLog, onStatus: sendStatus });

  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0f19',
    title: 'JobPilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Persist cookies/localStorage (the login) between launches.
      partition: 'persist:jobpilot',
    },
  });

  // External links (job postings etc.) open in the system browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.on('closed', () => { win = null; });

  // Closing the window HIDES it instead of quitting, so the automation keeps running in the
  // background (scheduled blocks still fire). Quit deliberately from the tray menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!hintShown) {
      hintShown = true;
      try {
        tray && tray.displayBalloon && tray.displayBalloon({
          title: 'JobPilot is still running',
          content: 'The automation keeps working in the background. Quit from the tray icon to stop it.',
        });
      } catch { /* balloons are Windows-only */ }
    }
  });
}

/**
 * Start just the automation worker, with no window and no static server — used when Windows
 * launches us at login with --hidden. Needs a token from a previous run; if there isn't one,
 * we stay idle in the tray until the user opens the app once and connects.
 */
async function startWorkerHeadless() {
  const t = (savedToken() || '').trim();
  if (!t) return;
  if (!worker) worker = new WorkerManager({ onLog: sendLog, onStatus: sendStatus });
  try { worker.start({ backendUrl: BACKEND_URL, token: t }); } catch { /* surfaced in the log */ }
}

/** Tray icon — the app's only visible presence once the window is closed. */
function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
      .resize({ width: 16, height: 16 });
    tray = new Tray(img);
  } catch {
    return; // no icon available — skip the tray rather than crash
  }
  const show = () => {
    if (win) { win.show(); win.focus(); } else { createWindow(); }
  };
  tray.setToolTip('JobPilot — automation running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open JobPilot', click: show },
    { type: 'separator' },
    {
      label: 'Start automation at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Quit (stops the automation)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', show);
}

// ---- IPC --------------------------------------------------------------------
ipcMain.on('app:backendUrl', (e) => { e.returnValue = BACKEND_URL; });
ipcMain.handle('worker:savedToken', () => savedToken());
ipcMain.handle('worker:recentLog', () => logBuffer);
ipcMain.handle('worker:status', () => (worker ? worker.status() : { running: false }));
ipcMain.handle('worker:start', (_e, token) => {
  const t = (token || savedToken() || '').trim();
  if (token) persistToken(t);
  return worker ? worker.start({ backendUrl: BACKEND_URL, token: t }) : { running: false };
});
ipcMain.handle('worker:stop', () => (worker ? worker.stop() : { running: false }));

// ---- lifecycle --------------------------------------------------------------
// Single instance: launching again just re-opens the window of the copy that's already
// running the automation, instead of starting a second worker that fights it for the browser.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } else createWindow(); });

  app.whenReady().then(async () => {
    createTray();
    // Launched by the login item (--hidden): start in the tray and run headlessly, no window.
    if (!process.argv.includes('--hidden')) await createWindow();
    else await startWorkerHeadless();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Window closed != quit — the automation stays alive in the tray.
  app.on('window-all-closed', () => { /* keep running; quit from the tray */ });
  app.on('before-quit', () => {
    quitting = true;
    try { worker && worker.stop(); } catch { /* ignore */ }
  });
}
