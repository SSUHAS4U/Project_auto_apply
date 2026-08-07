// JobPilot local worker — the entry point.
//
// Runs on the owner's PC. Opens a real Chromium (persistent profile: log into each
// portal ONCE), then loops: ask the backend what to do (/next), and when a portal run
// is active, drive it while streaming a live screen feed to the dashboard. The backend
// stays the brain (schedule, AI, records, metrics); this is just the hands + eyes.
//
// Setup:
//   1) npm install                 (also downloads Chromium)
//   2) set two env vars (or create worker.config.json — see README):
//        JOBPILOT_BACKEND_URL=https://your-backend
//        JOBPILOT_WORKER_TOKEN=<minted in dashboard → Auto Apply → Agent → "Connect worker">
//   3) npm start   → a browser opens; log into LinkedIn; hit ▶ for a portal in the dashboard.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Api } from './api.js';
import { launchBrowser, startPausePoller, sleep, APP_DIR } from './browser.js';
import { runLinkedIn } from './portals/linkedin.js';
import { runIndeed } from './portals/indeed.js';
import {
  reportSessions, handleConnectionActions, anyPortalLoggedIn, isLoggedIn, loginUrl,
} from './connections.js';
import { logSummary } from './log.js';
import { initFileLog, logEvent, logDir } from './logfile.js';

const DEFAULT_BACKEND = 'https://35.212.189.37.sslip.io';
const CONFIG_FILE = path.join(APP_DIR, 'jobpilot-desktop.config.json');

// Playwright's Firefox backend occasionally throws from one of its OWN internal navigation
// events — e.g. `removeChildFramesRecursively → _getChildFrames` on a frame that's already
// gone as a page redirects. These fire on Playwright's event emitter, not inside any await we
// control, so a try/catch around our navigation can't catch them. Left unhandled, ONE of them
// crashes the entire worker mid-run (exit 1) even though the browser is otherwise fine and had
// been submitting jobs. Keep the process alive and let the per-job try/catch handle anything
// that actually breaks the current job. We log every one so a real, recurring fault is visible.
/** Is the automation page still usable? False once the browser/context has been closed. */
async function pageAlive(page) {
  try {
    if (!page || page.isClosed?.()) return false;
    await page.evaluate(() => 1);
    return true;
  } catch { return false; }
}

let recoveredErrors = 0;
function recover(kind, err) {
  recoveredErrors++;
  const msg = String((err && err.message) || err || '').slice(0, 160);
  console.error(`  ⚠ recovered from ${kind} (run continues): ${msg}`);
  // If they storm in, the browser is genuinely dead — exit so the desktop app can relaunch a
  // clean worker instead of spinning uselessly.
  if (recoveredErrors > 40) { console.error('  too many browser errors — restarting the worker'); process.exit(1); }
}
process.on('uncaughtException', (err) => recover('a browser-internal error', err));
process.on('unhandledRejection', (err) => recover('an unhandled rejection', err));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/**
 * First-run setup with zero file editing: if there's no saved token, ask for it once
 * (paste it from the dashboard's Connect screen) and remember it. After that it just runs.
 */
async function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) { try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* re-ask */ } }
  let backendUrl = process.env.JOBPILOT_BACKEND_URL || cfg.backendUrl;
  let token = process.env.JOBPILOT_WORKER_TOKEN || cfg.token;

  if (!token) {
    console.log('\n  Welcome to JobPilot Desktop — first-time setup (takes 20 seconds).\n');
    console.log('  1) Open your JobPilot dashboard → Connections → "Set up".');
    console.log('  2) Click "Generate connect code" and copy it.\n');
    token = await ask('  Paste your connect code here: ');
    if (!token) { console.error('  No code entered. Run me again when you have it.\n'); process.exit(1); }
    if (!backendUrl) {
      const b = await ask(`  Backend URL [${DEFAULT_BACKEND}]: `);
      backendUrl = b || DEFAULT_BACKEND;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ backendUrl, token }, null, 2));
    console.log('  Saved ✓ — you won\'t need to do this again.\n');
  }
  return { backendUrl: backendUrl || DEFAULT_BACKEND, token };
}

// Only the portals the backend can actually hand out. `nextPortalWithWork` returns linkedin or
// indeed, and startRun rejects anything else — an 'all' adapter had no way to be requested.
const ADAPTERS = { linkedin: runLinkedIn, indeed: runIndeed };

