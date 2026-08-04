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
        // Stamp the build into the worker so every log says which version produced it.
        // Without this there is no way to tell an old installer's log from a new one, and
        // "did that fix ship?" becomes guesswork on both sides.
        // `jobpilotBuild`, not `build`: package.json's `build` is electron-builder's config
        // block, and CI must never write a string into it.
        JOBPILOT_BUILD: process.env.JOBPILOT_BUILD || require('./package.json').jobpilotBuild || 'dev',
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

  /**
   * Stop the worker, giving it a moment to tell the backend its run is over.
   *
   * SIGTERM (not an immediate kill) runs the worker's shutdown handler, which marks the active
   * run finished. Without that grace period the run stays "running" server-side and blocks the
   * next launch until the stale-run reaper clears it.
   *
   * @param graceMs how long to wait for a clean exit before forcing it.
   */
  stop(graceMs = 6000) {
    if (!this.proc) return this.status();
    this.onLog('\n■ Stopping worker…\n');
    const proc = this.proc;
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    // Force it if the clean path stalls — quitting must never hang on a wedged worker.
    const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    proc.once('exit', () => clearTimeout(force));
    return this.status();
  }

  /** Resolves once the worker process is really gone (or immediately if it already is). */
  waitForExit(timeoutMs = 7000) {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const done = setTimeout(resolve, timeoutMs);
      proc.once('exit', () => { clearTimeout(done); resolve(); });
    });
  }
}

module.exports = { WorkerManager };
