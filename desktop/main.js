// JobPilot desktop — Electron shell.
//
// One window that IS the dashboard: it serves the built React app over a fixed loopback
// port (so login persists), injects the backend URL, and runs the local automation worker
// as a child process whose live output streams into the in-app terminal panel. No separate
// browser tab and no console — everything the website does, plus the worker, in one place.
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
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
app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => {
  try { worker && worker.stop(); } catch { /* ignore */ }
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { try { worker && worker.stop(); } catch { /* ignore */ } });