/** A Playwright fault that means the browser is gone — recoverable by relaunching it. */
function isDeadBrowser(e) {
  return /target page, context or browser has been closed|browser has been closed|target closed|browser\.newcontext|browsercontext\.newpage/i
    .test(String((e && e.message) || e));
}

async function main() {
  const { backendUrl, token } = await loadConfig();
  const api = new Api(backendUrl, token);

  // First line of every session: which build this is. When a log shows a bug that was already
  // fixed, this is what tells us the installer is simply older than the fix.
  console.log(`JobPilot worker · build ${process.env.JOBPILOT_BUILD || 'dev'}`);
  console.log('Connecting to backend…');
  const hello = await api.hello().catch((e) => { console.error('  Auth failed:', e.message); process.exit(1); });
  console.log(`  Connected as ${hello.name || hello.userId}.`);

  // Start the full log before anything else can fail. Everything from here on — every terminal
  // line, every HTTP call and its reply, every navigation, every uncaught error — is written to
  // disk. The terminal stays a summary for reading; this is the record for diagnosing, and it
  // exists because release after release was spent inferring causes that one unrecorded line
  // would have settled outright.
  const logPath = initFileLog();
  console.log(`\n  Full log: ${logPath}`);
  console.log('  Everything this run does is recorded there. Send that file when something goes wrong.');
  console.log(`  (folder: ${logDir()} — kept for 7 days)\n`);

  // Visible only until a portal is signed in. After that every run happens with no window at
  // all — the terminal log is the whole interface, which is the point: you shouldn't have to
  // watch a browser drive itself.

  const signedInMarker = path.join(APP_DIR, '.signed-in');
  let background = fs.existsSync(signedInMarker);
  let { ctx, page } = await launchBrowser({ headless: background });

  // The marker only HINTS that we ran signed-in once. The real authority is whether the
  // browser profile still holds a live session. The marker outlives the session it was
  // written for — the auth cookie expires, the profile is reset, or the app is uninstalled
  // and reinstalled while %AppData% (where this lives) survives. When that happens a
  // marker-only check would run headless against a dead session, with no window to fix it —
  // exactly the "running in the background… can't sign in" trap. So verify, and if the
  // session is actually gone, throw the marker away and reopen a real window to log in.
  if (background && !(await anyPortalLoggedIn(ctx))) {
    console.log('\n  The saved sign-in is no longer valid (it expired, or the browser profile was reset');
    console.log('  — common right after a reinstall). Reopening a window so you can log in again…');
    try { fs.rmSync(signedInMarker, { force: true }); } catch { /* non-fatal */ }
    background = false;
    await ctx.close().catch(() => {});
    ({ ctx, page } = await launchBrowser({ headless: false }));
  }

  if (background) {
    console.log('\n  Running in the background — no browser window. Everything shows up here.');
  } else {
    console.log('\n  Browser is open. Log into the portals you want to use:');
    console.log('   • LinkedIn: https://www.linkedin.com/');
    console.log('   • Indeed:   https://www.indeed.com/');
    console.log('  (log in once — the session is remembered, and from then on it runs invisibly).\n');
    await page.goto('https://www.linkedin.com/').catch(() => {});
  }

  const state = { runId: null, portal: null, action: 'Idle — waiting for a run', paused: false };
  // The poller reports session status too, so the Connections card and the portal banner track
  // reality during a block instead of freezing for its whole 90 minutes. Reads `ctx` through the
  // closure rather than capturing it, because a relaunch (Connect, or a crashed browser) swaps
  // the context out — a captured one would keep reporting on a dead profile.
  const stopStream = startPausePoller(api, state, () => reportSessions(ctx, api));

  // graceful shutdown
  let running = true;
  /**
   * Close down cleanly when the desktop app quits.
   *
   * Telling the backend the run is over matters: only the worker advances a run, so a row left
   * as "running" blocks the whole rotation until the stale-run reaper clears it ten minutes
   * later. Reporting it here makes the dashboard correct immediately, and lets the next launch
   * start work straight away instead of waiting out the reaper.
   */
  const shutdown = async () => {
    running = false;
    stopStream();
    state.stopped = true;                      // any in-flight portal loop breaks at its next check
    if (state.runId) {
      console.log('\n■ Desktop app closing — ending the current run…');
      await Promise.race([
        api.runStatus(state.runId, 'done', 'Stopped — JobPilot Desktop was closed').catch(() => {}),
        sleep(4000),                            // never hang the app's exit on a slow network
      ]);
    }
    await ctx.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let sessionTick = 0;
  while (running) {
    // Connection handling every loop: act on Connect/Disconnect requests, and report
    // session status periodically (every ~6th idle tick) so the dashboard stays live.
    // A DEAD BROWSER MUST BE REVIVED HERE, not only inside a run.
    //
    // The relaunch used to live in the block executor, so it could only fire while a run was in
    // progress. When the browser died and the schedule was idle, nothing brought it back: the
    // log filled with "the automation browser is not responding … the run will relaunch it"
    // every few seconds, forever, promising a recovery that had no way of happening. Connect
    // could not work either — there was no browser to open a window in — so the card sat on
    // "not connected" while the worker cheerfully polled a backend it had nothing to offer.
    if (!(await pageAlive(page))) {
      console.log('\n  ⟳ the automation browser had stopped responding — reopening it…');
      logEvent('lifecycle', { event: 'browser dead while idle — relaunching', headless: background });
      await ctx.close().catch(() => {});
      await sleep(1200);   // let the profile lock drop before reopening the same directory
      try {
        ({ ctx, page } = await launchBrowser({ headless: background }));
        console.log('  ✓ automation browser is back.\n');
      } catch (e) {
        console.log(`  ! could not reopen the browser: ${String(e && e.message).slice(0, 140)}`);
        logEvent('lifecycle', { event: 'relaunch failed', error: String(e && e.message).slice(0, 200) });
        await sleep(15000);   // do not spin on a machine that cannot start a browser at all
        continue;
      }
    }

    // Connect must be able to put a REAL window on screen. While running headless there is
    // nothing to type into, so the callback relaunches the browser visibly and hands back the
    // new context. Same profile directory, so the cookies the sign-in produces are the ones
    // the next run reads.
    await handleConnectionActions(ctx, page, api, async () => {
      if (!background) return ctx;
      console.log('\n  → Opening a browser window so you can sign in…');
      try { fs.rmSync(signedInMarker, { force: true }); } catch { /* non-fatal */ }
      background = false;
      await ctx.close().catch(() => {});
      // Firefox holds a lock file inside the profile directory and does not always drop it the
      // instant close() resolves. Relaunching the same profile straight away can fail with
      // "profile is already in use" — and since the whole point of this callback is to produce
      // a visible window, that failure is the difference between Connect working and Connect
      // appearing to do nothing. Give the lock a moment, then relaunch.
      await sleep(1200);
      ({ ctx, page } = await launchBrowser({ headless: false }));
      return ctx;
    }).catch((e) => {
      // Not swallowed. A connect path that fails invisibly is the bug being fixed here.
      console.log(`\n  ! Connection handling failed: ${String(e && e.message ? e.message : e).slice(0, 160)}\n`);
    });
    // Report session status often when idle so the Connections cards stay accurate (a watcher
    // in handleConnectionActions also flips a card to Active seconds after sign-in).
    if (sessionTick++ % 2 === 0) await reportSessions(ctx, api).catch(() => {});

    let order;
    try { order = await api.next(); } catch (e) { console.error('poll error:', e.message); await sleep(5000); continue; }

    if (order.paused) { state.action = 'Paused'; state.paused = true; await sleep(4000); continue; }
    if (order.idle || !order.runId) { state.action = 'Idle — waiting for a run'; state.paused = false; await sleep(4000); continue; }

    const adapter = ADAPTERS[order.portal];
    if (!adapter) {
      state.action = `No adapter for ${order.portal} yet`;
      await api.runStatus(order.runId, 'done', `No worker adapter for ${order.portal} yet`);
      await sleep(4000);
      continue;
    }

    // execute the block
    state.runId = order.runId;
    state.portal = order.portal;
    api.portal = order.portal;   // tags screening questions with the portal that asked them
    state.paused = false;
    state.stopped = false; // cleared per block; the pause poller sets it if Stop is clicked
    console.log(`\n▶ ${order.portal.toUpperCase()} — starting`);
    logEvent('run', { event: 'block start', runId: order.runId, portal: order.portal,
      plan: order.plan });
    await api.runStatus(order.runId, 'running', `Working ${order.portal}`);
    try {
      // The browser can die between blocks (Playwright's own crash, or the window was closed).
      // The process-level guards keep the WORKER alive, but every later action then fails with
      // "Target page, context or browser has been closed" forever. Check it's alive and
      // relaunch if not, so a dead browser self-heals instead of failing every run.
      if (!(await pageAlive(page))) {
        console.log('  ⟳ the automation browser had closed — reopening it…');
        await ctx.close().catch(() => {});
        ({ ctx, page } = await launchBrowser({ headless: background }));
      }
      // The portal about to run must be signed in — not "some portal". `anyPortalLoggedIn`
      // above is an OR across every portal, so a live Indeed session kept the app headless
      // while LinkedIn's cookie was gone. The LinkedIn block then ended in under a second
      // with 0/0/0 and an event saying "open the automation browser and log in" — advice
      // that cannot be followed, because headless means there is no window to open. Check
      // the one portal we are about to drive, and if it is signed out, put a real window
      // on its login page so the instruction is actually actionable.
      if (background && !(await isLoggedIn(ctx, order.portal))) {
        console.log(`\n  ⚠ Not signed in to ${order.portal} — its session has expired.`);
        console.log('     Opening a window on the login page. Sign in there; the session is');
        console.log('     remembered and later runs go back to being invisible.\n');
        try { fs.rmSync(signedInMarker, { force: true }); } catch { /* non-fatal */ }
        background = false;
        await ctx.close().catch(() => {});
        ({ ctx, page } = await launchBrowser({ headless: false }));
        await page.goto(loginUrl(order.portal)).catch(() => {});
      }
      let res;
      try {
        res = await adapter(page, api, order.plan, state, ctx);
      } catch (e) {
        // The browser can also die DURING a block — Chrome crashes, the machine sleeps, the
        // window is closed. Every later ctx.newPage() then throws "Target page, context or
        // browser has been closed" and the whole block was abandoned on the spot, an hour of
        // work thrown away over a recoverable fault. Reopen and give the block one more go.
        if (!isDeadBrowser(e)) throw e;
        console.log('\n  ⟳ the automation browser closed mid-run — reopening and retrying this block…');
        await api.event({ runId: order.runId, portal: order.portal, type: 'info',
          detail: 'browser closed mid-run — reopened and retried' });
        await ctx.close().catch(() => {});
        ({ ctx, page } = await launchBrowser({ headless: background }));
        res = await adapter(page, api, order.plan, state, ctx);
      }
      // Clear the local run id BEFORE telling the server the run is over.
      //
      // The pause poller asks /next every 3 seconds and compares the answer to state.runId.
      // Marking the run done first left a window — the summary below takes a moment to print —
      // in which the server correctly reported nothing running while state.runId still pointed
      // at the run we had just ended. The poller read that as "our run vanished" and printed
      //     ■ Run <id> is no longer the active run on the server
      // at the end of EVERY block, which looked like the automation being killed mid-flight and
      // sent us hunting for a phantom for days. The worker was warning about its own shutdown.
      state.runId = null;
      await api.runStatus(order.runId, 'done', `Block complete — ${res.applied || 0} applied`);
      // Full breakdown, not just "applied": a 0 with no explanation is what made this feel
      // like nothing was happening. Every job lands in exactly one of these buckets.
      logSummary(order.portal.charAt(0).toUpperCase() + order.portal.slice(1), res || {});
    } catch (e) {
      console.error(`✗ ${order.portal} block failed:`, e.message);
      if (isDeadBrowser(e)) {
        console.error('  The automation browser kept closing. If this repeats, quit JobPilot from');
        console.error('  the tray and reopen it — the browser profile may be locked by a stale process.');
      }
      await api.event({ runId: order.runId, portal: order.portal, type: 'error', detail: String(e).slice(0, 200) });
      state.runId = null;   // same reason as the success path above
      await api.runStatus(order.runId, 'failed', e.message.slice(0, 120));
    }
    state.runId = null; state.portal = null; state.action = 'Idle — waiting for a run';
    await reportSessions(ctx, api).catch(() => {}); // refresh cards right after a block
    await sleep(3000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
