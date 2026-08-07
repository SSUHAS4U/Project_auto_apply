// Full-fidelity run log on disk.
//
// The terminal is a SUMMARY: it prints what the adapters chose to say, in the shape a person
// reads. That is the right thing for the app and the wrong thing for diagnosis — five releases
// were spent guessing at causes because the one fact that mattered was never printed. "The
// server reports nothing running" took four versions and a hand-added diagnostic to become
// `/next replied: {"idle":true}`, which is a line that should always have existed.
//
// So: everything goes here. Every terminal line, every HTTP request with its status, duration
// and body, every navigation, every error with its stack, every run boundary. Nothing is
// filtered on the way in — deciding in advance what matters is exactly the mistake this file
// exists to stop.
//
// Rules this file keeps:
//  · never lose data because of an error IN the logging (a log that can crash the app is worse
//    than no log — see the heartbeat that a cosmetic refresh killed);
//  · never write a secret: the worker token, cookies and auth headers are redacted;
//  · bound the size, so an unattended machine cannot fill its disk.
import fs from 'node:fs';
import path from 'node:path';

// Derived here rather than imported from browser.js. browser.js logs, so importing APP_DIR back
// out of it forms a cycle, and under ESM the loser of that cycle sees the binding in its
// temporal dead zone: "Cannot access 'APP_DIR' before initialization", thrown at import time,
// which takes down the whole worker before a single line can be written. The logger must depend
// on nothing — it has to survive to record the failures of everything else.
//
// Same rule as browser.js: packaged by pkg, the code lives in a virtual snapshot, so files must
// sit beside the real executable; unpackaged, the working directory is the worker folder.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();

/**
 * Where the log lives — a FIXED, well-known path, not one that moves with the install.
 *
 * APP_DIR is next to the executable, which for the packaged desktop app is buried somewhere
 * different on every machine and every reinstall. A log nobody can locate is no better than no
 * log, and "send me the file" is a round trip that should not need to exist. So: the platform's
 * standard per-user application-data folder, the same convention any production desktop app
 * follows, and always the same place.
 *
 *   Windows   %LOCALAPPDATA%\JobPilot\logs
 *   macOS     ~/Library/Application Support/JobPilot/logs
 *   Linux     ~/.local/share/JobPilot/logs
 *
 * JOBPILOT_LOG_DIR overrides it, which is what the tests use so a suite never writes into the
 * real folder.
 */
function resolveLogDir() {
  if (process.env.JOBPILOT_LOG_DIR) return process.env.JOBPILOT_LOG_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || APP_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'JobPilot', 'logs');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'JobPilot', 'logs');
  }
  return path.join(home, '.local', 'share', 'JobPilot', 'logs');
}

const LOG_DIR = resolveLogDir();
const KEEP_DAYS = 7;
const MAX_BYTES = 64 * 1024 * 1024;   // per file; beyond this we roll to -2, -3, …

let stream = null;
let currentPath = null;
let currentDay = null;
let written = 0;
let part = 1;

/** Redact anything that must never reach a file the owner might paste into a chat. */
function scrub(text) {
  return String(text)
    // The worker token, however it appears: header, JSON field, query string.
    .replace(/(x-worker-token"?\s*[:=]\s*"?)([^"',\s]+)/gi, '$1<redacted>')
    .replace(/("token"\s*:\s*")([^"]+)/gi, '$1<redacted>')
    .replace(/([?&]token=)([^&\s]+)/gi, '$1<redacted>')
    // Session cookies, if a value is ever logged by accident. The NAME is diagnostic and stays.
    .replace(/((?:li_at|PPID|JSESSIONID|bcookie|bscookie)"?\s*[:=]\s*"?)([^"',;\s]{6,})/gi,
             '$1<redacted>')
    .replace(/(authorization"?\s*[:=]\s*"?)([^"',\s]+)/gi, '$1<redacted>');
}

function stamp() {
  return new Date().toISOString();
}

function openFor(day) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const suffix = part > 1 ? `-${part}` : '';
  currentPath = path.join(LOG_DIR, `jobpilot-${day}${suffix}.log`);
  // Append: a restart mid-day must not erase the run that led up to it — which is usually the
  // run being investigated.
  stream = fs.createWriteStream(currentPath, { flags: 'a' });
  // A stream error (disk full, file locked by an editor) must never take the app down.
  stream.on('error', () => { stream = null; });
  written = 0;
  currentDay = day;
}

/** Drop log files older than KEEP_DAYS so an unattended machine cannot fill its disk. */
function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.startsWith('jobpilot-') || !f.endsWith('.log')) continue;
      const p = path.join(LOG_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch { /* pruning is housekeeping — never let it break logging */ }
}

/**
 * Write one line. Everything in this module funnels through here, and it swallows its own
 * failures on purpose: a logger that throws would take down the worker it is meant to explain.
 */
function write(line) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (!stream || day !== currentDay) { part = 1; openFor(day); prune(); }
    if (written > MAX_BYTES) { part++; openFor(currentDay); }
    const out = scrub(line) + '\n';
    written += out.length;
    stream.write(out);
  } catch { /* never throw from the logger */ }
}

/**
 * One structured record. `cat` groups them so a search can pull out just the HTTP traffic, or
 * just the navigations, without reading 200k lines.
 */
export function logEvent(cat, data) {
  let body;
  try {
    body = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    body = '<unserialisable>';   // circular objects must not silently drop the record
  }
  write(`${stamp()} [${cat}] ${body}`);
}

/**
 * Start file logging and tee the console into it.
 *
 * The terminal keeps behaving exactly as before — this only adds a copy. Returns the path so
 * the app can tell the owner where to look, which matters: a log nobody can find is no better
 * than no log.
 */
export function initFileLog() {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const tee = (level, fn) => (...args) => {
    fn(...args);   // the terminal FIRST — logging must never delay or swallow what a person sees
    try {
      write(`${stamp()} [${level}] ${args.map((a) =>
        typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
      ).join(' ')}`);
    } catch { /* ignore */ }
  };
  console.log = tee('term', orig.log);
  console.warn = tee('warn', orig.warn);
  console.error = tee('error', orig.error);

  // The failures that matter most are the ones nobody catches. These previously vanished with
  // the process, leaving a log that just stops mid-sentence.
  process.on('uncaughtException', (e) => {
    logEvent('fatal', { kind: 'uncaughtException', message: String(e && e.message), stack: String(e && e.stack) });
  });
  process.on('unhandledRejection', (e) => {
    logEvent('fatal', { kind: 'unhandledRejection', message: String(e && e.message), stack: String(e && e.stack) });
  });
  // Flush on the way out, so the last thing that happened is on disk. Without this the most
  // interesting lines — the ones just before a crash or a quit — are the ones you lose.
  const flush = () => { try { stream && stream.end(); } catch { /* ignore */ } };
  process.on('exit', flush);
  process.on('SIGINT', () => { logEvent('lifecycle', 'SIGINT'); flush(); });
  process.on('SIGTERM', () => { logEvent('lifecycle', 'SIGTERM'); flush(); });

  logEvent('lifecycle', {
    event: 'worker started', pid: process.pid, node: process.version,
    platform: process.platform, appDir: APP_DIR,
  });
  return currentPath || path.join(LOG_DIR, `jobpilot-${new Date().toISOString().slice(0, 10)}.log`);
}

/** Where the log lives — for the startup banner and for support. */
export function logDir() { return LOG_DIR; }
