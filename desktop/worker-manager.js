// Runs the local automation worker as a child process and streams its output to the
// renderer's terminal panel. The worker is the same code as the standalone JobPilot
// Desktop worker; here it's spawned inside the app with the backend URL + connect token
// injected via env, so it never prompts for anything on the console.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/** Where the worker's Chrome profile + logs live — stable + writable across launches. */
function workerDataDir() {
  const dir = path.join(app.getPath('userData'), 'worker');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the worker entry script, whether running from source or packaged. */
function workerEntry() {
  const candidates = [
    path.join(process.resourcesPath || '', 'worker', 'src', 'index.js'), // packaged
    path.join(__dirname, '..', 'worker', 'src', 'index.js'),             // from source
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || candidates[1];
}

class WorkerManager {
  constructor({ onLog, onStatus }) {
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.proc = null;
  }

  get running() { return !!this.proc; }

  status() { return { running: this.running }; }

  start({ backendUrl, token }) {
    if (this.proc) return this.status();
    if (!token) { this.onLog('✗ No connect token — sign in first, then Connect.\n'); return this.status(); }

    const entry = workerEntry();
    const cwd = workerDataDir();
    this.onLog('▶ Starting automation worker…\n');

    // ELECTRON_RUN_AS_NODE makes the app's own Electron binary behave as plain Node, so we
    // don't depend on a system Node install. The worker reads the token/backend from env
    // (index.js#loadConfig), so there's no interactive prompt.
    this.proc = spawn(process.execPath, [entry], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        JOBPILOT_BACKEND_URL: backendUrl,
        JOBPILOT_WORKER_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pipe = (buf) => this.onLog(buf.toString());
    this.proc.stdout.on('data', pipe);
    this.proc.stderr.on('data', pipe);
    this.proc.on('exit', (code) => {
      this.onLog(`\n■ Worker stopped${code ? ` (exit ${code})` : ''}.\n`);
      this.proc = null;
      this.onStatus(this.status());
    });
    this.proc.on('error', (err) => {
      this.onLog(`✗ Could not start worker: ${err.message}\n`);
      this.proc = null;
      this.onStatus(this.status());
    });

    this.onStatus(this.status());
    return this.status();
  }

  stop() {
    if (!this.proc) return this.status();
    this.onLog('\n■ Stopping worker…\n');
    try { this.proc.kill(); } catch { /* already gone */ }
    return this.status();
  }
}

module.exports = { WorkerManager };
