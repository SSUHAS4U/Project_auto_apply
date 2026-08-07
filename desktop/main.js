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
const { initAutoUpdate } = require('./auto-update');
let updater = null;

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

  // AUTO-CONNECT. Opening the app IS the trigger — there is nothing manual to press. If a
  // connect token was saved on a previous run (i.e. this isn't a brand-new install), the
  // worker starts on its own as soon as the window is ready. A new user connects once from
  // the Connections page; after that it's automatic, forever.
  win.webContents.once('did-finish-load', () => {
    const t = (savedToken() || '').trim();
    if (!t) { sendLog('\nNot connected yet — open Connections and connect once. After that this starts automatically.\n'); return; }
    if (worker && worker.running) return;
    sendLog('\n▶ Auto-starting the automation (saved connection)…\n');
    try { worker.start({ backendUrl: BACKEND_URL, token: t }); } catch { /* surfaced in the log */ }
  });

  // Closing the window STOPS the automation and quits.
  //
  // This used to hide to the tray and keep working, which meant the automation could be driving
  // a logged-in browser with nothing on screen to show it — and a machine that slept or was shut
  // down left a run marked "running" server-side, blocking every later run. Owner's decision:
  // closing the app stops the automation. `before-quit` handles the actual shutdown, so all this
  // has to do is let the quit proceed.
  win.on('close', () => {
    if (quitting) return;
    quitting = true;
    app.quit();
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
  tray.setToolTip('JobPilot');
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
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', show);
}

// ---- IPC --------------------------------------------------------------------
ipcMain.on('app:backendUrl', (e) => { e.returnValue = BACKEND_URL; });
// The installed build's version, for the sidebar badge. Without it there is no way to tell a
// freshly auto-updated app from one that has been running for days — an afternoon went into
// diagnosing runs that turned out to predate the fixes entirely.
ipcMain.handle('app:version', () => app.getVersion());
// "Update now" — the automatic path defers while the worker runs, which is always, so there
// has to be a way to say "do it now" without uninstalling and reinstalling.
ipcMain.handle('app:update', async () => {
  if (!updater) return { state: 'unavailable', version: app.getVersion() };
  try { return await updater.checkAndInstall(); }
  catch (e) { return { state: 'error', error: String(e && e.message).slice(0, 140) }; }
});
ipcMain.handle('worker:savedToken', () => savedToken());
ipcMain.handle('worker:recentLog', () => logBuffer);
// Delete really deletes: wipe the rolling buffer so the cleared log can't replay on remount.
ipcMain.handle('worker:clearLog', () => { logBuffer = ''; return true; });
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
    // Keep itself current. The app bundles the dashboard AND the worker, so an adapter fix
    // only reaches this machine through a new installer — without this, every iteration cost
    // a manual download-uninstall-reinstall and the old build kept running in the meantime.
    // Never restarts mid-run; see auto-update.js.
    updater = initAutoUpdate({
      log: (m) => sendLog(m),
      isBusy: () => !!(worker && worker.running),
    });
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // No window means no automation — closing the app stops the work it was doing.
  app.on('window-all-closed', () => { quitting = true; app.quit(); });

  // Hold the quit open just long enough for the worker to tell the backend its run is over.
  // Without this the process dies mid-run and the row stays "running" server-side, blocking
  // every later run until the stale-run reaper clears it ten minutes on.
  let shuttingDown = false;
  app.on('before-quit', async (e) => {
    quitting = true;
    if (!worker || !worker.running || shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    sendLog('\n■ Closing JobPilot — stopping the automation…\n');
    try {
      worker.stop();
      await worker.waitForExit();
    } catch { /* forced below regardless */ }
    // The worker is down, so this is the safe moment. If an update is waiting, install it
    // instead of quitting — otherwise it waits for a quit that already happened.
    if (updater && updater.installIfPending()) return;
    app.quit();
  });
}
